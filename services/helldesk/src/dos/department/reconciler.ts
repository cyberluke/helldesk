/**
 * Department Reconciler — read-only state reconciliation engine.
 *
 * Each reconcile function examines current state and returns Action[]
 * describing what mutations are needed to bring the system toward its
 * desired state. Rules are checked on every alarm tick.
 *
 * In Phase 2 (shadow mode), actions are logged but not applied.
 * In Phase 3+, actions are applied via applyAction().
 *
 * See reconciliation-spec.md §5.3.
 */

import { z } from 'zod';
import { tickets, TicketRecord } from '../../db/tables/tickets.table';
import { agent_metadata, AgentMetadataRecord } from '../../db/tables/agent-metadata.table';
import { review_metadata, ReviewMetadataRecord } from '../../db/tables/review-metadata.table';
import { shift_metadata, ShiftMetadataRecord } from '../../db/tables/shift-metadata.table';
import { ticket_dependencies } from '../../db/tables/ticket-dependencies.table';
import { agent_nudges } from '../../db/tables/agent-nudges.table';
import { escalation_metadata } from '../../db/tables/escalation-metadata.table';
import { query } from '../../util/query.util';
import {
  GUPP_ESCALATE_MS,
  GUPP_FORCE_STOP_MS,
  AGENT_GC_RETENTION_MS,
  TRIAGE_LABEL_LIKE,
  HELD_LABEL_LIKE,
  createTriageRequest,
} from './attendance';
import { MAX_DISPATCH_ATTEMPTS } from './scheduling';
import * as reviewQueue from './review-queue';
import * as agents from './agents';
import * as ticketOps from './tickets';
import { getWorkstation } from './workstations';
import { resolveWorkstationConfig } from './config';
import { PR_POLL_INTERVAL_MS } from './actions';
import type { Action } from './actions';
import type { DepartmentEventRecord } from '../../db/tables/department-events.table';
import type { DepartmentConfig } from '../../types';
import {
  buildEvidence,
  computeClaimStatus,
  groupTicketsByHelldeskClaim,
  isAlreadyReported,
  type ReporterTicket,
} from './helldesk-reporter';

const LOG = '[reconciler]';

/** Number of dispatch failures in a 30-min window to trip the department-level breaker. */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 20;
const CIRCUIT_BREAKER_WINDOW_MINUTES = 30;

/** Max landing MR creation attempts before failing the shift (#2260). */
const MAX_LANDING_MR_ATTEMPTS = 5;

/** Base cooldown for landing MR retry: min(2^attempts * BASE, MAX) (#2260). */
const LANDING_MR_COOLDOWN_BASE_MS = 30_000;

/** Max cooldown for landing MR retry (#2260). */
const LANDING_MR_COOLDOWN_MAX_MS = 30 * 60_000;

/**
 * department-level dispatch circuit breaker. Counts tickets with at least one
 * dispatch attempt in the recent window that have not yet closed
 * successfully. This captures tickets in active retry loops (in_progress
 * after a failed container start), tickets that have been explicitly
 * failed, and tickets that exhausted all attempts — while excluding
 * tickets that eventually succeeded (status = 'closed').
 */
