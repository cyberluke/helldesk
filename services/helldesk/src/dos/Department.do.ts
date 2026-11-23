/**
 * DepartmentDO — The single source of truth for all control-plane data:
 * workstations, agents, tickets, memo, review queues, TicketCases, ticket events,
 * shifts, escalations, and configuration.
 *
 * Agent events (high-volume SSE/streaming data) are delegated to per-agent
 * AgentDOs to stay within the 10GB DO SQLite limit.
 */

import { DurableObject } from 'cloudflare:workers';
import * as Sentry from '@sentry/cloudflare';
import { z } from 'zod';

import * as ticketOps from './department/tickets';
import type { FailureReason } from './department/types';
import * as agents from './department/agents';
import * as memo from './department/memo';
import * as reviewQueue from './department/review-queue';
import * as config from './department/config';
import * as workstations from './department/workstations';
import * as dispatch from './department/container-dispatch';
import * as attendance from './department/attendance';
import * as scheduling from './department/scheduling';
import * as events from './department/events';
import { stopContainerIfIdle as _stopContainerIfIdle } from './department/container-idle-stop';
import {
  OWNER_ACCESS_STORAGE_KEY,
  refreshOwnerAccess as _refreshOwnerAccess,
  type OwnerAccessState,
} from './department/owner-access';
import { evaluateHelldeskAccessFlag } from '../util/helldesk-access-flag.util';
import {
  CONTAINER_HEALTH_STORAGE_KEYS,
  recoverContainerIfWedged as _recoverContainerIfWedged,
  type ContainerHealthPingOutcome,
  type ContainerRecoveryPathHint,
} from './department/container-health-watchdog';
import * as scm from './department/department-scm';
import * as reconciler from './department/reconciler';
import * as helldesk from './department/helldesk';
import { pickCanonicalTicket, type ReporterTicket } from './department/helldesk-reporter';
import { applyAction } from './department/actions';
import type { Action, ApplyActionContext } from './department/actions';
import { buildSoulSystemPrompt } from '../prompts/soul-system.prompt';
import { buildQualityAssuranceSystemPrompt } from '../prompts/quality-assurance-system.prompt';

import {
  tickets,
  TicketRecord,
  EscalationTicketRecord,
  ShiftTicketRecord,
} from '../db/tables/tickets.table';
import { agent_metadata } from '../db/tables/agent-metadata.table';
import { escalation_metadata } from '../db/tables/escalation-metadata.table';
import { shift_metadata } from '../db/tables/shift-metadata.table';
import { ticket_dependencies } from '../db/tables/ticket-dependencies.table';
import { department_events, DepartmentEventRecord, type DepartmentEventType } from '../db/tables/department-events.table';
import {
  agent_nudges,
  AgentNudgeRecord,
  createTableAgentNudges,
  getIndexesAgentNudges,
} from '../db/tables/agent-nudges.table';
import { query } from '../util/query.util';
import { generateId, now } from '../util/id.util';
import { getAgentDOStub } from './Agent.do';
import { getDepartmentContainerDoId, getDepartmentContainerStub } from './DepartmentContainer.do';

import { kiloTokenPayload } from '@kilocode/worker-utils';
import { jwtVerify } from 'jose';
import { generateKiloApiToken } from '../util/kilo-token.util';
import { resolveSecret } from '../util/secret.util';
import { writeEvent, type HelldeskEventData } from '../util/analytics.util';
import { logger, withLogTags } from '../util/log.util';
import {
  HELLDESK_CONTAINER_SKU,
  isContainerUsageMeteringEnabled,
  isHelldeskBillingEnforced,
  type ContainerRunPolicy,
  type HelldeskBillingStatus,
  type UsageActor,
  type UsageContext,
} from '../billing/container-usage.billing';
import { TicketPriority } from '../types';
import type {
  DepartmentConfig,
  DepartmentConfigUpdate,
  CreateTicketInput,
  TicketFilter,
  Ticket,
  TicketStatus,
  TicketType as TicketTypeType,
  TicketPriority as TicketPriorityType,
  RegisterAgentInput,
  AgentFilter,
  Agent,
  AgentRole,
  SendMemoInput,
  Memo,
  ReviewQueueInput,
  AgentDoneInput,
  PrimeContext,
  TicketCase,
  TicketEventRecord,
  MergeStrategy,
  ShiftMergeMode,
  UiAction,
  WorkstationOverrideConfig,
} from '../types';

const DEPARTMENT_LOG = '[Department.do]';

/** Format a ticket_events row into a human-readable message for the status feed. */
function formatEventMessage(row: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : `${v as string}`);
  const eventType = s(row.event_type);
  const ticketTitle = row.ticket_title ? s(row.ticket_title) : null;
  const newValue = row.new_value ? s(row.new_value) : null;
  const agentId = row.agent_id ? s(row.agent_id).slice(0, 8) : null;
  const ticketId = row.ticket_id ? s(row.ticket_id).slice(0, 8) : null;

  const target = ticketTitle ? `"${ticketTitle}"` : ticketId ? `ticket ${ticketId}…` : 'unknown';
  const actor = agentId ? `agent ${agentId}…` : 'system';

  switch (eventType) {
    case 'status_changed':
      return `${target} → ${newValue ?? '?'} (by ${actor})`;
    case 'assigned':
      return `${target} assigned to ${actor}`;
    case 'pr_created':
      return `PR created for ${target}`;
    case 'pr_merged':
      return `PR merged for ${target}`;
    case 'pr_creation_failed':
      return `PR creation failed for ${target}`;
    case 'escalation_created':
      return `Escalation created: ${target}`;
    case 'agent_status':
      return `${actor}: ${newValue ?? 'status update'}`;
    default:
      return `${eventType}: ${target}`;
  }
}

const ACTIVE_ALARM_INTERVAL_MS = 5_000;
const IDLE_ALARM_INTERVAL_MS = 5 * 60_000;
const STALE_ESCALATION_THRESHOLD_MS = 4 * 60 * 60 * 1000;
const MAX_RE_ESCALATIONS = 3;
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'] as const;

type WorkstationConfig = {
  departmentId: string;
  workstationId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
  /** Per-workstation merge strategy override. When unset, inherits from department config. */
  merge_strategy?: MergeStrategy;
};

type EscalationEntry = {
  id: string;
  source_workstation_id: string;
  source_agent_id: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: string | null;
  message: string;
  acknowledged: number;
  re_escalation_count: number;
  created_at: string;
  acknowledged_at: string | null;
};

function toEscalation(row: EscalationTicketRecord): EscalationEntry {
  return {
    id: row.ticket_id,
    source_workstation_id: row.workstation_id ?? '',
    source_agent_id: row.created_by,
    severity: row.severity,
    category: row.category,
    message: row.body ?? row.title,
    acknowledged: row.acknowledged,
    re_escalation_count: row.re_escalation_count,
    created_at: row.created_at,
    acknowledged_at: row.acknowledged_at,
  };
}

type ShiftEntry = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  staged: boolean;
  total_tickets: number;
  closed_tickets: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
  feature_branch: string | null;
  merge_mode: string | null;
};

function toShift(row: ShiftTicketRecord): ShiftEntry {
  return {
    id: row.ticket_id,
    title: row.title,
    status: row.status === 'closed' ? 'landed' : 'active',
    staged: row.staged === 1,
    total_tickets: row.total_tickets,
    closed_tickets: row.closed_tickets,
    created_by: row.created_by,
    created_at: row.created_at,
    landed_at: row.landed_at,
    feature_branch: row.feature_branch,
    merge_mode: row.merge_mode,
  };
}

const SHIFT_JOIN = /* sql */ `
  SELECT ${tickets}.*,
         ${shift_metadata.total_tickets}, ${shift_metadata.closed_tickets},
         ${shift_metadata.landed_at}, ${shift_metadata.feature_branch},
         ${shift_metadata.merge_mode}, ${shift_metadata.staged}
  FROM ${tickets}
  INNER JOIN ${shift_metadata} ON ${tickets.ticket_id} = ${shift_metadata.ticket_id}
`;

const ESCALATION_JOIN = /* sql */ `
  SELECT ${tickets}.*,
         ${escalation_metadata.severity}, ${escalation_metadata.category},
         ${escalation_metadata.acknowledged}, ${escalation_metadata.re_escalation_count},
         ${escalation_metadata.acknowledged_at}
  FROM ${tickets}
  INNER JOIN ${escalation_metadata} ON ${tickets.ticket_id} = ${escalation_metadata.ticket_id}
`;