function checkDispatchCircuitBreaker(sql: SqlStorage): Action[] {
  const rows = z
    .object({ failure_count: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT count(*) as failure_count
          FROM ${tickets}
          WHERE ${tickets.last_dispatch_attempt_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${CIRCUIT_BREAKER_WINDOW_MINUTES} minutes')
            AND ${tickets.dispatch_attempts} > 0
            AND ${tickets.status} != 'closed'
        `,
        []
      ),
    ]);

  const failureCount = rows[0]?.failure_count ?? 0;
  if (failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    console.warn(
      `${LOG} circuit breaker OPEN: ${failureCount} dispatch failures in last ${CIRCUIT_BREAKER_WINDOW_MINUTES}min (threshold=${CIRCUIT_BREAKER_FAILURE_THRESHOLD})`
    );
    return [
      {
        type: 'notifyFrontDesk',
        message: `Dispatch circuit breaker is OPEN: ${failureCount} dispatch failures in the last ${CIRCUIT_BREAKER_WINDOW_MINUTES} minutes. All dispatch actions are paused until failures clear.`,
      },
    ];
  }
  return [];
}

// ── Timeouts (from spec §7) ─────────────────────────────────────────

/** Reset non-PR MR tickets stuck in_progress with no working agent */
const STUCK_REVIEW_TIMEOUT_MS = 30 * 60_000;

/** Reset unhooked MR tickets to open */
const ABANDONED_MR_TIMEOUT_MS = 2 * 60_000;

/** Reset in_review tickets with all-terminal MRs */
const ORPHANED_SOURCE_TIMEOUT_MS = 5 * 60_000;

/** Fail PR-strategy tickets with dead agents */
const ORPHANED_PR_REVIEW_TIMEOUT_MS = 30 * 60_000;

/** In-progress issue ticket with no working agent considered stale.
 * Must be longer than AGENT_IDLE_TIMEOUT_MS (2 min) + one alarm tick (5s)
 * to avoid racing with the idle-timer → agentCompleted → reconciler flow. */
const STALE_IN_PROGRESS_TIMEOUT_MS = 5 * 60_000;

/** Time in 'stalled' before auto-transitioning to idle.
 * Today, stalled agents are only cleared via container_status: exited|not_found
 * events. If the container crashed hard or /status keeps returning
 * running/unknown, the stalled row persists indefinitely. This time-based
 * cleanup closes the loop. */
const STALLED_AUTO_IDLE_MS = 2.5 * 60 * 60_000;

// ── Helper: staleness check ─────────────────────────────────────────

function staleMs(timestamp: string | null, thresholdMs: number): boolean {
  if (!timestamp) return true;
  return Date.now() - new Date(timestamp).getTime() > thresholdMs;
}

function getDispatchCooldownMs(dispatchAttempts: number): number {
  if (dispatchAttempts <= 1) return 30_000;
  if (dispatchAttempts === 2) return 60_000;
  if (dispatchAttempts === 3) return 2 * 60_000;
  if (dispatchAttempts === 4) return 5 * 60_000;
  return 10 * 60_000;
}

const AgentRow = AgentMetadataRecord.pick({
  ticket_id: true,
  role: true,
  status: true,
  current_hook_ticket_id: true,
  dispatch_attempts: true,
  last_activity_at: true,
  last_event_type: true,
  last_event_at: true,
  active_tools: true,
  stalled_at: true,
}).extend({
  workstation_id: ticketRecord.shape.workstation_id,
});
type AgentRow = z.infer<typeof AgentRow>;

const TicketRow = TicketRecord.pick({
  ticket_id: true,
  type: true,
  status: true,
  workstation_id: true,
  assignee_agent_ticket_id: true,
  updated_at: true,
  labels: true,
  created_by: true,
  dispatch_attempts: true,
  last_dispatch_attempt_at: true,
});
type TicketRow = z.infer<typeof TicketRow>;

const MrTicketRow = TicketRecord.pick({
  ticket_id: true,
  status: true,
  workstation_id: true,
  updated_at: true,
  assignee_agent_ticket_id: true,
  metadata: true,
}).extend({
  pr_url: ReviewMetadataRecord.shape.pr_url,
});
type MrTicketRow = z.infer<typeof MrTicketRow>;

const ShiftRow = TicketRecord.pick({
  ticket_id: true,
  status: true,
}).extend({
  // Joined from shift_metadata
  total_tickets: shiftMetadataRecord.shape.total_tickets,
  closed_tickets: shiftMetadataRecord.shape.closed_tickets,
  feature_branch: shiftMetadataRecord.shape.feature_branch,
  merge_mode: shiftMetadataRecord.shape.merge_mode,
  staged: ShiftMetadataRecord.shape.staged,
  metadata: z.string(),
});
type ShiftRow = z.infer<typeof ShiftRow>;

/**
 * Apply a single event to the database. Events represent facts that
 * have occurred; applying them updates state to reflect those facts.
 *
 * Delegates to existing module functions to ensure identical behavior
 * to the pre-reconciler system.
 *
 * See reconciliation-spec.md §5.2.
 */
export function applyEvent(
  sql: SqlStorage,
  event: DepartmentEventRecord,
  opts?: { departmentConfig?: DepartmentConfig }
): void {
  const payload = event.payload;

  switch (event.event_type) {
    case 'agent_done': {
      if (!event.agent_id) {
        console.warn(`${LOG} applyEvent: agent_done missing agent_id`);
        return;
      }
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const pr_url = typeof payload.pr_url === 'string' ? payload.pr_url : undefined;
      const summary = typeof payload.summary === 'string' ? payload.summary : undefined;

      reviewQueue.agentDone(sql, event.agent_id, { branch, pr_url, summary });
      return;
    }

    case 'agent_completed': {
      if (!event.agent_id) {
        console.warn(`${LOG} applyEvent: agent_completed missing agent_id`);
        return;
      }
      const status =
        payload.status === 'completed' || payload.status === 'failed' ? payload.status : 'failed';
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;

      reviewQueue.agentCompleted(sql, event.agent_id, { status, reason });
      return;
    }

    case 'pr_status_changed': {
      if (!event.ticket_id) {
        console.warn(`${LOG} applyEvent: pr_status_changed missing ticket_id`);
        return;
      }
      const pr_state = payload.pr_state;
      if (pr_state === 'merged') {
        reviewQueue.completeReviewWithResult(sql, {
          entry_id: event.ticket_id,
          status: 'merged',
          message: 'PR merged (detected by polling)',
        });
      } else if (pr_state === 'closed') {
        reviewQueue.completeReviewWithResult(sql, {
          entry_id: event.ticket_id,
          status: 'failed',
          message: 'PR closed without merge',
        });
      }
      return;
    }

    case 'ticket_created': {
      // No state change needed — ticket already exists in DB.
      // Reconciler will pick it up as unassigned on next pass.
      return;
    }

    case 'ticket_cancelled': {
      if (!event.ticket_id) {
        console.warn(`${LOG} applyEvent: ticket_cancelled missing ticket_id`);
        return;
      }
      // Tolerate the ticket having been deleted after the event was enqueued.
      // Without this guard updateTicketStatus throws `Ticket <id> not found`,
      // the drain loop can't mark the event processed, and the error
      // recurs on every alarm tick forever.
      const existing = ticketOps.getTicket(sql, event.ticket_id);
      if (!existing) {
        console.warn(
          `${LOG} applyEvent: ticket_cancelled target ticket ${event.ticket_id} no longer exists — skipping`
        );
        return;
      }
      const cancelStatus =
        payload.cancel_status === 'closed' || payload.cancel_status === 'failed'
          ? payload.cancel_status
          : 'failed';

      ticketOps.updateTicketStatus(sql, event.ticket_id, cancelStatus, 'system');

      const hookedAgentRows = z
        .object({ ticket_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
            SELECT ${agent_metadata.ticket_id}
            FROM ${agent_metadata}
            WHERE ${agent_metadata.current_hook_ticket_id} = ?
          `,
            [event.ticket_id]
          ),
        ]);
      for (const row of hookedAgentRows) {
        agents.unhookTicket(sql, row.ticket_id);
      }
      return;
    }

    case 'shift_started': {
      const shiftId = typeof payload.shift_id === 'string' ? payload.shift_id : null;
      if (!shiftId) {
        console.warn(`${LOG} applyEvent: shift_started missing shift_id`);
        return;
      }
      query(
        sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.staged} = 0
          WHERE ${shift_metadata.columns.ticket_id} = ?
        `,
        [shiftId]
      );
      return;
    }

    case 'container_status': {
      if (!event.agent_id) return;

      const containerStatus = payload.status as string;
      const agent = agents.getAgent(sql, event.agent_id);
      if (!agent) return;

      // Only act on working/stalled agents whose container has stopped.
      // For 'not_found': skip if the agent was dispatched recently (#1358).
      // During a cold start the container may 404 on /agents/:id/status
      // because the agent hasn't registered in the process manager yet.
      // The 3-minute grace period covers the 60s HTTP timeout plus
      // typical cold start time (git clone + worktree). Truly dead
      // agents are caught by reconcileAgents after 90s of no heartbeats.
      if (containerStatus === 'not_found' && agent.last_activity_at) {
        const ageSec = (Date.now() - new Date(agent.last_activity_at).getTime()) / 1000;
        if (ageSec < 180) return; // 3-minute grace for cold starts
      }

      if (
        (agent.status === 'working' || agent.status === 'stalled') &&
        (containerStatus === 'exited' || containerStatus === 'not_found')
      ) {
        if (agent.role === 'qualityAssurance') {
          // Check if gt_done already completed the MR
          if (agent.current_hook_ticket_id) {
            const mr = ticketOps.getTicket(sql, agent.current_hook_ticket_id);
            if (mr && (mr.status === 'closed' || mr.status === 'failed')) {
              // MR already terminal — clean up the qualityAssurance
              agents.unhookTicket(sql, event.agent_id);
              agents.updateAgentStatus(sql, event.agent_id, 'idle');
              agents.writeCheckpoint(sql, event.agent_id, null);
            } else {
              // QualityAssurance died without completing — set idle, keep hook.
              // reconcileReviewQueue Rule 6 will retry dispatch.
              agents.updateAgentStatus(sql, event.agent_id, 'idle');
            }
          } else {
            agents.updateAgentStatus(sql, event.agent_id, 'idle');
          }
        } else {
          // Non-quality-assurance died — set idle. Ticket stays in_progress.
          // reconcileTickets Rule 3 will reset it to open after 5 min.
          agents.updateAgentStatus(sql, event.agent_id, 'idle');
        }
      }
      return;
    }

    case 'container_eviction': {
      // Draining flag is managed by the DepartmentDO via KV storage.
      // The reconciler reads it from there; no SQL state change needed here.
      // The event is recorded for audit trail.
      return;
    }

    case 'nudge_timeout': {
      // GUPP violations are handled by reconcileGUPP on the next pass.
      // The event just records the fact for audit trail.
      return;
    }

    case 'pr_feedback_detected': {
      const mrTicketId = typeof payload.mr_ticket_id === 'string' ? payload.mr_ticket_id : null;
      if (!mrTicketId) {
        console.warn(`${LOG} applyEvent: pr_feedback_detected missing mr_ticket_id`);
        return;
      }

      const mrTicket = ticketOps.getTicket(sql, mrTicketId);
      if (!mrTicket || mrTicket.status === 'closed' || mrTicket.status === 'failed') return;

      if (hasExistingPrFeedbackTicket(sql, mrTicketId)) return;

      const prUrl = typeof payload.pr_url === 'string' ? payload.pr_url : '';
      const prNumber = typeof payload.pr_number === 'number' ? payload.pr_number : 0;
      const repo = typeof payload.repo === 'string' ? payload.repo : '';
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const hasUnresolvedComments = payload.has_unresolved_comments === true;
      const hasFailingChecks = payload.has_failing_checks === true;
      const hasUncheckedRuns = payload.has_unchecked_runs === true;

      // Consolidation: if there's already an open gt:pr-conflict ticket for this MR,
      // add has_feedback: true to it instead of creating a separate feedback ticket.
      // The agent resolving conflicts will then also address review feedback afterward.
      const existingConflictTicketId = getExistingPrConflictTicketId(sql, mrTicketId);
      if (existingConflictTicketId) {
        query(
          sql,
          /* sql */ `
            UPDATE ${tickets}
            SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.has_feedback', 1),
                ${tickets.columns.updated_at} = ?
            WHERE ${tickets.ticket_id} = ?
          `,
          [new Date().toISOString(), existingConflictTicketId]
        );
        console.log(
          `${LOG} pr_feedback_detected: merged into existing conflict ticket ${existingConflictTicketId} (mrTicketId=${mrTicketId})`
        );
        return;
      }

      const feedbackTicket = ticketOps.createTicket(sql, {
        type: 'issue',
        title: buildFeedbackTicketTitle(
          prNumber,
          repo,
          hasUnresolvedComments,
          hasFailingChecks,
          hasUncheckedRuns
        ),
        body: buildFeedbackPrompt(
          prNumber,
          repo,
          branch,
          hasUnresolvedComments,
          hasFailingChecks,
          hasUncheckedRuns
        ),
        workstation_id: mrTicket.workstation_id ?? undefined,
        parent_ticket_id: mrTicketId,
        labels: ['gt:pr-feedback'],
        metadata: {
          pr_feedback_for: mrTicketId,
          pr_url: prUrl,
          branch,
        },
      });

      ticketOps.insertDependency(sql, mrTicketId, feedbackTicket.ticket_id, 'blocks');
      return;
    }

    case 'pr_conflict_detected': {
      const mrTicketId = typeof payload.mr_ticket_id === 'string' ? payload.mr_ticket_id : null;
      if (!mrTicketId) {
        console.warn(`${LOG} applyEvent: pr_conflict_detected missing mr_ticket_id`);
        return;
      }

      const mrTicket = ticketOps.getTicket(sql, mrTicketId);
      if (!mrTicket || mrTicket.status === 'closed' || mrTicket.status === 'failed') return;

      // Idempotent: check for an existing open gt:pr-conflict ticket for this pr_url
      if (hasExistingPrConflictTicket(sql, mrTicketId)) return;

      const prUrl = typeof payload.pr_url === 'string' ? payload.pr_url : '';
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const sourceTicket = typeof payload.source_ticket_id === 'string' ? payload.source_ticket_id : null;

      const rmRows = z
        .object({ target_branch: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
              SELECT ${review_metadata.columns.target_branch}
              FROM ${review_metadata}
              WHERE ${review_metadata.ticket_id} = ?
            `,
            [mrTicketId]
          ),
        ]);
      const targetBranch = rmRows[0]?.target_branch ?? '';

      // Read auto_resolve_merge_conflicts using the same fallback chain as
      // auto_resolve_pr_feedback: workstation override → department config → default (true).
      const workstation = mrTicket.workstation_id ? getWorkstation(sql, mrTicket.workstation_id) : null;
      const effectiveConfig = opts?.departmentConfig
        ? resolveWorkstationConfig(opts.departmentConfig, workstation?.config ?? null)
        : { auto_resolve_merge_conflicts: workstation?.config?.auto_resolve_merge_conflicts !== false };
      const autoResolveConflicts = effectiveConfig.auto_resolve_merge_conflicts !== false;

      if (autoResolveConflicts) {
        // Consolidation: if there's already an open gt:pr-feedback ticket for this MR,
        // add has_conflicts: true to it instead of creating a separate conflict ticket.
        // The agent handling the feedback ticket will resolve conflicts first, then
        // address review comments.
        const existingFeedbackTicketId = getExistingPrFeedbackTicketId(sql, mrTicketId);
        if (existingFeedbackTicketId) {
          query(
            sql,
            /* sql */ `
              UPDATE ${tickets}
              SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.has_conflicts', 1, '$.conflict_target_branch', ?),
                  ${tickets.columns.updated_at} = ?
              WHERE ${tickets.ticket_id} = ?
            `,
            [targetBranch, new Date().toISOString(), existingFeedbackTicketId]
          );
          console.log(
            `${LOG} pr_conflict_detected: merged into existing feedback ticket ${existingFeedbackTicketId} (mrTicketId=${mrTicketId})`
          );
          return;
        }

        const conflictTicket = ticketOps.createTicket(sql, {
          type: 'issue',
          title: `Resolve merge conflicts on PR: ${branch}`,
          body: buildConflictResolutionPrompt(prUrl, branch, targetBranch),
          workstation_id: mrTicket.workstation_id ?? undefined,
          parent_ticket_id: mrTicketId,
          labels: ['gt:pr-conflict'],
          metadata: {
            pr_url: prUrl,
            branch,
            target_branch: targetBranch,
            mr_ticket_id: mrTicketId,
            source_ticket_id: sourceTicket,
          },
        });

        ticketOps.insertDependency(sql, mrTicketId, conflictTicket.ticket_id, 'blocks');
      } else {
        // auto_resolve_merge_conflicts disabled — route through the full
        // escalation pipeline so escalation_metadata, triage request, and
        // frontDesk notification are all created (same path as routeEscalation()).
        const escalationTicket = ticketOps.createTicket(sql, {
          type: 'escalation',
          title: `Merge conflict detected: ${branch}`,
          body: `PR ${prUrl} (branch ${branch}) has merge conflicts that require manual resolution.`,
          priority: 'high',
          workstation_id: mrTicket.workstation_id ?? undefined,
          labels: ['gt:escalation', 'severity:high'],
          metadata: {
            pr_url: prUrl,
            branch,
            target_branch: targetBranch,
            mr_ticket_id: mrTicketId,
            source_ticket_id: sourceTicket,
            conflict: true,
          },
        });
        query(
          sql,
          /* sql */ `
            INSERT INTO ${escalation_metadata} (
              ${escalation_metadata.columns.ticket_id},
              ${escalation_metadata.columns.severity},
              ${escalation_metadata.columns.category},
              ${escalation_metadata.columns.acknowledged},
              ${escalation_metadata.columns.re_escalation_count},
              ${escalation_metadata.columns.acknowledged_at}
            ) VALUES (?, ?, ?, ?, ?, ?)
          `,
          [escalationTicket.ticket_id, 'high', 'merge_conflict', 0, 0, null]
        );
        createTriageRequest(sql, {
          triageType: 'escalation',
          agentTicketId: null,
          title: `Escalation (high): Merge conflict on ${branch}`,
          context: {
            escalation_ticket_id: escalationTicket.ticket_id,
            severity: 'high',
            workstation_id: mrTicket.workstation_id,
            category: 'merge_conflict',
            pr_url: prUrl,
            branch,
            mr_ticket_id: mrTicketId,
          },
          options: ['ESCALATE_TO_FRONT_DESK', 'RESTART', 'CLOSE_TICKET', 'REASSIGN_TICKET'],
          workstationId: mrTicket.workstation_id ?? undefined,
        });
      }
      return;
    }

    case 'pr_auto_merge': {
      const mrTicketId = typeof payload.mr_ticket_id === 'string' ? payload.mr_ticket_id : null;
      if (!mrTicketId) {
        console.warn(`${LOG} applyEvent: pr_auto_merge missing mr_ticket_id`);
        return;
      }

      const mrTicket = ticketOps.getTicket(sql, mrTicketId);
      if (!mrTicket || mrTicket.status === 'closed' || mrTicket.status === 'failed') return;

      // The actual merge is handled by the merge_pr side effect generated by
      // the reconciler on the next tick when it sees this event has been processed.
      // We just mark the intent here via metadata.
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.auto_merge_pending', 1),
              ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [new Date().toISOString(), mrTicketId]
      );
      return;
    }

    default: {
      console.warn(`${LOG} applyEvent: unknown event type: ${event.event_type}`);
    }
  }
}

export function reconcile(
  sql: SqlStorage,
  opts?: { draining?: boolean; departmentConfig?: DepartmentConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];
  actions.push(...reconcileAgents(sql, { draining }));
  actions.push(...reconcileTickets(sql, { draining, departmentConfig: opts?.departmentConfig }));
  actions.push(...reconcileReviewQueue(sql, { draining, departmentConfig: opts?.departmentConfig }));
  actions.push(...reconcileShifts(sql));
  actions.push(...reconcileGUPP(sql, { draining }));
  actions.push(...reconcileGC(sql));
  actions.push(...reconcileHelldeskClaims(sql));
  return actions;
}

export function reconcileAgents(sql: SqlStorage, opts?: { draining?: boolean }): Action[] {
  const actions: Action[] = [];

  // Working agents with stale or missing heartbeat — container probably dead.
  // This is a safety net: the container status observation pre-phase
  // emits container_status events which are applied in Phase 0, but
  // if that fails (e.g. container DO unreachable), this catches agents
  // whose heartbeat stopped. 3 missed heartbeats (90s) = container dead.
  // Agents with NULL last_activity_at never received a heartbeat at all
  // (container may have failed to start).
  const workingAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.status} = 'working'
      `,
      []
    ),
  ]);

  for (const agent of workingAgents) {
    // FrontDesk are always working with no hook — skip them
    if (agent.role === 'frontDesk') continue;

    // During container drain the heartbeat reporter is stopped, so
    // last_activity_at freezes. Skip stale-heartbeat checks to avoid
    // false-positive idle transitions while agents are still working.
    if (opts?.draining) continue;

    if (!agent.last_activity_at) {
      // No heartbeat ever received — container may have failed to start
      actions.push({
        type: 'transition_agent',
        agent_id: agent.ticket_id,
        from: 'working',
        to: 'idle',
        reason: 'no heartbeat received since dispatch',
      });
    } else if (staleMs(agent.last_activity_at, 90_000)) {
      actions.push({
        type: 'transition_agent',
        agent_id: agent.ticket_id,
        from: 'working',
        to: 'idle',
        reason: 'heartbeat lost (3 missed cycles)',
      });
    } else if (!agent.current_hook_ticket_id) {
      // Agent is working with fresh heartbeat but no hook — it's running
      // in the container but has no ticket to work on (gt_done already ran,
      // or the hook was cleared by another code path). Set to idle so
      // the reconciler can dispatch it to new work.
      actions.push({
        type: 'transition_agent',
        agent_id: agent.ticket_id,
        from: 'working',
        to: 'idle',
        reason: 'working agent has no hook (gt_done already completed)',
      });
    }
  }

  // Stalled agents that have been stuck past STALLED_AUTO_IDLE_MS —
  // transition to idle and unhook. Without this, a stalled row persists
  // indefinitely if its container crashed hard or its /status keeps
  // returning running/unknown (so the container_status → exited|not_found
  // cleanup path never fires). Skip during drain to match working-agent
  // handling above.
  if (!opts?.draining) {
    const longStalledAgents = AgentRow.array().parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
                 ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at},
                 ${agent_metadata.stalled_at},
                 b.${tickets.columns.workstation_id}
          FROM ${agent_metadata}
          LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
          WHERE ${agent_metadata.status} = 'stalled'
        `,
        []
      ),
    ]);

    for (const agent of longStalledAgents) {
      // Measure stalled duration from when the agent entered `stalled`,
      // not from last_activity_at. Heartbeats keep arriving after GUPP
      // force-stops a stalled container, which would otherwise collapse
      // the 2.5h recovery window down to ~30min.
      if (!agent.stalled_at) continue;
      const stalledMs = Date.now() - new Date(agent.stalled_at).getTime();
      if (stalledMs <= STALLED_AUTO_IDLE_MS) continue;

      actions.push({
        type: 'transition_agent',
        agent_id: agent.ticket_id,
        from: 'stalled',
        to: 'idle',
        reason: 'stalled_timeout (exceeded 2h 30min)',
      });
      if (agent.current_hook_ticket_id) {
        actions.push({
          type: 'unhook_agent',
          agent_id: agent.ticket_id,
          reason: 'stalled_timeout (exceeded 2h 30min)',
        });
      }
    }
  }

  const staleAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.dispatch_attempts} >= ?
          AND ${agent_metadata.last_activity_at} < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')
      `,
      [MAX_DISPATCH_ATTEMPTS]
    ),
  ]);

  for (const agent of staleAgents) {
    actions.push({
      type: 'reset_agent_dispatch_attempts',
      agent_id: agent.ticket_id,
    });
  }

  // Idle agents hooked to terminal tickets — clean up stale hooks
  const idleHooked = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL
      `,
      []
    ),
  ]);

  for (const agent of idleHooked) {
    if (!agent.current_hook_ticket_id) continue;

    const hookedRows = z
      .object({ status: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${tickets.status}
          FROM ${tickets}
          WHERE ${tickets.ticket_id} = ?
        `,
          [agent.current_hook_ticket_id]
        ),
      ]);

    if (hookedRows.length === 0) {
      // Hooked ticket doesn't exist — stale reference
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.ticket_id,
        reason: 'hooked ticket does not exist',
      });
      actions.push({
        type: 'clear_agent_checkpoint',
        agent_id: agent.ticket_id,
      });
      continue;
    }

    const hookedStatus = hookedRows[0].status;
    if (hookedStatus === 'closed' || hookedStatus === 'failed') {
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.ticket_id,
        reason: 'hooked ticket is terminal',
      });
      actions.push({
        type: 'clear_agent_checkpoint',
        agent_id: agent.ticket_id,
      });
    } else if (hookedStatus === 'in_progress' || hookedStatus === 'open') {
      // Idle agent hooked to a live ticket — usually means the dispatch
      // started but the agent died (container failed to start, OOM,
      // etc.) and agentCompleted set it to idle without unhooking.
      //
      // Guard against the phantom-failed-dispatch case: dispatchAgent
      // can return started=false even when the container actually
      // accepted the agent (e.g. /refresh-token raced a token rotation),
      // and the SDK session keeps heartbeating happily. Tearing the
      // hook out from under a live session causes tools that need a
      // hooked ticket (gt_request_changes, gt_triage_resolve) to fail
      // with "is not hooked to a ticket" until the session exits.
      //
      // If we've seen a heartbeat in the last 90s, treat the agent as
      // alive and leave the hook in place. The 90s window matches
      // reconcileAgents' stale-heartbeat threshold, so a truly dead
      // agent still gets reaped by the heartbeat path on a later tick.
      if (!staleMs(agent.last_activity_at, 90_000)) continue;

      actions.push({
        type: 'unhook_agent',
        agent_id: agent.ticket_id,
        reason: 'idle agent hooked to live ticket (dispatch failed)',
      });
      actions.push({
        type: 'transition_Ticket',
        ticket_id: agent.current_hook_ticket_id,
        from: hookedStatus,
        to: 'open',
        reason: 'agent went idle without completing work — reset for re-dispatch',
        actor: 'system',
      });
    }
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileTickets — handle unassigned tickets, lost agents, stale reviews
// ════════════════════════════════════════════════════════════════════

export function reconcileTickets(
  sql: SqlStorage,
  opts?: { draining?: boolean; departmentConfig?: DepartmentConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];

  const workstationMaxDispatchAttempts = (workstationId: string | null): number => {
    if (!workstationId || !opts?.departmentConfig) return MAX_DISPATCH_ATTEMPTS;
    const workstation = getWorkstation(sql, workstationId);
    return (
      resolveWorkstationConfig(opts.departmentConfig, workstation?.config ?? null).max_dispatch_attempts ??
      MAX_DISPATCH_ATTEMPTS
    );
  };

  // department-level circuit breaker: if too many dispatch failures in the
  // window, skip all dispatch_agent actions and escalate to frontDesk.
  const circuitBreakerActions = checkDispatchCircuitBreaker(sql);
  const circuitBreakerOpen = circuitBreakerActions.length > 0;

  // Rule 1: Open issue tickets with no assignee, no blockers, not staged, not triage
  const unassigned = TicketRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${tickets.columns.ticket_id}, b.${tickets.columns.type},
               b.${tickets.columns.status}, b.${tickets.columns.workstation_id},
               b.${tickets.columns.assignee_agent_ticket_id},
               b.${tickets.columns.updated_at},
               b.${tickets.columns.labels},
               b.${tickets.columns.created_by},
               b.${tickets.columns.dispatch_attempts},
               b.${tickets.columns.last_dispatch_attempt_at}
        FROM ${tickets} b
        WHERE b.${tickets.columns.type} = 'issue'
          AND b.${tickets.columns.status} = 'open'
          AND b.${tickets.columns.assignee_agent_ticket_id} IS NULL
          AND b.${tickets.columns.workstation_id} IS NOT NULL
          AND b.${tickets.columns.labels} NOT LIKE ?
          AND b.${tickets.columns.labels} NOT LIKE ?
          AND NOT EXISTS (
            SELECT 1 FROM ${ticket_dependencies} bd
            INNER JOIN ${tickets} blocker ON blocker.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
            WHERE bd.${ticket_dependencies.columns.ticket_id} = b.${tickets.columns.ticket_id}
              AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
              AND blocker.${tickets.columns.status} NOT IN ('closed', 'failed')
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${ticket_dependencies} bd2
            INNER JOIN ${shift_metadata} cm ON cm.${shift_metadata.columns.ticket_id} = bd2.${ticket_dependencies.columns.depends_on_ticket_id}
            WHERE bd2.${ticket_dependencies.columns.ticket_id} = b.${tickets.columns.ticket_id}
              AND bd2.${ticket_dependencies.columns.dependency_type} = 'tracks'
              AND cm.${shift_metadata.columns.staged} = 1
          )
      `,
      [TRIAGE_LABEL_LIKE, HELD_LABEL_LIKE]
    ),
  ]);

  for (const ticket of unassigned) {
    if (!ticket.workstation_id) continue;
    if (draining) {
      console.log(`${LOG} Department is draining, skipping dispatch for ticket ${ticket.ticket_id}`);
      continue;
    }

    if (ticket.dispatch_attempts >= workstationMaxDispatchAttempts(ticket.workstation_id)) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id: ticket.ticket_id,
        from: 'open',
        to: 'failed',
        reason: `max dispatch attempts exceeded (${ticket.dispatch_attempts})`,
        actor: 'system',
      });
      continue;
    }

    // Exponential backoff: skip if last dispatch attempt was too recent
    const cooldownMs = getDispatchCooldownMs(ticket.dispatch_attempts);
    if (!staleMs(ticket.last_dispatch_attempt_at, cooldownMs)) continue;

    if (circuitBreakerOpen) continue;

    actions.push({
      type: 'dispatch_agent',
      agent_id: '', // resolved at apply time
      ticket_id: ticket.ticket_id,
      workstation_id: ticket.workstation_id,
    });
  }

  // Rule 1b: Open issue tickets with a stale assignee (agent exists but is not
  // hooked to this ticket). This happens when a container restart causes the
  // agent to be unhooked while the ticket is reset to open (e.g. by the frontDesk).
  // Clear the assignee so Rule 1 can pick it up on the next reconciler tick.
  const staleAssigned = TicketRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${tickets.ticket_id}, ${tickets.type},
               ${tickets.status}, ${tickets.workstation_id},
               ${tickets.assignee_agent_ticket_id},
               ${tickets.updated_at},
               ${tickets.labels},
               ${tickets.created_by},
               ${tickets.dispatch_attempts},
               ${tickets.last_dispatch_attempt_at}
        FROM ${tickets}
        WHERE ${tickets.type} = 'issue'
          AND ${tickets.status} = 'open'
          AND ${tickets.assignee_agent_ticket_id} IS NOT NULL
          AND ${tickets.workstation_id} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${agent_metadata}
            WHERE ${agent_metadata.ticket_id} = ${tickets.assignee_agent_ticket_id}
              AND ${agent_metadata.current_hook_ticket_id} = ${tickets.ticket_id}
          )
      `,
      []
    ),
  ]);

  for (const ticket of staleAssigned) {
    // Skip system-assigned tickets (escalations, rework requests) — those
    // are handled by other subsystems and don't need dispatch.
    if (ticket.assignee_agent_ticket_id === 'system') continue;

    // Skip triage-request tickets — attendance.createTriageRequest() sets
    // assignee_agent_ticket_id to route the request to a specific agent,
    // but hookTicket() intentionally refuses to hook triage-request tickets.
    // Without this skip, the reconciler would clear the assignee on
    // every tick because the hook will never exist.
    if (ticket.labels.includes('gt:triage-request')) continue;

    actions.push({
      type: 'clear_ticket_assignee',
      ticket_id: ticket.ticket_id,
    });
  }

  // Rule 2: Idle agents with hooks need dispatch
  const idleHooked = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL
          AND ${agent_metadata.columns.role} != 'qualityAssurance'
      `,
      []
    ),
  ]);

  for (const agent of idleHooked) {
    if (!agent.current_hook_ticket_id) continue;

    // Check if the hooked ticket is open and unblocked, and read its
    // dispatch_attempts for the per-ticket circuit breaker.
    const hookedRows = z
      .object({
        status: z.string(),
        workstation_id: z.string().nullable(),
        dispatch_attempts: z.number(),
        last_dispatch_attempt_at: z.string().nullable(),
      })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${tickets.status}, ${tickets.workstation_id},
                 ${tickets.dispatch_attempts}, ${tickets.last_dispatch_attempt_at}
          FROM ${tickets}
          WHERE ${tickets.ticket_id} = ?
        `,
          [agent.current_hook_ticket_id]
        ),
      ]);

    if (hookedRows.length === 0) continue;
    const hooked = hookedRows[0];
    if (hooked.status !== 'open') continue;

    // Per-ticket dispatch cap (uses ticket counter, not agent counter)
    if (hooked.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id: agent.current_hook_ticket_id,
        from: null,
        to: 'failed',
        reason: `max dispatch attempts exceeded (${hooked.dispatch_attempts})`,
        actor: 'system',
      });
      actions.push({
        type: 'unhook_agent',
        agent_id: agent.ticket_id,
        reason: 'max dispatch attempts',
      });
      continue;
    }

    // Exponential backoff using ticket's last_dispatch_attempt_at
    const cooldownMs = getDispatchCooldownMs(hooked.dispatch_attempts);
    if (!staleMs(hooked.last_dispatch_attempt_at, cooldownMs)) continue;

    // Check blockers
    const blockerCount = z
      .object({ cnt: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT count(*) as cnt
          FROM ${ticket_dependencies} bd
          INNER JOIN ${tickets} blocker ON blocker.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
          WHERE bd.${ticket_dependencies.columns.ticket_id} = ?
            AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
            AND blocker.${tickets.columns.status} NOT IN ('closed', 'failed')
        `,
          [agent.current_hook_ticket_id]
        ),
      ]);

    if (blockerCount[0]?.cnt > 0) continue;

    if (draining) {
      console.log(
        `${LOG} Department is draining, skipping dispatch for ticket ${agent.current_hook_ticket_id}`
      );
      continue;
    }

    if (circuitBreakerOpen) continue;

    actions.push({
      type: 'dispatch_agent',
      agent_id: agent.ticket_id,
      ticket_id: agent.current_hook_ticket_id,
      workstation_id: hooked.workstation_id ?? agent.workstation_id ?? '',
    });
  }

  // Rule 3: In-progress issue tickets with no working/stalled agent
  const staleInProgress = TicketRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${tickets.columns.ticket_id}, b.${tickets.columns.type},
               b.${tickets.columns.status}, b.${tickets.columns.workstation_id},
               b.${tickets.columns.assignee_agent_ticket_id},
               b.${tickets.columns.updated_at},
               b.${tickets.columns.labels},
               b.${tickets.columns.created_by},
               b.${tickets.columns.dispatch_attempts},
               b.${tickets.columns.last_dispatch_attempt_at}
        FROM ${tickets} b
        WHERE b.${tickets.columns.type} = 'issue'
          AND b.${tickets.columns.status} = 'in_progress'
      `,
      []
    ),
  ]);

  for (const ticket of staleInProgress) {
    if (!staleMs(ticket.updated_at, STALE_IN_PROGRESS_TIMEOUT_MS)) continue;

    // Check if any agent is hooked AND (working/stalled OR has a recent
    // heartbeat). The heartbeat check is defense-in-depth for #1358: if
    // the agent's status is wrong (e.g. stuck on 'idle' due to a dispatch
    // timeout race), a fresh heartbeat proves the agent is alive.
    const hookedAgent = z
      .object({ status: z.string(), last_activity_at: z.string().nullable() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${agent_metadata.status}, ${agent_metadata.last_activity_at}
          FROM ${agent_metadata}
          WHERE ${agent_metadata.current_hook_ticket_id} = ?
            AND (
              ${agent_metadata.status} IN ('working', 'stalled')
              OR ${agent_metadata.last_activity_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds')
            )
        `,
          [ticket.ticket_id]
        ),
      ]);

    if (hookedAgent.length > 0) continue;

    // If the ticket has exhausted its dispatch attempts, fail it instead
    // of resetting to open (which would cause an infinite retry loop).
    if (ticket.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id: ticket.ticket_id,
        from: 'in_progress',
        to: 'failed',
        reason: `agent lost, max dispatch attempts exhausted (${ticket.dispatch_attempts})`,
        actor: 'system',
      });
      actions.push({
        type: 'clear_ticket_assignee',
        ticket_id: ticket.ticket_id,
      });
      continue;
    }

    actions.push({
      type: 'transition_Ticket',
      ticket_id: ticket.ticket_id,
      from: 'in_progress',
      to: 'open',
      reason: 'agent lost',
      actor: 'system',
    });
    actions.push({
      type: 'clear_ticket_assignee',
      ticket_id: ticket.ticket_id,
    });
  }

  // Rule 4: In-review issue tickets where all MR tickets are terminal
  const inReview = TicketRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${tickets.columns.ticket_id}, b.${tickets.columns.type},
               b.${tickets.columns.status}, b.${tickets.columns.workstation_id},
               b.${tickets.columns.assignee_agent_ticket_id},
               b.${tickets.columns.updated_at},
               b.${tickets.columns.labels},
               b.${tickets.columns.created_by}
        FROM ${tickets} b
        WHERE b.${tickets.columns.type} = 'issue'
          AND b.${tickets.columns.status} = 'in_review'
      `,
      []
    ),
  ]);

  for (const ticket of inReview) {
    if (!staleMs(ticket.updated_at, ORPHANED_SOURCE_TIMEOUT_MS)) continue;

    // Get all MR tickets tracking this source
    const mrTickets = z
      .object({ status: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT mr.${tickets.columns.status}
          FROM ${ticket_dependencies} bd
          INNER JOIN ${tickets} mr ON mr.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.ticket_id}
          WHERE bd.${ticket_dependencies.columns.depends_on_ticket_id} = ?
            AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
            AND mr.${tickets.columns.type} = 'merge_request'
        `,
          [ticket.ticket_id]
        ),
      ]);

    if (mrTickets.length === 0) continue;
    const allTerminal = mrTickets.every(mr => mr.status === 'closed' || mr.status === 'failed');
    if (!allTerminal) continue;

    const anyMerged = mrTickets.some(mr => mr.status === 'closed');

    if (anyMerged) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id: ticket.ticket_id,
        from: 'in_review',
        to: 'closed',
        reason: 'MR merged (reconciler safety net)',
        actor: 'system',
      });
    } else {
      actions.push({
        type: 'transition_Ticket',
        ticket_id: ticket.ticket_id,
        from: 'in_review',
        to: 'open',
        reason: 'all reviews failed',
        actor: 'system',
      });
      actions.push({
        type: 'clear_ticket_assignee',
        ticket_id: ticket.ticket_id,
      });
    }
  }

  // Emit circuit breaker notification (once per reconcile pass)
  if (circuitBreakerOpen) {
    actions.push(...circuitBreakerActions);
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// reconcileReviewQueue — PR polling, stuck/abandoned MR recovery,
// qualityAssurance dispatch
// ════════════════════════════════════════════════════════════════════

export function reconcileReviewQueue(
  sql: SqlStorage,
  opts?: { draining?: boolean; departmentConfig?: DepartmentConfig }
): Action[] {
  const draining = opts?.draining ?? false;
  const actions: Action[] = [];

  const circuitBreakerOpen = checkDispatchCircuitBreaker(sql).length > 0;

  // Resolve per-workstation code_review setting. Falls back to department default when
  // departmentConfig is not provided (e.g. in tests or debug replay).
  const workstationCodeReview = (workstationId: string): boolean => {
    if (!opts?.departmentConfig) return true;
    const workstation = getWorkstation(sql, workstationId);
    return resolveWorkstationConfig(opts.departmentConfig, workstation?.config ?? null).code_review;
  };

  const workstationMaxDispatchAttempts = (workstationId: string | null): number => {
    if (!workstationId || !opts?.departmentConfig) return MAX_DISPATCH_ATTEMPTS;
    const workstation = getWorkstation(sql, workstationId);
    return (
      resolveWorkstationConfig(opts.departmentConfig, workstation?.config ?? null).max_dispatch_attempts ??
      MAX_DISPATCH_ATTEMPTS
    );
  };

  const mrTickets = MrTicketRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${tickets.columns.ticket_id}, b.${tickets.columns.status},
               b.${tickets.columns.workstation_id}, b.${tickets.columns.updated_at},
               b.${tickets.columns.metadata},
               rm.${review_metadata.columns.pr_url},
               b.${tickets.columns.assignee_agent_ticket_id}
        FROM ${tickets} b
        INNER JOIN ${review_metadata} rm ON rm.${review_metadata.columns.ticket_id} = b.${tickets.columns.ticket_id}
        WHERE b.${tickets.columns.type} = 'merge_request'
          AND b.${tickets.columns.status} IN ('open', 'in_progress')
      `,
      []
    ),
  ]);

  for (const mr of mrTickets) {
    // Rule 1: PR-strategy MR tickets in_progress need polling.
    // Rate-limit: skip if polled less than PR_POLL_INTERVAL_MS ago (#1632).
    if (mr.status === 'in_progress' && mr.pr_url) {
      const lastPollAt: unknown = mr.metadata?.last_poll_at;
      const msSinceLastPoll =
        typeof lastPollAt === 'string' ? Date.now() - new Date(lastPollAt).getTime() : Infinity;

      if (msSinceLastPoll >= PR_POLL_INTERVAL_MS) {
        actions.push({
          type: 'poll_pr',
          ticket_id: mr.ticket_id,
          pr_url: mr.pr_url,
        });
      }
      // If auto-merge is pending, also attempt the merge
      if (mr.metadata?.auto_merge_pending) {
        actions.push({
          type: 'merge_pr',
          ticket_id: mr.ticket_id,
          pr_url: mr.pr_url,
        });
      }
    }

    // Rule 2: Stuck MR tickets in_progress with no PR, no working agent, stale >30min
    // Skip MR tickets with unresolved rework blockers — they're waiting for
    // a soul to finish rework, which is a normal in-flight state.
    if (
      mr.status === 'in_progress' &&
      !mr.pr_url &&
      staleMs(mr.updated_at, STUCK_REVIEW_TIMEOUT_MS)
    ) {
      if (hasUnresolvedReworkBlockers(sql, mr.ticket_id)) continue;
      const workingAgent = hasWorkingAgentHooked(sql, mr.ticket_id);
      if (!workingAgent) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: mr.ticket_id,
          from: 'in_progress',
          to: 'open',
          reason: 'stuck review, no working agent',
          actor: 'system',
        });
        // Unhook any idle agent still pointing at this MR
        const idleAgent = getIdleAgentHookedTo(sql, mr.ticket_id);
        if (idleAgent) {
          actions.push({
            type: 'unhook_agent',
            agent_id: idleAgent,
            reason: 'stuck review cleanup',
          });
        }
      }
    }

    // Rule 3: Abandoned MR tickets in_progress, no PR, no agent hooked, stale >2min
    // Skip MR tickets with rework blockers (same reasoning as Rule 2).
    if (
      mr.status === 'in_progress' &&
      !mr.pr_url &&
      staleMs(mr.updated_at, ABANDONED_MR_TIMEOUT_MS)
    ) {
      if (hasUnresolvedReworkBlockers(sql, mr.ticket_id)) continue;
      const anyAgent = hasAnyAgentHooked(sql, mr.ticket_id);
      if (!anyAgent) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: mr.ticket_id,
          from: 'in_progress',
          to: 'open',
          reason: 'abandoned, no agent hooked',
          actor: 'system',
        });
      }
    }

    // Rule 4: PR-strategy MR tickets orphaned (qualityAssurance dispatched then died, stale >30min)
    // Only in_progress — open tickets are just waiting for the qualityAssurance to pop them.
    // Skip when qualityAssurance code review is disabled for this workstation: poll_pr keeps the
    // ticket alive via updated_at touches, and no qualityAssurance is expected to be working.
    if (
      mr.workstation_id &&
      workstationCodeReview(mr.workstation_id) &&
      mr.status === 'in_progress' &&
      mr.pr_url &&
      staleMs(mr.updated_at, ORPHANED_PR_REVIEW_TIMEOUT_MS)
    ) {
      const mrMeta: Record<string, unknown> = mr.metadata ?? {};
      if (mrMeta.awaiting_approval === 1 || mrMeta.awaiting_approval === true) {
        continue;
      }
      const workingAgent = hasWorkingAgentHooked(sql, mr.ticket_id);
      if (!workingAgent) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: mr.ticket_id,
          from: mr.status,
          to: 'failed',
          reason: 'PR review orphaned',
          actor: 'system',
        });
      }
    }
  }

  // Per-workstation: when qualityAssurance code review is disabled for a workstation:
  //  - MR tickets for that workstation WITH pr_url → fast-track to in_progress for poll_pr
  //  - MR tickets for that workstation WITHOUT pr_url → fail them and reopen the source ticket
  //    (the soul was supposed to create the PR via merge_strategy=pr
  //    but didn't provide one — retry the source ticket)
  // Collect all workstations that have open MR tickets so we can apply per-workstation logic.
  const workstationsWithAnyOpenMrs = z
    .object({ workstation_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT DISTINCT b.${tickets.columns.workstation_id}
          FROM ${tickets} b
          WHERE b.${tickets.columns.type} = 'merge_request'
            AND b.${tickets.columns.status} = 'open'
            AND b.${tickets.columns.workstation_id} IS NOT NULL
        `,
        []
      ),
    ]);

  for (const { workstation_id } of workstationsWithAnyOpenMrs) {
    if (workstationCodeReview(workstation_id)) continue;

    // Fast-track: open MR tickets with pr_url → in_progress (skip qualityAssurance review)
    const openMrsWithPr = z
      .object({ ticket_id: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
            SELECT b.${tickets.columns.ticket_id}
            FROM ${tickets} b
            JOIN ${review_metadata} rm
              ON rm.${review_metadata.columns.ticket_id} = b.${tickets.columns.ticket_id}
            WHERE b.${tickets.columns.type} = 'merge_request'
              AND b.${tickets.columns.status} = 'open'
              AND b.${tickets.columns.workstation_id} = ?
              AND rm.${review_metadata.columns.pr_url} IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM ${tickets} parent
                JOIN ${shift_metadata} cm
                  ON cm.${shift_metadata.columns.ticket_id} = parent.${tickets.columns.ticket_id}
                WHERE parent.${tickets.columns.ticket_id} = b.${tickets.columns.parent_ticket_id}
                  AND cm.${shift_metadata.columns.merge_mode} = 'review-and-merge'
              )
          `,
          [workstation_id]
        ),
      ]);
    for (const { ticket_id } of openMrsWithPr) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id,
        from: 'open',
        to: 'in_progress',
        reason: 'qualityAssurance code review disabled — skip to poll_pr',
        actor: 'system',
      });
    }

    // Orphan cleanup: open MR tickets without pr_url that aren't shift
    // review-and-merge tickets or system-created landing MR tickets.
    // The soul should have created the PR (merge_strategy=pr) but
    // didn't — fail the MR and reopen the source ticket so another
    // soul can retry.
    // Landing MR tickets (created_by='system') are excluded because they
    // are created by reconcileShifts for review-then-land shifts and
    // intentionally have no pr_url at creation — the qualityAssurance creates
    // the PR when it picks up the landing MR.
    const orphanedMrs = z
      .object({ ticket_id: z.string(), source_ticket_id: z.string().nullable() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
            SELECT b.${tickets.columns.ticket_id},
                   bd.${ticket_dependencies.columns.depends_on_ticket_id} AS source_ticket_id
            FROM ${tickets} b
            JOIN ${review_metadata} rm
              ON rm.${review_metadata.columns.ticket_id} = b.${tickets.columns.ticket_id}
            LEFT JOIN ${ticket_dependencies} bd
              ON bd.${ticket_dependencies.columns.ticket_id} = b.${tickets.columns.ticket_id}
              AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
            WHERE b.${tickets.columns.type} = 'merge_request'
              AND b.${tickets.columns.status} = 'open'
              AND b.${tickets.columns.workstation_id} = ?
              AND rm.${review_metadata.columns.pr_url} IS NULL
              AND b.${tickets.columns.created_by} != 'system'
              AND NOT EXISTS (
                SELECT 1
                FROM ${tickets} parent
                JOIN ${shift_metadata} cm
                  ON cm.${shift_metadata.columns.ticket_id} = parent.${tickets.columns.ticket_id}
                WHERE parent.${tickets.columns.ticket_id} = b.${tickets.columns.parent_ticket_id}
                  AND cm.${shift_metadata.columns.merge_mode} = 'review-and-merge'
              )
          `,
          [workstation_id]
        ),
      ]);
    for (const { ticket_id, source_ticket_id } of orphanedMrs) {
      actions.push({
        type: 'transition_Ticket',
        ticket_id,
        from: 'open',
        to: 'failed',
        reason: 'MR ticket has no pr_url and code review is disabled — soul failed to create PR',
        actor: 'system',
      });
      if (source_ticket_id) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: source_ticket_id,
          from: 'in_review',
          to: 'open',
          reason: 'MR failed (no PR created) — reopening for retry',
          actor: 'system',
        });
      }
    }
  }

  // Rules 5-6: QualityAssurance dispatch for open MR tickets.
  // When code_review=true for a workstation: dispatches for all open MR tickets in that workstation.
  // When code_review=false for a workstation: only dispatches for shift review-and-merge
  // MR tickets (the fast-track above already moved ordinary MR tickets to
  // in_progress as actions, but those haven't been applied to SQL yet —
  // so we must filter here to avoid re-dispatching them).
  {
    // Rule 5: Pop open MR ticket for idle qualityAssurance
    // Get all workstations that have open MR tickets needing the qualityAssurance.
    // All workstations with open MRs are candidates; per-workstation code_review is checked inside the loop.
    const workstationsWithOpenMrs = z
      .object({ workstation_id: z.string() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
        SELECT DISTINCT b.${tickets.columns.workstation_id}
        FROM ${tickets} b
        WHERE b.${tickets.columns.type} = 'merge_request'
          AND b.${tickets.columns.status} = 'open'
          AND b.${tickets.columns.workstation_id} IS NOT NULL
      `,
          []
        ),
      ]);

    for (const { workstation_id } of workstationsWithOpenMrs) {
      // When code_review=false, only dispatch the qualityAssurance for:
      //  1. Shift review-and-merge MR tickets (qualityAssurance does combined review+merge)
      //  2. System-created landing MR tickets (review-then-land shift finalization)
      // MR tickets WITH a pr_url are handled by the fast-track → poll_pr.
      // MR tickets WITHOUT a pr_url when merge_strategy=pr are orphaned
      // (soul should have created the PR) — orphan cleanup handles them.
      const qualityAssuranceNeededFilter = workstationCodeReview(workstation_id)
        ? ''
        : /* sql */ `
            AND (
              EXISTS (
                SELECT 1
                FROM ${tickets} outer_parent
                JOIN ${shift_metadata} cm
                  ON cm.${shift_metadata.columns.ticket_id} = outer_parent.${tickets.columns.ticket_id}
                WHERE outer_parent.${tickets.columns.ticket_id} = ${tickets.parent_ticket_id}
                  AND cm.${shift_metadata.columns.merge_mode} = 'review-and-merge'
              )
              OR ${tickets.created_by} = 'system'
            )`;

      // Check if workstation already has an in_progress MR that needs the qualityAssurance.
      // PR-strategy MR tickets (pr_url IS NOT NULL) don't need the qualityAssurance —
      // the merge is handled by the user/CI via the PR. Only direct-strategy
      // MRs (no pr_url, qualityAssurance merges to main itself) block the queue.
      const inProgressCount = z
        .object({ cnt: z.number() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT count(*) as cnt FROM ${tickets} b
          INNER JOIN ${review_metadata} rm
            ON rm.${review_metadata.columns.ticket_id} = b.${tickets.columns.ticket_id}
          WHERE b.${tickets.columns.type} = 'merge_request'
            AND b.${tickets.columns.status} = 'in_progress'
            AND b.${tickets.columns.workstation_id} = ?
            AND rm.${review_metadata.columns.pr_url} IS NULL
        `,
            [workstation_id]
          ),
        ]);
      if ((inProgressCount[0]?.cnt ?? 0) > 0) continue;

      const qualityAssurance = AgentRow.array().parse([
        ...query(
          sql,
          /* sql */ `
          SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
                 ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
                 ${agent_metadata.dispatch_attempts},
                 ${agent_metadata.last_activity_at},
                 b.${tickets.columns.workstation_id}
          FROM ${agent_metadata}
          LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
          WHERE ${agent_metadata.columns.role} = 'qualityAssurance'
            AND b.${tickets.columns.workstation_id} = ?
          LIMIT 1
        `,
          [workstation_id]
        ),
      ]);

      // Get oldest open MR for this workstation (filtered by shift when code_review=false)
      const oldestMr = z
        .object({ ticket_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT ${tickets.ticket_id}
          FROM ${tickets}
          WHERE ${tickets.type} = 'merge_request'
            AND ${tickets.status} = 'open'
            AND ${tickets.workstation_id} = ?
            ${qualityAssuranceNeededFilter}
          ORDER BY ${tickets.created_at} ASC
          LIMIT 1
        `,
            [workstation_id]
          ),
        ]);

      if (oldestMr.length === 0) continue;

      if (draining) {
        console.log(`${LOG} Department is draining, skipping dispatch for ticket ${oldestMr[0].ticket_id}`);
        continue;
      }

      if (circuitBreakerOpen) continue;

      // If no qualityAssurance exists or it's busy, emit a dispatch_agent with empty
      // agent_id — applyAction will create the qualityAssurance via getOrCreateAgent.
      if (qualityAssurance.length === 0) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: oldestMr[0].ticket_id,
          from: 'open',
          to: 'in_progress',
          reason: 'popped for review (creating qualityAssurance)',
          actor: 'system',
        });
        actions.push({
          type: 'dispatch_agent',
          agent_id: '',
          ticket_id: oldestMr[0].ticket_id,
          workstation_id,
        });
        continue;
      }

      const ref = qualityAssurance[0];
      if (ref.status !== 'idle' || ref.current_hook_ticket_id) continue;

      actions.push({
        type: 'transition_Ticket',
        ticket_id: oldestMr[0].ticket_id,
        from: 'open',
        to: 'in_progress',
        reason: 'popped for review',
        actor: 'system',
      });
      actions.push({
        type: 'hook_agent',
        agent_id: ref.ticket_id,
        ticket_id: oldestMr[0].ticket_id,
      });
      actions.push({
        type: 'dispatch_agent',
        agent_id: ref.ticket_id,
        ticket_id: oldestMr[0].ticket_id,
        workstation_id,
      });
    }

    // Rule 6: Idle qualityAssurance hooked to in_progress MR — needs re-dispatch
    const idleRefineries = AgentRow.array().parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.columns.role} = 'qualityAssurance'
          AND ${agent_metadata.status} = 'idle'
          AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL
      `,
        []
      ),
    ]);

    for (const ref of idleRefineries) {
      if (!ref.current_hook_ticket_id) continue;

      const mrRows = z
        .object({
          status: z.string(),
          type: z.string(),
          workstation_id: z.string().nullable(),
          dispatch_attempts: z.number(),
          last_dispatch_attempt_at: z.string().nullable(),
          metadata: z.string(),
        })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
          SELECT ${tickets.status}, ${tickets.type}, ${tickets.workstation_id},
                 ${tickets.dispatch_attempts}, ${tickets.last_dispatch_attempt_at},
                 ${tickets.columns.metadata}
          FROM ${tickets}
          WHERE ${tickets.ticket_id} = ?
        `,
            [ref.current_hook_ticket_id]
          ),
        ]);

      if (mrRows.length === 0) continue;
      const mr = mrRows[0];
      if (mr.type !== 'merge_request' || mr.status !== 'in_progress') continue;

      let mrMeta: Record<string, unknown> = {};
      try {
        mrMeta = JSON.parse(mr.metadata ?? '{}') as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      if (mrMeta.awaiting_approval === 1 || mrMeta.awaiting_approval === true) {
        continue;
      }

      if (draining) {
        console.log(
          `${LOG} Department is draining, skipping dispatch for ticket ${ref.current_hook_ticket_id}`
        );
        continue;
      }

      const workstationId = mr.workstation_id ?? ref.workstation_id ?? null;

      // Per-ticket dispatch cap — check before cooldown so max-attempt MR
      // tickets are failed immediately rather than waiting for the cooldown.
      if (mr.dispatch_attempts >= workstationMaxDispatchAttempts(workstationId)) {
        actions.push({
          type: 'transition_Ticket',
          ticket_id: ref.current_hook_ticket_id,
          from: null,
          to: 'failed',
          reason: `qualityAssurance max dispatch attempts exceeded (${mr.dispatch_attempts})`,
          actor: 'system',
        });
        actions.push({
          type: 'unhook_agent',
          agent_id: ref.ticket_id,
          reason: 'max dispatch attempts',
        });
        continue;
      }

      // Exponential backoff using ticket's last_dispatch_attempt_at
      const cooldownMs = getDispatchCooldownMs(mr.dispatch_attempts);
      if (!staleMs(mr.last_dispatch_attempt_at, cooldownMs)) continue;

      if (circuitBreakerOpen) continue;

      // Container status is checked at apply time (async). In shadow mode,
      // we just note that a dispatch is needed.
      actions.push({
        type: 'dispatch_agent',
        agent_id: ref.ticket_id,
        ticket_id: ref.current_hook_ticket_id,
        workstation_id: workstationId ?? '',
      });
    }
  } // end Rules 5–6 block

  // Rule 7: Working qualityAssurance hooked to a terminal MR ticket — stop it.
  // This catches the race where auto-merge closes the MR ticket while the
  // qualityAssurance is still running in the container. Without this, the qualityAssurance
  // can post review comments on an already-merged PR.
  const workingRefineries = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.columns.role} = 'qualityAssurance'
          AND ${agent_metadata.status} IN ('working', 'stalled')
          AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL
      `,
      []
    ),
  ]);

  for (const ref of workingRefineries) {
    if (!ref.current_hook_ticket_id) continue;
    const mr = ticketOps.getTicket(sql, ref.current_hook_ticket_id);
    if (!mr || (mr.status !== 'closed' && mr.status !== 'failed')) continue;

    actions.push({
      type: 'stop_agent',
      agent_id: ref.ticket_id,
      reason: `MR ticket ${ref.current_hook_ticket_id} is ${mr.status}`,
    });
    actions.push({
      type: 'unhook_agent',
      agent_id: ref.ticket_id,
      reason: `MR ticket ${mr.status} — cleanup`,
    });
    // Transition to idle immediately so the agent doesn't spend a tick
    // in an inconsistent working+unhooked state.
    actions.push({
      type: 'transition_agent',
      agent_id: ref.ticket_id,
      from: ref.status,
      to: 'idle',
      reason: `MR ticket ${mr.status} — cleanup`,
    });
  }

  return actions;
}