export class DepartmentDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initPromise: Promise<void> | null = null;
  private _ownerUserId: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private emitEvent(data: Omit<HelldeskEventData, 'userId' | 'delivery'>): void {
    writeEvent(this.env, {
      ...data,
      delivery: 'internal',
      userId: this._ownerUserId,
    });
  }

  /** Build the context object used by the scheduling sub-module. */
  private get schedulingCtx(): Parameters<typeof scheduling.dispatchAgent>[0] {
    return {
      sql: this.sql,
      env: this.env,
      storage: this.ctx.storage,
      departmentId: this.departmentId,
      getDepartmentConfig: () => this.getDepartmentConfig(),
      getWorkstationConfig: (workstationId: string) => this.getWorkstationConfig(workstationId),
      resolveKilocodeToken: () => this.resolveKilocodeToken(),
      emitEvent: data => this.emitEvent(data),
      prepareContainerBilling: async () => {
        await this.prepareContainerBilling();
        if (isContainerUsageMeteringEnabled(this.env)) {
          await getDepartmentContainerStub(this.env, this.departmentId).warmUp();
          this._billingBlocked = false;
          await this.ctx.storage.put('billing:blocked', false);
        }
      },
    };
  }

  /** Build the context object used by the reconciler's applyAction. */
  private get applyActionCtx(): ApplyActionContext {
    const schedulingCtx = this.schedulingCtx;
    return {
      sql: this.sql,
      departmentId: this.departmentId,
      dispatchAgent: async (agentId, ticketId, workstationId) => {
        const agent = agents.getAgent(this.sql, agentId);
        const ticket = ticketOps.getTicket(this.sql, ticketId);
        if (!agent || !ticket) return false;

        let systemPromptOverride: string | undefined;
        const departmentConfig = await this.getDepartmentConfig();
        const workstation = workstations.getWorkstation(this.sql, workstationId);
        const effectiveConfig = config.resolveWorkstationConfig(departmentConfig, workstation?.config ?? null);

        // Build quality-assurance-specific system prompt with branch/target info.
        // When the MR ticket already has a pr_url (soul created the PR),
        // the qualityAssurance reviews the existing PR and adds GitHub comments
        // instead of creating a new PR.
        if (agent.role === 'qualityAssurance' && ticket.type === 'merge_request') {
          const reviewMeta = reviewQueue.getReviewMetadata(this.sql, ticketId);
          // Always pass existingPrUrl so the qualityAssurance knows the PR exists
          // and doesn't create a duplicate. The review_mode controls HOW
          // the qualityAssurance communicates findings (comments vs rework), not
          // whether it knows the PR exists.
          const existingPrUrl =
            typeof reviewMeta?.pr_url === 'string' ? reviewMeta.pr_url : undefined;
          systemPromptOverride = buildQualityAssuranceSystemPrompt({
            identity: agent.identity,
            workstationId,
            departmentId: this.departmentId,
            gates: departmentConfig.qualityAssurance?.gates ?? [],
            branch: reviewMeta?.branch ?? 'unknown',
            targetBranch: reviewMeta?.target_branch ?? 'main',
            soulAgentId:
              typeof ticket.metadata?.source_agent_id === 'string'
                ? ticket.metadata.source_agent_id
                : 'unknown',
            mergeStrategy: effectiveConfig.merge_strategy,
            existingPrUrl,
            reviewMode: effectiveConfig.review_mode,
          });
        }

        // When merge_strategy is 'pr', souls always create the PR themselves
        // and pass pr_url to gt_done. For review-then-land shift intermediate
        // tickets, the PR targets the shift feature branch (not main).
        if (agent.role === 'soul' && effectiveConfig.merge_strategy === 'pr') {
          const shiftId = ticketOps.getShiftForTicket(this.sql, ticketId);
          const shiftFeatureBranch = shiftId
            ? ticketOps.getShiftFeatureBranch(this.sql, shiftId)
            : null;
          const shiftMergeMode = shiftId ? ticketOps.getShiftMergeMode(this.sql, shiftId) : null;
          const targetBranch =
            shiftMergeMode === 'review-then-land' && shiftFeatureBranch
              ? shiftFeatureBranch
              : (workstation?.default_branch ?? 'main');

          console.log(
            `${DEPARTMENT_LOG} dispatch soul: ticket=${ticketId} shiftId=${shiftId ?? 'none'} mergeMode=${shiftMergeMode ?? 'none'} featureBranch=${shiftFeatureBranch ?? 'none'} targetBranch=${targetBranch}`
          );

          systemPromptOverride = buildSoulSystemPrompt({
            agentName: agent.name,
            workstationId,
            departmentId: this.departmentId,
            identity: agent.identity,
            gates: departmentConfig.qualityAssurance?.gates ?? [],
            mergeStrategy: 'pr',
            targetBranch,
          });
        }

        // Option B (defense-in-depth): If the reconciler re-dispatches an
        // open triage batch ticket (gt:triage, created_by='attendance') — e.g.
        // because Option A's in_progress transition was somehow bypassed —
        // inject the triage system prompt so the soul gets the correct
        // tools and instructions instead of the generic soul prompt.
        if (ticket.labels.includes(attendance.TRIAGE_BATCH_LABEL) && ticket.created_by === 'attendance') {
          const pendingRequests = attendance.listPendingTriageRequests(this.sql);
          const { buildTriageSystemPrompt } = await import('../prompts/triage-system.prompt');
          systemPromptOverride = buildTriageSystemPrompt(pendingRequests);
        }

        return scheduling.dispatchAgent(schedulingCtx, agent, ticket, {
          systemPromptOverride,
        });
      },
      stopAgent: async agentId => {
        await dispatch.stopAgentInContainer(this.env, this.departmentId, agentId);
      },
      checkPRStatus: async prUrl => {
        return scm.checkPRStatus(
          { env: this.env, departmentId: this.departmentId, getDepartmentConfig: () => this.getDepartmentConfig() },
          prUrl
        );
      },
      checkPRFeedback: async prUrl => {
        return scm.checkPRFeedback(
          { env: this.env, departmentId: this.departmentId, getDepartmentConfig: () => this.getDepartmentConfig() },
          prUrl
        );
      },
      mergePR: async prUrl => {
        return scm.mergePR(
          { env: this.env, departmentId: this.departmentId, getDepartmentConfig: () => this.getDepartmentConfig() },
          prUrl
        );
      },
      getDepartmentConfig: async () => {
        return this.getDepartmentConfig();
      },
      queueNudge: async (agentId, message, _tier) => {
        await this.queueNudge(agentId, message, {
          mode: 'immediate',
          priority: 'urgent',
          source: 'reconciler',
        });
      },
      insertEvent: (eventType, params) => {
        events.insertEvent(this.sql, eventType as Parameters<typeof events.insertEvent>[1], params);
      },
      emitEvent: data => {
        if (typeof data.event === 'string') {
          this.emitEvent(data as Parameters<typeof this.emitEvent>[0]);
        }
      },
      reportHelldeskDone: async input => this.reportHelldeskDone(input),
    };
  }

  /**
   * Stamp the canonical ticket for a helldesk claim with `reported_done_at`.
   * Used by the manual `handleHelldeskDone` path so the auto-done
   * reconciler doesn't re-fire for items the frontDesk already reported.
   * No-op when no canonical ticket is found (e.g. the frontDesk reported done
   * for an item that never produced a helldesk-tagged ticket in this department).
   */
  async stampHelldeskReported(input: {
    helldeskId: string;
    itemId: string;
    evidence: string;
  }): Promise<{ stamped: boolean; ticket_id: string | null }> {
    // Find every ticket carrying this helldesk tag and pick the canonical one
    // by the same rule the reconciler uses (shift ticket if any, else the
    // earliest-created ticket).
    const candidates = TicketRecord.array().parse([
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${tickets}
          WHERE json_extract(${tickets.metadata}, '$.helldesk.helldesk_id') = ?
            AND json_extract(${tickets.metadata}, '$.helldesk.item_id') = ?
          ORDER BY ${tickets.created_at} ASC
        `,
        [input.helldeskId, input.itemId]
      ),
    ]);
    if (candidates.length === 0) {
      return { stamped: false, ticket_id: null };
    }
    // Reuse the same canonical-ticket rule the reconciler uses so the manual
    // and auto paths can never disagree about which ticket carries the flag.
    const reporterCandidates: ReporterTicket[] = candidates.map(b => ({
      ticket_id: b.ticket_id,
      type: b.type,
      status: b.status,
      title: b.title,
      metadata: b.metadata,
      pr_url: null,
      created_at: b.created_at,
    }));
    const canonical = pickCanonicalTicket(reporterCandidates);
    if (!canonical) {
      return { stamped: false, ticket_id: null };
    }
    const stamped = helldesk.stampHelldeskReportedDone(this.sql, canonical.ticket_id, {
      evidence: input.evidence,
    });
    if (!stamped) {
      console.warn(
        `${DEPARTMENT_LOG} stampHelldeskReported: ticket=${canonical.ticket_id} has no metadata.helldesk; nothing to stamp`
      );
    }
    return { stamped, ticket_id: canonical.ticket_id };
  }

  /**
   * Mark a helldesk wanted item as done upstream and stamp
   * `metadata.helldesk.reported_done_at` on the canonical ticket. Best
   * effort: returns false on any failure so the reconciler retries on
   * the next tick (the local stamp is the idempotency gate). The
   * upstream RPC is the meaningful side effect; the local stamp is just
   * how we remember we did it.
   *
   * Before issuing the RPC, this checks whether the upstream item is
   * already in `done` state — that handles the crash-window case where
   * a previous tick called the RPC successfully but the worker died
   * before writing the local stamp. In that case we just stamp locally
   * and skip the duplicate RPC.
   */
  private async reportHelldeskDone(input: {
    helldeskId: string;
    itemId: string;
    evidence: string;
    canonicalTicketId: string;
  }): Promise<boolean> {
    const departmentConfig = await this.getDepartmentConfig();
    const userId = departmentConfig.owner_user_id;
    if (!userId) {
      console.warn(
        `${DEPARTMENT_LOG} reportHelldeskDone: department has no owner_user_id; skipping item=${input.itemId}`
      );
      return false;
    }

    // Crash-window guard: if a previous tick already called markWantedItemDone
    // but died before stamping locally, the upstream item is already in
    // 'done' state. Detect that and just stamp locally — calling the RPC
    // again can produce a duplicate upstream PR.
    const alreadyDoneUpstream = await this.isWantedItemDoneUpstream(
      input.helldeskId,
      userId,
      input.itemId
    );
    if (alreadyDoneUpstream) {
      const stamped = helldesk.stampHelldeskReportedDone(this.sql, input.canonicalTicketId, {
        evidence: input.evidence,
      });
      if (!stamped) {
        console.warn(
          `${DEPARTMENT_LOG} reportHelldeskDone: upstream already done but ticket=${input.canonicalTicketId} has no metadata.helldesk; cannot stamp`
        );
        return false;
      }
      console.log(
        `${DEPARTMENT_LOG} reportHelldeskDone: upstream already done for item=${input.itemId}; stamped ticket=${input.canonicalTicketId} without re-calling RPC`
      );
      return true;
    }

    try {
      const result = await this.env.HELLDESK_SERVICE.markWantedItemDone({
        helldeskId: input.helldeskId,
        userId,
        itemId: input.itemId,
        evidence: input.evidence,
      });
      if (!result.success) {
        console.warn(
          `${DEPARTMENT_LOG} reportHelldeskDone: upstream call failed code=${result.code} item=${input.itemId} msg=${result.message}`
        );
        return false;
      }
      const stamped = helldesk.stampHelldeskReportedDone(this.sql, input.canonicalTicketId, {
        evidence: input.evidence,
      });
      if (!stamped) {
        console.warn(
          `${DEPARTMENT_LOG} reportHelldeskDone: RPC succeeded but ticket=${input.canonicalTicketId} has no metadata.helldesk; cannot stamp (will retry next tick — risk of duplicate upstream call mitigated by isWantedItemDoneUpstream precheck)`
        );
        return false;
      }
      console.log(
        `${DEPARTMENT_LOG} reportHelldeskDone: marked item=${input.itemId} as done; stamped ticket=${input.canonicalTicketId}`
      );
      return true;
    } catch (err) {
      console.error(`${DEPARTMENT_LOG} reportHelldeskDone: unexpected error item=${input.itemId}:`, err);
      return false;
    }
  }

  /**
   * Best-effort check of whether a wanted item is already `done` upstream.
   * Returns false on any error (network, parse, item missing) so the
   * caller falls through to the normal RPC path. Used as the crash-window
   * guard inside `reportHelldeskDone`.
   */
  private async isWantedItemDoneUpstream(
    helldeskId: string,
    userId: string,
    itemId: string
  ): Promise<boolean> {
    try {
      const browse = await this.env.HELLDESK_SERVICE.browseWantedBoard({
        helldeskId,
        userId,
      });
      if (!browse.success) return false;
      const item = browse.data.find(it => it.id === itemId);
      if (!item) return false;
      return item.status === 'done';
    } catch (err) {
      console.warn(`${DEPARTMENT_LOG} isWantedItemDoneUpstream: browse failed for item=${itemId}:`, err);
      return false;
    }
  }

  /**
   * Handle HTTP requests to the DO. Only used for the /status/ws
   * WebSocket upgrade — all other requests use RPC methods.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname.endsWith('/status/ws') &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, ['status']);

      // Send an initial snapshot immediately so the client doesn't
      // wait for the next alarm tick.
      try {
        const snapshot = await this.getAlarmStatus();
        server.send(JSON.stringify(snapshot));
      } catch {
        // Best-effort — snapshot will come on next tick
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  /** Called by the runtime when a hibernated WebSocket receives a message. */
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Status WebSocket is server-push only — ignore client messages.
  }

  /** Called by the runtime when a hibernated WebSocket is closed. */
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed
    }
  }

  /** Called by the runtime when a hibernated WebSocket errors. */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Already closed
    }
  }

  /**
   * Broadcast the alarm status snapshot to all connected status WebSocket
   * clients. Called at the end of each alarm tick.
   */
  private broadcastAlarmStatus(snapshot: Awaited<ReturnType<DepartmentDO['getAlarmStatus']>>): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;

    const payload = JSON.stringify(snapshot);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast a lightweight agent_status event to all connected status
   * WebSocket clients. Called whenever an agent updates its status message.
   */
  private broadcastAgentStatus(agentId: string, message: string): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;

    const payload = JSON.stringify({
      type: 'agent_status',
      agentId,
      message,
      timestamp: now(),
    });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast an incremental ticket lifecycle event to all connected status
   * WebSocket clients. Called after ticket create/update/close operations.
   */
  private broadcastTicketEvent(event: {
    type: 'ticket.created' | 'ticket.status_changed' | 'ticket.closed' | 'ticket.failed';
    ticketId: string;
    title?: string;
    status?: string;
    workstationId?: string;
    shiftId?: string;
  }): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({ channel: 'ticket', ...event, ts: now() });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast shift progress to all connected status WebSocket clients.
   * Called from onTicketClosed() after updating closed_tickets count.
   */
  private broadcastShiftProgress(shiftId: string, totalTickets: number, closedTickets: number): void {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({
      channel: 'shift',
      shiftId,
      totalTickets,
      closedTickets,
      ts: now(),
    });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  /**
   * Broadcast a ui_action event to all connected status WebSocket clients.
   * Called by the frontDesk via the /frontDesk/ui-action HTTP route.
   */
  async broadcastUiAction(action: UiAction): Promise<void> {
    const sockets = this.ctx.getWebSockets('status');
    if (sockets.length === 0) return;
    const frame = JSON.stringify({ channel: 'ui_action', action, ts: now() });
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {
        // Client disconnected — will be cleaned up by webSocketClose
      }
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    const storedId = await this.ctx.storage.get<string>('department:id');
    if (storedId) this._departmentId = storedId;

    const departmentConfig = await config.getDepartmentConfig(this.ctx.storage);
    this._ownerUserId = departmentConfig.owner_user_id;

    this._draining = (await this.ctx.storage.get<boolean>('department:draining')) ?? false;
    this._drainNonce = (await this.ctx.storage.get<string>('department:drainNonce')) ?? null;
    this._drainStartedAt = (await this.ctx.storage.get<number>('department:drainStartedAt')) ?? null;
    this._billingBlocked = (await this.ctx.storage.get<boolean>('billing:blocked')) ?? false;
    this._accessRevoked =
      (await this.ctx.storage.get<OwnerAccessState>(OWNER_ACCESS_STORAGE_KEY))?.revoked ?? false;
    this._containerRunPolicy =
      (await this.ctx.storage.get<ContainerRunPolicy>('container:runPolicy')) ?? 'automatic';

    ticketOps.initTicketTables(this.sql);

    agents.initAgentTables(this.sql);
    memo.initMemoTables(this.sql);
    reviewQueue.initReviewQueueTables(this.sql);

    workstations.initWorkstationTables(this.sql);

    query(this.sql, createTableAgentNudges(), []);
    for (const idx of getIndexesAgentNudges()) {
      query(this.sql, idx, []);
    }

    helldesk.initHelldeskTables(this.sql);

    events.initDepartmentEventsTable(this.sql);

    // One-shot cleanup: older versions of this DO stored a separate
    // `frontDesk:ready_reported_for:<startedAt>` key per container instance,
    // which grew unbounded over a department's lifetime. We now store a single
    // `frontDesk:ready_reported_for` key instead. Delete the legacy entries
    // on next init so long-lived departments don't leak durable storage.
    const legacyReadyKeys = await this.ctx.storage.list<unknown>({
      prefix: 'frontDesk:ready_reported_for:',
    });
    if (legacyReadyKeys.size > 0) {
      await this.ctx.storage.delete([...legacyReadyKeys.keys()]);
    }

    // Ensure the alarm loop is running. After a deploy/restart, the
    // Cloudflare runtime normally delivers missed alarms, but if the alarm
    // was never set or was deleted by destroy(), the loop is dead. Re-arm
    // unconditionally so pending work (idle agents with hooks, open MR tickets,
    // stale reviews) gets processed.
    await this.armAlarmIfNeeded();
  }

  private _departmentId: string | null = null;
  private _lastReconcilerMetrics: reconciler.ReconcilerMetrics | null = null;
  private _dashboardContext: string | null = null;
  /** Monotonic timestamp of the last working → transition for the frontDesk.
   *  Used to reject stale session.idle callbacks that arrive after a new
   *  prompt has already re-activated the frontDesk. */
  private _frontDeskWorkingSince = 0;
  private _draining = false;
  private _drainNonce: string | null = null;
  private _drainStartedAt: number | null = null;
  private _billingBlocked = false;
  private _accessRevoked = false;
  private _containerRunPolicy: ContainerRunPolicy = 'automatic';
  /** Instance UUID of the current container, set by the first heartbeat. */
  private _containerInstanceId: string | null = null;

  private get departmentId(): string {
    return this._departmentId ?? this.ctx.id.name ?? this.ctx.id.toString();
  }

  /**
   * Explicitly set the department ID. Called by configureWorkstation or any handler
   * that knows the real department UUID, so that subsequent internal calls
   * (alarm, sendFrontDeskMessage) use the correct ID for container stubs.
   */
  async setDepartmentId(departmentId: string): Promise<void> {
    this._departmentId = departmentId;
    await this.ctx.storage.put('department:id', departmentId);
  }

  async setDashboardContext(context: string): Promise<void> {
    this._dashboardContext = context;
    // Best-effort push to the running container so the plugin has it
    // in-memory for the next LLM call without a network round-trip.
    await dispatch.pushDashboardContext(this.env, this.departmentId, context);
  }

  async getDashboardContext(): Promise<string | null> {
    return this._dashboardContext;
  }

  /**
   * Record a container eviction event and set the draining flag.
   * Called by the container when it receives SIGTERM. While draining,
   * the reconciler skips dispatch to prevent new work from starting.
   *
   * Returns a drain nonce that must be presented via
   * `acknowledgeContainerReady()` to clear the drain flag. This
   * prevents stale heartbeats from the dying container from
   * prematurely re-enabling dispatch.
   */
  async recordContainerEviction(): Promise<string> {
    events.insertEvent(this.sql, 'container_eviction', {});
    const nonce = crypto.randomUUID();
    const startedAt = Date.now();
    this._draining = true;
    this._drainNonce = nonce;
    this._drainStartedAt = startedAt;
    await this.ctx.storage.put('department:draining', true);
    await this.ctx.storage.put('department:drainNonce', nonce);
    await this.ctx.storage.put('department:drainStartedAt', startedAt);
    console.log(`${DEPARTMENT_LOG} recordContainerEviction: draining flag set, nonce=${nonce}`);
    return nonce;
  }

  /**
   * Acknowledge that the replacement container is ready. Clears the
   * draining flag only if the provided nonce matches the one generated
   * during `recordContainerEviction()`. This ensures that only the
   * new container (which received the nonce via startup config) can
   * re-enable dispatch — not a stale heartbeat from the old container.
   */
  async acknowledgeContainerReady(nonce: string): Promise<boolean> {
    if (!this._draining) {
      console.log(`${DEPARTMENT_LOG} acknowledgeContainerReady: not draining, noop`);
      return true;
    }
    if (nonce !== this._drainNonce) {
      console.warn(
        `${DEPARTMENT_LOG} acknowledgeContainerReady: nonce mismatch (got=${nonce}, expected=${this._drainNonce})`
      );
      return false;
    }
    this._draining = false;
    this._drainNonce = null;
    this._drainStartedAt = null;
    await this.ctx.storage.put('department:draining', false);
    await this.ctx.storage.delete('department:drainNonce');
    await this.ctx.storage.delete('department:drainStartedAt');
    console.log(`${DEPARTMENT_LOG} acknowledgeContainerReady: draining flag cleared`);
    return true;
  }

  /** Whether the department is in draining mode (container eviction in progress). */
  async isDraining(): Promise<boolean> {
    return this._draining;
  }

  /** The current drain nonce (null when not draining). */
  async getDrainNonce(): Promise<string | null> {
    return this._drainNonce;
  }

  /** When the drain started (epoch ms), or null when not draining. */
  async getDrainStartedAt(): Promise<number | null> {
    return this._drainStartedAt;
  }

  async getDepartmentConfig(): Promise<DepartmentConfig> {
    return config.getDepartmentConfig(this.ctx.storage);
  }

  async updateDepartmentConfig(update: DepartmentConfigUpdate): Promise<DepartmentConfig> {
    const result = await config.updateDepartmentConfig(this.ctx.storage, update);
    this._ownerUserId = result.owner_user_id;
    await this.prepareContainerBilling(undefined, result);
    return result;
  }

  async getBillingStatus(): Promise<HelldeskBillingStatus> {
    try {
      if (isContainerUsageMeteringEnabled(this.env)) await this.prepareContainerBilling();
      const status = await getDepartmentContainerStub(this.env, this.departmentId).getBillingStatus();
      await this.syncContainerRunPolicy(status.runPolicy);
      return status;
    } catch (error) {
      // A read-only status query must never fail the dashboard. Fall back to a
      // degraded status if billing setup or the container DO is unreachable.
      logger.warn('billing: getBillingStatus failed, returning degraded', {
        departmentId: this.departmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        enabled: isContainerUsageMeteringEnabled(this.env),
        enforcing: isHelldeskBillingEnforced(this.env),
        state: 'degraded',
        runPolicy: this._containerRunPolicy,
      };
    }
  }

  async setContainerRunPolicy(policy: ContainerRunPolicy): Promise<HelldeskBillingStatus> {
    const status = await getDepartmentContainerStub(this.env, this.departmentId).setRunPolicy(policy);
    await this.syncContainerRunPolicy(status.runPolicy);
    return status;
  }

  private async syncContainerRunPolicy(policy: ContainerRunPolicy): Promise<void> {
    if (this._containerRunPolicy === policy) return;
    this._containerRunPolicy = policy;
    await this.ctx.storage.put('container:runPolicy', policy);
  }

  private containerStartsBlocked(): boolean {
    return (
      this._accessRevoked || this._billingBlocked || this._containerRunPolicy === 'paused_by_user'
    );
  }

  private async refreshOwnerAccess(): Promise<void> {
    this._accessRevoked = await _refreshOwnerAccess({
      // Same user the frontDesk runs as. Departments created over HTTP have no owner_user_id.
      getOwnerUserId: async () => {
        const departmentConfig = await this.getDepartmentConfig();
        return (
          departmentConfig.owner_user_id ??
          (await this.getFrontDeskWorkstationConfig())?.userId ??
          departmentConfig.created_by_user_id
        );
      },
      evaluateAccess: userId => evaluateHelldeskAccessFlag(this.env, userId),
      getState: () => this.ctx.storage.get<OwnerAccessState>(OWNER_ACCESS_STORAGE_KEY),
      setState: state => this.ctx.storage.put(OWNER_ACCESS_STORAGE_KEY, state),
      applyToContainer: revoked =>
        getDepartmentContainerStub(this.env, this.departmentId).setAccessRevoked(revoked),
      now: () => Date.now(),
    });
  }

  private async prepareContainerBilling(
    actor?: UsageActor,
    providedConfig?: DepartmentConfig
  ): Promise<void> {
    if (!isContainerUsageMeteringEnabled(this.env)) return;

    const departmentConfig = providedConfig ?? (await this.getDepartmentConfig());
    const ownerId = departmentConfig.owner_id ?? departmentConfig.organization_id ?? departmentConfig.owner_user_id;
    if (!ownerId) {
      // A department without a resolvable billing owner (e.g. a freshly created department
      // before its owner is set) simply isn't metered yet. Skip billing setup
      // rather than throwing so unrelated config/token updates aren't broken.
      logger.warn('billing: skipping container billing setup, department has no billing owner', {
        departmentId: this.departmentId,
      });
      return;
    }

    const subject =
      departmentConfig.owner_type === 'org'
        ? ({ type: 'org', id: ownerId } as const)
        : ({ type: 'user', id: ownerId } as const);
    const useBotActor = !actor || (subject.type === 'user' && actor.id !== subject.id);
    const billingActor = useBotActor
      ? ({ type: 'bot', id: `helldesk:${this.departmentId}` } as const)
      : actor;
    const context: UsageContext = {
      service: 'helldesk',
      instanceId: getDepartmentContainerDoId(this.env, this.departmentId),
      sku: HELLDESK_CONTAINER_SKU,
      subject,
      actor: billingActor,
      sessionId: this.departmentId,
      metadata: {
        departmentId: this.departmentId,
        ...(actor && useBotActor ? { triggeredByUserId: actor.id } : {}),
      },
      ...(billingActor.type === 'bot' ? { onBehalfOf: subject } : {}),
    };
    const container = getDepartmentContainerStub(this.env, this.departmentId);
    await container.setBillingContext(context);
    const estimatedHourlyCharge = await this.getBillingHourlyEstimate();
    if (estimatedHourlyCharge !== undefined) {
      await container.setBillingHourlyEstimate(estimatedHourlyCharge);
    }
  }

  private async getBillingHourlyEstimate(): Promise<number | undefined> {
    const storageKey = `billing:hourlyEstimate:${HELLDESK_CONTAINER_SKU}`;
    const cached = await this.ctx.storage.get<number>(storageKey);
    if (cached !== undefined) return cached;
    if (!this.env.HYPERDRIVE) return undefined;

    const { getSkuHourlyCharge } = await import('../billing/sku-rate.billing');
    const estimate = await getSkuHourlyCharge(
      this.env.HYPERDRIVE.connectionString,
      HELLDESK_CONTAINER_SKU
    );
    if (estimate !== undefined) await this.ctx.storage.put(storageKey, estimate);
    return estimate;
  }

  private async updateContainerBilling(): Promise<HelldeskBillingStatus> {
    if (!isContainerUsageMeteringEnabled(this.env)) {
      return {
        enabled: false,
        enforcing: false,
        state: 'idle',
        runPolicy: this._containerRunPolicy,
      };
    }

    // Usage is always metered and reported. The blocked/graceful-stop reactions
    // below are enforcement and only apply when HELLDESK_BILLING_ENABLED is on;
    // with enforcement off we collect shadow usage without affecting the department.
    await this.prepareContainerBilling();
    const container = getDepartmentContainerStub(this.env, this.departmentId);
    const status = await container.recordUsageHeartbeat();
    await this.syncContainerRunPolicy(status.runPolicy);

    if (!isHelldeskBillingEnforced(this.env)) {
      if (this._billingBlocked) {
        this._billingBlocked = false;
        await this.ctx.storage.put('billing:blocked', false);
      }
      return status;
    }

    const blocked =
      status.runPolicy === 'automatic' &&
      (status.state === 'blocked' || status.state === 'stopping');

    if (blocked !== this._billingBlocked) {
      this._billingBlocked = blocked;
      await this.ctx.storage.put('billing:blocked', blocked);
    }

    if (status.state === 'stopping') {
      await container.stopForBilling().catch(error => {
        logger.warn('billing: graceful container stop failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return status;
  }

  /**
   * Force-refresh the container token, bypassing the 1-hour throttle.
   * Called from the user-facing tRPC mutation so operators can manually
   * push a fresh JWT to the running container.
   *
   * Unlike the alarm-driven refreshContainerToken, this propagates ALL
   * errors (including container-down) so the UI can show a real failure
   * instead of a false success.
   */
  async forceRefreshContainerToken(): Promise<void> {
    const departmentId = this.departmentId;
    if (!departmentId) throw new Error('departmentId not set');
    const departmentConfig = await this.getDepartmentConfig();
    const userId = departmentConfig.owner_user_id ?? departmentId;
    await dispatch.forceRefreshContainerToken(this.env, departmentId, userId);
    await this.ctx.storage.put('container:lastTokenRefreshAt', Date.now());
  }

  /**
   * Push config-derived env vars to the running container. Called after
   * updateDepartmentConfig so that settings changes take effect without a
   * container restart. New agent processes inherit the updated values.
   *
   * Two-phase push:
   *  1. setEnvVar — persists to DO storage for next boot
   *  2. POST /sync-config — hot-swaps process.env on the running container
   */
  async syncConfigToContainer(): Promise<void> {
    const departmentId = this.departmentId;
    if (!departmentId) return;
    const departmentConfig = await this.getDepartmentConfig();
    const container = getDepartmentContainerStub(this.env, departmentId);

    // Resolve a fresh GitHub token here too — this method runs both at
    // initial config push and on every config change, so the persisted
    // GIT_TOKEN must be live rather than the stale value stored in
    // git_auth.github_token from workstation creation. The container's
    // syncDepartmentConfigToProcessEnv path reads `git_auth.github_token`
    // from the X-department-Config header on every request, so the in-process
    // GIT_TOKEN follows the same source-of-truth as the persisted one.
    const githubToken = await scm.resolveGitHubTokenString({
      env: this.env,
      departmentId,
      getDepartmentConfig: () => Promise.resolve(departmentConfig),
    });

    const envMapping: Array<[string, string | undefined]> = [
      ['GIT_TOKEN', githubToken ?? undefined],
      ['GITLAB_TOKEN', departmentConfig.git_auth?.gitlab_token],
      ['GITLAB_INSTANCE_URL', departmentConfig.git_auth?.gitlab_instance_url],
      ['GITHUB_CLI_PAT', departmentConfig.github_cli_pat],
      ['HELLDESK_GIT_AUTHOR_NAME', departmentConfig.git_author_name],
      ['HELLDESK_GIT_AUTHOR_EMAIL', departmentConfig.git_author_email],
      ['HELLDESK_DISABLE_AI_COAUTHOR', departmentConfig.disable_ai_coauthor ? '1' : undefined],
      ['KILOCODE_TOKEN', departmentConfig.kilocode_token],
    ];

    for (const [key, value] of envMapping) {
      try {
        if (value) {
          await container.setEnvVar(key, value);
        } else {
          await container.deleteEnvVar(key);
        }
      } catch (err) {
        console.warn(`[Department.do] syncConfigToContainer: ${key} sync failed:`, err);
      }
    }

    // Persist custom env_vars to DO storage so they survive container restarts.
    // Compare against the previously-persisted set of keys to clear removed ones.
    // Reserved infra keys are never overwritten or deleted — infra values always win.
    const RESERVED_ENV_KEYS = new Set([
      'KILOCODE_TOKEN',
      'GIT_TOKEN',
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'GITLAB_INSTANCE_URL',
      'GITHUB_CLI_PAT',
      'GH_TOKEN',
      'HELLDESK_GIT_AUTHOR_NAME',
      'HELLDESK_GIT_AUTHOR_EMAIL',
      'HELLDESK_DISABLE_AI_COAUTHOR',
      'HELLDESK_ORGANIZATION_ID',
      'HELLDESK_CONTAINER_TOKEN',
      'HELLDESK_SESSION_TOKEN',
      'HELLDESK_API_URL',
    ]);
    const CUSTOM_ENV_KEYS_STORAGE_KEY = 'container:custom_env_var_keys';
    const prevCustomKeys: string[] =
      (await this.ctx.storage.get<string[]>(CUSTOM_ENV_KEYS_STORAGE_KEY)) ?? [];
    const newCustomKeys = Object.keys(departmentConfig.env_vars).filter(
      key => !RESERVED_ENV_KEYS.has(key)
    );
    const newCustomKeySet = new Set(newCustomKeys);

    for (const key of prevCustomKeys) {
      if (RESERVED_ENV_KEYS.has(key)) continue;
      if (!newCustomKeySet.has(key)) {
        try {
          await container.deleteEnvVar(key);
        } catch (err) {
          console.warn(`[Department.do] syncConfigToContainer: delete custom ${key} failed:`, err);
        }
      }
    }
    for (const [key, value] of Object.entries(departmentConfig.env_vars)) {
      if (RESERVED_ENV_KEYS.has(key)) continue;
      try {
        await container.setEnvVar(key, value);
      } catch (err) {
        console.warn(`[Department.do] syncConfigToContainer: set custom ${key} failed:`, err);
      }
    }
    await this.ctx.storage.put(CUSTOM_ENV_KEYS_STORAGE_KEY, newCustomKeys);

    try {
      const containerConfig = await config.buildContainerConfig(
        this.ctx.storage,
        this.env,
        this.departmentId
      );
      await container.fetch('http://container/sync-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-department-Config': JSON.stringify(containerConfig),
        },
      });
    } catch (err) {
      // Best-effort — container may not be running yet.
      console.warn(
        `[Department.do] syncConfigToContainer: /sync-config push failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  async addWorkstation(input: {
    workstationId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }): Promise<workstations.WorkstationRecord> {
    return workstations.addWorkstation(this.sql, input);
  }

  async removeWorkstation(workstationId: string): Promise<void> {
    workstations.removeWorkstation(this.sql, workstationId);
    await this.ctx.storage.delete(`workstation:${workstationId}:config`);
    // Delete all tickets belonging to this workstation (cascades to satellite tables via deleteTicket)
    const workstationTickets = TicketRecord.pick({ ticket_id: true })
      .array()
      .parse([
        ...query(
          this.sql,
          /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.workstation_id} = ?`,
          [workstationId]
        ),
      ]);
    for (const { ticket_id } of workstationTickets) {
      ticketOps.deleteTicket(this.sql, ticket_id);
    }
  }

  async listWorkstations(): Promise<workstations.WorkstationRecord[]> {
    return workstations.listWorkstations(this.sql);
  }

  async getWorkstationAsync(workstationId: string): Promise<workstations.WorkstationRecord | null> {
    return workstations.getWorkstation(this.sql, workstationId);
  }

  async updateWorkstationConfig(workstationId: string, config: WorkstationOverrideConfig): Promise<workstations.WorkstationRecord | null> {
    workstations.updateWorkstationConfig(this.sql, workstationId, config);
    return workstations.getWorkstation(this.sql, workstationId);
  }

  async connectHELLDESK(input: {
    connectionId: string;
    helldeskId: string;
    upstream: string;
    workstationHandle: string;
    dolthubOrg: string;
  }): Promise<helldesk.HelldeskConnectionRecord> {
    return helldesk.connectHELLDESK(this.sql, input);
  }

  async disconnectHELLDESK(helldeskId: string): Promise<void> {
    helldesk.disconnectHELLDESK(this.sql, helldeskId);
  }

  async getHelldeskConnection(): Promise<helldesk.HelldeskConnectionRecord | null> {
    return helldesk.getHelldeskConnection(this.sql);
  }

  async configureWorkstation(workstationConfig: WorkstationConfig): Promise<void> {
    return withLogTags({ source: 'Department.do', tags: { departmentId: this.departmentId } }, () =>
      this._configureworkstation(workstationConfig)
    );
  }

  private async _configureWorkstation(workstationConfig: WorkstationConfig): Promise<void> {
    logger.setTags({ workstationId: workstationConfig.workstationId, userId: workstationConfig.userId });
    logger.info('configureWorkstation: start', { hasKilocodeToken: !!workstationConfig.kilocodeToken });
    await this.ctx.storage.put(`workstation:${workstationConfig.workstationId}:config`, workstationConfig);

    if (workstationConfig.kilocodeToken) {
      const departmentConfig = await this.getDepartmentConfig();
      if (!departmentConfig.kilocode_token || departmentConfig.kilocode_token !== workstationConfig.kilocodeToken) {
        logger.info('configureWorkstation: propagating kilocodeToken to department config');
        await this.updateDepartmentConfig({
          kilocode_token: workstationConfig.kilocodeToken,
        });
      }
    }

    const token = workstationConfig.kilocodeToken ?? (await this.resolveKilocodeToken());
    if (token) {
      try {
        const container = getDepartmentContainerStub(this.env, this.departmentId);
        await container.setEnvVar('KILOCODE_TOKEN', token);
        logger.info('configureWorkstation: stored KILOCODE_TOKEN on DepartmentContainerDO');
      } catch (err) {
        logger.warn('configureWorkstation: failed to store token on container DO', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('configureWorkstation: proactively starting container');
    await this.armAlarmIfNeeded();
    try {
      const container = getDepartmentContainerStub(this.env, this.departmentId);
      await container.fetch('http://container/health');
    } catch {
      // Container may take a moment to start — the alarm will retry
    }

    // Proactively clone the workstation's repo and create a browse worktree so
    // the frontDesk has immediate access to the codebase without waiting for
    // the first agent dispatch.
    this.setupWorkstationRepoInContainer(workstationConfig).catch(err =>
      logger.warn('configureWorkstation: background repo setup failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

  /**
   * Tell the container to clone a workstation's repo and create a browse worktree.
   * Fire-and-forget — failures are logged but don't block the caller.
   */
  private async setupWorkstationRepoInContainer(workstationConfig: WorkstationConfig): Promise<void> {
    logger.setTags({ workstationId: workstationConfig.workstationId });
    const departmentConfig = await this.getDepartmentConfig();
    const envVars: Record<string, string> = {};
    // Resolve GitHub token through scm.resolveGitHubTokenString so the workstation
    // setup uses a fresh installation token when a platform integration
    // is configured. The workstation's own integration ID takes precedence over
    // the department-level one (this workstation may be wired to a different repo
    // installation than the rest of the department).
    const githubToken = await scm.resolveGitHubTokenString({
      env: this.env,
      departmentId: this.departmentId,
      getDepartmentConfig: () => Promise.resolve(departmentConfig),
      platformIntegrationId: workstationConfig.platformIntegrationId,
    });
    if (githubToken) {
      envVars.GIT_TOKEN = githubToken;
    }
    if (departmentConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = departmentConfig.git_auth.gitlab_token;
    }
    if (departmentConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = departmentConfig.git_auth.gitlab_instance_url;
    }
    // resolveGitCredentials in the container needs KILOCODE_TOKEN to
    // authenticate against the credential API for platform integrations.
    const kilocodeToken = workstationConfig.kilocodeToken ?? departmentConfig.kilocode_token;
    if (kilocodeToken) {
      envVars.KILOCODE_TOKEN = kilocodeToken;
    }

    const containerConfig = await config.buildContainerConfig(
      this.ctx.storage,
      this.env,
      this.departmentId
    );
    const container = getDepartmentContainerStub(this.env, this.departmentId);
    const response = await container.fetch('http://container/repos/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-department-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        workstationId: workstationConfig.workstationId,
        gitUrl: workstationConfig.gitUrl,
        defaultBranch: workstationConfig.defaultBranch,
        envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
        platformIntegrationId: workstationConfig.platformIntegrationId,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      logger.warn('setupWorkstationRepoInContainer: failed', {
        status: response.status,
        body: text.slice(0, 200),
      });
    } else {
      logger.info('setupWorkstationRepoInContainer: accepted');
    }
  }

  async getWorkstationConfig(workstationId: string): Promise<WorkstationConfig | null> {
    return (await this.ctx.storage.get<WorkstationConfig>(`workstation:${workstationId}:config`)) ?? null;
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const ticket = ticketOps.createTicket(this.sql, input);
    this.emitEvent({
      event: 'ticket.created',
      departmentId: this.departmentId,
      workstationId: input.workstation_id,
      ticketId: ticket.ticket_id,
      ticketType: input.type,
    });
    this.broadcastTicketEvent({
      type: 'ticket.created',
      ticketId: ticket.ticket_id,
      title: ticket.title,
      status: ticket.status,
      workstationId: ticket.workstation_id ?? undefined,
    });
    return ticket;
  }

  async getTicketAsync(ticketId: string): Promise<Ticket | null> {
    return ticketOps.getTicket(this.sql, ticketId);
  }

  async listTickets(filter: TicketFilter): Promise<Ticket[]> {
    return ticketOps.listTickets(this.sql, filter);
  }

  async updateTicketStatus(
    ticketId: string,
    status: string,
    agentId: string,
    failureReason?: FailureReason
  ): Promise<Ticket> {
    // Record terminal transitions as ticket_cancelled events for the reconciler.
    // Non-terminal transitions are normal lifecycle changes, not cancellations.
    if (status === 'closed' || status === 'failed') {
      events.insertEvent(this.sql, 'ticket_cancelled', {
        ticket_id: ticketId,
        payload: { cancel_status: status },
      });
    }

    // Shift progress is updated automatically inside ticketOps.updateTicketStatus
    // when the ticket reaches a terminal status (closed/failed).
    const ticket = ticketOps.updateTicketStatus(this.sql, ticketId, status, agentId, failureReason);

    if (status === 'closed') {
      const durationMs = Date.now() - new Date(ticket.created_at).getTime();
      this.emitEvent({
        event: 'ticket.closed',
        departmentId: this.departmentId,
        workstationId: ticket.workstation_id ?? undefined,
        ticketId,
        ticketType: ticket.type,
        durationMs,
      });
      this.broadcastTicketEvent({
        type: 'ticket.closed',
        ticketId,
        title: ticket.title,
        status: 'closed',
        workstationId: ticket.workstation_id ?? undefined,
      });
      this.dispatchUnblockedTickets(ticketId);
    } else if (status === 'failed') {
      this.emitEvent({
        event: 'ticket.failed',
        departmentId: this.departmentId,
        workstationId: ticket.workstation_id ?? undefined,
        ticketId,
        ticketType: ticket.type,
      });
      this.broadcastTicketEvent({
        type: 'ticket.failed',
        ticketId,
        title: ticket.title,
        status: 'failed',
        workstationId: ticket.workstation_id ?? undefined,
      });
      this.dispatchUnblockedTickets(ticketId);
    } else {
      this.emitEvent({
        event: 'ticket.status_changed',
        departmentId: this.departmentId,
        workstationId: ticket.workstation_id ?? undefined,
        ticketId,
        ticketType: ticket.type,
        label: status,
      });
      this.broadcastTicketEvent({
        type: 'ticket.status_changed',
        ticketId,
        title: ticket.title,
        status,
        workstationId: ticket.workstation_id ?? undefined,
      });
    }

    return ticket;
  }

  async closeTicket(ticketId: string, agentId: string): Promise<Ticket> {
    return this.updateTicketStatus(ticketId, 'closed', agentId);
  }

  async deleteTicket(ticketId: string, workstationId?: string): Promise<boolean> {
    return ticketOps.deleteTicket(this.sql, ticketId, workstationId);
  }

  async deleteTickets(ticketIds: string[], workstationId?: string): Promise<number> {
    return ticketOps.deleteTickets(this.sql, ticketIds, workstationId);
  }

  async deleteTicketsByStatus(
    status: TicketStatus,
    type?: TicketTypeType,
    workstationId?: string
  ): Promise<number> {
    if (workstationId) {
      const workstationTickets = TicketRecord.pick({ ticket_id: true })
        .array()
        .parse([
          ...this.sql.exec(
            /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.workstation_id} = ? AND ${tickets.status} = ?${type ? ` AND ${tickets.type} = ?` : ''}`,
            ...(type ? [workstationId, status, type] : [workstationId, status])
          ),
        ]);
      if (workstationTickets.length === 0) return 0;
      return ticketOps.deleteTickets(
        this.sql,
        workstationTickets.map(r => r.ticket_id)
      );
    }
    return ticketOps.deleteTicketsByStatus(this.sql, status, type);
  }

  async listTicketEvents(options: {
    ticketId?: string;
    since?: string;
    limit?: number;
  }): Promise<TicketEventRecord[]> {
    return ticketOps.listTicketEvents(this.sql, options);
  }

  /**
   * Partially update a ticket's editable fields.
   * Only fields explicitly provided are updated (partial update semantics).
   * Writes a `fields_updated` ticket_event for auditability.
   */
  async updateTicket(
    ticketId: string,
    fields: Partial<{
      title: string;
      body: string | null;
      priority: TicketPriorityType;
      labels: string[];
      status: TicketStatus;
      metadata: Record<string, unknown>;
      depends_on: string[];
    }>,
    actorId: string
  ): Promise<Ticket> {
    // Record terminal transitions as ticket_cancelled events for the reconciler,
    // matching the behaviour of updateTicketStatus (the dedicated status method).
    if (fields.status === 'closed' || fields.status === 'failed') {
      events.insertEvent(this.sql, 'ticket_cancelled', {
        ticket_id: ticketId,
        payload: { cancel_status: fields.status },
      });
    }

    const { depends_on, ...ticketFields } = fields;
    const ticket = ticketOps.updateTicketFields(this.sql, ticketId, ticketFields, actorId);

    if (depends_on !== undefined) {
      ticketOps.setDependencies(this.sql, ticketId, depends_on);
    }

    if (fields.status === 'closed' || fields.status === 'failed') {
      this.dispatchUnblockedTickets(ticketId);
    }

    return ticket;
  }

  /** Add an existing ticket to a shift's tracking. Returns updated shift metadata. */
  async shiftAddTicket(
    shiftId: string,
    ticketId: string,
    dependsOn?: string[]
  ): Promise<{ total_tickets: number }> {
    const shiftCheck = [
      ...query(
        this.sql,
        /* sql */ `SELECT 1 FROM ${shift_metadata} WHERE ${shift_metadata.ticket_id} = ?`,
        [shiftId]
      ),
    ];
    if (shiftCheck.length === 0) throw new Error(`Ticket ${shiftId} is not a shift`);
    ticketOps.shiftAddTicket(this.sql, shiftId, ticketId);
    if (dependsOn !== undefined) {
      ticketOps.setDependencies(this.sql, ticketId, dependsOn);
    }
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${shift_metadata.total_tickets}
          FROM ${shift_metadata}
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [shiftId]
      ),
    ];
    const parsed = z.object({ total_tickets: z.number() }).array().parse(rows);
    const total = parsed[0]?.total_tickets ?? 0;
    return { total_tickets: total };
  }

  /** Remove a ticket from a shift's tracking. Returns updated shift metadata. */
  async shiftRemoveTicket(shiftId: string, ticketId: string): Promise<{ total_tickets: number }> {
    const shiftCheck = [
      ...query(
        this.sql,
        /* sql */ `SELECT 1 FROM ${shift_metadata} WHERE ${shift_metadata.ticket_id} = ?`,
        [shiftId]
      ),
    ];
    if (shiftCheck.length === 0) throw new Error(`Ticket ${shiftId} is not a shift`);
    ticketOps.shiftRemoveTicket(this.sql, shiftId, ticketId);
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${shift_metadata.total_tickets}
          FROM ${shift_metadata}
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [shiftId]
      ),
    ];
    const parsed = z.object({ total_tickets: z.number() }).array().parse(rows);
    const total = parsed[0]?.total_tickets ?? 0;
    return { total_tickets: total };
  }

  /**
   * Force-reset an agent to idle, unhooking from its current ticket if any.
   * Sets the ticket status back to 'open' so it can be re-dispatched.
   * Writes a ticket_event for auditability.
   */
  async resetAgent(agentId: string): Promise<void> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const hookedTicketId = agent.current_hook_ticket_id;

    if (hookedTicketId) {
      // Return the ticket to 'open' so the scheduler can re-assign it.
      // Also reset ticket dispatch_attempts so the reconciler doesn't
      // skip it due to accumulated cooldown from prior failed dispatches.
      const ticket = ticketOps.getTicket(this.sql, hookedTicketId);
      if (ticket && ticket.status !== 'closed' && ticket.status !== 'failed') {
        ticketOps.updateTicketStatus(this.sql, hookedTicketId, 'open', agentId);
        query(
          this.sql,
          /* sql */ `
            UPDATE ${tickets}
            SET ${tickets.columns.dispatch_attempts} = 0,
                ${tickets.columns.last_dispatch_attempt_at} = NULL
            WHERE ${tickets.ticket_id} = ?
          `,
          [hookedTicketId]
        );
      }

      ticketOps.logTicketEvent(this.sql, {
        ticketId: hookedTicketId,
        agentId,
        eventType: 'unhooked',
        newValue: 'open',
        metadata: { reason: 'agent_reset', actor: 'frontDesk' },
      });

      agents.unhookTicket(this.sql, agentId);
    }

    agents.updateAgentStatus(this.sql, agentId, 'idle');

    // Reset dispatch_attempts so the reconciler will dispatch this agent
    // immediately on the next tick instead of waiting for cooldown/backoff.
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.dispatch_attempts} = 0
        WHERE ${agent_metadata.ticket_id} = ?
      `,
      [agentId]
    );

    console.log(
      `${DEPARTMENT_LOG} resetAgent: reset agent=${agentId} hookedTicket=${hookedTicketId ?? 'none'}`
    );
  }

  /**
   * Reset an agent's dispatch_attempts counter to 0 without unhooking.
   * Also resets the hooked ticket's dispatch_attempts/last_dispatch_attempt_at so
   * the reconciler doesn't skip the ticket due to accumulated cooldown state.
   * Verifies the agent belongs to workstationId to prevent cross-workstation mutations.
   */
  async resetAgentDispatchAttempts(agentId: string, workstationId: string): Promise<void> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.workstation_id !== workstationId) throw new Error(`Agent ${agentId} does not belong to workstation ${workstationId}`);

    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.dispatch_attempts} = 0
        WHERE ${agent_metadata.ticket_id} = ?
      `,
      [agentId]
    );

    // Also clear the hooked ticket's dispatch state so the reconciler won't skip
    // it due to accumulated cooldown or max-attempt circuit breaker.
    const hookedTicketId = agent.current_hook_ticket_id;
    if (hookedTicketId) {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.dispatch_attempts} = 0,
              ${tickets.columns.last_dispatch_attempt_at} = NULL
          WHERE ${tickets.ticket_id} = ?
        `,
        [hookedTicketId]
      );
    }

    console.log(
      `${DEPARTMENT_LOG} resetAgentDispatchAttempts: reset agent=${agentId} hookedTicket=${hookedTicketId ?? 'none'}`
    );
  }

  /**
   * Edit shift_metadata fields (merge_mode, feature_branch).
   * Returns the updated shift, or null if not found.
   */
  async updateShift(
    shiftId: string,
    fields: Partial<{ merge_mode: ShiftMergeMode; feature_branch: string }>
  ): Promise<ShiftEntry | null> {
    const shift = this.getShift(shiftId);
    if (!shift) return null;

    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (fields.merge_mode !== undefined) {
      setClauses.push(`${shift_metadata.columns.merge_mode} = ?`);
      values.push(fields.merge_mode);
    }
    if (fields.feature_branch !== undefined) {
      setClauses.push(`${shift_metadata.columns.feature_branch} = ?`);
      values.push(fields.feature_branch);
    }

    if (setClauses.length > 0) {
      values.push(shiftId);
      // Dynamic SET clause — query() can't statically verify param count here,
      // so use sql.exec() directly. The guard above guarantees values is non-empty.
      this.sql.exec(
        /* sql */ `UPDATE ${shift_metadata} SET ${setClauses.join(', ')} WHERE ${shift_metadata.ticket_id} = ?`,
        ...values
      );

      // Also update the shift ticket's updated_at
      query(
        this.sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [now(), shiftId]
      );
    }

    return this.getShift(shiftId);
  }

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    return agents.registerAgent(this.sql, input);
  }

  async getAgentAsync(agentId: string): Promise<Agent | null> {
    return agents.getAgent(this.sql, agentId);
  }

  async getAgentByIdentity(identity: string): Promise<Agent | null> {
    return agents.getAgentByIdentity(this.sql, identity);
  }

  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    return agents.listAgents(this.sql, filter);
  }

  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    agents.updateAgentStatus(this.sql, agentId, status);
  }

  async deleteAgent(agentId: string): Promise<void> {
    agents.deleteAgent(this.sql, agentId);
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      await agentDO.destroy();
    } catch {
      // Best-effort
    }
  }

  async hookTicket(agentId: string, ticketId: string): Promise<void> {
    agents.hookTicket(this.sql, agentId, ticketId);
    await this.armAlarmIfNeeded();
  }

  async unhookTicket(agentId: string): Promise<void> {
    agents.unhookTicket(this.sql, agentId);
  }

  async getHookedTicket(agentId: string): Promise<Ticket | null> {
    return agents.getHookedTicket(this.sql, agentId);
  }

  async getOrCreateAgent(role: AgentRole, workstationId: string): Promise<Agent> {
    return agents.getOrCreateAgent(this.sql, role, workstationId, this.departmentId);
  }

  async appendAgentEvent(agentId: string, eventType: string, data: unknown): Promise<number> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.appendEvent(eventType, data);
  }

  async getAgentEvents(agentId: string, afterId?: number, limit?: number): Promise<unknown[]> {
    const agentDO = getAgentDOStub(this.env, agentId);
    return agentDO.getEvents(afterId, limit);
  }

  /**
   * Reconstruct a conversation transcript from an agent's persisted
   * streaming events. Delegates to the AgentDO so the DepartmentDO doesn't
   * bear the cost of fetching and reducing thousands of events.
   */
  async reconstructConversation(agentId: string): Promise<string> {
    try {
      const agentDO = getAgentDOStub(this.env, agentId);
      return await agentDO.reconstructConversation();
    } catch (err) {
      console.error(
        `${DEPARTMENT_LOG} reconstructConversation: failed for agent=${agentId}:`,
        err instanceof Error ? err.message : err
      );
      return '';
    }
  }

  async prime(agentId: string): Promise<PrimeContext> {
    return agents.prime(this.sql, agentId);
  }

  async writeCheckpoint(agentId: string, data: unknown): Promise<void> {
    agents.writeCheckpoint(this.sql, agentId, data);
  }

  async readCheckpoint(agentId: string): Promise<unknown> {
    return agents.readCheckpoint(this.sql, agentId);
  }

  /**
   * Append eviction context to a ticket's body so the next agent dispatched
   * to it knows there is WIP code on a branch. Called by the container's
   * Phase 4 force-save after pushing the WIP commit.
   */
  async writeTicketEvictionContext(
    agentId: string,
    context: { branch: string; agent_name: string; saved_at: string }
  ): Promise<void> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent?.current_hook_ticket_id) return;
    const ticket = ticketOps.getTicket(this.sql, agent.current_hook_ticket_id);
    if (!ticket) return;
    const evictionNote =
      `\n\n---\n**Container eviction note:** ${context.agent_name} pushed WIP progress ` +
      `to branch \`${context.branch}\` before container eviction at ${context.saved_at}. ` +
      `Pick up from where they left off — pull the branch and continue the work.`;
    const updatedBody = (ticket.body ?? '') + evictionNote;
    ticketOps.updateTicketFields(this.sql, ticket.ticket_id, { body: updatedBody }, 'system');
  }

  /**
   * Update an agent's heartbeat timestamp. Returns the current drain
   * nonce (if draining) so the caller can include it in the HTTP
   * response without a second RPC — preventing a TOCTOU race where
   * an in-flight heartbeat from the old container could observe a
   * nonce generated between two separate DO calls.
   */
  async touchAgentHeartbeat(
    agentId: string,
    watermark?: {
      lastEventType?: string | null;
      lastEventAt?: string | null;
      activeTools?: string[];
      containerInstanceId?: string;
    }
  ): Promise<{ drainNonce: string | null }> {
    agents.touchAgent(this.sql, agentId, watermark);
    await this.armAlarmIfNeeded();

    // Detect container restarts via instance ID change. The instance ID
    // is persisted so it survives DO restarts (unlike in-memory only).
    if (watermark?.containerInstanceId) {
      // Hydrate from storage on first access after DO restart
      if (this._containerInstanceId === null) {
        this._containerInstanceId =
          (await this.ctx.storage.get<string>('department:containerInstanceId')) ?? null;
      }

      if (
        this._draining &&
        this._containerInstanceId &&
        watermark.containerInstanceId !== this._containerInstanceId
      ) {
        // New container started — clear drain flag. This supplements the
        // nonce handshake (acknowledgeContainerReady) as a faster path:
        // the heartbeat fires every 30s vs the nonce which requires the
        // container to explicitly call /container-ready.
        this._draining = false;
        this._drainNonce = null;
        this._drainStartedAt = null;
        await this.ctx.storage.put('department:draining', false);
        await this.ctx.storage.delete('department:drainNonce');
        await this.ctx.storage.delete('department:drainStartedAt');
        console.log(
          `${DEPARTMENT_LOG} heartbeat: new container instance ${watermark.containerInstanceId} (was ${this._containerInstanceId}), clearing drain flag`
        );
      }

      if (watermark.containerInstanceId !== this._containerInstanceId) {
        this._containerInstanceId = watermark.containerInstanceId;
        await this.ctx.storage.put('department:containerInstanceId', watermark.containerInstanceId);
      }
    }

    return { drainNonce: this._drainNonce };
  }

  async updateAgentStatusMessage(agentId: string, message: string): Promise<void> {
    agents.updateAgentStatusMessage(this.sql, agentId, message);
    const agent = agents.getAgent(this.sql, agentId);
    if (agent?.current_hook_ticket_id) {
      const workstation = agent.workstation_id ? workstations.getWorkstation(this.sql, agent.workstation_id) : null;
      ticketOps.logTicketEvent(this.sql, {
        ticketId: agent.current_hook_ticket_id,
        agentId,
        eventType: 'agent_status',
        newValue: message,
        metadata: {
          agentId,
          message,
          agent_name: agent.name,
          workstation_id: agent.workstation_id,
          workstation_name: workstation?.name,
        },
      });
    }
    this.broadcastAgentStatus(agentId, message);
  }

  /** Test-only: directly set dispatch_attempts (and optionally last_activity_at) for an agent. */
  async setAgentDispatchAttempts(
    agentId: string,
    attempts: number,
    lastActivityAt?: string
  ): Promise<void> {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.dispatch_attempts} = ?,
            ${agent_metadata.columns.last_activity_at} = COALESCE(?, ${agent_metadata.columns.last_activity_at})
        WHERE ${agent_metadata.ticket_id} = ?
      `,
      [attempts, lastActivityAt ?? null, agentId]
    );
  }

  async sendMemo(input: SendMemoInput): Promise<void> {
    memo.sendMemo(this.sql, input);
  }

  async checkMemo(agentId: string): Promise<Memo[]> {
    return memo.checkMemo(this.sql, agentId);
  }

  /**
   * Queue a nudge for an agent. If mode is 'immediate', attempts to push
   * the message directly via the container and marks it delivered on success.
   * Returns the nudge_id.
   */
  async queueNudge(
    agentId: string,
    message: string,
    options?: {
      mode?: 'wait-idle' | 'immediate' | 'queue';
      priority?: 'normal' | 'urgent';
      source?: string;
      ttlSeconds?: number;
    }
  ): Promise<string> {
    const nudgeId = crypto.randomUUID();
    const mode = options?.mode ?? 'wait-idle';
    const priority = options?.priority ?? 'normal';
    const source = options?.source ?? 'system';

    let expiresAt: string | null = null;
    if (mode === 'queue' && options?.ttlSeconds != null) {
      // Use SQLite-compatible datetime format (space separator, no Z suffix) so
      // comparisons against datetime('now') work correctly.
      expiresAt = new Date(Date.now() + options.ttlSeconds * 1000)
        .toISOString()
        .replace('T', ' ')
        .replace('Z', '');
    }

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${agent_nudges} (
          ${agent_nudges.columns.nudge_id},
          ${agent_nudges.columns.agent_ticket_id},
          ${agent_nudges.columns.message},
          ${agent_nudges.columns.mode},
          ${agent_nudges.columns.priority},
          ${agent_nudges.columns.source},
          ${agent_nudges.columns.expires_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [nudgeId, agentId, message, mode, priority, source, expiresAt]
    );

    console.log(
      `${DEPARTMENT_LOG} queueNudge: nudge_id=${nudgeId} agent=${agentId} mode=${mode} priority=${priority} source=${source}`
    );

    if (mode === 'immediate') {
      const sent = await dispatch.sendMessageToAgent(this.env, this.departmentId, agentId, message);
      if (sent) {
        query(
          this.sql,
          /* sql */ `
            UPDATE ${agent_nudges}
            SET ${agent_nudges.columns.delivered_at} = datetime('now')
            WHERE ${agent_nudges.nudge_id} = ?
          `,
          [nudgeId]
        );
        console.log(`${DEPARTMENT_LOG} queueNudge: immediate nudge delivered to agent=${agentId}`);
      } else {
        console.warn(
          `${DEPARTMENT_LOG} queueNudge: immediate delivery failed for agent=${agentId}, nudge queued for retry`
        );
      }
    }

    return nudgeId;
  }

  /**
   * Return undelivered, non-expired nudges for an agent.
   * Urgent nudges are returned first, then FIFO within same priority.
   */
  async getPendingNudges(agentId: string): Promise<
    {
      nudge_id: string;
      message: string;
      mode: string;
      priority: string;
      source: string;
    }[]
  > {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT
            ${agent_nudges.nudge_id},
            ${agent_nudges.message},
            ${agent_nudges.mode},
            ${agent_nudges.priority},
            ${agent_nudges.source}
          FROM ${agent_nudges}
          WHERE ${agent_nudges.agent_ticket_id} = ?
            AND ${agent_nudges.delivered_at} IS NULL
            AND (${agent_nudges.expires_at} IS NULL OR ${agent_nudges.expires_at} > datetime('now'))
          ORDER BY
            CASE ${agent_nudges.priority} WHEN 'urgent' THEN 0 ELSE 1 END ASC,
            ${agent_nudges.created_at} ASC
        `,
        [agentId]
      ),
    ];

    return AgentNudgeRecord.pick({
      nudge_id: true,
      message: true,
      mode: true,
      priority: true,
      source: true,
    })
      .array()
      .parse(rows);
  }

  /** Mark a nudge as delivered. */
  async markNudgeDelivered(nudgeId: string): Promise<void> {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${agent_nudges}
        SET ${agent_nudges.columns.delivered_at} = datetime('now')
        WHERE ${agent_nudges.nudge_id} = ?
      `,
      [nudgeId]
    );
  }

  /**
   * Expire nudges whose expires_at has passed.
   * Called from the alarm loop. Returns the count of nudges expired.
   */
  async expireStaleNudges(): Promise<number> {
    const result = [
      ...query(
        this.sql,
        /* sql */ `
          UPDATE ${agent_nudges}
          SET ${agent_nudges.columns.delivered_at} = datetime('now')
          WHERE ${agent_nudges.expires_at} IS NOT NULL
            AND ${agent_nudges.expires_at} < datetime('now')
            AND ${agent_nudges.delivered_at} IS NULL
          RETURNING ${agent_nudges.nudge_id}
        `,
        []
      ),
    ];

    return result.length;
  }

  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> {
    reviewQueue.submitToReviewQueue(this.sql, input);
    this.emitEvent({
      event: 'review.submitted',
      departmentId: this.departmentId,
      workstationId: input.workstation_id,
      ticketId: input.ticket_id,
    });
    await this.escalateToActiveCadence();
  }

  async completeReviewWithResult(input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }): Promise<void> {
    // Resolve the source ticket ID before completing the review, so we can
    // trigger dispatchUnblockedTickets for it after the MR closes.
    const mrTicket = ticketOps.getTicket(this.sql, input.entry_id);
    const sourceTicketId =
      typeof mrTicket?.metadata?.source_ticket_id === 'string' ? mrTicket.metadata.source_ticket_id : null;

    reviewQueue.completeReviewWithResult(this.sql, input);

    if (input.status === 'merged') {
      this.emitEvent({
        event: 'review.completed',
        departmentId: this.departmentId,
        ticketId: input.entry_id,
      });
      // When a review is merged, the source ticket's pending MR is now resolved.
      // Downstream tickets that were blocked (because hasUnresolvedBlockers saw
      // the open MR) should now be dispatched.
      if (sourceTicketId) {
        this.dispatchUnblockedTickets(sourceTicketId);
      }
    } else if (input.status === 'failed' || input.status === 'conflict') {
      this.emitEvent({
        event: 'review.failed',
        departmentId: this.departmentId,
        ticketId: input.entry_id,
      });
    }

    // Rework is handled by the reconciler's scheduling path: the failed/conflict
    // path in completeReviewWithResult sets the source ticket to 'open' with
    // assignee cleared. The reconciler will hook a soul and dispatch it.
  }

  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> {
    // Event-only: record the fact. The alarm's Phase 0 drains and
    // applies all pending events before reconciliation runs. DO RPCs
    // are serialized, so agentCompleted can't race with this — it
    // waits for agentDone to finish before executing.
    events.insertEvent(this.sql, 'agent_done', {
      agent_id: agentId,
      payload: {
        branch: input.branch,
        ...(input.pr_url ? { pr_url: input.pr_url } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
      },
    });
    await this.armAlarmIfNeeded();
  }

  /**
   * Transition the frontDesk from "working" to "waiting". Called by the
   * container when the frontDesk's session goes idle (turn done, waiting for
   * user input). The "waiting" status means the frontDesk is alive in the
   * container but not doing LLM work — hasActiveWork() returns false,
   * so the alarm drops to the idle cadence and health-check pings stop
   * resetting the container's sleepAfter timer.
   *
   * @param firedAt - Timestamp (ms) when the container fired this
   *   callback. Used to reject stale session.idle callbacks from a
   *   previous turn that arrive after the frontDesk has already been
   *   re-activated by a new prompt.
   */
  async frontDeskWaiting(agentId?: string, firedAt?: number): Promise<void> {
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0];
      if (frontDesk) resolvedAgentId = frontDesk.id;
    }
    if (!resolvedAgentId) return;

    const agent = agents.getAgent(this.sql, resolvedAgentId);
    if (!agent || agent.role !== 'frontDesk') return;

    // Only transition from working → waiting. If the agent has already
    // been set to idle/stalled/dead by another path, don't overwrite.
    // Guard against stale session.idle callbacks: reportFrontDeskWaiting is
    // fire-and-forget, so a callback from a previous turn can arrive
    // after sendFrontDeskMessage has already re-activated the frontDesk. If the
    // callback carries a firedAt timestamp that predates the last
    // working transition, it belongs to an older turn — reject it.
    if (agent.status === 'working') {
      if (firedAt && firedAt < this._front_deskWorkingSince) return;
      agents.updateAgentStatus(this.sql, resolvedAgentId, 'waiting');
    }
  }

  async agentCompleted(
    agentId: string,
    input: { status: 'completed' | 'failed'; reason?: string }
  ): Promise<void> {
    // Resolve empty agentId to frontDesk (backwards compat with container callback)
    let resolvedAgentId = agentId;
    if (!resolvedAgentId) {
      const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0];
      if (frontDesk) resolvedAgentId = frontDesk.id;
    }

    // Event-only: record the fact. The alarm's Phase 0 drains and
    // applies all pending events. DO RPCs are serialized so there's
    // no race with agentDone.
    events.insertEvent(this.sql, 'agent_completed', {
      agent_id: resolvedAgentId || agentId,
      payload: {
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });

    // Emit analytics event (not part of reconciler — UI/observability concern)
    if (resolvedAgentId) {
      const agent = agents.getAgent(this.sql, resolvedAgentId);
      this.emitEvent({
        event: 'agent.exited',
        departmentId: this.departmentId,
        agentId: resolvedAgentId,
        role: agent?.role,
      });
    }
    await this.armAlarmIfNeeded();
    // Rework dispatch is handled by the reconciler's reconcileTickets Rule 1:
    // open tickets with no assignee get agents on the next alarm tick.
  }

  /**
   * QualityAssurance requests changes on an in-progress MR ticket. Creates a rework
   * ticket that blocks the MR ticket. The qualityAssurance should call gt_done after
   * this to release its session. The reconciler assigns a soul to the
   * rework ticket; when it closes, the MR unblocks and the qualityAssurance re-reviews.
   */
  async requestChanges(
    agentId: string,
    input: { feedback: string; files?: string[] }
  ): Promise<{ rework_ticket_id: string }> {
    const agent = agents.getAgent(this.sql, agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (agent.role !== 'qualityAssurance') throw new Error(`Only refineries can request changes`);
    if (!agent.current_hook_ticket_id) throw new Error(`Agent ${agentId} is not hooked to a ticket`);

    const mrTicket = ticketOps.getTicket(this.sql, agent.current_hook_ticket_id);
    if (!mrTicket || mrTicket.type !== 'merge_request') {
      throw new Error(`Agent ${agentId} is not hooked to a merge_request ticket`);
    }

    // Find the source ticket (the original issue the soul worked on)
    const sourceTicketId =
      typeof mrTicket.metadata?.source_ticket_id === 'string' ? mrTicket.metadata.source_ticket_id : null;
    const sourceTicket = sourceTicketId ? ticketOps.getTicket(this.sql, sourceTicketId) : null;

    // Get branch info from review_metadata
    const reviewMeta = reviewQueue.getReviewMetadata(this.sql, mrTicket.ticket_id);

    const reworkTicket = ticketOps.createTicket(this.sql, {
      type: 'issue',
      title: `Rework: ${sourceTicket?.title ?? mrTicket.title}`,
      body: input.feedback,
      priority: sourceTicket?.priority ?? 'medium',
      workstation_id: mrTicket.workstation_id ?? undefined,
      parent_ticket_id: mrTicket.ticket_id,
      labels: ['gt:rework'],
      metadata: {
        rework_for: sourceTicketId,
        mr_ticket_id: mrTicket.ticket_id,
        branch: reviewMeta?.branch ?? null,
        target_branch: reviewMeta?.target_branch ?? null,
        files: input.files ?? [],
      },
    });

    // Rework ticket blocks the MR ticket — MR can't proceed until rework is done
    ticketOps.insertDependency(this.sql, mrTicket.ticket_id, reworkTicket.ticket_id, 'blocks');

    // Record event so the reconciler picks up the rework ticket
    events.insertEvent(this.sql, 'ticket_created', {
      ticket_id: reworkTicket.ticket_id,
      payload: { ticket_type: 'issue', workstation_id: mrTicket.workstation_id },
    });

    ticketOps.logTicketEvent(this.sql, {
      ticketId: mrTicket.ticket_id,
      agentId,
      eventType: 'rework_requested',
      newValue: reworkTicket.ticket_id,
      metadata: { feedback: input.feedback.slice(0, 500), files: input.files },
    });

    console.log(
      `${DEPARTMENT_LOG} requestChanges: qualityAssurance=${agentId} mr=${mrTicket.ticket_id} rework=${reworkTicket.ticket_id}`
    );

    await this.escalateToActiveCadence();
    return { rework_ticket_id: reworkTicket.ticket_id };
  }

  /**
   * Resolve a triage_request ticket. Called by the triage agent via the
   * gt_triage_resolve tool. Applies the chosen action, closes the
   * triage request, and logs the resolution.
   */
  async resolveTriage(input: {
    agent_id: string;
    triage_request_ticket_id: string;
    action: string;
    resolution_notes: string;
  }): Promise<Ticket> {
    const triageTicket = ticketOps.getTicket(this.sql, input.triage_request_ticket_id);
    if (!triageTicket)
      throw new Error(`Triage request ticket ${input.triage_request_ticket_id} not found`);
    if (!triageTicket.labels.includes(attendance.TRIAGE_REQUEST_LABEL)) {
      throw new Error(`Ticket ${input.triage_request_ticket_id} is not a triage request`);
    }
    if (triageTicket.status !== 'open') {
      throw new Error(
        `Triage request ${input.triage_request_ticket_id} is already ${triageTicket.status} — cannot resolve again`
      );
    }

    const targetAgentId =
      typeof triageTicket.metadata?.agent_ticket_id === 'string'
        ? triageTicket.metadata.agent_ticket_id
        : null;
    // Use the hooked ticket ID captured when the triage request was created,
    // not the agent's current hook (which may have changed since then).
    const snapshotHookedTicketId =
      typeof triageTicket.metadata?.hooked_ticket_id === 'string'
        ? triageTicket.metadata.hooked_ticket_id
        : null;
    const action = input.action.toUpperCase();

    if (targetAgentId) {
      const targetAgent = agents.getAgent(this.sql, targetAgentId);

      switch (action) {
        case 'RESTART':
        case 'RESTART_WITH_BACKOFF': {
          if (targetAgent) {
            // Use the ticket captured in the triage snapshot (not the agent's
            // current hook, which may have changed since the triage request
            // was created). Fall back to current hook for backward compat.
            const restartTicketId = snapshotHookedTicketId ?? targetAgent.current_hook_ticket_id;

            // Only stop the agent if it's still working on the snapshot ticket.
            // If it has moved on, stopping it would abort unrelated work.
            const agentStillOnTicket =
              restartTicketId && targetAgent.current_hook_ticket_id === restartTicketId;
            if (
              agentStillOnTicket &&
              (targetAgent.status === 'working' || targetAgent.status === 'stalled')
            ) {
              dispatch.stopAgentInContainer(this.env, this.departmentId, targetAgentId).catch(() => {});
            }

            // Check if the hooked ticket has exhausted its dispatch cap.
            // If so, fail it immediately instead of letting the reconciler
            // re-dispatch indefinitely (#1653).
            if (restartTicketId) {
              const hookedTicket = ticketOps.getTicket(this.sql, restartTicketId);
              if (hookedTicket && hookedTicket.dispatch_attempts >= scheduling.MAX_DISPATCH_ATTEMPTS) {
                ticketOps.updateTicketStatus(this.sql, restartTicketId, 'failed', 'system', {
                  code: 'max_dispatch_attempts',
                  message: `Dispatch attempts exhausted (${hookedTicket.dispatch_attempts})`,
                  source: 'triage',
                });
                agents.unhookTicket(this.sql, targetAgentId);
                break;
              }
            }
            // Only reset agent state if it's still on the snapshot ticket.
            // If it moved on, let it continue its current work.
            if (agentStillOnTicket) {
              // RESTART clears last_activity_at so the scheduler picks it
              // up immediately. RESTART_WITH_BACKOFF sets it to now() so
              // the dispatch cooldown (DISPATCH_COOLDOWN_MS) delays the
              // next attempt, preventing immediate restart of crash loops.
              const activityAt = action === 'RESTART_WITH_BACKOFF' ? now() : null;
              query(
                this.sql,
                /* sql */ `
                  UPDATE ${agent_metadata}
                  SET ${agent_metadata.columns.status} = 'idle',
                      ${agent_metadata.columns.last_activity_at} = ?
                  WHERE ${agent_metadata.ticket_id} = ?
                `,
                [activityAt, targetAgentId]
              );
            }
            // Stamp the ticket's last_dispatch_attempt_at regardless — even
            // if the agent moved on, the backoff gate should still fire
            // on the snapshot ticket to prevent immediate redispatch.
            if (action === 'RESTART_WITH_BACKOFF' && restartTicketId) {
              query(
                this.sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.last_dispatch_attempt_at} = ?
                  WHERE ${tickets.ticket_id} = ?
                `,
                [now(), restartTicketId]
              );
            }
          }
          break;
        }
        case 'CLOSE_TICKET': {
          // Fail the ticket that was hooked when the triage request was
          // created (not the agent's current hook, which may differ).
          const ticketToClose = snapshotHookedTicketId ?? targetAgent?.current_hook_ticket_id;
          if (ticketToClose) {
            ticketOps.updateTicketStatus(this.sql, ticketToClose, 'failed', input.agent_id, {
              code: 'triage_close',
              message: input.resolution_notes || 'Closed via triage',
              source: 'triage',
            });
            // Only stop and unhook if the agent is still working on this
            // specific ticket. If the agent has moved on, stopping it would
            // abort unrelated work.
            if (targetAgent?.current_hook_ticket_id === ticketToClose) {
              if (targetAgent.status === 'working' || targetAgent.status === 'stalled') {
                dispatch.stopAgentInContainer(this.env, this.departmentId, targetAgentId).catch(() => {});
              }
              agents.unhookTicket(this.sql, targetAgentId);
            }
          }
          break;
        }
        case 'ESCALATE_TO_FRONT_DESK':
        case 'ESCALATE': {
          const message = input.resolution_notes || triageTicket.title || 'Triage escalation';
          this.sendFrontDeskMessage(
            `[Triage Escalation] ${message}\n\nAgent: ${targetAgentId ?? 'unknown'}\nTicket: ${snapshotHookedTicketId ?? 'unknown'}`
          ).catch(err =>
            console.warn(`${DEPARTMENT_LOG} resolveTriage: frontDesk notification failed:`, err)
          );
          break;
        }
        case 'NUDGE': {
          // Nudge the stuck agent — time-sensitive, deliver immediately
          if (targetAgent && targetAgentId) {
            this.queueNudge(
              targetAgentId,
              input.resolution_notes ||
                'The triage system has flagged you as potentially stuck. Please report your status.',
              { mode: 'immediate', source: 'triage', priority: 'urgent' }
            ).catch(err =>
              console.warn(
                `${DEPARTMENT_LOG} resolveTriage: nudge failed for agent=${targetAgentId}:`,
                err
              )
            );
            this.emitEvent({
              event: 'nudge.queued',
              departmentId: this.departmentId,
              agentId: targetAgentId,
              label: 'triage_nudge',
            });
          }
          break;
        }
        case 'REASSIGN_TICKET': {
          // Target the ticket from the triage snapshot, not the agent's current hook.
          const ticketToReassign = snapshotHookedTicketId ?? targetAgent?.current_hook_ticket_id;
          if (ticketToReassign) {
            // Only stop and unhook if the agent is still working on this
            // specific ticket. If the agent has moved on, stopping it would
            // abort unrelated work.
            if (targetAgent?.current_hook_ticket_id === ticketToReassign) {
              if (targetAgent.status === 'working' || targetAgent.status === 'stalled') {
                dispatch.stopAgentInContainer(this.env, this.departmentId, targetAgentId).catch(() => {});
              }
              agents.unhookTicket(this.sql, targetAgentId);
            }
            // Check the ticket's dispatch_attempts before resetting to open.
            // If the ticket exhausted its dispatch cap, fail it instead of
            // re-entering the infinite retry loop (#1653).
            const reassignTicket = ticketOps.getTicket(this.sql, ticketToReassign);
            if (
              reassignTicket &&
              reassignTicket.dispatch_attempts >= scheduling.MAX_DISPATCH_ATTEMPTS
            ) {
              ticketOps.updateTicketStatus(this.sql, ticketToReassign, 'failed', input.agent_id, {
                code: 'max_dispatch_attempts',
                message: `Dispatch attempts exhausted during reassign (${reassignTicket.dispatch_attempts})`,
                source: 'triage',
              });
            } else {
              query(
                this.sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.assignee_agent_ticket_id} = NULL,
                      ${tickets.columns.status} = 'open',
                      ${tickets.columns.updated_at} = ?
                  WHERE ${tickets.ticket_id} = ?
                    AND ${tickets.status} != 'closed'
                    AND ${tickets.status} != 'failed'
                `,
                [now(), ticketToReassign]
              );
            }
          }
          break;
        }
        // DISCARD, PROVIDE_GUIDANCE, and other informational actions
        // are handled by the triage agent itself via gt_memo_send
        // before calling gt_triage_resolve — no server-side effect needed.
        default:
          break;
      }
    }

    const timestamp = now();
    query(
      this.sql,
      /* sql */ `
        UPDATE ${tickets}
        SET ${tickets.columns.status} = 'closed',
            ${tickets.columns.closed_at} = ?,
            ${tickets.columns.updated_at} = ?,
            ${tickets.columns.metadata} = json_set(
              COALESCE(${tickets.metadata}, '{}'),
              '$.resolution_action', ?,
              '$.resolution_notes', ?,
              '$.resolved_by', ?
            )
        WHERE ${tickets.ticket_id} = ?
      `,
      [
        timestamp,
        timestamp,
        input.action,
        input.resolution_notes,
        input.agent_id,
        input.triage_request_ticket_id,
      ]
    );

    ticketOps.logTicketEvent(this.sql, {
      ticketId: input.triage_request_ticket_id,
      agentId: input.agent_id,
      eventType: 'status_changed',
      oldValue: triageTicket.status,
      newValue: 'closed',
      metadata: {
        action: input.action,
        resolution_notes: input.resolution_notes,
      },
    });

    // Log a triage_resolved event on the target ticket so the action shows
    // up in the activity feed for the ticket that was actually affected.
    const targetTicketId = snapshotHookedTicketId ?? targetAgentId;
    if (targetTicketId && targetTicketId !== input.triage_request_ticket_id) {
      ticketOps.logTicketEvent(this.sql, {
        ticketId: targetTicketId,
        agentId: input.agent_id,
        eventType: 'triage_resolved',
        newValue: action,
        metadata: {
          action,
          resolution_notes: input.resolution_notes,
          triage_request_ticket_id: input.triage_request_ticket_id,
          target_agent_id: targetAgentId,
        },
      });
    }

    // If this triage request was created for an escalation, close the
    // linked escalation ticket too so it doesn't sit open indefinitely.
    // The escalation_ticket_id is nested under metadata.context (set by
    // createTriageRequest's TriageRequestMetadata structure).
    const ctx =
      typeof triageTicket.metadata?.context === 'object' && triageTicket.metadata.context !== null
        ? (triageTicket.metadata.context as Record<string, unknown>)
        : null;
    const escalationTicketId =
      typeof ctx?.escalation_ticket_id === 'string' ? ctx.escalation_ticket_id : null;
    if (escalationTicketId) {
      ticketOps.updateTicketStatus(this.sql, escalationTicketId, 'closed', input.agent_id);
    }

    console.log(
      `${DEPARTMENT_LOG} resolveTriage: ticket=${input.triage_request_ticket_id} action=${input.action}`
    );

    const updated = ticketOps.getTicket(this.sql, input.triage_request_ticket_id);
    if (!updated) throw new Error('Triage ticket not found after update');
    return updated;
  }

  async createTicketCase(ticketId: string, formula: unknown): Promise<TicketCase> {
    return reviewQueue.createTicketCase(this.sql, ticketId, formula);
  }

  async getTicketCaseCurrentStep(
    agentId: string
  ): Promise<{ TicketCase: TicketCase; step: unknown } | null> {
    return reviewQueue.getTicketCaseCurrentStep(this.sql, agentId);
  }

  async advanceTicketCaseStep(agentId: string, summary: string): Promise<TicketCase | null> {
    return reviewQueue.advanceTicketCaseStep(this.sql, agentId, summary);
  }

  async getMergeQueueData(params: {
    workstationId?: string;
    limit?: number;
    since?: string;
  }): Promise<reviewQueue.MergeQueueData> {
    return reviewQueue.getMergeQueueData(this.sql, params);
  }

  async slingTicket(input: {
    workstationId: string;
    title: string;
    body?: string;
    priority?: string;
    metadata?: Record<string, unknown>;
    labels?: string[];
  }): Promise<{ ticket: Ticket; agent: Agent }> {
    const createdTicket = ticketOps.createTicket(this.sql, {
      type: 'issue',
      title: input.title,
      body: input.body,
      priority: TicketPriority.catch('medium').parse(input.priority ?? 'medium'),
      workstation_id: input.workstationId,
      metadata: input.metadata,
      labels: input.labels,
    });

    events.insertEvent(this.sql, 'ticket_created', {
      ticket_id: createdTicket.ticket_id,
      payload: { ticket_type: 'issue', workstation_id: input.workstationId, has_blockers: false },
    });

    // Fast path: assign agent immediately for UX ("Toast is on it!")
    // rather than waiting for the next alarm tick. Uses the same
    // getOrCreateAgent + hookTicket path the reconciler would use.
    const agent = agents.getOrCreateAgent(this.sql, 'soul', input.workstationId, this.departmentId);
    agents.hookTicket(this.sql, agent.id, createdTicket.ticket_id);

    const ticket = ticketOps.getTicket(this.sql, createdTicket.ticket_id) ?? createdTicket;
    const hookedAgent = agents.getAgent(this.sql, agent.id) ?? agent;

    // Fire-and-forget dispatch so the sling call returns immediately.
    // The alarm loop retries if this fails.
    this.dispatchAgent(hookedAgent, ticket).catch(err =>
      console.error(`${DEPARTMENT_LOG} slingTicket: fire-and-forget dispatchAgent failed:`, err)
    );
    await this.escalateToActiveCadence();
    return { ticket, agent: hookedAgent };
  }

  /**
   * Create an open ticket with the given labels, without arming the reconciler alarm.
   * The caller is responsible for including `gt:held` in the labels if the ticket
   * should not be dispatched immediately.
   *
   * `workstationId` is optional: callers like the helldesk integration that don't have
   * a confidently-resolved local workstation can omit it; the ticket will still be
   * persisted (the `workstation_id` column is nullable) and surfaces in admin views.
   */
  async createHeldTicket(input: {
    workstationId: string | null;
    title: string;
    body?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
    created_by?: string;
  }): Promise<Ticket> {
    const ticket = ticketOps.createTicket(this.sql, {
      type: 'issue',
      title: input.title,
      body: input.body,
      workstation_id: input.workstationId ?? undefined,
      labels: input.labels,
      metadata: input.metadata,
      created_by: input.created_by,
    });

    events.insertEvent(this.sql, 'ticket_created', {
      ticket_id: ticket.ticket_id,
      payload: { ticket_type: 'issue', workstation_id: input.workstationId, has_blockers: false },
    });

    return ticket;
  }

  /**
   * Notify the frontDesk about a newly created held ticket.
   * The frontDesk can then explore the codebase, plan, decompose into a shift, or start it.
   */
  async notifyFrontDeskOfNewTicket(
    ticketId: string,
    workstationId: string,
    title: string,
    body?: string
  ): Promise<void> {
    const message = [
      `A user just created a new ticket in workstation ${workstationId}:`,
      `ID: ${ticketId}`,
      `Title: "${title}"`,
      body ? `Description: ${body.slice(0, 500)}${body.length > 500 ? '...' : ''}` : '',
      ``,
      `The ticket is currently held (tagged gt:held) and will not be dispatched until started.`,
      `Would you like to explore the codebase and flesh out a detailed plan, decompose it into a staged shift, or start it immediately?`,
      `Your chat reply is already visible to the user — no extra tool call is needed to surface your response.`,
      `To start the ticket immediately, remove the gt:held label via gt_ticket_update.`,
    ]
      .filter(Boolean)
      .join('\n');
    await this.sendFrontDeskMessage(message);
  }

  /**
   * Remove the `gt:held` label from a ticket and arm the reconciler alarm so the
   * ticket is picked up on the next tick.
   *
   * @param workstationId - The workstation the caller has verified ownership of. The ticket must
   *   belong to this workstation to prevent cross-workstation label removal within the same department.
   */
  async startHeldTicket(ticketId: string, workstationId: string): Promise<Ticket> {
    const ticket = ticketOps.getTicket(this.sql, ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    if (ticket.workstation_id !== workstationId) {
      throw new Error(`Ticket ${ticketId} does not belong to workstation ${workstationId}`);
    }

    const updatedLabels = (ticket.labels ?? []).filter(l => l !== attendance.HELD_LABEL);
    const updated = ticketOps.updateTicketFields(this.sql, ticketId, { labels: updatedLabels }, 'system');
    await this.escalateToActiveCadence();
    return updated;
  }

  /** Build the workstation list for frontDesk agent startup (browse worktree setup on fresh containers). */
  private async workstationListForFrontDesk(): Promise<
    Array<{
      workstationId: string;
      gitUrl: string;
      defaultBranch: string;
      platformIntegrationId?: string;
    }>
  > {
    const workstationRecords = workstations.listWorkstations(this.sql);
    return Promise.all(
      workstationRecords.map(async r => {
        const rc = await this.getWorkstationConfig(r.id);
        return {
          workstationId: r.id,
          gitUrl: r.git_url,
          defaultBranch: r.default_branch,
          platformIntegrationId: rc?.platformIntegrationId,
        };
      })
    );
  }

  async sendFrontDeskMessage(
    message: string,
    _model?: string,
    uiContext?: string,
    actorUserId?: string
  ): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    return withLogTags({ source: 'Department.do', tags: { departmentId: this.departmentId } }, () =>
      this._sendfront_deskMessage(message, _model, uiContext, actorUserId)
    );
  }

  private async _sendFrontDeskMessage(
    message: string,
    _model?: string,
    uiContext?: string,
    actorUserId?: string
  ): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    const departmentId = this.departmentId;
    await this.prepareContainerBilling(actorUserId ? { type: 'user', id: actorUserId } : undefined);
    if (isContainerUsageMeteringEnabled(this.env)) {
      await getDepartmentContainerStub(this.env, departmentId).warmUp();
      this._billingBlocked = false;
      await this.ctx.storage.put('billing:blocked', false);
    }

    let frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    if (!frontDesk) {
      const identity = `front-desk-${departmentId.slice(0, 8)}`;
      frontDesk = agents.registerAgent(this.sql, {
        role: 'frontDesk',
        name: 'frontDesk',
        identity,
      });
    }

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, departmentId, frontDesk.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    logger.setTags({ agentId: frontDesk.id });
    logger.info('sendFrontDeskMessage', {
      containerStatus: containerStatus.status,
      isAlive,
    });

    const effectiveContext = uiContext ?? this._dashboardContext;
    const combinedMessage = effectiveContext
      ? `<system-reminder>\n${effectiveContext}\n</system-reminder>\n\n${message}`
      : message;

    let sessionStatus: 'idle' | 'active' | 'starting';

    if (isAlive) {
      // Refresh the container-scoped JWT before sending. The frontDesk makes GT
      // tool calls using HELLDESK_CONTAINER_TOKEN, and sendMessageToAgent does
      // not otherwise call ensureContainerToken. Without this, a frontDesk that
      // has been waiting longer than the 8h token expiry would 401 on its
      // first GT tool call for the new prompt.
      //
      // Best-effort: ensureContainerToken throws on non-2xx /refresh-token
      // responses. We don't want a transient refresh failure (404/500) to
      // drop the user's prompt — the stored envVar fallback and the next
      // alarm tick will recover. Log and proceed to sendMessageToAgent.
      try {
        const departmentConfig = await this.getDepartmentConfig();
        const userId = departmentConfig.owner_user_id ?? departmentId;
        await dispatch.ensureContainerToken(this.env, departmentId, userId);
      } catch (err) {
        logger.warn('sendFrontDeskMessage: ensureContainerToken failed, proceeding with send', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const sent = await dispatch.sendMessageToAgent(this.env, departmentId, frontDesk.id, combinedMessage);
      if (sent) {
        // Transition waiting → working so the alarm runs at the active cadence
        // while the frontDesk processes this prompt. Also reschedule the alarm
        // immediately — the idle alarm may be up to 5 min away, and we need
        // the reconciler/health-check loop to resume promptly.
        // Always refresh the watermark so a stale frontDeskWaiting callback
        // from a previous turn can't flip the frontDesk back to waiting
        // while a queued prompt is being processed.
        this._front_deskWorkingSince = Date.now();
        if (frontDesk.status === 'waiting') {
          agents.updateAgentStatus(this.sql, frontDesk.id, 'working');
          await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
        }
        sessionStatus = 'active';
      } else {
        sessionStatus = 'idle';
      }
    } else {
      const departmentConfig = await this.getDepartmentConfig();
      const workstationConfig = await this.getFrontDeskWorkstationConfig();
      const kilocodeToken = await this.resolveKilocodeToken();

      logger.info('sendFrontDeskMessage: starting container', {
        hasWorkstationConfig: !!workstationConfig,
        hasKilocodeToken: !!kilocodeToken,
        departmentConfigToken: !!departmentConfig.kilocode_token,
        workstationConfigToken: !!workstationConfig?.kilocodeToken,
        userId: departmentConfig.owner_user_id ?? workstationConfig?.userId,
        orgId: departmentConfig.organization_id,
      });

      if (kilocodeToken) {
        try {
          const containerStub = getDepartmentContainerStub(this.env, departmentId);
          await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
        } catch {
          // Best effort
        }
      }

      const { started: frontDeskStarted } = await dispatch.startAgentInContainer(
        this.env,
        this.ctx.storage,
        {
          departmentId,
          workstationId: `front-desk-${departmentId}`,
          userId: departmentConfig.owner_user_id ?? workstationConfig?.userId ?? departmentId,
          agentId: frontDesk.id,
          agentName: 'frontDesk',
          role: 'frontDesk',
          identity: frontDesk.identity,
          ticketId: '',
          ticketTitle: combinedMessage,
          ticketBody: '',
          checkpoint: agents.readCheckpoint(this.sql, frontDesk.id),
          gitUrl: workstationConfig?.gitUrl ?? '',
          defaultBranch: workstationConfig?.defaultBranch ?? 'main',
          kilocodeToken,
          departmentConfig,
          workstations: await this.workstationListForFrontDesk(),
        }
      );

      if (frontDeskStarted) {
        agents.updateAgentStatus(this.sql, frontDesk.id, 'working');
        this._front_deskWorkingSince = Date.now();
        sessionStatus = 'starting';
      } else {
        sessionStatus = 'idle';
      }
    }

    await this.armAlarmIfNeeded();
    return { agentId: frontDesk.id, sessionStatus };
  }

  /**
   * Ensure the frontDesk agent exists and its container is running.
   * Called eagerly on page load so the terminal is available immediately
   * without requiring the user to send a message first.
   */
  async getFrontDeskAgentId(): Promise<string | null> {
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    return frontDesk?.id ?? null;
  }

  /**
   * Returns everything the container needs to prewarm the frontDesk SDK
   * server with a config that matches what the next /agents/start will
   * use — so the prewarm cache hit is real instead of triggering the
   * "config mismatch, evicting prewarmed server" eviction path.
   *
   * Returns null only when there's no frontDesk at all. When the frontDesk
   * exists but the kilocode token isn't available, returns a partial
   * shape with just { agentId } so callers can derive the fallback
   * agentId without a second RPC hop.
   */
  async getFrontDeskPrewarmContext(): Promise<{
    agentId: string;
    model?: string;
    smallModel?: string;
    kilocodeToken?: string;
    organizationId?: string | null;
    githubToken?: string;
    githubCliPat?: string;
  } | null> {
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    if (!frontDesk) return null;

    const kilocodeToken = await this.resolveKilocodeToken();
    if (!kilocodeToken) {
      return { agentId: frontDesk.id };
    }

    const departmentConfig = await this.getDepartmentConfig();

    // Resolve the GitHub token using the same chain as startAgentInContainer
    // so the prewarmed frontDesk SDK boots with `gh` CLI auth (`GH_TOKEN`)
    // already populated. Without this, the frontDesk's bash tool sees an
    // empty environment for git/gh until the SDK is torn down and the
    // /agents/start path's buildAgentEnv runs — which never happens
    // while ensureFrontDesk short-circuits on a warm session.
    const githubToken = await scm.resolveGitHubTokenString({
      env: this.env,
      departmentId: this.departmentId,
      getDepartmentConfig: () => Promise.resolve(departmentConfig),
    });

    // _ensureFrontDesk dispatches the frontDesk without a per-workstation override
    // (Department.do.ts:2766-2790). Match that resolution here so the prewarm
    // KILO_CONFIG_CONTENT is byte-identical to what /agents/start will
    // build, and ensureSDKServer's config-mismatch eviction never fires.
    return {
      agentId: frontDesk.id,
      model: config.resolveModel(departmentConfig, null, 'frontDesk'),
      smallModel: config.resolveSmallModel(departmentConfig),
      kilocodeToken,
      organizationId: departmentConfig.organization_id ?? null,
      ...(githubToken ? { githubToken } : {}),
      ...(departmentConfig.github_cli_pat ? { githubCliPat: departmentConfig.github_cli_pat } : {}),
    };
  }

  async ensureFrontDesk(actorUserId?: string): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    return withLogTags({ source: 'Department.do', tags: { departmentId: this.departmentId } }, () =>
      this._ensurefront_desk(actorUserId)
    );
  }

  private async _ensureFrontDesk(actorUserId?: string): Promise<{
    agentId: string;
    sessionStatus: 'idle' | 'active' | 'starting';
  }> {
    const departmentId = this.departmentId;
    await this.prepareContainerBilling(actorUserId ? { type: 'user', id: actorUserId } : undefined);
    if (isContainerUsageMeteringEnabled(this.env)) {
      await getDepartmentContainerStub(this.env, departmentId).warmUp();
      this._billingBlocked = false;
      await this.ctx.storage.put('billing:blocked', false);
    }

    let frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    if (!frontDesk) {
      const identity = `front-desk-${departmentId.slice(0, 8)}`;
      frontDesk = agents.registerAgent(this.sql, {
        role: 'frontDesk',
        name: 'frontDesk',
        identity,
      });
      logger.info('ensureFrontDesk: created frontDesk agent', { agentId: frontDesk.id });
    }

    logger.setTags({ agentId: frontDesk.id });

    // Check if the container is already running AND the SDK has a live
    // session for the frontDesk. The SDK can be torn down (serverPort=0,
    // sessionId='') after stream errors or drain while the agent record
    // still says "running" — in that case we must fall through to a
    // fresh dispatch instead of returning early.
    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, departmentId, frontDesk.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';
    const sdkAlive =
      isAlive && (containerStatus.serverPort ?? 0) > 0 && Boolean(containerStatus.sessionId);

    if (sdkAlive) {
      const isActive =
        frontDesk.status === 'working' || frontDesk.status === 'stalled' || frontDesk.status === 'waiting';
      writeEvent(this.env, {
        event: 'frontDesk.ensure_decision',
        departmentId,
        agentId: frontDesk.id,
        role: 'frontDesk',
        label: isActive ? 'short_circuit_warm' : 'short_circuit_idle',
      });
      return { agentId: frontDesk.id, sessionStatus: isActive ? 'active' : 'idle' };
    }

    // Container says running/starting but SDK has no port/session — the
    // SDK was torn down (e.g. stream error, drain). Fall through to a
    // fresh dispatch so the user doesn't have to manually refresh.
    if (isAlive && !sdkAlive) {
      logger.info('ensureFrontDesk: container alive but SDK torn down, redispatching', {
        agentId: frontDesk.id,
        containerStatus: containerStatus.status,
        serverPort: containerStatus.serverPort,
        sessionId: containerStatus.sessionId,
      });
      writeEvent(this.env, {
        event: 'frontDesk.ensure_decision',
        departmentId,
        agentId: frontDesk.id,
        role: 'frontDesk',
        label: 'sdk_dead_redispatch',
      });
    }

    // Start the container with an idle frontDesk (no initial prompt)
    const departmentConfig = await this.getDepartmentConfig();
    const workstationConfig = await this.getFrontDeskWorkstationConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    // Don't start without a kilocode token — the session would use the
    // default free model and have no provider credentials. The frontend
    // will retry via status polling once a workstation is created and the token
    // becomes available.
    if (!kilocodeToken) {
      logger.warn('ensureFrontDesk: no kilocodeToken available, deferring start', {
        userId: departmentConfig.owner_user_id,
        orgId: departmentConfig.organization_id,
      });
      return { agentId: frontDesk.id, sessionStatus: 'idle' };
    }

    writeEvent(this.env, {
      event: 'frontDesk.ensure_decision',
      departmentId,
      agentId: frontDesk.id,
      role: 'frontDesk',
      label: 'fresh_dispatch',
    });

    try {
      const containerStub = getDepartmentContainerStub(this.env, departmentId);
      await containerStub.setEnvVar('KILOCODE_TOKEN', kilocodeToken);
    } catch {
      // Best effort
    }

    // Start with an empty prompt — the frontDesk will be idle but its container
    // and SDK server will be running, ready for PTY connections.
    const { started: frontDeskStarted } = await dispatch.startAgentInContainer(
      this.env,
      this.ctx.storage,
      {
        departmentId,
        workstationId: `front-desk-${departmentId}`,
        userId:
          departmentConfig.owner_user_id ?? workstationConfig?.userId ?? departmentConfig.created_by_user_id ?? departmentId,
        agentId: frontDesk.id,
        agentName: 'frontDesk',
        role: 'frontDesk',
        identity: frontDesk.identity,
        ticketId: '',
        ticketTitle: 'FrontDesk ready. Waiting for instructions.',
        ticketBody: '',
        checkpoint: agents.readCheckpoint(this.sql, frontDesk.id),
        gitUrl: workstationConfig?.gitUrl ?? '',
        defaultBranch: workstationConfig?.defaultBranch ?? 'main',
        kilocodeToken,
        departmentConfig,
        workstations: await this.workstationListForFrontDesk(),
      }
    );

    if (frontDeskStarted) {
      agents.updateAgentStatus(this.sql, frontDesk.id, 'working');
      this._front_deskWorkingSince = Date.now();
      return { agentId: frontDesk.id, sessionStatus: 'starting' };
    }

    return { agentId: frontDesk.id, sessionStatus: 'idle' };
  }

  /**
   * Hot-update the frontDesk's model without restarting the session.
   * Patches the running SDK server config and per-message model override
   * so both the frontDesk and its sub-agents use the new model immediately.
   */
  async updateFrontDeskModel(model: string, smallModel?: string): Promise<void> {
    const departmentId = this.departmentId;
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0];
    if (!frontDesk) return;

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, departmentId, frontDesk.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';

    if (isAlive) {
      // Attach fresh department config so the container can update process.env
      // before restarting the SDK server (tokens, git identity, etc.).
      const containerConfig = await config.buildContainerConfig(
        this.ctx.storage,
        this.env,
        this.departmentId
      );

      // Resolve departmentConfig to thread the organization_id into the request body
      // (belt-and-suspenders: ensures org billing survives even if X-department-Config
      // header parsing fails on the container side).
      const departmentConfig = await config.getDepartmentConfig(this.ctx.storage);

      const updated = await dispatch.updateAgentModelInContainer(
        this.env,
        departmentId,
        frontDesk.id,
        model,
        smallModel,
        undefined,
        containerConfig,
        departmentConfig.organization_id
      );
      if (updated) {
        console.log(
          `${DEPARTMENT_LOG} updateFrontDeskModel: hot-updated frontDesk ${frontDesk.id} to model=${model}`
        );
      } else {
        console.warn(`${DEPARTMENT_LOG} updateFrontDeskModel: failed to hot-update frontDesk ${frontDesk.id}`);
      }
    }
    // If the frontDesk is not alive, the next dispatch will pick up the new
    // model from the updated department config automatically.
  }

  /**
   * Rewrite the running frontDesk's AGENTS.md with the current system prompt
   * (including custom instructions). Called when custom instructions change
   * so the frontDesk picks them up on its next session restart.
   */
  async updateFrontDeskSystemPrompt(): Promise<void> {
    const departmentId = this.departmentId;
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0];
    if (!frontDesk) return;

    const containerStatus = await dispatch.checkAgentContainerStatus(this.env, departmentId, frontDesk.id);
    const isAlive = containerStatus.status === 'running' || containerStatus.status === 'starting';
    if (!isAlive) return;

    const departmentConfig = await this.getDepartmentConfig();
    const systemPrompt = dispatch.appendCustomInstructions(
      dispatch.systemPromptForRole({
        role: 'frontDesk',
        identity: frontDesk.identity,
        agentName: 'frontDesk',
        workstationId: `front-desk-${departmentId}`,
        departmentId,
        gates: departmentConfig.qualityAssurance?.gates ?? [],
      }),
      'frontDesk',
      departmentConfig
    );

    const updated = await dispatch.updateFrontDeskSystemPromptInContainer(
      this.env,
      departmentId,
      frontDesk.id,
      systemPrompt
    );
    if (updated) {
      console.log(`${DEPARTMENT_LOG} updateFrontDeskSystemPrompt: rewrote AGENTS.md for frontDesk ${frontDesk.id}`);
    } else {
      console.warn(
        `${DEPARTMENT_LOG} updateFrontDeskSystemPrompt: failed to rewrite AGENTS.md for frontDesk ${frontDesk.id}`
      );
    }
  }

  async getFrontDeskStatus(): Promise<{
    configured: boolean;
    departmentId: string;
    session: {
      agentId: string;
      sessionId: string;
      status: 'idle' | 'active' | 'starting';
      lastActivityAt: string;
    } | null;
  }> {
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;

    const mapStatus = (agentStatus: string): 'idle' | 'active' | 'starting' => {
      switch (agentStatus) {
        case 'working':
        case 'waiting':
        case 'stalled':
          return 'active';
        default:
          return 'idle';
      }
    };

    return {
      configured: true,
      departmentId: this.departmentId,
      session: frontDesk
        ? {
            agentId: frontDesk.id,
            sessionId: frontDesk.id,
            status: mapStatus(frontDesk.status),
            lastActivityAt: frontDesk.last_activity_at ?? frontDesk.created_at,
          }
        : null,
    };
  }

  private async getFrontDeskWorkstationConfig(): Promise<WorkstationConfig | null> {
    const workstationList = workstations.listWorkstations(this.sql);
    if (workstationList.length === 0) return null;
    return this.getWorkstationConfig(workstationList[0].id);
  }

  private async resolveKilocodeToken(): Promise<string | undefined> {
    const departmentConfig = await this.getDepartmentConfig();
    if (departmentConfig.kilocode_token) return departmentConfig.kilocode_token;

    const workstationList = workstations.listWorkstations(this.sql);
    for (const workstation of workstationList) {
      const rc = await this.getWorkstationConfig(workstation.id);
      if (rc?.kilocodeToken) {
        await this.updateDepartmentConfig({ kilocode_token: rc.kilocodeToken });
        return rc.kilocodeToken;
      }
    }

    return undefined;
  }

  async createShift(input: {
    title: string;
    tickets: Array<{ ticket_id: string; workstation_id: string }>;
    created_by?: string;
  }): Promise<ShiftEntry> {
    const parsed = z
      .object({
        title: z.string().min(1),
        tickets: z.array(z.object({ ticket_id: z.string().min(1), workstation_id: z.string().min(1) })).min(1),
        created_by: z.string().min(1).optional(),
      })
      .parse(input);

    const shiftId = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${tickets} (
          ${tickets.columns.ticket_id}, ${tickets.columns.type}, ${tickets.columns.status},
          ${tickets.columns.title}, ${tickets.columns.body}, ${tickets.columns.workstation_id},
          ${tickets.columns.parent_ticket_id}, ${tickets.columns.assignee_agent_ticket_id},
          ${tickets.columns.priority}, ${tickets.columns.labels}, ${tickets.columns.metadata},
          ${tickets.columns.created_by}, ${tickets.columns.created_at}, ${tickets.columns.updated_at},
          ${tickets.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        shiftId,
        'shift',
        'open',
        parsed.title,
        null,
        null,
        null,
        null,
        'medium',
        JSON.stringify(['gt:shift']),
        '{}',
        parsed.created_by ?? null,
        timestamp,
        timestamp,
        null,
      ]
    );

    const departmentConfig = await this.getDepartmentConfig();
    const shiftMergeMode = departmentConfig.shift_merge_mode ?? 'review-then-land';
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${shift_metadata} (
          ${shift_metadata.columns.ticket_id}, ${shift_metadata.columns.total_tickets},
          ${shift_metadata.columns.closed_tickets}, ${shift_metadata.columns.landed_at},
          ${shift_metadata.columns.merge_mode}
        ) VALUES (?, ?, ?, ?, ?)
      `,
      [shiftId, parsed.tickets.length, 0, null, shiftMergeMode]
    );

    for (const ticket of parsed.tickets) {
      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${ticket_dependencies} (
            ${ticket_dependencies.columns.ticket_id},
            ${ticket_dependencies.columns.depends_on_ticket_id},
            ${ticket_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [ticket.ticket_id, shiftId, 'tracks']
      );
    }

    const shift = this.getShift(shiftId);
    if (!shift) throw new Error('Failed to create shift');
    this.emitEvent({
      event: 'shift.created',
      departmentId: this.departmentId,
      shiftId,
    });
    return shift;
  }

  async onTicketClosed(input: { shiftId: string; ticketId: string }): Promise<ShiftEntry | null> {
    const closedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT COUNT(1) AS count FROM ${ticket_dependencies}
          INNER JOIN ${tickets} ON ${ticket_dependencies.ticket_id} = ${tickets.ticket_id}
          WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'tracks'
            AND ${tickets.status} = 'closed'
        `,
        [input.shiftId]
      ),
    ];
    const closedCount = z.object({ count: z.number() }).parse(closedRows[0] ?? { count: 0 }).count;

    query(
      this.sql,
      /* sql */ `
        UPDATE ${shift_metadata}
        SET ${shift_metadata.columns.closed_tickets} = ?
        WHERE ${shift_metadata.ticket_id} = ?
      `,
      [closedCount, input.shiftId]
    );

    const shift = this.getShift(input.shiftId);
    if (shift) {
      this.broadcastShiftProgress(input.shiftId, shift.total_tickets, shift.closed_tickets);
    }
    if (shift && shift.status === 'active' && shift.closed_tickets >= shift.total_tickets) {
      const timestamp = now();
      query(
        this.sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.status} = 'closed', ${tickets.columns.closed_at} = ?, ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [timestamp, timestamp, input.shiftId]
      );
      query(
        this.sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.landed_at} = ?
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [timestamp, input.shiftId]
      );
      this.emitEvent({
        event: 'shift.landed',
        departmentId: this.departmentId,
        shiftId: input.shiftId,
      });
      return this.getShift(input.shiftId);
    }
    return shift;
  }

  /**
   * Force-close a shift and all its tracked tickets. Unhooks any agents
   * still assigned to those tickets so they return to the idle pool.
   */
  async closeShift(shiftId: string): Promise<ShiftEntry | null> {
    const shift = this.getShift(shiftId);
    if (!shift) return null;

    const timestamp = now();

    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${tickets.ticket_id}, ${tickets.status}, ${tickets.assignee_agent_ticket_id}
          FROM ${ticket_dependencies}
          INNER JOIN ${tickets} ON ${ticket_dependencies.ticket_id} = ${tickets.ticket_id}
          WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'tracks'
        `,
        [shiftId]
      ),
    ];

    const TrackedRow = z.object({
      ticket_id: z.string(),
      status: z.string(),
      assignee_agent_ticket_id: z.string().nullable(),
    });

    for (const raw of trackedRows) {
      const row = TrackedRow.parse(raw);
      if (row.status === 'closed' || row.status === 'failed') continue;

      if (row.assignee_agent_ticket_id) {
        try {
          agents.unhookTicket(this.sql, row.assignee_agent_ticket_id);
        } catch (err) {
          console.warn(
            `${DEPARTMENT_LOG} closeShift: unhookTicket failed for agent=${row.assignee_agent_ticket_id}`,
            err
          );
        }
      }

      ticketOps.updateTicketStatus(this.sql, row.ticket_id, 'closed', 'system');
    }

    // Close the shift ticket itself if not already auto-landed by
    // updateShiftProgress (which fires when the last tracked ticket closes).
    const current = this.getShift(shiftId);
    if (current && current.status !== 'landed') {
      query(
        this.sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.status} = 'closed',
              ${tickets.columns.closed_at} = ?,
              ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [timestamp, timestamp, shiftId]
      );
      query(
        this.sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.closed_tickets} = ${shift_metadata.columns.total_tickets},
              ${shift_metadata.columns.landed_at} = ?
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [timestamp, shiftId]
      );
    }

    console.log(`${DEPARTMENT_LOG} closeShift: force-closed shift=${shiftId}`);
    return this.getShift(shiftId);
  }

  /**
   * Atomic batch sling: create N tickets + 1 shift, assign souls, dispatch.
   * Used by the FrontDesk's gt_sling_batch tool.
   */
  async slingShift(input: {
    workstationId: string;
    shiftTitle: string;
    tasks: Array<{ title: string; body?: string; depends_on?: number[] }>;
    merge_mode?: 'review-then-land' | 'review-and-merge';
    staged?: boolean;
    /**
     * Metadata stamped onto BOTH the shift ticket AND every task ticket. Useful
     * for cross-cutting context like the helldesk origin tag. Reserved keys
     * managed internally (`shift_id`, `feature_branch`) take precedence.
     */
    metadata?: Record<string, unknown>;
  }): Promise<{
    shift: ShiftEntry;
    tickets: Array<{ ticket: Ticket; agent: Agent | null }>;
  }> {
    // Resolve staged: explicit request wins, otherwise fall back to department config default.
    const departmentConfig = await this.getDepartmentConfig();
    const isStaged = input.staged ?? departmentConfig.staged_shifts_default;

    const shiftId = generateId();
    const timestamp = now();

    // Generate a feature branch name for this shift.
    // Convention: shift/<slug>/<id-prefix>/head
    // The /head suffix is required because git refs are file-based: a branch
    // at path X prevents branches under X/. Agent branches live under
    // <featureBranch>/gt/<agent>/<ticket>, so the feature branch itself must
    // end with a path component (/head) to act as a directory prefix.
    const shiftSlug =
      input.shiftTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'shift';
    const featureBranch = `shift/${shiftSlug}/${shiftId.slice(0, 8)}/head`;

    // 1. Validate the dependency graph has no cycles BEFORE persisting anything.
    // Kahn's algorithm: if we can't visit all nodes, there's a cycle.
    {
      const adj = new Map<number, number[]>();
      const inDegree = new Map<number, number>();
      for (let i = 0; i < input.tasks.length; i++) {
        adj.set(i, []);
        inDegree.set(i, 0);
      }
      for (let i = 0; i < input.tasks.length; i++) {
        for (const depIdx of input.tasks[i].depends_on ?? []) {
          if (depIdx < 0 || depIdx >= input.tasks.length || depIdx === i) continue;
          (adj.get(depIdx) ?? []).push(i);
          inDegree.set(i, (inDegree.get(i) ?? 0) + 1);
        }
      }
      const queue: number[] = [];
      for (const [node, deg] of inDegree) {
        if (deg === 0) queue.push(node);
      }
      let visited = 0;
      while (queue.length > 0) {
        const node = queue.shift();
        if (node === undefined) break;
        visited++;
        for (const neighbor of adj.get(node) ?? []) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDeg);
          if (newDeg === 0) queue.push(neighbor);
        }
      }
      if (visited < input.tasks.length) {
        throw new Error(
          `Shift dependency graph contains a cycle — ${input.tasks.length - visited} tasks are involved in circular dependencies`
        );
      }
    }

    // 2. Create shift ticket + shift_metadata
    // Merge caller-supplied metadata FIRST so reserved keys (feature_branch)
    // always win and can't be accidentally overridden.
    const shiftTicketMetadata = {
      ...(input.metadata ?? {}),
      feature_branch: featureBranch,
    };
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${tickets} (
          ${tickets.columns.ticket_id}, ${tickets.columns.type}, ${tickets.columns.status},
          ${tickets.columns.title}, ${tickets.columns.body}, ${tickets.columns.workstation_id},
          ${tickets.columns.parent_ticket_id}, ${tickets.columns.assignee_agent_ticket_id},
          ${tickets.columns.priority}, ${tickets.columns.labels}, ${tickets.columns.metadata},
          ${tickets.columns.created_by}, ${tickets.columns.created_at}, ${tickets.columns.updated_at},
          ${tickets.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        shiftId,
        'shift',
        'open',
        input.shiftTitle,
        null,
        null, // workstation_id — intentionally null; a shift is a department-level grouping that can span multiple workstations
        null,
        null,
        'medium',
        JSON.stringify(['gt:shift']),
        JSON.stringify(shiftTicketMetadata),
        null,
        timestamp,
        timestamp,
        null,
      ]
    );

    const tc = await this.getDepartmentConfig();
    const mergeMode = input.merge_mode ?? tc.shift_merge_mode ?? 'review-then-land';

    const stagedValue = isStaged ? 1 : 0;

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${shift_metadata} (
          ${shift_metadata.columns.ticket_id}, ${shift_metadata.columns.total_tickets},
          ${shift_metadata.columns.closed_tickets}, ${shift_metadata.columns.landed_at},
          ${shift_metadata.columns.feature_branch}, ${shift_metadata.columns.merge_mode},
          ${shift_metadata.columns.staged}
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [shiftId, input.tasks.length, 0, null, featureBranch, mergeMode, stagedValue]
    );

    // Push the shift feature branch to the remote so souls can immediately
    // open PRs targeting it and the qualityAssurance can merge into it.
    const workstation = workstations.getWorkstation(this.sql, input.workstationId);
    if (workstation) {
      const workstationConfig = await this.getWorkstationConfig(input.workstationId);
      await scm
        .createShiftBranch(
          {
            env: this.env,
            departmentId: this.departmentId,
            getDepartmentConfig: () => this.getDepartmentConfig(),
            platformIntegrationId: workstationConfig?.platformIntegrationId,
          },
          {
            gitUrl: workstation.git_url,
            defaultBranch: workstation.default_branch,
            featureBranch,
          }
        )
        .catch(err =>
          console.warn(`${DEPARTMENT_LOG} slingShift: createShiftBranch failed (non-fatal)`, {
            error: err instanceof Error ? err.message : String(err),
          })
        );
    }

    const ticketIds: string[] = [];
    const results: Array<{ ticket: Ticket; agent: Agent | null }> = [];

    for (const task of input.tasks) {
      // Merge caller-supplied metadata FIRST so reserved keys
      // (shift_id, feature_branch) always win.
      const taskTicketMetadata = {
        ...(input.metadata ?? {}),
        shift_id: shiftId,
        feature_branch: featureBranch,
      };
      const createdTicket = ticketOps.createTicket(this.sql, {
        type: 'issue',
        title: task.title,
        body: task.body,
        priority: 'medium',
        workstation_id: input.workstationId,
        metadata: taskTicketMetadata,
      });
      ticketIds.push(createdTicket.ticket_id);

      query(
        this.sql,
        /* sql */ `
          INSERT INTO ${ticket_dependencies} (
            ${ticket_dependencies.columns.ticket_id},
            ${ticket_dependencies.columns.depends_on_ticket_id},
            ${ticket_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [createdTicket.ticket_id, shiftId, 'tracks']
      );
    }

    for (let i = 0; i < input.tasks.length; i++) {
      const deps = input.tasks[i].depends_on;
      if (!deps || deps.length === 0) continue;
      for (const depIdx of deps) {
        if (depIdx < 0 || depIdx >= ticketIds.length || depIdx === i) continue;
        query(
          this.sql,
          /* sql */ `
            INSERT OR IGNORE INTO ${ticket_dependencies} (
              ${ticket_dependencies.columns.ticket_id},
              ${ticket_dependencies.columns.depends_on_ticket_id},
              ${ticket_dependencies.columns.dependency_type}
            ) VALUES (?, ?, ?)
          `,
          [ticketIds[i], ticketIds[depIdx], 'blocks']
        );
      }
    }

    // Record ticket_created events for reconciler (dual-write, no behavior change)
    for (let i = 0; i < ticketIds.length; i++) {
      const hasBlockers = (input.tasks[i].depends_on ?? []).length > 0;
      events.insertEvent(this.sql, 'ticket_created', {
        ticket_id: ticketIds[i],
        payload: {
          ticket_type: 'issue',
          workstation_id: input.workstationId,
          shift_id: shiftId,
          has_blockers: hasBlockers,
        },
      });
    }

    // Lazy assignment: tickets are created with no assignee. The reconciler's
    // reconcileTickets Rule 1 assigns agents to unblocked tickets on the next
    // alarm tick. This avoids creating N souls upfront for a shift
    // where only 1-3 tickets are unblocked initially (#1249).
    for (const ticketId of ticketIds) {
      const ticket = ticketOps.getTicket(this.sql, ticketId);
      if (!ticket) continue;
      results.push({ ticket, agent: null });
    }

    if (!isStaged) {
      await this.escalateToActiveCadence();
    }

    const shift = this.getShift(shiftId);
    if (!shift) throw new Error('Failed to create shift');
    this.emitEvent({
      event: 'shift.created',
      departmentId: this.departmentId,
      shiftId,
    });
    return { shift, tickets: results };
  }

  /**
   * Transition a staged shift to active: hook agents and begin dispatch.
   */
  async startShift(shiftId: string): Promise<{
    shift: ShiftEntry;
    tickets: Array<{ ticket: Ticket; agent: Agent | null }>;
  }> {
    const shift = this.getShift(shiftId);
    if (!shift) throw new Error(`Shift not found: ${shiftId}`);
    if (!shift.staged) throw new Error(`Shift is not staged: ${shiftId}`);

    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${ticket_dependencies.ticket_id}
          FROM ${ticket_dependencies}
          WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'tracks'
        `,
        [shiftId]
      ),
    ];

    const TicketIdRow = z.object({ ticket_id: z.string() });
    const trackedTicketIds = TicketIdRow.array()
      .parse(trackedRows)
      .map(r => r.ticket_id);

    const results: Array<{ ticket: Ticket; agent: Agent | null }> = [];

    // Lazy assignment: just collect tickets. The reconciler's reconcileTickets
    // Rule 1 assigns agents to unblocked tickets on the next alarm tick.
    for (const ticketId of trackedTicketIds) {
      const ticket = ticketOps.getTicket(this.sql, ticketId);
      if (!ticket) continue;
      results.push({ ticket, agent: null });
    }

    // Clear the staged flag so the reconciler sees these tickets as active.
    query(
      this.sql,
      /* sql */ `
        UPDATE ${shift_metadata}
        SET ${shift_metadata.columns.staged} = 0
        WHERE ${shift_metadata.ticket_id} = ?
      `,
      [shiftId]
    );

    events.insertEvent(this.sql, 'shift_started', {
      payload: { shift_id: shiftId },
    });

    await this.escalateToActiveCadence();

    const updatedShift = this.getShift(shiftId);
    if (!updatedShift) throw new Error(`Failed to re-fetch shift after start: ${shiftId}`);
    this.emitEvent({
      event: 'shift.started',
      departmentId: this.departmentId,
      shiftId,
    });
    return { shift: updatedShift, tickets: results };
  }

  /**
   * List active shifts with progress counts.
   */
  async listShifts(): Promise<ShiftEntry[]> {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `${SHIFT_JOIN}
          WHERE ${tickets.status} != 'closed'
          ORDER BY ${tickets.created_at} DESC`,
        []
      ),
    ];
    return rows.map(row => toShift(ShiftTicketRecord.parse(row)));
  }

  /**
   * List active shifts with full per-ticket breakdown in a single DO call.
   * Avoids N+1 RPC fan-out from calling getShiftStatus for each shift.
   */
  async listShiftsDetailed(): Promise<
    Array<
      ShiftEntry & {
        tickets: Array<{
          ticket_id: string;
          title: string;
          status: string;
          workstation_id: string | null;
          assignee_agent_name: string | null;
        }>;
        dependency_edges: Array<{
          ticket_id: string;
          depends_on_ticket_id: string;
        }>;
      }
    >
  > {
    const shifts = await this.listShifts();
    const detailed = [];
    for (const shift of shifts) {
      const status = await this.getShiftStatus(shift.id);
      detailed.push(status ?? { ...shift, tickets: [], dependency_edges: [] });
    }
    return detailed;
  }

  /**
   * Detailed shift status with per-ticket breakdown and DAG edges.
   */
  async getShiftStatus(shiftId: string): Promise<
    | (ShiftEntry & {
        tickets: Array<{
          ticket_id: string;
          title: string;
          status: string;
          workstation_id: string | null;
          assignee_agent_name: string | null;
        }>;
        dependency_edges: Array<{
          ticket_id: string;
          depends_on_ticket_id: string;
        }>;
      })
    | null
  > {
    const shift = this.getShift(shiftId);
    if (!shift) return null;

    // Fetch tracked tickets with optional agent name.
    // Both sides of the LEFT JOIN are the tickets table, so all column refs
    // must be qualified to avoid ambiguity.
    const trackedRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${tickets.ticket_id}, ${tickets.title}, ${tickets.status},
                 ${tickets.workstation_id},
                 ${tickets.assignee_agent_ticket_id},
                 agent_tickets.${tickets.columns.title} AS assignee_agent_name
          FROM ${ticket_dependencies}
          INNER JOIN ${tickets} ON ${ticket_dependencies.ticket_id} = ${tickets.ticket_id}
          LEFT JOIN ${tickets} AS agent_tickets
            ON ${tickets.assignee_agent_ticket_id} = agent_tickets.${tickets.columns.ticket_id}
          WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'tracks'
          ORDER BY ${tickets.created_at} ASC
        `,
        [shiftId]
      ),
    ];

    const TrackedTicketRow = z.object({
      ticket_id: z.string(),
      title: z.string(),
      status: z.string(),
      workstation_id: z.string().nullable(),
      assignee_agent_name: z.string().nullable(),
    });

    const dependencyEdges = ticketOps.getShiftDependencyEdges(this.sql, shiftId);

    return {
      ...shift,
      tickets: trackedRows.map(row => TrackedTicketRow.parse(row)),
      dependency_edges: dependencyEdges,
    };
  }

  private getShift(shiftId: string): ShiftEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${SHIFT_JOIN} WHERE ${tickets.ticket_id} = ?`, [shiftId]),
    ];
    if (rows.length === 0) return null;
    return toShift(ShiftTicketRecord.parse(rows[0]));
  }

  async acknowledgeEscalation(escalationId: string): Promise<EscalationEntry | null> {
    query(
      this.sql,
      /* sql */ `
        UPDATE ${escalation_metadata}
        SET ${escalation_metadata.columns.acknowledged} = 1, ${escalation_metadata.columns.acknowledged_at} = ?
        WHERE ${escalation_metadata.ticket_id} = ? AND ${escalation_metadata.acknowledged} = 0
      `,
      [now(), escalationId]
    );
    // Acknowledging an escalation also closes it — the frontDesk has seen
    // the issue and doesn't need it sitting open in the queue.
    // Guard with getTicket so stale/duplicate acknowledge calls remain
    // idempotent instead of throwing on a missing ticket.
    const escalationTicket = ticketOps.getTicket(this.sql, escalationId);
    if (escalationTicket && escalationTicket.status !== 'closed') {
      ticketOps.updateTicketStatus(this.sql, escalationId, 'closed', null);
    }
    this.emitEvent({
      event: 'escalation.acknowledged',
      departmentId: this.departmentId,
      ticketId: escalationId,
    });
    return this.getEscalation(escalationId);
  }

  async listEscalations(filter?: { acknowledged?: boolean }): Promise<EscalationEntry[]> {
    const rows =
      filter?.acknowledged !== undefined
        ? [
            ...query(
              this.sql,
              /* sql */ `${ESCALATION_JOIN} WHERE ${escalation_metadata.acknowledged} = ? ORDER BY ${tickets.created_at} DESC LIMIT 100`,
              [filter.acknowledged ? 1 : 0]
            ),
          ]
        : [
            ...query(
              this.sql,
              /* sql */ `${ESCALATION_JOIN} ORDER BY ${tickets.created_at} DESC LIMIT 100`,
              []
            ),
          ];
    return EscalationTicketRecord.array().parse(rows).map(toEscalation);
  }

  async routeEscalation(input: {
    departmentId: string;
    source_workstation_id: string;
    source_agent_id?: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    category?: string;
    message: string;
  }): Promise<EscalationEntry> {
    const ticketId = generateId();
    const timestamp = now();

    // Resolve shift context from the source agent's hooked ticket so the
    // escalation is associated with the shift for display and future
    // automated handling (Phase 4: shift-aware triage).
    let shiftId: string | null = null;
    let sourceTicketId: string | null = null;
    if (input.source_agent_id) {
      const agent = agents.getAgent(this.sql, input.source_agent_id);
      if (agent?.current_hook_ticket_id) {
        sourceTicketId = agent.current_hook_ticket_id;
        shiftId = ticketOps.getShiftForTicket(this.sql, sourceTicketId);
      }
    }

    const metadata: Record<string, unknown> = {};
    if (shiftId) metadata.shift_id = shiftId;
    if (sourceTicketId) metadata.source_ticket_id = sourceTicketId;

    // Create the escalation ticket
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${tickets} (
          ${tickets.columns.ticket_id}, ${tickets.columns.type}, ${tickets.columns.status},
          ${tickets.columns.title}, ${tickets.columns.body}, ${tickets.columns.workstation_id},
          ${tickets.columns.parent_ticket_id}, ${tickets.columns.assignee_agent_ticket_id},
          ${tickets.columns.priority}, ${tickets.columns.labels}, ${tickets.columns.metadata},
          ${tickets.columns.created_by}, ${tickets.columns.created_at}, ${tickets.columns.updated_at},
          ${tickets.columns.closed_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        ticketId,
        'escalation',
        'open',
        `Escalation: ${input.message.slice(0, 100)}`,
        input.message,
        input.source_workstation_id,
        null,
        null,
        input.severity === 'critical' ? 'critical' : input.severity === 'high' ? 'high' : 'medium',
        JSON.stringify(['gt:escalation', `severity:${input.severity}`]),
        JSON.stringify(metadata),
        input.source_agent_id ?? null,
        timestamp,
        timestamp,
        null,
      ]
    );

    // Create escalation_metadata
    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${escalation_metadata} (
          ${escalation_metadata.columns.ticket_id}, ${escalation_metadata.columns.severity},
          ${escalation_metadata.columns.category}, ${escalation_metadata.columns.acknowledged},
          ${escalation_metadata.columns.re_escalation_count}, ${escalation_metadata.columns.acknowledged_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [ticketId, input.severity, input.category ?? null, 0, 0, null]
    );

    const escalation = this.getEscalation(ticketId);
    if (!escalation) throw new Error('Failed to create escalation');

    this.emitEvent({
      event: 'escalation.created',
      departmentId: this.departmentId,
      workstationId: input.source_workstation_id,
      agentId: input.source_agent_id,
      ticketId,
      shiftId: shiftId ?? undefined,
    });

    // Create a triage request so the attendance→triage→resolve loop can
    // act on the escalation. Without this, escalation tickets sit open
    // with no assignee and no automated follow-up.
    attendance.createTriageRequest(this.sql, {
      triageType: 'escalation',
      agentTicketId: input.source_agent_id ?? null,
      title: `Escalation (${input.severity}): ${input.message.slice(0, 80)}`,
      context: {
        escalation_ticket_id: ticketId,
        severity: input.severity,
        workstation_id: input.source_workstation_id,
        category: input.category,
        shift_id: shiftId,
        source_ticket_id: sourceTicketId,
      },
      options:
        input.severity === 'low'
          ? ['NUDGE', 'CLOSE_TICKET', 'PROVIDE_GUIDANCE']
          : ['ESCALATE_TO_FRONT_DESK', 'RESTART', 'CLOSE_TICKET', 'REASSIGN_TICKET'],
      workstationId: input.source_workstation_id,
    });

    // Notify frontDesk directly for medium+ severity (in addition to triage)
    if (input.severity !== 'low') {
      this.sendFrontDeskMessage(
        `[Escalation:${input.severity}] workstation=${input.source_workstation_id} ${input.message}`
      ).catch(err => {
        console.warn(`${DEPARTMENT_LOG} routeEscalation: failed to notify frontDesk:`, err);
        try {
          ticketOps.logTicketEvent(this.sql, {
            ticketId,
            agentId: input.source_agent_id ?? null,
            eventType: 'notification_failed',
            metadata: {
              target: 'frontDesk',
              reason: err instanceof Error ? err.message : String(err),
              severity: input.severity,
            },
          });
        } catch (logErr) {
          console.error(
            `${DEPARTMENT_LOG} routeEscalation: failed to log notification_failed event:`,
            logErr
          );
        }
      });
    }

    return escalation;
  }

  private getEscalation(escalationId: string): EscalationEntry | null {
    const rows = [
      ...query(this.sql, /* sql */ `${ESCALATION_JOIN} WHERE ${tickets.ticket_id} = ?`, [escalationId]),
    ];
    if (rows.length === 0) return null;
    return toEscalation(EscalationTicketRecord.parse(rows[0]));
  }

  async alarm(): Promise<void> {
    return withLogTags({ source: 'Department.do' }, async () => {
      await this._alarm();
    });
  }

  private async _alarm(): Promise<void> {
    // Exit condition: if this DO was destroyed, don't re-arm.
    // After destroy(), deleteAll() wipes storage but may not clear
    // the alarm (compat date < 2026-02-24). A resurrected alarm
    // will find no department:id — stop the loop immediately.
    const storedId = await this.ctx.storage.get<string>('department:id');
    if (!storedId) {
      logger.info('alarm: no department:id — department was destroyed, not re-arming');
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const departmentId = this.departmentId;
    logger.setTags({ departmentId });
    logger.info('alarm: fired');

    // Call once per tick — threaded to ensureContainerReady, maybeDispatchTriageAgent, and getAlarmStatus
    const workstationList = workstations.listWorkstations(this.sql);
    const hasWorkstations = workstationList.length > 0;
    let billingStatus: HelldeskBillingStatus = {
      enabled: false,
      enforcing: false,
      state: 'idle',
      runPolicy: this._containerRunPolicy,
    };

    if (isContainerUsageMeteringEnabled(this.env)) {
      try {
        billingStatus = await this.updateContainerBilling();
      } catch (err) {
        billingStatus = {
          enabled: true,
          enforcing: isHelldeskBillingEnforced(this.env),
          state: 'degraded',
          runPolicy: this._containerRunPolicy,
        };
        logger.warn('alarm: container billing update failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      await this.refreshOwnerAccess();
    } catch (err) {
      logger.warn('alarm: owner access check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (hasWorkstations && !this.containerStartsBlocked()) {
      try {
        await this.ensureContainerReady(workstationList);
      } catch (err) {
        logger.warn('alarm: container health check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Refresh the container-scoped JWT. Throttled to once per hour (tokens
      // have 8h expiry). Skips when no active work AND no alive frontDesk — the
      // container is sleeping and the token will be refreshed at dispatch time.
      // Keeps refreshing for waiting frontDesk since sendFrontDeskMessage reuses the
      // container without calling ensureContainerToken.
      try {
        await this.refreshContainerToken();
      } catch (err) {
        logger.warn('alarm: refreshContainerToken failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Proactively remint KILOCODE_TOKEN before it expires (30-day
      // expiry, checked daily, refreshed within 7 days of expiry).
      try {
        await this.refreshKilocodeTokenIfExpiring();
      } catch (err) {
        logger.warn('alarm: refreshKilocodeTokenIfExpiring failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Poll the container for each working/stalled agent and emit
    // container_status events. These are drained in Phase 0 and applied
    // before reconciliation.
    try {
      const workingAgentRows = z
        .object({ ticket_id: z.string() })
        .array()
        .parse([
          ...query(
            this.sql,
            /* sql */ `
            SELECT ${agent_metadata.ticket_id}
            FROM ${agent_metadata}
            WHERE ${agent_metadata.status} IN ('working', 'stalled')
          `,
            []
          ),
        ]);

      if (workingAgentRows.length > 0 && !this.containerStartsBlocked()) {
        const statusChecks = workingAgentRows.map(async row => {
          try {
            const containerInfo = await dispatch.checkAgentContainerStatus(
              this.env,
              departmentId,
              row.ticket_id
            );
            // Skip inserting events for 'running' — it's the steady-state and
            // a no-op in applyEvent, so recording it just bloats the event table
            // (~720 events/hour/agent). Non-running statuses (stopped, error,
            // unknown) still get inserted so the reconciler can detect and handle them.
            if (containerInfo.status !== 'running') {
              events.upsertContainerStatus(this.sql, row.ticket_id, {
                status: containerInfo.status,
                exit_reason: containerInfo.exitReason,
              });
            }
          } catch (err) {
            logger.warn('alarm: container status check failed', {
              agentId: row.ticket_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
        await Promise.allSettled(statusChecks);
      }
    } catch (err) {
      logger.error('alarm: container observation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const reconcilerStart = Date.now();
    const metrics: reconciler.ReconcilerMetrics = {
      eventsDrained: 0,
      actionsEmitted: 0,
      actionsByType: {},
      sideEffectsAttempted: 0,
      sideEffectsSucceeded: 0,
      sideEffectsFailed: 0,
      invariantViolations: 0,
      wallClockMs: 0,
      pendingEventCount: 0,
    };

    // Fetch department config once and share across Phase 0 and Phase 1 so that
    // applyEvent can use the full fallback chain (workstation → department → default) for
    // settings like auto_resolve_merge_conflicts.
    const departmentConfig = await this.getDepartmentConfig();

    // Phase 0: Drain events and apply state transitions
    try {
      const pending = events.drainEvents(this.sql);
      metrics.eventsDrained = pending.length;
      if (pending.length > 0) {
        logger.info('reconciler: draining events', { count: pending.length });
      }
      for (const event of pending) {
        try {
          reconciler.applyEvent(this.sql, event, { departmentConfig });
          events.markProcessed(this.sql, event.event_id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Terminal errors referencing a missing ticket/agent can never
          // succeed on retry — mark them processed so the drain loop
          // stops re-running them every alarm tick.
          const isMissingEntity =
            err instanceof Error && /\b(Ticket|Agent) [0-9a-f-]{36} not found\b/.test(err.message);
          if (isMissingEntity) {
            logger.warn('reconciler: applyEvent skipped (missing entity)', {
              eventId: event.event_id,
              eventType: event.event_type,
              error: message,
            });
            events.markProcessed(this.sql, event.event_id);
          } else {
            logger.error('reconciler: applyEvent failed', {
              eventId: event.event_id,
              eventType: event.event_type,
              error: message,
            });
            // Event stays unprocessed — will be retried on the next alarm tick.
          }
        }
      }
    } catch (err) {
      logger.error('reconciler: event drain failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      Sentry.captureException(err);
    }

    // Safety-net: auto-clear drain flag if it has been active too long.
    // The primary clear mechanism is the heartbeat instance ID check
    // (see recordHeartbeat), but this catches edge cases where no
    // heartbeat arrives (e.g. container failed to start).
    if (this._draining && this._drainStartedAt) {
      const DRAIN_TIMEOUT_MS = 7 * 60 * 1000;
      if (Date.now() - this._drainStartedAt > DRAIN_TIMEOUT_MS) {
        this._draining = false;
        this._drainNonce = null;
        this._drainStartedAt = null;
        await this.ctx.storage.put('department:draining', false);
        await this.ctx.storage.delete('department:drainNonce');
        await this.ctx.storage.delete('department:drainStartedAt');
        logger.info('reconciler: drain timeout exceeded, auto-clearing draining flag');
      }
    }

    // Phase 1: Reconcile — compute desired state vs actual state
    const sideEffects: Array<() => Promise<void>> = [];
    try {
      const actions = reconciler.reconcile(this.sql, {
        draining: this._draining || this.containerStartsBlocked(),
        departmentConfig,
      });
      metrics.actionsEmitted = actions.length;
      for (const a of actions) {
        metrics.actionsByType[a.type] = (metrics.actionsByType[a.type] ?? 0) + 1;
      }
      if (actions.length > 0) {
        logger.info('reconciler: actions computed', {
          count: actions.length,
          types: [...new Set(actions.map(a => a.type))].join(','),
        });
      }
      const ctx = this.applyActionCtx;
      for (const action of actions) {
        try {
          const effect = applyAction(ctx, action);
          if (effect) sideEffects.push(effect);
        } catch (err) {
          logger.error('reconciler: applyAction failed', {
            actionType: action.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error('reconciler: reconcile failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      Sentry.captureException(err);
    }

    // Phase 2: Execute side effects (async, best-effort)
    metrics.sideEffectsAttempted = sideEffects.length;
    if (sideEffects.length > 0) {
      const results = await Promise.allSettled(sideEffects.map(fn => fn()));
      for (const r of results) {
        if (r.status === 'fulfilled') metrics.sideEffectsSucceeded++;
        else metrics.sideEffectsFailed++;
      }
    }

    try {
      const violations = reconciler.checkInvariants(this.sql);
      metrics.invariantViolations = violations.length;
      if (violations.length > 0) {
        // Emit as an analytics event for observability dashboards instead
        // of console.error (which spams Workers logs every 5s per department).
        this.emitEvent({
          event: 'reconciler.invariant_violations',
          departmentId,
          label: violations.map(v => `[${v.invariant}] ${v.message}`).join('; '),
          value: violations.length,
        });

        for (const violation of violations) {
          Sentry.captureMessage(
            `Reconciler invariant #${violation.invariant} violated: ${violation.message}`,
            {
              level: 'error',
              extra: {
                invariant: violation.invariant,
                message: violation.message,
                departmentId,
              },
              tags: {
                invariant: String(violation.invariant),
                departmentId,
              },
            }
          );

          // TODO: auto-recovery for invariant #7 (working agent with no hook).
          // Transitioning to idle requires unhooking side-effects (container stop,
          // ticket status rollback) that live in agents.ts — needs a dedicated
          // recovery action in the reconciler rather than a raw SQL update here.
        }
      }
    } catch (err) {
      logger.warn('reconciler: invariant check failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    metrics.wallClockMs = Date.now() - reconcilerStart;
    metrics.pendingEventCount = events.pendingEventCount(this.sql);
    this._lastReconcilerMetrics = metrics;

    // Emit reconciler metrics to Analytics Engine for Grafana dashboards.
    // Field mapping:
    //   double1  = wallClockMs
    //   double2  = eventsDrained
    //   double3  = actionsEmitted
    //   double4  = sideEffectsAttempted
    //   double5  = sideEffectsSucceeded
    //   double6  = sideEffectsFailed
    //   double7  = invariantViolations
    //   double8  = pendingEventCount
    //   blob10   = JSON-encoded actionsByType breakdown
    this.emitEvent({
      event: 'reconciler_tick',
      departmentId,
      durationMs: metrics.wallClockMs,
      value: metrics.eventsDrained,
      double3: metrics.actionsEmitted,
      double4: metrics.sideEffectsAttempted,
      double5: metrics.sideEffectsSucceeded,
      double6: metrics.sideEffectsFailed,
      double7: metrics.invariantViolations,
      double8: metrics.pendingEventCount,
      label: JSON.stringify(metrics.actionsByType),
    });

    // Computed after Phases 0-2 so re-arm and getAlarmStatus reflect
    // any work created during reconciliation (hooks, dispatches, triage).
    const activeWork = this.hasActiveWork();

    // ── Phase 3: Housekeeping (independent, all parallelizable) ────

    // Call once per tick — threaded to maybeDispatchTriageAgent and getAlarmStatus
    const cachedTriageCount = attendance.countPendingTriageRequests(this.sql);

    await Promise.allSettled([
      this.deliverPendingMemo().catch(err =>
        logger.warn('alarm: deliverPendingMemo failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      this.expireStaleNudges().catch(err =>
        logger.warn('alarm: expireStaleNudges failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      this.reEscalateStaleEscalations().catch(err =>
        logger.warn('alarm: reEscalation failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      ...(this.containerStartsBlocked()
        ? []
        : [
            this.maybeDispatchTriageAgent(cachedTriageCount, workstationList).catch(err =>
              logger.warn('alarm: maybeDispatchTriageAgent failed', {
                error: err instanceof Error ? err.message : String(err),
              })
            ),
          ]),
      Promise.resolve().then(() => {
        try {
          events.pruneOldEvents(this.sql, 7 * 24 * 60 * 60 * 1000);
        } catch (err) {
          logger.warn('alarm: event pruning failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    ]);

    await this.stopContainerIfIdle().catch(err =>
      logger.warn('alarm: stopContainerIfIdle failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );

    // A revoked department cannot run its work, so it does not need the fast cadence.
    const interval =
      activeWork && !this._accessRevoked ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + interval);

    // Broadcast status snapshot to connected WebSocket clients (skip if nobody is listening)
    const statusClients = this.ctx.getWebSockets('status');
    if (statusClients.length > 0) {
      try {
        const snapshot = await this.getAlarmStatus({
          activeWork,
          triageCount: cachedTriageCount,
          billingStatus,
        });
        this.broadcastAlarmStatus(snapshot);
      } catch (err) {
        logger.warn('alarm: status broadcast failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Push a fresh container-scoped JWT to the DepartmentContainerDO. Called
   * from the alarm handler, throttled to once per hour (tokens have
   * 8h expiry). The DepartmentContainerDO stores it as an env var so it's
   * available to all agents in the container.
   *
   * The throttle timestamp is persisted in ctx.storage so it survives
   * DO eviction. Without persistence, eviction resets the throttle to 0
   * and the refresh fires immediately on the next alarm tick, sending
   * requests that reset the container's sleepAfter timer (#1409).
   */
  private async refreshContainerToken(): Promise<void> {
    // Skip if no running agent AND no actively-running frontDesk — the container is
    // sleeping (or about to) and doesn't need a fresh token. The token will be
    // refreshed when work is next dispatched (ensureContainerToken is called in
    // startAgentInContainer at container-dispatch.ts) and on the warm-send path
    // in _sendFrontDeskMessage before sendMessageToAgent. 'waiting' is intentionally
    // excluded: a user may leave a frontDesk in waiting indefinitely, and counting
    // it as alive here would keep the container awake forever via hourly
    // /refresh-token pings that reset sleepAfter (#1409).
    const frontDesk = agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    const frontDeskAlive = frontDesk && (frontDesk.status === 'working' || frontDesk.status === 'stalled');
    if (!scheduling.hasRunningAgents(this.sql) && !frontDeskAlive) return;

    const TOKEN_REFRESH_INTERVAL_MS = 60 * 60_000;
    const now = Date.now();
    const lastRefresh = (await this.ctx.storage.get<number>('container:lastTokenRefreshAt')) ?? 0;
    if (now - lastRefresh < TOKEN_REFRESH_INTERVAL_MS) return;

    const departmentId = this.departmentId;
    if (!departmentId) return;
    const departmentConfig = await this.getDepartmentConfig();
    const userId = departmentConfig.owner_user_id ?? departmentId;
    await dispatch.refreshContainerToken(this.env, departmentId, userId);
    // Only mark as refreshed after success — failed refreshes should
    // be retried on the next alarm tick, not throttled for an hour.
    await this.ctx.storage.put('container:lastTokenRefreshAt', now);
  }

  /**
   * Proactively stop the department container when the department is idle.
   *
   * Cloudflare's sleepAfter timer resets on any port-8080 traffic (including
   * long-lived PTY WebSockets), so containers can stay awake for hours after
   * all real work finishes. Delegates to container-idle-stop sub-module.
   */
  private async stopContainerIfIdle(): Promise<void> {
    await _stopContainerIfIdle({
      hasRunningAgents: () => scheduling.hasRunningAgents(this.sql),
      isDraining: () => this._draining || this.containerStartsBlocked(),
      getFrontDesk: () => agents.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null,
      getDepartmentId: () => this.departmentId,
      getLastIdleStopAt: () => this.ctx.storage.get<number>('container:lastIdleStopAt'),
      setLastIdleStopAt: value => this.ctx.storage.put('container:lastIdleStopAt', value),
      getContainerStub: departmentId => {
        const container = getDepartmentContainerStub(this.env, departmentId);
        return {
          getState: () => container.getState(),
          stop: () => container.stopForInactivity(),
        };
      },
      writeEventFn: data => writeEvent(this.env, data),
      now: () => Date.now(),
    });
  }

  private async recordContainerHealthOutcome(
    departmentId: string,
    outcome: ContainerHealthPingOutcome
  ): Promise<void> {
    await _recoverContainerIfWedged({
      departmentId,
      containerDoId: getDepartmentContainerDoId(this.env, departmentId),
      outcome,
      isDraining: () => this._draining || this.containerStartsBlocked(),
      getConsecutiveHealthFailures: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures),
      setConsecutiveHealthFailures: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.consecutiveHealthFailures, value),
      getFirstHealthFailureAt: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt),
      setFirstHealthFailureAt: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt, value),
      deleteFirstHealthFailureAt: () =>
        this.ctx.storage.delete(CONTAINER_HEALTH_STORAGE_KEYS.firstHealthFailureAt),
      getLastAutoRestartAt: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.lastAutoRestartAt),
      setLastAutoRestartAt: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.lastAutoRestartAt, value),
      getAutoRestartWindowStart: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartWindowStart),
      setAutoRestartWindowStart: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartWindowStart, value),
      getAutoRestartsInWindow: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartsInWindow),
      setAutoRestartsInWindow: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartsInWindow, value),
      getAutoRestartExhaustedWindowStart: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart),
      setAutoRestartExhaustedWindowStart: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart, value),
      deleteAutoRestartExhaustedWindowStart: () =>
        this.ctx.storage.delete(CONTAINER_HEALTH_STORAGE_KEYS.autoRestartExhaustedWindowStart),
      getUnhealthyEpisodeStartedAt: () =>
        this.ctx.storage.get<number>(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt),
      setUnhealthyEpisodeStartedAt: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt, value),
      deleteUnhealthyEpisodeStartedAt: () =>
        this.ctx.storage.delete(CONTAINER_HEALTH_STORAGE_KEYS.unhealthyEpisodeStartedAt),
      getRecoveryPathHint: () =>
        this.ctx.storage.get<ContainerRecoveryPathHint>(
          CONTAINER_HEALTH_STORAGE_KEYS.recoveryPathHint
        ),
      setRecoveryPathHint: value =>
        this.ctx.storage.put(CONTAINER_HEALTH_STORAGE_KEYS.recoveryPathHint, value),
      deleteRecoveryPathHint: () =>
        this.ctx.storage.delete(CONTAINER_HEALTH_STORAGE_KEYS.recoveryPathHint),
      getContainerStub: id => getDepartmentContainerStub(this.env, id),
      writeEventFn: data => writeEvent(this.env, data),
      logWarnFn: data => logger.warn('container health watchdog', data),
      now: () => Date.now(),
    });
  }

  /**
   * Proactively remint KILOCODE_TOKEN when it's approaching expiry.
   * Throttled to once per day — the 30-day token is refreshed when
   * within 7 days of expiry, providing ample safety margin.
   *
   * Verifies the existing token's signature before trusting its claims,
   * preventing a forged near-expiry token from being re-signed with
   * real credentials.
   */
  private lastKilocodeTokenCheckAt = 0;
  private async refreshKilocodeTokenIfExpiring(): Promise<void> {
    const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
    const REFRESH_WINDOW_SECONDS = 7 * 24 * 60 * 60;
    const now = Date.now();
    if (now - this.lastKilocodeTokenCheckAt < CHECK_INTERVAL_MS) return;
    this.lastKilocodeTokenCheckAt = now;

    const departmentConfig = await this.getDepartmentConfig();
    const token = departmentConfig.kilocode_token;
    if (!token) return;

    if (!this.env.NEXTAUTH_SECRET) {
      logger.warn('refreshKilocodeTokenIfExpiring: NEXTAUTH_SECRET not configured');
      return;
    }
    const secret = await resolveSecret(this.env.NEXTAUTH_SECRET);
    if (!secret) {
      logger.warn('refreshKilocodeTokenIfExpiring: failed to resolve NEXTAUTH_SECRET');
      return;
    }

    // Verify the existing token's signature before trusting its claims.
    // This prevents a forged token from being re-signed with real credentials.
    // Use a very large clockTolerance so that already-expired (but validly
    // signed) tokens are still accepted — this alarm is the recovery path
    // for expired tokens, so rejecting them on exp would leave the department
    // permanently stuck if it missed the 7-day refresh window.
    let payload: { kiloUserId: string; apiTokenPepper?: string | null; exp?: number };
    try {
      const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;
      const { payload: raw } = await jwtVerify(token, new TextEncoder().encode(secret), {
        algorithms: ['HS256'],
        clockTolerance: TEN_YEARS_SECONDS,
      });
      const parsed = kiloTokenPayload.safeParse(raw);
      if (!parsed.success) {
        logger.warn('refreshKilocodeTokenIfExpiring: token payload failed schema validation');
        return;
      }
      payload = parsed.data;
    } catch {
      // Signature invalid or token malformed — don't remint from untrusted claims.
      logger.warn('refreshKilocodeTokenIfExpiring: existing token failed signature verification');
      return;
    }

    const exp = payload.exp;
    if (!exp) return;

    const nowSeconds = Math.floor(now / 1000);
    if (exp - nowSeconds > REFRESH_WINDOW_SECONDS) return;

    const userId = payload.kiloUserId;
    if (!userId) return;

    const newToken = await generateKiloApiToken(
      { id: userId, api_token_pepper: payload.apiTokenPepper ?? null },
      secret
    );
    await this.updateDepartmentConfig({ kilocode_token: newToken });
    await this.syncConfigToContainer();
    logger.info('refreshKilocodeTokenIfExpiring: reminted KILOCODE_TOKEN proactively', {
      userId,
      oldExp: new Date(exp * 1000).toISOString(),
    });
  }

  private hasActiveWork(): boolean {
    return scheduling.hasActiveWork(this.sql);
  }

  /** Dispatch a single agent to the container. Delegates to scheduling module. */
  private dispatchAgent(
    agent: Agent,
    ticket: Ticket,
    options?: { systemPromptOverride?: string }
  ): Promise<boolean> {
    return scheduling.dispatchAgent(this.schedulingCtx, agent, ticket, options);
  }

  /** When a ticket closes, dispatch any tickets it was blocking. */
  private dispatchUnblockedTickets(closedTicketId: string): void {
    scheduling.dispatchUnblockedTickets(this.schedulingCtx, closedTicketId);
  }

  /**
   * If triage_request tickets are queued, dispatch a short-lived triage
   * agent to process them. The triage agent gets a focused prompt with
   * the pending requests and a narrow tool set.
   *
   * Skips dispatch if a triage agent is already working.
   */
  private async maybeDispatchTriageAgent(
    cachedTriageCount?: number,
    cachedWorkstationList?: workstations.WorkstationRecord[]
  ): Promise<void> {
    const pendingCount = cachedTriageCount ?? attendance.countPendingTriageRequests(this.sql);
    if (pendingCount === 0) return;

    // Check if a triage batch ticket is already in progress (meaning a
    // triage agent is working), or recently failed (cooldown to prevent
    // rapid retry loops). Skip dispatch in either case.
    const triageBatchLike = attendance.TRIAGE_LABEL_LIKE.replace(
      attendance.TRIAGE_REQUEST_LABEL,
      attendance.TRIAGE_BATCH_LABEL
    );
    const cooldownCutoff = new Date(Date.now() - scheduling.DISPATCH_COOLDOWN_MS).toISOString();
    const existingBatch = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${tickets.ticket_id} FROM ${tickets}
          WHERE ${tickets.type} = 'issue'
            AND ${tickets.labels} LIKE ?
            AND ${tickets.created_by} = 'attendance'
            AND (
              ${tickets.status} IN ('open', 'in_progress')
              OR (${tickets.status} = 'failed' AND ${tickets.updated_at} > ?)
            )
          LIMIT 1
        `,
        [triageBatchLike, cooldownCutoff]
      ),
    ];
    if (existingBatch.length > 0) {
      console.log(
        `${DEPARTMENT_LOG} maybeDispatchTriageAgent: triage batch ticket active or in cooldown, skipping (${pendingCount} pending)`
      );
      return;
    }

    // Validate preconditions before creating any tickets to avoid
    // leaked phantom issue tickets on early-return paths.
    const workstationList = cachedWorkstationList ?? workstations.listWorkstations(this.sql);
    if (workstationList.length === 0) {
      console.warn(`${DEPARTMENT_LOG} maybeDispatchTriageAgent: no workstations available, skipping`);
      return;
    }
    const workstationId = workstationList[0].id;

    const workstationConfig = await this.getWorkstationConfig(workstationId);
    if (!workstationConfig) {
      console.warn(`${DEPARTMENT_LOG} maybeDispatchTriageAgent: no workstation config for workstation=${workstationId}`);
      return;
    }

    console.log(
      `${DEPARTMENT_LOG} maybeDispatchTriageAgent: ${pendingCount} pending triage request(s), dispatching agent`
    );

    const departmentConfig = await this.getDepartmentConfig();
    const kilocodeToken = await this.resolveKilocodeToken();

    const pendingRequests = attendance.listPendingTriageRequests(this.sql);
    const { buildTriageSystemPrompt } = await import('../prompts/triage-system.prompt');
    const systemPrompt = buildTriageSystemPrompt(pendingRequests);

    // Only now create the synthetic ticket — preconditions are verified.
    // Set workstation_id so that if Rule 3 resets this ticket to 'open' after a
    // dispatch timeout, Rule 1 of the reconciler can pick it up and
    // re-dispatch it (with the correct triage system prompt via Option B).
    const triageTicket = ticketOps.createTicket(this.sql, {
      type: 'issue',
      title: `Triage batch: ${pendingCount} request(s)`,
      body: 'Process all pending triage request tickets and resolve each one.',
      priority: 'high',
      labels: [attendance.TRIAGE_BATCH_LABEL],
      created_by: 'attendance',
      workstation_id: workstationId,
    });

    const triageAgent = agents.getOrCreateAgent(this.sql, 'soul', workstationId, this.departmentId);
    agents.hookTicket(this.sql, triageAgent.id, triageTicket.ticket_id);

    // Option A: Immediately mark the triage batch ticket as in_progress so
    // the reconciler's Rule 2 (idle agent + open hooked ticket → dispatch_agent)
    // does not re-fire on the next tick if the container start fails. Rule 3
    // (stale in_progress ticket + no working agent + 5-min timeout) will reset
    // it back to open if the dispatch fails, allowing a clean retry via
    // maybeDispatchTriageAgent with the correct triage system prompt.
    ticketOps.updateTicketStatus(this.sql, triageTicket.ticket_id, 'in_progress', triageAgent.id);

    const { started: triageStarted } = await dispatch.startAgentInContainer(
      this.env,
      this.ctx.storage,
      {
        departmentId: this.departmentId,
        workstationId,
        userId: workstationConfig.userId,
        agentId: triageAgent.id,
        agentName: triageAgent.name,
        role: 'soul',
        identity: triageAgent.identity,
        ticketId: triageTicket.ticket_id,
        ticketTitle: triageTicket.title,
        ticketBody: triageTicket.body ?? '',
        checkpoint: null,
        gitUrl: workstationConfig.gitUrl,
        defaultBranch: workstationConfig.defaultBranch,
        kilocodeToken,
        departmentConfig,
        systemPromptOverride: systemPrompt,
        platformIntegrationId: workstationConfig.platformIntegrationId,
        lightweight: true,
      }
    );

    if (triageStarted) {
      // Mark the agent as working so the duplicate-guard on the next
      // alarm tick sees it and skips dispatch.
      agents.updateAgentStatus(this.sql, triageAgent.id, 'working');
    } else {
      agents.unhookTicket(this.sql, triageAgent.id);
      // Failing the batch ticket triggers cooldown: the guard at the top of
      // this method skips dispatch while a failed batch ticket's updated_at
      // is within DISPATCH_COOLDOWN_MS.
      ticketOps.updateTicketStatus(this.sql, triageTicket.ticket_id, 'failed', triageAgent.id, {
        code: 'container_start_failed',
        message: 'Triage agent failed to start in container',
        source: 'container',
      });
      console.error(`${DEPARTMENT_LOG} maybeDispatchTriageAgent: triage agent failed to start`);
    }
  }

  /**
   * Push undelivered memo to agents that are currently running in the
   * container. For each working agent with open message tickets, we format
   * the messages and send them as a follow-up prompt via the container's
   * /agents/:id/message endpoint. The memo is then marked as delivered so
   * it isn't sent again on the next alarm tick.
   */
  private async deliverPendingMemo(): Promise<void> {
    const pendingByAgent = memo.getPendingMemoForWorkingAgents(this.sql);
    if (pendingByAgent.size === 0) return;

    console.log(
      `${DEPARTMENT_LOG} deliverPendingMemo: ${pendingByAgent.size} agent(s) with pending memo`
    );

    const deliveries = [...pendingByAgent.entries()].map(async ([agentId, messages]) => {
      const lines = messages.map(m => `[memo from ${m.from_agent_id}] ${m.subject}\n${m.body}`);
      const prompt = `You have ${messages.length} new memo message(s):\n\n${lines.join('\n\n---\n\n')}`;

      const sent = await dispatch.sendMessageToAgent(this.env, this.departmentId, agentId, prompt);

      if (sent) {
        // Mark delivered only after the container accepted the message
        memo.readAndDeliverMemo(this.sql, agentId);
        if (
          messages.some(
            m =>
              m.subject === 'TRIAGE_NUDGE' ||
              m.subject === 'GUPP_ESCALATION' ||
              m.subject === 'GUPP_CHECK'
          )
        ) {
          this.emitEvent({
            event: 'nudge.delivered',
            departmentId: this.departmentId,
            agentId,
          });
        }
        console.log(
          `${DEPARTMENT_LOG} deliverPendingMemo: delivered ${messages.length} message(s) to agent=${agentId}`
        );
      } else {
        console.warn(
          `${DEPARTMENT_LOG} deliverPendingMemo: failed to push memo to agent=${agentId}, will retry next tick`
        );
      }
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Bump severity of stale unacknowledged escalations.
   */
  private async reEscalateStaleEscalations(): Promise<void> {
    const candidates = [
      ...query(
        this.sql,
        /* sql */ `${ESCALATION_JOIN} WHERE ${tickets.status} NOT IN ('closed', 'failed') AND ${escalation_metadata.acknowledged} = 0 AND ${escalation_metadata.re_escalation_count} < ?`,
        [MAX_RE_ESCALATIONS]
      ),
    ].map(r => toEscalation(EscalationTicketRecord.parse(r)));

    const nowMs = Date.now();
    for (const esc of candidates) {
      const ageMs = nowMs - new Date(esc.created_at).getTime();
      const requiredAgeMs = (esc.re_escalation_count + 1) * STALE_ESCALATION_THRESHOLD_MS;
      if (ageMs < requiredAgeMs) continue;

      const currentIdx = SEVERITY_ORDER.indexOf(esc.severity);
      if (currentIdx < 0 || currentIdx >= SEVERITY_ORDER.length - 1) continue;

      const newSeverity = SEVERITY_ORDER[currentIdx + 1];
      query(
        this.sql,
        /* sql */ `
          UPDATE ${escalation_metadata}
          SET ${escalation_metadata.columns.severity} = ?,
              ${escalation_metadata.columns.re_escalation_count} = ${escalation_metadata.columns.re_escalation_count} + 1
          WHERE ${escalation_metadata.ticket_id} = ?
        `,
        [newSeverity, esc.id]
      );

      if (newSeverity !== 'low') {
        this.sendFrontDeskMessage(
          `[Re-Escalation:${newSeverity}] workstation=${esc.source_workstation_id} ${esc.message}`
        ).catch(err => {
          console.warn(`${DEPARTMENT_LOG} re-escalation: failed to notify frontDesk:`, err);
          try {
            ticketOps.logTicketEvent(this.sql, {
              ticketId: esc.id,
              agentId: null,
              eventType: 'notification_failed',
              metadata: {
                target: 'frontDesk',
                reason: err instanceof Error ? err.message : String(err),
                severity: newSeverity,
                re_escalation: true,
              },
            });
          } catch (logErr) {
            console.error(
              `${DEPARTMENT_LOG} re-escalation: failed to log notification_failed event:`,
              logErr
            );
          }
        });
      }
    }
  }

  private async ensureContainerReady(cachedWorkstationList?: workstations.WorkstationRecord[]): Promise<void> {
    if (this.containerStartsBlocked()) return;
    const workstationList = cachedWorkstationList ?? workstations.listWorkstations(this.sql);
    if (workstationList.length === 0) return;

    // Other active work starts the container when it is dispatched.
    if (!scheduling.hasRunningAgents(this.sql) && !this._draining) {
      const newestWorkstationAge = workstationList.reduce((min, r) => {
        const age = Date.now() - new Date(r.created_at).getTime();
        return Math.min(min, age);
      }, Infinity);
      const isRecentlyConfigured = newestWorkstationAge < 5 * 60_000;
      if (!isRecentlyConfigured) return;
    }

    const departmentId = this.departmentId;
    if (!departmentId) return;

    // Cloudflare container identity, stamped on boot lifecycle telemetry so it
    // correlates with Cloudflare support/dashboard and the watchdog events.
    const containerId = getDepartmentContainerDoId(this.env, departmentId);

    try {
      const container = getDepartmentContainerStub(this.env, departmentId);

      // Measure Cloudflare container cold-start latency only when warmUp()
      // actually starts the container. Already-running containers still rely
      // on the /health probe below as the application-level liveness source.
      try {
        const warm = await container.warmUp();
        if (warm.coldStart) {
          writeEvent(this.env, {
            event: 'container.cold_start',
            departmentId,
            containerId,
            durationMs: warm.durationMs,
          });
          // Dual-write boot lifecycle to Logpush (watchdog envelope) so Axiom
          // carries it too. Runs inside the alarm's withLogTags source scope.
          logger.warn('container health watchdog', {
            event: 'container.cold_start',
            departmentId,
            containerId,
            durationMs: warm.durationMs,
          });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
        writeEvent(this.env, {
          event: 'container.cold_start',
          departmentId,
          containerId,
          error,
        });
        logger.warn('container health watchdog', {
          event: 'container.cold_start',
          departmentId,
          containerId,
          error,
        });
        // Fall through to /health ping anyway — the container may recover.
      }

      // Always include X-department-Config so the container populates
      // lastKnownDepartmentConfig on startup — before any /agents/start arrives.
      // This ensures org context and credentials are available immediately
      // after a container restart when the first request is a model update
      // (PATCH /model) rather than a new agent start.
      const containerConfig = await config.buildContainerConfig(
        this.ctx.storage,
        this.env,
        this.departmentId
      );
      const headers: Record<string, string> = {
        'X-department-Config': JSON.stringify(containerConfig),
      };
      // When draining AND enough time has passed for the old container
      // to have exited (drainAll waits up to 10 min + exit), pass the
      // nonce so the replacement container can acknowledge readiness.
      // We only send the nonce after 11 minutes to avoid the old
      // (still-draining) container receiving it and clearing drain
      // prematurely — the health check goes to whichever container is
      // currently serving this department.
      const DRAIN_HANDOFF_DELAY_MS = 11 * 60 * 1000;
      if (
        this._draining &&
        this._drainNonce &&
        this._drainStartedAt &&
        Date.now() - this._drainStartedAt > DRAIN_HANDOFF_DELAY_MS
      ) {
        headers['X-Drain-Nonce'] = this._drainNonce;
        headers['X-department-Id'] = departmentId;
      }
      const t0 = Date.now();
      try {
        const healthResp = await container.fetch('http://container/health', {
          signal: AbortSignal.timeout(5_000),
          headers,
        });
        const durationMs = Date.now() - t0;
        if (!healthResp.ok) {
          writeEvent(this.env, {
            event: 'container.health_ping',
            departmentId,
            containerId,
            durationMs,
            statusCode: healthResp.status,
            error: `non-ok status ${healthResp.status}`,
          });
          await this.recordContainerHealthOutcome(departmentId, {
            ok: false,
            reason: 'non_ok',
            durationMs,
            statusCode: healthResp.status,
            error: `non-ok status ${healthResp.status}`,
          });
        } else {
          writeEvent(this.env, {
            event: 'container.health_ping',
            departmentId,
            containerId,
            durationMs,
            statusCode: healthResp.status,
          });
          await this.recordContainerHealthOutcome(departmentId, {
            ok: true,
            durationMs,
            statusCode: healthResp.status,
          });
          const rawBody: unknown = await healthResp.json().catch(() => null);
          const HealthBody = z
            .object({
              startedAt: z.string().optional(),
              uptime: z.number().optional(),
              frontDeskReadyAt: z.string().optional(),
            })
            .passthrough();
          const body = HealthBody.safeParse(rawBody);
          if (body.success && body.data.startedAt) {
            const containerStartedAt = new Date(body.data.startedAt).getTime();
            const readyDurationMs = Date.now() - containerStartedAt;
            writeEvent(this.env, {
              event: 'container.ready_observed',
              departmentId,
              containerId,
              containerStartedAt: body.data.startedAt,
              durationMs: readyDurationMs,
            });
            // Dual-write boot lifecycle to Logpush (watchdog envelope) for Axiom.
            logger.warn('container health watchdog', {
              event: 'container.ready_observed',
              departmentId,
              containerId,
              durationMs: readyDurationMs,
            });

            // Emit frontDesk.session_ready exactly once per container instance.
            // We store just the most recently reported startedAt in a single
            // key — when a container restarts, startedAt changes and we
            // re-emit, overwriting the previous value. This keeps storage
            // at O(1) rather than accumulating a key per container lifetime.
            if (body.data.frontDeskReadyAt) {
              const lastReportedStartedAt = await this.ctx.storage.get<string>(
                'frontDesk:ready_reported_for'
              );
              if (lastReportedStartedAt !== body.data.startedAt) {
                await this.ctx.storage.put('frontDesk:ready_reported_for', body.data.startedAt);
                const frontDeskReadyAt = new Date(body.data.frontDeskReadyAt).getTime();
                writeEvent(this.env, {
                  event: 'frontDesk.session_ready',
                  departmentId,
                  containerStartedAt: body.data.startedAt,
                  durationMs: frontDeskReadyAt - containerStartedAt,
                });
              }
            }
          }
        }
      } catch {
        const durationMs = Date.now() - t0;
        writeEvent(this.env, {
          event: 'container.health_ping',
          departmentId,
          containerId,
          durationMs,
          error: 'timeout',
        });
        await this.recordContainerHealthOutcome(departmentId, {
          ok: false,
          reason: 'timeout',
          durationMs,
          error: 'timeout',
        });
        // Container is starting up or unavailable — alarm will retry
      }
    } catch {
      // Outer try: buildContainerConfig or getDepartmentContainerStub failed
    }
  }

  private async armAlarmIfNeeded(): Promise<void> {
    // Don't resurrect the alarm on a destroyed DO. After destroy(),
    // department:id is wiped — if it's missing, the department was deleted.
    const storedId = await this.ctx.storage.get<string>('department:id');
    if (!storedId) return;

    const current = await this.ctx.storage.getAlarm();
    if (!current || current < Date.now()) {
      await this.ctx.storage.setAlarm(Date.now() + ACTIVE_ALARM_INTERVAL_MS);
    }
  }

  /**
   * Switch to active alarm cadence if the current alarm is too far out.
   * Only shortens the alarm — never pushes it back. This avoids starving
   * the reconciler during bursts of work creation (each call would
   * otherwise reset the 5s countdown).
   */
  private async escalateToActiveCadence(): Promise<void> {
    const storedId = await this.ctx.storage.get<string>('department:id');
    if (!storedId) return;

    const target = Date.now() + ACTIVE_ALARM_INTERVAL_MS;
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /**
   * Health check: verify the alarm is set and return basic department status.
   * Called by the HelldeskUserDO watchdog alarm to ensure each department's
   * alarm loop is firing. Re-arms the alarm if it's missing, picking the
   * cadence based on `hasActiveWork` so idle departments don't all wake up
   * on the fast 5s cadence after a deploy.
   */
  async healthCheck(): Promise<{
    departmentId: string;
    alarmSet: boolean;
    activeAgents: number;
    pendingTickets: number;
  }> {
    const departmentId = this.departmentId;

    const currentAlarm = await this.ctx.storage.getAlarm();
    const alarmSet = currentAlarm !== null && currentAlarm > Date.now();

    // Re-arm if missing — this is the whole point of the watchdog. Pick
    // the cadence to match observed activity: active departments recover fast,
    // idle departments don't pay the cost of a 5s wake-up storm across the fleet.
    if (!alarmSet) {
      const interval = scheduling.hasActiveWork(this.sql)
        ? ACTIVE_ALARM_INTERVAL_MS
        : IDLE_ALARM_INTERVAL_MS;
      console.warn(
        `${DEPARTMENT_LOG} healthCheck: alarm not set for department=${departmentId}, re-arming with ${interval}ms`
      );
      await this.ctx.storage.setAlarm(Date.now() + interval);
    }

    const activeAgents = Number(
      [
        ...query(
          this.sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM ${agent_metadata} WHERE ${agent_metadata.status} IN ('working', 'stalled')`,
          []
        ),
      ][0]?.cnt ?? 0
    );

    const pendingTickets = Number(
      [
        ...query(
          this.sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM ${tickets} WHERE ${tickets.status} IN ('open', 'in_progress', 'in_review') AND ${tickets.type} NOT IN ('agent', 'message')`,
          []
        ),
      ][0]?.cnt ?? 0
    );

    return { departmentId, alarmSet, activeAgents, pendingTickets };
  }

  /**
   * Return a structured snapshot of the alarm loop and attendance state
   * for the dashboard Status tab.
   */
  async getAlarmStatus(cached?: {
    activeWork?: boolean;
    triageCount?: number;
    billingStatus?: HelldeskBillingStatus;
  }): Promise<{
    alarm: {
      nextFireAt: string | null;
      intervalMs: number;
      intervalLabel: string;
    };
    agents: {
      working: number;
      waiting: number;
      idle: number;
      stalled: number;
      dead: number;
      total: number;
    };
    tickets: {
      open: number;
      inProgress: number;
      inReview: number;
      failed: number;
      triageRequests: number;
    };
    attendance: {
      guppWarnings: number;
      guppEscalations: number;
      stalledAgents: number;
      orphanedHooks: number;
    };
    reconciler: reconciler.ReconcilerMetrics | null;
    recentEvents: Array<{
      time: string;
      type: string;
      message: string;
    }>;
    draining?: boolean;
    drainStartedAt?: string;
    billing: HelldeskBillingStatus;
  }> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    const active = cached?.activeWork ?? this.hasActiveWork();
    const intervalMs = active ? ACTIVE_ALARM_INTERVAL_MS : IDLE_ALARM_INTERVAL_MS;

    const agentRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.status} AS status, COUNT(*) AS cnt
          FROM ${agent_metadata}
          GROUP BY ${agent_metadata.status}
        `,
        []
      ),
    ];
    const agentCounts = { working: 0, waiting: 0, idle: 0, stalled: 0, dead: 0, total: 0 };
    for (const row of agentRows) {
      const s = `${row.status as string}`;
      const c = Number(row.cnt);
      if (s in agentCounts) (agentCounts as Record<string, number>)[s] = c;
      agentCounts.total += c;
    }

    const ticketRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${tickets.status} AS status, COUNT(*) AS cnt
          FROM ${tickets}
          WHERE ${tickets.type} NOT IN ('agent', 'message')
          GROUP BY ${tickets.status}
        `,
        []
      ),
    ];
    const ticketCounts = {
      open: 0,
      inProgress: 0,
      inReview: 0,
      failed: 0,
      triageRequests: 0,
    };
    for (const row of ticketRows) {
      const s = `${row.status as string}`;
      const c = Number(row.cnt);
      if (s === 'open') ticketCounts.open = c;
      else if (s === 'in_progress') ticketCounts.inProgress = c;
      else if (s === 'in_review') ticketCounts.inReview = c;
      else if (s === 'failed') ticketCounts.failed = c;
    }

    // Triage request count (issue tickets with gt:triage-request label)
    ticketCounts.triageRequests = cached?.triageCount ?? attendance.countPendingTriageRequests(this.sql);

    // Attendance indicators — count active GUPP warnings + escalations in one query
    const guppRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT
            SUM(CASE WHEN ${tickets.title} = 'GUPP_CHECK' THEN 1 ELSE 0 END) AS warnings,
            SUM(CASE WHEN ${tickets.title} = 'GUPP_ESCALATION' THEN 1 ELSE 0 END) AS escalations
          FROM ${tickets}
          WHERE ${tickets.type} = 'message'
            AND ${tickets.title} IN ('GUPP_CHECK', 'GUPP_ESCALATION')
            AND ${tickets.status} = 'open'
        `,
        []
      ),
    ];
    const guppWarnings = Number(guppRows[0]?.warnings ?? 0);
    const guppEscalations = Number(guppRows[0]?.escalations ?? 0);

    const stalledAgents = agentCounts.stalled;

    // Only count idle+hooked agents as orphaned if they've been idle for
    // longer than the dispatch cooldown. Agents that were just hooked by
    // the reconciler or restarted with backoff are legitimately waiting
    // for the next scheduler tick.
    const orphanedHooks = Number(
      [
        ...query(
          this.sql,
          /* sql */ `
            SELECT COUNT(*) AS cnt FROM ${agent_metadata}
            WHERE ${agent_metadata.status} = 'idle'
              AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL
              AND (
                ${agent_metadata.last_activity_at} IS NULL
                OR ${agent_metadata.last_activity_at} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
              )
          `,
          []
        ),
      ][0]?.cnt ?? 0
    );

    const recentRows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT be.created_at, be.event_type, be.new_value, be.agent_id, be.ticket_id,
                 b.${tickets.columns.title} AS ticket_title
          FROM ticket_events AS be
          LEFT JOIN ${tickets} AS b ON be.ticket_id = b.${tickets.columns.ticket_id}
          ORDER BY be.created_at DESC
          LIMIT 20
        `,
        []
      ),
    ];

    const recentEvents = recentRows.map(row => ({
      time: `${row.created_at as string}`,
      type: `${row.event_type as string}`,
      message: formatEventMessage(row),
    }));

    const billing =
      cached?.billingStatus ??
      (isContainerUsageMeteringEnabled(this.env)
        ? // getBillingStatus is guarded and falls back to a degraded status, so
          // the Status tab never fails just because the container DO is
          // momentarily unreachable.
          await this.getBillingStatus()
        : {
            enabled: false,
            enforcing: false,
            state: 'idle' as const,
            runPolicy: this._containerRunPolicy,
          });

    return {
      alarm: {
        nextFireAt: currentAlarm ? new Date(Number(currentAlarm)).toISOString() : null,
        intervalMs,
        intervalLabel: active ? 'active (5s)' : 'idle (5m)',
      },
      agents: agentCounts,
      tickets: ticketCounts,
      attendance: {
        guppWarnings,
        guppEscalations,
        stalledAgents,
        orphanedHooks,
      },
      reconciler: this._lastReconcilerMetrics,
      recentEvents,
      draining: this._draining || undefined,
      drainStartedAt: this._drainStartedAt
        ? new Date(this._drainStartedAt).toISOString()
        : undefined,
      billing,
    };
  }

  // DEBUG: replay events from a time range, apply them to state, run the
  // reconciler, and return computed actions. Uses a savepoint + rollback so
  // no state is permanently modified.
  //
  // CAVEAT: events are re-applied on top of current (live) state, not from a
  // clean snapshot taken before the requested window. Non-idempotent handlers
  // (e.g. agentDone, completeReviewWithResult) may target different tickets than
  // they originally did, so actions and snapshots are approximate — useful for
  // debugging event flow, not for faithful historical reconstruction.
  async debugReplayEvents(
    from: string,
    to: string
  ): Promise<{
    caveat: string;
    eventsReplayed: number;
    actions: Action[];
    stateSnapshot: {
      agents: unknown[];
      nonTerminalTickets: unknown[];
    };
  }> {
    this.sql.exec('SAVEPOINT debug_replay_events');
    try {
      // Query ALL events in the time range regardless of processed_at
      const rangeEvents = DepartmentEventRecord.array().parse([
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${department_events.event_id}, ${department_events.event_type},
                   ${department_events.agent_id}, ${department_events.ticket_id},
                   ${department_events.payload}, ${department_events.created_at},
                   ${department_events.processed_at}
            FROM ${department_events}
            WHERE ${department_events.created_at} >= ?
              AND ${department_events.created_at} <= ?
            ORDER BY ${department_events.created_at} ASC
          `,
          [from, to]
        ),
      ]);

      for (const event of rangeEvents) {
        reconciler.applyEvent(this.sql, event);
      }

      const tc = await this.getDepartmentConfig();
      const actions = reconciler.reconcile(this.sql, {
        departmentConfig: tc,
      });

      const agentSnapshot = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${agent_metadata.ticket_id},
                   ${agent_metadata.role},
                   ${agent_metadata.status},
                   ${agent_metadata.current_hook_ticket_id},
                   ${agent_metadata.dispatch_attempts},
                   ${agent_metadata.last_activity_at}
            FROM ${agent_metadata}
          `,
          []
        ),
      ];

      const ticketSnapshot = [
        ...query(
          this.sql,
          /* sql */ `
            SELECT ${tickets.ticket_id},
                   ${tickets.type},
                   ${tickets.status},
                   ${tickets.title},
                   ${tickets.assignee_agent_ticket_id},
                   ${tickets.updated_at}
            FROM ${tickets}
            WHERE ${tickets.status} NOT IN ('closed', 'failed')
              AND ${tickets.type} != 'agent'
            ORDER BY ${tickets.type}, ${tickets.status}
          `,
          []
        ),
      ];

      return {
        caveat:
          'Events are re-applied on top of current live state, not from a pre-window snapshot. ' +
          'Non-idempotent handlers may produce different results than the original processing. ' +
          'Use for debugging event flow, not faithful historical reconstruction.',
        eventsReplayed: rangeEvents.length,
        actions,
        stateSnapshot: {
          agents: agentSnapshot,
          nonTerminalTickets: ticketSnapshot,
        },
      };
    } finally {
      this.sql.exec('ROLLBACK TO SAVEPOINT debug_replay_events');
      this.sql.exec('RELEASE SAVEPOINT debug_replay_events');
    }
  }

  // DEBUG: dry-run the reconciler against current state, returning actions
  // it would emit without applying them. Drains pending events first (same
  // as the real alarm loop) inside a savepoint that is rolled back, so the
  // endpoint remains fully side-effect-free.
  async debugDryRun(): Promise<{
    actions: Action[];
    metrics: Pick<
      reconciler.ReconcilerMetrics,
      'actionsEmitted' | 'actionsByType' | 'pendingEventCount' | 'eventsDrained'
    >;
  }> {
    // Use a savepoint so we can drain events (which mutates state)
    // then roll back without permanent side effects
    this.sql.exec('SAVEPOINT debug_dry_run');
    try {
      // Phase 0: Drain and apply pending events (same as real alarm loop)
      const pending = events.drainEvents(this.sql);
      for (const event of pending) {
        reconciler.applyEvent(this.sql, event);
        events.markProcessed(this.sql, event.event_id);
      }

      const tc2 = await this.getDepartmentConfig();
      const actions = reconciler.reconcile(this.sql, {
        departmentConfig: tc2,
      });
      const pendingEventCount = events.pendingEventCount(this.sql);
      const actionsByType: Record<string, number> = {};
      for (const a of actions) {
        actionsByType[a.type] = (actionsByType[a.type] ?? 0) + 1;
      }

      return {
        actions,
        metrics: {
          actionsEmitted: actions.length,
          actionsByType,
          pendingEventCount,
          eventsDrained: pending.length,
        },
      };
    } finally {
      this.sql.exec('ROLLBACK TO SAVEPOINT debug_dry_run');
      this.sql.exec('RELEASE SAVEPOINT debug_dry_run');
    }
  }

  // DEBUG: enumerate every ticket carrying a `metadata.helldesk` tag.
  // Used by the /debug/departments/:departmentId/helldesk-tickets endpoint to verify the
  // helldesk → ticket integration without going through the UI.
  // Returns `unknown[]` to keep Hono's response type inference shallow —
  // the caller validates / projects the rows it cares about.
  async debugListHelldeskTickets(): Promise<unknown[]> {
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${tickets}
          WHERE json_extract(${tickets.metadata}, '$.helldesk') IS NOT NULL
          ORDER BY ${tickets.created_at} DESC
        `,
        []
      ),
    ];
    return TicketRecord.array().parse(rows);
  }

  async debugTicketSummary(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${tickets.ticket_id},
                 ${tickets.type},
                 ${tickets.status},
                 ${tickets.title},
                 ${tickets.assignee_agent_ticket_id},
                 ${tickets.workstation_id},
                 ${tickets.created_by},
                 ${tickets.labels},
                 ${tickets.metadata},
                 ${tickets.updated_at}
          FROM ${tickets}
          WHERE ${tickets.status} NOT IN ('closed', 'failed')
            AND ${tickets.type} != 'agent'
          ORDER BY ${tickets.type}, ${tickets.status}
        `,
        []
      ),
    ];
  }

  async debugPendingNudges(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_nudges.nudge_id},
                 ${agent_nudges.agent_ticket_id},
                 ${agent_nudges.message},
                 ${agent_nudges.mode},
                 ${agent_nudges.priority},
                 ${agent_nudges.source},
                 ${agent_nudges.created_at},
                 ${agent_nudges.delivered_at},
                 ${agent_nudges.expires_at}
          FROM ${agent_nudges}
          WHERE ${agent_nudges.delivered_at} IS NULL
          ORDER BY ${agent_nudges.created_at} DESC
          LIMIT 20
        `,
        []
      ),
    ];
  }

  async debugGetTicket(ticketId: string): Promise<unknown> {
    const ticket = ticketOps.getTicket(this.sql, ticketId);
    if (!ticket) return { error: 'ticket not found' };

    const reviewMeta = reviewQueue.getReviewMetadata(this.sql, ticketId);
    const deps = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${ticket_dependencies.ticket_id},
                 ${ticket_dependencies.depends_on_ticket_id},
                 ${ticket_dependencies.dependency_type}
          FROM ${ticket_dependencies}
          WHERE ${ticket_dependencies.ticket_id} = ?
             OR ${ticket_dependencies.depends_on_ticket_id} = ?
        `,
        [ticketId, ticketId]
      ),
    ];

    return { ticket, reviewMetadata: reviewMeta ?? null, dependencies: deps };
  }

  async debugAgentMetadata(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${agent_metadata.ticket_id},
                 ${agent_metadata.role},
                 ${agent_metadata.status},
                 ${agent_metadata.current_hook_ticket_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
        `,
        []
      ),
    ];
  }

  async debugDepartmentEvents(): Promise<unknown[]> {
    return [
      ...query(
        this.sql,
        /* sql */ `
          SELECT ${department_events.event_id},
                 ${department_events.event_type},
                 ${department_events.agent_id},
                 ${department_events.ticket_id},
                 ${department_events.processed_at}
          FROM ${department_events}
          ORDER BY ${department_events.created_at} ASC
        `,
        []
      ),
    ];
  }

  /**
   * Test-only helper: directly insert a row into the department_events queue
   * without going through the producer APIs. Used to reproduce orphan
   * events (referencing deleted tickets/agents) in tests.
   */
  async debugInsertDepartmentEvent(input: {
    event_type: DepartmentEventType;
    agent_id?: string | null;
    ticket_id?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const eventId = events.insertEvent(this.sql, input.event_type, {
      agent_id: input.agent_id ?? null,
      ticket_id: input.ticket_id ?? null,
      payload: input.payload ?? {},
    });
    await this.armAlarmIfNeeded();
    return eventId;
  }

  /**
   * Test-only helper: insert a container_status event for a given agent.
   * Mirrors the container observer's upsert so tests can verify that
   * deleteTicket sweeps agent-keyed events.
   */
  async debugRecordContainerStatus(
    agentId: string,
    payload: { status: string; exit_reason?: string | null }
  ): Promise<void> {
    events.upsertContainerStatus(this.sql, agentId, payload);
  }

  async destroy(): Promise<void> {
    console.log(`${DEPARTMENT_LOG} destroy: clearing all storage and alarms`);

    // Destroy all AgentDOs (clears agent_events tables)
    try {
      const allAgents = agents.listAgents(this.sql);
      await Promise.allSettled(
        allAgents.map(agent => getAgentDOStub(this.env, agent.id).destroy())
      );
    } catch (err) {
      console.warn(`${DEPARTMENT_LOG} destroy: agent cleanup failed`, err);
    }

    // Attempt to settle usage before destroying container state, but never let
    // a billing-settlement failure block storage teardown — otherwise the department
    // would be left un-destroyable until the container/billing path recovers.
    // The container DO force-closes stale intervals for reconciliation anyway.
    const containerStub = getDepartmentContainerStub(this.env, this.departmentId);
    try {
      await containerStub.destroyWithBilling();
    } catch (err) {
      console.warn(`${DEPARTMENT_LOG} destroy: container billing settlement failed`, err);
      await containerStub.destroy().catch(destroyErr => {
        console.warn(`${DEPARTMENT_LOG} destroy: container cleanup failed`, destroyErr);
      });
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export function getDepartmentDOStub(env: Env, departmentId: string) {
  return env.department.get(env.department.idFromName(departmentId));
}