export function reconcileShifts(sql: SqlStorage): Action[] {
  const actions: Action[] = [];

  const shifts = ShiftRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT b.${tickets.columns.ticket_id}, b.${tickets.columns.status},
               cm.${shift_metadata.columns.total_tickets} as total_tickets,
               cm.${shift_metadata.columns.closed_tickets} as closed_tickets,
               cm.${shift_metadata.columns.feature_branch} as feature_branch,
               cm.${shift_metadata.columns.merge_mode} as merge_mode,
               cm.${shift_metadata.columns.staged} as staged,
               b.${tickets.columns.metadata} as metadata
        FROM ${tickets} b
        INNER JOIN ${shift_metadata} cm ON cm.${shift_metadata.columns.ticket_id} = b.${tickets.columns.ticket_id}
        WHERE b.${tickets.columns.type} = 'shift'
          AND b.${tickets.columns.status} = 'open'
      `,
      []
    ),
  ]);

  for (const shift of shifts) {
    const progressRows = z
      .object({ closed_count: z.number(), total_count: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT
            count(CASE WHEN tracked.${tickets.columns.status} IN ('closed', 'failed') THEN 1 END) as closed_count,
            count(*) as total_count
          FROM ${ticket_dependencies} bd
          INNER JOIN ${tickets} tracked ON tracked.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.ticket_id}
          WHERE bd.${ticket_dependencies.columns.depends_on_ticket_id} = ?
            AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
            AND tracked.${tickets.columns.type} = 'issue'
        `,
          [shift.ticket_id]
        ),
      ]);

    if (progressRows.length === 0) continue;
    const { closed_count, total_count } = progressRows[0];

    // Parse shift metadata for landing MR tracking fields (#2260)
    let parsedMeta: Record<string, unknown> = {};
    try {
      parsedMeta = JSON.parse(shift.metadata) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const landingMrAttempts =
      typeof parsedMeta.landing_mr_attempts === 'number' ? parsedMeta.landing_mr_attempts : 0;
    const lastLandingMrAttemptAt =
      typeof parsedMeta.last_landing_mr_attempt_at === 'string'
        ? parsedMeta.last_landing_mr_attempt_at
        : null;

    const inFlightMrCount = z
      .object({ cnt: z.number() })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `
          SELECT count(*) as cnt
          FROM ${ticket_dependencies} track_dep
          INNER JOIN ${ticket_dependencies} mr_dep
            ON mr_dep.${ticket_dependencies.columns.depends_on_ticket_id} = track_dep.${ticket_dependencies.columns.ticket_id}
          INNER JOIN ${tickets} mr
            ON mr.${tickets.columns.ticket_id} = mr_dep.${ticket_dependencies.columns.ticket_id}
          WHERE track_dep.${ticket_dependencies.columns.depends_on_ticket_id} = ?
            AND track_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
            AND mr_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
            AND mr.${tickets.columns.type} = 'merge_request'
            AND mr.${tickets.columns.status} IN ('open', 'in_progress')
        `,
          [shift.ticket_id]
        ),
      ]);

    const hasInFlightReviews = (inFlightMrCount[0]?.cnt ?? 0) > 0;

    const allTicketsDone = closed_count >= total_count && total_count > 0 && !hasInFlightReviews;

    // Update progress if stale (skip if we're failing/closing the shift this tick)
    if (closed_count !== shift.closed_tickets) {
      actions.push({
        type: 'update_shift_progress',
        shift_id: shift.ticket_id,
        closed_tickets: closed_count,
      });
    }

    if (!allTicketsDone) continue;

    if (shift.merge_mode === 'review-then-land' && shift.feature_branch) {
      if (!parsedMeta.ready_to_land) {
        actions.push({
          type: 'set_shift_ready_to_land',
          shift_id: shift.ticket_id,
        });
      }

      if (parsedMeta.ready_to_land) {
        const landingMrs = z
          .object({ status: z.string(), metadata: z.string() })
          .array()
          .parse([
            ...query(
              sql,
              /* sql */ `
                SELECT mr.${tickets.columns.status}, mr.${tickets.columns.metadata}
                FROM ${ticket_dependencies} bd
                INNER JOIN ${tickets} mr ON mr.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.ticket_id}
                WHERE bd.${ticket_dependencies.columns.depends_on_ticket_id} = ?
                  AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
                  AND mr.${tickets.columns.type} = 'merge_request'
              `,
              [shift.ticket_id]
            ),
          ]);

        const hasMergedLanding = landingMrs.some(mr => mr.status === 'closed');
        if (hasMergedLanding) {
          actions.push({
            type: 'close_shift',
            shift_id: shift.ticket_id,
          });
          continue;
        }

        // Fix 1 (#2260): If a landing MR is active (open or in_progress), wait — don't create another
        const hasActiveLanding = landingMrs.some(
          mr => mr.status === 'open' || mr.status === 'in_progress'
        );
        if (hasActiveLanding) continue;

        const hasPendingExternalReview = landingMrs.some(mr => {
          if (mr.status !== 'failed') return false;
          try {
            const meta = JSON.parse(mr.metadata ?? '{}') as Record<string, unknown>;
            return meta.awaiting_approval === 1 || meta.awaiting_approval === true;
          } catch {
            return false;
          }
        });
        if (hasPendingExternalReview) {
          actions.push({
            type: 'emit_event',
            event_name: 'reconciler.respawn_suppressed',
            data: {
              shiftId: shift.ticket_id,
              suppressedAttempt: landingMrAttempts + 1,
            },
          });
          continue;
        }

        // Fix 2 (#2260): If max landing MR attempts exceeded and no landing MR is
        // active or merged, fail the shift. Checked after landing MR status lookup
        // so the final allowed attempt can still succeed.
        if (landingMrAttempts >= MAX_LANDING_MR_ATTEMPTS) {
          actions.push({
            type: 'fail_shift',
            shift_id: shift.ticket_id,
            reason: `Landing MR creation failed after ${MAX_LANDING_MR_ATTEMPTS} attempts`,
          });
          continue;
        }

        // Fix 2 (#2260): Apply exponential cooldown between landing MR attempts
        if (landingMrAttempts > 0 && lastLandingMrAttemptAt) {
          const elapsed = Date.now() - new Date(lastLandingMrAttemptAt).getTime();
          const cooldownMs = Math.min(
            Math.pow(2, landingMrAttempts) * LANDING_MR_COOLDOWN_BASE_MS,
            LANDING_MR_COOLDOWN_MAX_MS
          );
          if (elapsed < cooldownMs) continue;
        }

        // Fix 3 (#2260): Check that tracked tickets have at least one MR with a PR URL.
        // For review-then-land shifts using direct merge strategy, intermediate ticket
        // merges go straight into the feature branch without persisting a pr_url —
        // skip this guard and always create the landing MR when all tickets are closed.
        const needsPrUrl = shift.merge_mode !== 'review-then-land';
        if (needsPrUrl) {
          const shiftTicketsWithPr = z
            .object({ cnt: z.number() })
            .array()
            .parse([
              ...query(
                sql,
                /* sql */ `
                  SELECT count(*) as cnt
                  FROM ${ticket_dependencies} track_dep
                  INNER JOIN ${ticket_dependencies} mr_dep
                    ON mr_dep.${ticket_dependencies.columns.depends_on_ticket_id} = track_dep.${ticket_dependencies.columns.ticket_id}
                  INNER JOIN ${review_metadata} rm
                    ON rm.${review_metadata.columns.ticket_id} = mr_dep.${ticket_dependencies.columns.ticket_id}
                  WHERE track_dep.${ticket_dependencies.columns.depends_on_ticket_id} = ?
                    AND track_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
                    AND mr_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
                    AND rm.${review_metadata.columns.pr_url} IS NOT NULL
                `,
                [shift.ticket_id]
              ),
            ]);

          if ((shiftTicketsWithPr[0]?.cnt ?? 0) === 0) {
            console.warn(
              `${LOG} shift ${shift.ticket_id} has no tickets with pr_url — skipping create_landing_mr`
            );
            continue;
          }
        }

        // No landing MR exists yet and cooldown has passed — create one
        {
          const workstationRows = z
            .object({ workstation_id: z.string() })
            .array()
            .parse([
              ...query(
                sql,
                /* sql */ `
                  SELECT DISTINCT tracked.${tickets.columns.workstation_id} as workstation_id
                  FROM ${ticket_dependencies} bd
                  INNER JOIN ${tickets} tracked ON tracked.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.ticket_id}
                  WHERE bd.${ticket_dependencies.columns.depends_on_ticket_id} = ?
                    AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
                    AND tracked.${tickets.columns.workstation_id} IS NOT NULL
                  LIMIT 1
                `,
                [shift.ticket_id]
              ),
            ]);

          if (workstationRows.length > 0) {
            const workstation = getWorkstation(sql, workstationRows[0].workstation_id);
            actions.push({
              type: 'create_landing_mr',
              shift_id: shift.ticket_id,
              workstation_id: workstationRows[0].workstation_id,
              feature_branch: shift.feature_branch,
              target_branch: workstation?.default_branch ?? 'main',
            });
          }
        }
      }
    } else {
      // review-and-merge or no feature branch — auto-close
      actions.push({
        type: 'close_shift',
        shift_id: shift.ticket_id,
      });
    }
  }

  return actions;
}

export function reconcileGUPP(sql: SqlStorage, opts?: { draining?: boolean }): Action[] {
  // During container drain the heartbeat reporter is stopped, so
  // last_event_at freezes. Skip GUPP checks entirely to avoid
  // false-positive "idle for 15 minutes" nudges while agents are
  // still actively working in the draining container.
  if (opts?.draining) return [];
  const actions: Action[] = [];

  const workingAgents = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               ${agent_metadata.last_event_type},
               ${agent_metadata.last_event_at},
               ${agent_metadata.active_tools},
               ${agent_metadata.stalled_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.status} IN ('working', 'stalled')
          AND ${agent_metadata.role} != 'frontDesk'
      `,
      []
    ),
  ]);

  for (const agent of workingAgents) {
    // Use last_event_at (SDK activity) as primary signal, fall back to
    // last_activity_at (heartbeat). Agents with no heartbeat at all are
    // handled by reconcileAgents (NULL-heartbeat check), so skip them here.
    const activityTimestamp = agent.last_event_at ?? agent.last_activity_at;
    if (!activityTimestamp) continue;

    const elapsed = Date.now() - new Date(activityTimestamp).getTime();
    if (Number.isNaN(elapsed) || elapsed < 0) continue;

    // Stalled agents past the auto-idle threshold are owned by
    // reconcileAgents (stalled → idle + unhook). Skip them here so the
    // later GUPP force-stop action (stalled → stalled) doesn't overwrite
    // the earlier auto-idle transition in the same reconcile pass.
    // applyAction('transition_agent') ignores `from`, so action order
    // decides the final state.
    //
    // Mirror reconcileAgents' auto-idle eligibility check, which measures
    // from `stalled_at` (when the agent entered `stalled`), not from
    // heartbeats. Heartbeats keep arriving after GUPP force-stops a
    // container, so `last_activity_at` stays fresh and wouldn't trigger
    // this skip — leaving GUPP to re-stall an agent that reconcileAgents
    // is about to auto-idle in the same pass. Fall back to
    // `last_activity_at` only for rows from before `stalled_at` was
    // populated, so legacy stalled rows can still escape this loop.
    if (agent.status === 'stalled') {
      const stalledSince = agent.stalled_at ?? agent.last_activity_at;
      if (stalledSince && Date.now() - new Date(stalledSince).getTime() > STALLED_AUTO_IDLE_MS) {
        continue;
      }
    }

    if (elapsed > GUPP_FORCE_STOP_MS) {
      actions.push({
        type: 'transition_agent',
        agent_id: agent.ticket_id,
        from: agent.status,
        to: 'stalled',
        reason: 'GUPP force stop — no SDK activity for 2h',
      });
      actions.push({
        type: 'stop_agent',
        agent_id: agent.ticket_id,
        reason: 'exceeded 2h GUPP limit',
      });
      actions.push({
        type: 'create_triage_request',
        agent_id: agent.ticket_id,
        triage_type: 'stuck_agent',
        reason: 'GUPP force stop',
      });
    } else if (elapsed > GUPP_ESCALATE_MS) {
      if (!hasRecentNudge(sql, agent.ticket_id, 'escalate')) {
        actions.push({
          type: 'send_nudge',
          agent_id: agent.ticket_id,
          message:
            'You have been working for over 1 hour without completing your task. Please wrap up or report if you are stuck.',
          tier: 'escalate',
        });
        actions.push({
          type: 'create_triage_request',
          agent_id: agent.ticket_id,
          triage_type: 'stuck_agent',
          reason: 'GUPP escalation',
        });
      }
    } else if (elapsed > 15 * 60_000) {
      // Skip if agent is mid-tool-call — long-running tools like git clone are normal.
      let tools: string[] = [];
      try {
        tools = JSON.parse(agent.active_tools ?? '[]') as string[];
      } catch {
        /* ignore */
      }

      if (tools.length === 0 && !hasRecentNudge(sql, agent.ticket_id, 'warn')) {
        actions.push({
          type: 'send_nudge',
          agent_id: agent.ticket_id,
          message:
            'You have been idle for 15 minutes with no tool activity. Please check your progress.',
          tier: 'warn',
        });
      }
    }
  }

  return actions;
}

export function reconcileGC(sql: SqlStorage): Action[] {
  const actions: Action[] = [];

  const gcCandidates = AgentRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${agent_metadata.ticket_id}, ${agent_metadata.role},
               ${agent_metadata.status}, ${agent_metadata.current_hook_ticket_id},
               ${agent_metadata.dispatch_attempts},
               ${agent_metadata.last_activity_at},
               b.${tickets.columns.workstation_id}
        FROM ${agent_metadata}
        LEFT JOIN ${tickets} b ON b.${tickets.columns.ticket_id} = ${agent_metadata.ticket_id}
        WHERE ${agent_metadata.status} IN ('idle', 'dead')
          AND ${agent_metadata.columns.role} IN ('soul', 'qualityAssurance')
          AND ${agent_metadata.current_hook_ticket_id} IS NULL
      `,
      []
    ),
  ]);

  for (const agent of gcCandidates) {
    if (staleMs(agent.last_activity_at, AGENT_GC_RETENTION_MS)) {
      actions.push({
        type: 'delete_agent',
        agent_id: agent.ticket_id,
        reason: 'GC: idle > 24h',
      });
    }
  }

  return actions;
}

/** Check if an MR ticket has open rework tickets blocking it. */
function hasUnresolvedReworkBlockers(sql: SqlStorage, mrTicketId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${ticket_dependencies} bd
        INNER JOIN ${tickets} rework ON rework.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
        WHERE bd.${ticket_dependencies.columns.ticket_id} = ?
          AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
          AND rework.${tickets.columns.status} NOT IN ('closed', 'failed')
        LIMIT 1
      `,
      [mrTicketId]
    ),
  ];
  return rows.length > 0;
}

function hasWorkingAgentHooked(sql: SqlStorage, ticketId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_ticket_id} = ?
          AND ${agent_metadata.status} IN ('working', 'stalled')
        LIMIT 1
      `,
      [ticketId]
    ),
  ];
  return rows.length > 0;
}

function hasAnyAgentHooked(sql: SqlStorage, ticketId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_ticket_id} = ?
        LIMIT 1
      `,
      [ticketId]
    ),
  ];
  return rows.length > 0;
}

function getIdleAgentHookedTo(sql: SqlStorage, ticketId: string): string | null {
  const rows = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.ticket_id}
        FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_ticket_id} = ?
          AND ${agent_metadata.status} = 'idle'
        LIMIT 1
      `,
        [ticketId]
      ),
    ]);
  return rows.length > 0 ? rows[0].ticket_id : null;
}

function hasRecentNudge(sql: SqlStorage, agentId: string, tier: string): boolean {
  // Check if a nudge with this exact tier source was created in the last 60 min.
  // The source is set to `reconciler:${tier}` by applyAction('send_nudge').
  // Use SQLite's datetime() for the cutoff so the comparison works regardless
  // of whether created_at was stored in SQLite's native 'YYYY-MM-DD HH:MM:SS'
  // format (old rows) or ISO 8601 'YYYY-MM-DDTHH:MM:SS.000Z' (new rows).
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${agent_nudges}
        WHERE ${agent_nudges.agent_ticket_id} = ?
          AND ${agent_nudges.source} = ?
          AND datetime(${agent_nudges.created_at}) > datetime('now', '-60 minutes')
        LIMIT 1
      `,
      [agentId, `reconciler:${tier}`]
    ),
  ];
  return rows.length > 0;
}

/** Check if an MR ticket has a non-terminal conflict ticket (gt:pr-conflict) blocking it. */
function hasExistingPrConflictTicket(sql: SqlStorage, mrTicketId: string): boolean {
  return getExistingPrConflictTicketId(sql, mrTicketId) !== null;
}

/** Return the ticket_id of a non-terminal conflict ticket (gt:pr-conflict) blocking the MR, or null. */
function getExistingPrConflictTicketId(sql: SqlStorage, mrTicketId: string): string | null {
  const rows = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT fb.${tickets.columns.ticket_id}
          FROM ${ticket_dependencies} bd
          INNER JOIN ${tickets} fb ON fb.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
          WHERE bd.${ticket_dependencies.columns.ticket_id} = ?
            AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
            AND fb.${tickets.columns.labels} LIKE '%gt:pr-conflict%'
            AND fb.${tickets.columns.status} NOT IN ('closed', 'failed')
          LIMIT 1
        `,
        [mrTicketId]
      ),
    ]);
  return rows.length > 0 ? rows[0].ticket_id : null;
}

/** Check if an MR ticket has a non-terminal feedback ticket (gt:pr-feedback) blocking it. */
function hasExistingPrFeedbackTicket(sql: SqlStorage, mrTicketId: string): boolean {
  return getExistingPrFeedbackTicketId(sql, mrTicketId) !== null;
}

/** Return the ticket_id of a non-terminal feedback ticket (gt:pr-feedback) blocking the MR, or null. */
function getExistingPrFeedbackTicketId(sql: SqlStorage, mrTicketId: string): string | null {
  const rows = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT fb.${tickets.columns.ticket_id}
          FROM ${ticket_dependencies} bd
          INNER JOIN ${tickets} fb ON fb.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
          WHERE bd.${ticket_dependencies.columns.ticket_id} = ?
            AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
            AND fb.${tickets.columns.labels} LIKE '%gt:pr-feedback%'
            AND fb.${tickets.columns.status} NOT IN ('closed', 'failed')
          LIMIT 1
        `,
        [mrTicketId]
      ),
    ]);
  return rows.length > 0 ? rows[0].ticket_id : null;
}

/** Build a human-readable title for the feedback ticket. */
function buildFeedbackTicketTitle(
  prNumber: number,
  repo: string,
  hasComments: boolean,
  hasFailingChecks: boolean,
  hasUncheckedRuns = false
): string {
  const parts: string[] = [];
  if (hasComments) parts.push('review comments');
  if (hasFailingChecks) parts.push('failing CI');
  if (hasUncheckedRuns && !hasFailingChecks) parts.push('unchecked CI runs');
  const shortRepo = repo.includes('/') ? repo.split('/').pop() : repo;
  return `Address ${parts.join(' & ')} on PR #${prNumber}${shortRepo ? ` (${shortRepo})` : ''}`;
}

/** Build the soul prompt body for addressing PR feedback. */
function buildFeedbackPrompt(
  prNumber: number,
  repo: string,
  branch: string,
  hasComments: boolean,
  hasFailingChecks: boolean,
  hasUncheckedRuns = false
): string {
  const lines: string[] = [];
  lines.push(`You are addressing feedback on PR #${prNumber} on ${repo}, branch ${branch}.`);
  lines.push('');

  if (hasComments && hasFailingChecks) {
    lines.push('This PR has both unresolved review comments and failing CI checks.');
    lines.push(
      'Address the review comments first, then fix the CI failures, as comment fixes may also resolve some CI issues.'
    );
  } else if (hasComments && hasUncheckedRuns) {
    lines.push(
      'This PR has unresolved review comments and more than 100 CI check-runs (not all could be inspected). Address the review comments and verify CI status.'
    );
  } else if (hasComments) {
    lines.push('This PR has unresolved review comments.');
  } else if (hasFailingChecks) {
    lines.push('This PR has failing CI checks.');
  } else if (hasUncheckedRuns) {
    lines.push(
      'This PR has more than 100 CI check-runs. Not all could be inspected by the system. Check `gh pr checks` for the full status and fix any failures.'
    );
  }

  lines.push('');
  lines.push('## Review Comments');
  lines.push('');
  lines.push(`Run \`gh pr view ${prNumber} --comments\` to see all review comments.`);
  lines.push('');
  lines.push('For each unresolved comment thread:');
  lines.push(
    "- If it's a relevant code fix: make the change, push, reply explaining what you did, and resolve the thread"
  );
  lines.push("- If it's not relevant: reply explaining why, and resolve the thread");
  lines.push('');
  lines.push("It's important to resolve the full thread rather than just the base comment.");
  lines.push('');
  lines.push('## CI Checks');
  lines.push('');
  lines.push(`Run \`gh pr checks ${prNumber}\` to see the status of all CI checks.`);
  lines.push('');
  lines.push('For each failing check:');
  lines.push('- Read the failure logs via `gh run view <run_id> --log-failed`');
  lines.push('- Fix the underlying issue (test failure, lint error, type error, etc.)');
  lines.push('- Push the fix');
  lines.push('- Verify the check passes by reviewing the new run');
  lines.push('');
  lines.push(
    'After addressing everything, push all changes in a single commit (or minimal commits) and call gt_done.'
  );

  return lines.join('\n');
}

/** Build the soul prompt body for resolving merge conflicts on a PR branch. */
function buildConflictResolutionPrompt(
  prUrl: string,
  branch: string,
  targetBranch: string
): string {
  const lines: string[] = [];
  lines.push(`You are resolving merge conflicts on branch \`${branch}\`.`);
  lines.push(`The PR is: ${prUrl}`);
  lines.push(`The target branch is: \`${targetBranch}\``);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('1. Fetch the latest state of the remote:');
  lines.push('   ```');
  lines.push('   git fetch origin');
  lines.push('   ```');
  lines.push('');
  lines.push(`2. Rebase your branch onto the target branch to incorporate its latest changes:`);
  lines.push('   ```');
  lines.push(`   git rebase origin/${targetBranch}`);
  lines.push('   ```');
  lines.push('');
  lines.push('3. If there are conflicts during rebase, resolve them:');
  lines.push(
    '   - Edit the conflicting files to resolve the conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)'
  );
  lines.push('   - Stage the resolved files: `git add <file>`');
  lines.push('   - Continue the rebase: `git rebase --continue`');
  lines.push('   - Repeat until the rebase completes');
  lines.push('');
  lines.push('4. Push the rebased branch:');
  lines.push('   ```');
  lines.push(`   git push --force-with-lease origin ${branch}`);
  lines.push('   ```');
  lines.push('');
  lines.push('5. Call `gt_done` once the push succeeds, passing both required arguments:');
  lines.push(`   - \`pr_url\`: \`${prUrl}\``);
  lines.push(`   - \`branch\`: \`${branch}\``);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════
// reconcileHelldeskClaims — auto-report `done` upstream once every
// helldesk-tagged MR for a claim has reached a merged terminal state.
// Idempotent via `metadata.helldesk.reported_done_at` on the canonical
// ticket (the shift ticket if one exists, else the first task ticket).
// ════════════════════════════════════════════════════════════════════

const HelldeskReporterRow = TicketRecord.pick({
  ticket_id: true,
  type: true,
  status: true,
  title: true,
  metadata: true,
  created_at: true,
}).extend({
  pr_url: ReviewMetadataRecord.shape.pr_url,
});

export function reconcileHelldeskClaims(sql: SqlStorage): Action[] {
  // Load every helldesk-tagged ticket whose claim has NOT been reported yet.
  // The "reported" flag lives on a single canonical ticket per claim, so we
  // filter at the SQL layer using a NOT EXISTS over the same
  // (helldesk_id, item_id) group. This keeps the scan bounded to active
  // claims even when the department has accumulated many completed ones.
  const rows = HelldeskReporterRow.array().parse([
    ...query(
      sql,
      /* sql */ `
        SELECT ${tickets.ticket_id},
               ${tickets.type},
               ${tickets.status},
               ${tickets.title},
               ${tickets.metadata},
               ${tickets.created_at},
               ${review_metadata.pr_url} AS pr_url
        FROM ${tickets}
        LEFT JOIN ${review_metadata}
          ON ${review_metadata.ticket_id} = ${tickets.ticket_id}
        WHERE json_extract(${tickets.metadata}, '$.helldesk.item_id') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM ${tickets} other
            WHERE json_extract(other.${tickets.columns.metadata}, '$.helldesk.helldesk_id')
                  = json_extract(${tickets.metadata}, '$.helldesk.helldesk_id')
              AND json_extract(other.${tickets.columns.metadata}, '$.helldesk.item_id')
                  = json_extract(${tickets.metadata}, '$.helldesk.item_id')
              AND json_extract(other.${tickets.columns.metadata}, '$.helldesk.reported_done_at')
                  IS NOT NULL
          )
      `,
      []
    ),
  ]);

  const reporterTickets: ReporterTicket[] = rows.map(r => ({
    ticket_id: r.ticket_id,
    type: r.type,
    status: r.status,
    title: r.title,
    metadata: r.metadata,
    pr_url: r.pr_url,
    created_at: r.created_at,
  }));

  const claims = groupTicketsByHelldeskClaim(reporterTickets);
  const actions: Action[] = [];

  for (const claim of claims) {
    if (isAlreadyReported(claim)) continue;
    const status = computeClaimStatus(claim);
    if (status.kind !== 'merged') continue;

    const evidence = buildEvidence(
      status,
      claim.tickets[0]?.title ?? `helldesk item ${claim.item_id}`
    );
    actions.push({
      type: 'report_helldesk_done',
      canonical_ticket_id: claim.canonical_ticket_id,
      helldesk_id: claim.helldesk_id,
      item_id: claim.item_id,
      evidence,
    });
  }

  return actions;
}

// ════════════════════════════════════════════════════════════════════
// Invariant checker — runs after action application to detect
// violations of the system invariants from spec §6.
// ════════════════════════════════════════════════════════════════════

export type Violation = {
  invariant: number;
  message: string;
};

/**
 * Check all system invariants. Returns violations found.
 * Should run at the end of each alarm tick after actions are applied.
 * See reconciliation-spec.md §6.
 */
export function checkInvariants(sql: SqlStorage): Violation[] {
  const violations: Violation[] = [];

  // Invariant 7: Working agents must have hooks
  // FrontDesk are always 'working' and intentionally have no hook — exclude them.
  const unhookedWorkers = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.ticket_id}
        FROM ${agent_metadata}
        WHERE ${agent_metadata.status} = 'working'
          AND ${agent_metadata.current_hook_ticket_id} IS NULL
          AND ${agent_metadata.role} != 'frontDesk'
      `,
        []
      ),
    ]);
  for (const a of unhookedWorkers) {
    violations.push({
      invariant: 7,
      message: `Working agent ${a.ticket_id} has no hook`,
    });
  }

  // Invariant 5: Shift tickets should not be in unexpected states.
  // Valid states: open, in_progress, in_review, closed, failed.
  // 'failed' is a terminal state set by FailShift when landing MR
  // creation is exhausted.
  const badStateShifts = z
    .object({ ticket_id: z.string(), status: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${tickets.ticket_id}, ${tickets.status}
        FROM ${tickets}
        WHERE ${tickets.type} = 'shift'
          AND ${tickets.status} NOT IN ('open', 'in_progress', 'in_review', 'closed', 'failed')
      `,
        []
      ),
    ]);
  for (const c of badStateShifts) {
    violations.push({
      invariant: 5,
      message: `Shift ticket ${c.ticket_id} is in unexpected state '${c.status}'`,
    });
  }

  // Invariant 3: Only one MR ticket in_progress per workstation (qualityAssurance is serial)
  const duplicateMrPerWorkstation = z
    .object({ workstation_id: z.string(), cnt: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${tickets.workstation_id} as workstation_id, count(*) as cnt
        FROM ${tickets}
        WHERE ${tickets.type} = 'merge_request'
          AND ${tickets.status} = 'in_progress'
          AND ${tickets.workstation_id} IS NOT NULL
        GROUP BY ${tickets.workstation_id}
        HAVING count(*) > 1
      `,
        []
      ),
    ]);
  for (const r of duplicateMrPerWorkstation) {
    violations.push({
      invariant: 3,
      message: `Workstation ${r.workstation_id} has ${r.cnt} in_progress MR tickets (should be at most 1)`,
    });
  }

  // Invariant 6: At most one agent hooked per ticket
  const multiHooked = z
    .object({ hook: z.string(), cnt: z.number() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${agent_metadata.current_hook_ticket_id} as hook, count(*) as cnt
        FROM ${agent_metadata}
        WHERE ${agent_metadata.current_hook_ticket_id} IS NOT NULL
        GROUP BY ${agent_metadata.current_hook_ticket_id}
        HAVING count(*) > 1
      `,
        []
      ),
    ]);
  for (const m of multiHooked) {
    violations.push({
      invariant: 6,
      message: `Ticket ${m.hook} has ${m.cnt} agents hooked (should be at most 1)`,
    });
  }

  // Invariant 4: in_review tickets must have at least one open/in_progress MR
  const orphanedInReview = z
    .object({ ticket_id: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT b.${tickets.columns.ticket_id}
        FROM ${tickets} b
        WHERE b.${tickets.columns.type} = 'issue'
          AND b.${tickets.columns.status} = 'in_review'
          AND NOT EXISTS (
            SELECT 1
            FROM ${ticket_dependencies} bd
            INNER JOIN ${tickets} mr ON mr.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.ticket_id}
            WHERE bd.${ticket_dependencies.columns.depends_on_ticket_id} = b.${tickets.columns.ticket_id}
              AND bd.${ticket_dependencies.columns.dependency_type} = 'tracks'
              AND mr.${tickets.columns.type} = 'merge_request'
              AND mr.${tickets.columns.status} IN ('open', 'in_progress')
          )
      `,
        []
      ),
    ]);
  for (const b of orphanedInReview) {
    violations.push({
      invariant: 4,
      message: `Issue ticket ${b.ticket_id} is in_review but has no open/in_progress MR ticket`,
    });
  }

  return violations;
}

export type ReconcilerMetrics = {
  eventsDrained: number;
  actionsEmitted: number;
  actionsByType: Record<string, number>;
  sideEffectsAttempted: number;
  sideEffectsSucceeded: number;
  sideEffectsFailed: number;
  invariantViolations: number;
  wallClockMs: number;
  pendingEventCount: number;
};
