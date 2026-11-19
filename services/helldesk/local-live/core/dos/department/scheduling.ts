/**
 * Agent scheduling and dispatch for the Department DO alarm loop.
 *
 * Owns the core dispatch/retry logic that was previously inline in
 * Department.do.ts. The Department DO delegates to these pure(ish) functions,
 * passing its SQL handle and env bindings.
 */

import * as Sentry from '@sentry/cloudflare';
import { tickets } from '../../db/tables/tickets.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { query } from '../../util/query.util';
import { now } from '../../util/id.util';
import * as ticketOps from './tickets';
import * as agents from './agents';
import * as workstations from './workstations';
import * as dispatch from './container-dispatch';
import * as attendance from './attendance';
import type { Agent, Ticket, DepartmentConfig } from '../../types';
import type { HelldeskEventData } from '../../util/analytics.util';

const LOG = '[scheduling]';

export const DISPATCH_COOLDOWN_MS = 30_000;
export const MAX_DISPATCH_ATTEMPTS = 5;

type SchedulingContext = {
  sql: SqlStorage;
  env: Env;
  storage: DurableObjectStorage;
  departmentId: string;
  getDepartmentConfig: () => Promise<DepartmentConfig>;
  getWorkstationConfig: (workstationId: string) => Promise<WorkstationConfig | null>;
  resolveKilocodeToken: () => Promise<string | undefined>;
  emitEvent: (data: Omit<HelldeskEventData, 'userId' | 'delivery'>) => void;
  prepareContainerBilling: () => Promise<void>;
};

type WorkstationConfig = {
  departmentId: string;
  workstationId: string;
  gitUrl: string;
  defaultBranch: string;
  userId: string;
  kilocodeToken?: string;
  platformIntegrationId?: string;
  merge_strategy?: string;
};

/**
 * Dispatch a single agent to the container. Transitions the ticket to
 * in_progress and the agent to working BEFORE the async network call
 * (I/O gate safety for fire-and-forget callers). Returns true if the
 * container accepted the agent.
 */
export async function dispatchAgent(
  ctx: SchedulingContext,
  agent: Agent,
  ticket: Ticket,
  options?: { systemPromptOverride?: string }
): Promise<boolean> {
  try {
    const workstationId = agent.workstation_id ?? workstations.listWorkstations(ctx.sql)[0]?.id ?? '';
    const workstationConfig = workstationId ? await ctx.getWorkstationConfig(workstationId) : null;
    if (!workstationConfig) {
      console.warn(`${LOG} dispatchAgent: no workstation config for agent=${agent.id} workstation=${workstationId}`);
      return false;
    }

    const departmentConfig = await ctx.getDepartmentConfig();
    const kilocodeToken = await ctx.resolveKilocodeToken();
    await ctx.prepareContainerBilling();

    const shiftId = ticketOps.getShiftForTicket(ctx.sql, ticket.ticket_id);
    const shiftFeatureBranch = shiftId ? ticketOps.getShiftFeatureBranch(ctx.sql, shiftId) : null;

    // Transition ticket to in_progress BEFORE the async container start.
    // Must happen synchronously within the I/O gate — fire-and-forget
    // callers (slingTicket, slingShift) close the gate before the
    // network call completes.
    const currentTicket = ticketOps.getTicket(ctx.sql, ticket.ticket_id);
    if (
      currentTicket &&
      currentTicket.status !== 'in_progress' &&
      currentTicket.status !== 'closed' &&
      currentTicket.status !== 'failed'
    ) {
      ticketOps.updateTicketStatus(ctx.sql, ticket.ticket_id, 'in_progress', agent.id);
    }

    // Set agent to 'working' BEFORE the async container start (same
    // I/O gate rationale).
    const timestamp = now();
    query(
      ctx.sql,
      /* sql */ `
        UPDATE ${agent_metadata}
        SET ${agent_metadata.columns.status} = 'working',
            ${agent_metadata.columns.dispatch_attempts} = ${agent_metadata.columns.dispatch_attempts} + 1,
            ${agent_metadata.columns.last_activity_at} = ?,
            ${agent_metadata.columns.last_event_at} = NULL,
            ${agent_metadata.columns.last_event_type} = NULL
        WHERE ${agent_metadata.ticket_id} = ?
      `,
      [timestamp, agent.id]
    );
    // Track dispatch attempts on the ticket itself so the counter
    // survives agent re-creation and hookTicket cycles.
    query(
      ctx.sql,
      /* sql */ `
        UPDATE ${tickets}
        SET ${tickets.columns.dispatch_attempts} = ${tickets.columns.dispatch_attempts} + 1,
            ${tickets.columns.last_dispatch_attempt_at} = ?
        WHERE ${tickets.ticket_id} = ?
      `,
      [timestamp, ticket.ticket_id]
    );

    const workstationRecord = workstations.getWorkstation(ctx.sql, workstationId);

    const { started, containerFetchMs } = await dispatch.startAgentInContainer(
      ctx.env,
      ctx.storage,
      {
        departmentId: ctx.departmentId,
        workstationId,
        userId: workstationConfig.userId,
        agentId: agent.id,
        agentName: agent.name,
        role: agent.role,
        identity: agent.identity,
        ticketId: ticket.ticket_id,
        ticketTitle: ticket.title,
        ticketBody: ticket.body ?? '',
        checkpoint: agent.checkpoint,
        gitUrl: workstationConfig.gitUrl,
        defaultBranch: workstationConfig.defaultBranch,
        kilocodeToken,
        departmentConfig,
        workstationOverride: workstationRecord?.config ?? null,
        platformIntegrationId: workstationConfig.platformIntegrationId,
        shiftFeatureBranch: shiftFeatureBranch ?? undefined,
        systemPromptOverride: options?.systemPromptOverride,
      }
    );

    if (started) {
      // Reset dispatch_attempts on successful start — but NOT for refineries.
      // Refineries can loop (idle-timeout → re-dispatch) many times on the
      // same MR ticket, so we keep the counter monotonically increasing until
      // the ticket is closed or the agent hooks a new ticket (#1342).
      if (agent.role !== 'qualityAssurance') {
        query(
          ctx.sql,
          /* sql */ `
            UPDATE ${agent_metadata}
            SET ${agent_metadata.columns.dispatch_attempts} = 0
            WHERE ${agent_metadata.ticket_id} = ?
          `,
          [agent.id]
        );
      }
      console.log(`${LOG} dispatchAgent: started agent=${agent.name}(${agent.id})`);
      ctx.emitEvent({
        event: 'agent.spawned',
        departmentId: ctx.departmentId,
        workstationId,
        agentId: agent.id,
        ticketId: ticket.ticket_id,
        role: agent.role,
        durationMs: containerFetchMs,
      });
    } else {
      // Container start returned false — but the container may have
      // actually started the agent (timeout race). Leave the agent
      // as 'working' so the reconciler doesn't treat it as lost.
      // If the agent truly didn't start: reconcileAgents catches it
      // after 90s of missing heartbeats and transitions to 'idle'.
      // If the agent actually started: heartbeats keep it alive. (#1358)
      const startError = dispatch.getLastStartError();
      ctx.emitEvent({
        event: 'agent.dispatch_failed',
        departmentId: ctx.departmentId,
        workstationId,
        agentId: agent.id,
        ticketId: ticket.ticket_id,
        role: agent.role,
        reason: startError ?? 'container returned false',
      });
    }
    return started;
  } catch (err) {
    console.error(`${LOG} dispatchAgent: failed for agent=${agent.id}:`, err);
    Sentry.captureException(err, {
      extra: { agentId: agent.id, ticketId: ticket.ticket_id },
    });
    // Do NOT transition the agent to 'idle' here. The container may
    // already have accepted /agents/start (e.g. /refresh-token failed
    // late, after the agent process spawned), in which case the SDK
    // session is alive and heartbeating. Marking it idle would trip
    // reconcileAgents Rule 3 (idle agent + hooked + live ticket →
    // unhook + reset ticket), tearing the hook out from under the
    // running session and causing tools like gt_request_changes to
    // fail with "is not hooked to a ticket" (#1358 follow-up).
    //
    // Instead, leave the agent as 'working'. If the container truly
    // didn't start, reconcileAgents catches it after 90s of missing
    // heartbeats and transitions to 'idle' through the normal path.
    ctx.emitEvent({
      event: 'agent.dispatch_failed',
      departmentId: ctx.departmentId,
      agentId: agent.id,
      ticketId: ticket.ticket_id,
      role: agent.role,
      reason: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * When a ticket closes, find tickets that were blocked by it and are now
 * fully unblocked. Dispatch their assigned agents (fire-and-forget).
 */
export function dispatchUnblockedTickets(ctx: SchedulingContext, closedTicketId: string): void {
  const unblockedIds = ticketOps.getNewlyUnblockedTickets(ctx.sql, closedTicketId);
  if (unblockedIds.length === 0) return;

  console.log(
    `${LOG} dispatchUnblockedTickets: ${unblockedIds.length} tickets unblocked by ${closedTicketId}`
  );

  for (const ticketId of unblockedIds) {
    const ticket = ticketOps.getTicket(ctx.sql, ticketId);
    if (!ticket || ticket.status === 'closed' || ticket.status === 'failed') continue;

    if (!ticket.assignee_agent_ticket_id) continue;
    const agent = agents.getAgent(ctx.sql, ticket.assignee_agent_ticket_id);
    if (!agent || agent.status !== 'idle') continue;

    dispatchAgent(ctx, agent, ticket).catch(err =>
      console.error(
        `${LOG} dispatchUnblockedTickets: fire-and-forget dispatch failed for ticket=${ticketId}`,
        err
      )
    );
  }
}

/**
 * Returns true if the department has work that requires the fast (5s) alarm
 * interval. Used to decide between active and idle alarm cadence.
 *
 * Each signal is wrapped in a thunk so `||` short-circuits at the SQL
 * layer: as soon as one signal returns true we skip the remaining
 * queries. On a hot department with working agents this avoids 4 extra reads
 * per check; on a cold idle department it costs the full 5 reads (same as
 * before).
 */
export function hasActiveWork(sql: SqlStorage): boolean {
  // Idle agents that already hold a hook — the reconciler should dispatch
  // them on the next tick.
  const hasHookedIdleAgents = (): boolean =>
    countOf([
      ...query(
        sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata}
          WHERE ${agent_metadata.status} = 'idle'
            AND ${agent_metadata.current_hook_ticket_id} IS NOT NULL`,
        []
      ),
    ]) > 0;

  const hasOpenMergeRequests = (): boolean =>
    countOf([
      ...query(
        sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${tickets}
          WHERE ${tickets.type} = 'merge_request'
            AND ${tickets.status} IN ('open', 'in_progress')`,
        []
      ),
    ]) > 0;

  const hasOpenTriageTickets = (): boolean =>
    countOf([
      ...query(
        sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${tickets}
          WHERE ${tickets.type} = 'issue'
            AND ${tickets.labels} LIKE ?
            AND ${tickets.status} = 'open'`,
        [attendance.TRIAGE_LABEL_LIKE]
      ),
    ]) > 0;

  // Open issue tickets with a workstation (eligible for dispatch by reconcileTickets Rule 1)
  // but not yet assigned to any agent. Without this check, the alarm drops to
  // idle cadence after a container restart when agents lose their hooks and
  // tickets revert to open+unassigned, delaying dispatch by up to 5 minutes.
  const hasUnassignedIssues = (): boolean =>
    countOf([
      ...query(
        sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${tickets}
          WHERE ${tickets.type} = 'issue'
            AND ${tickets.status} = 'open'
            AND ${tickets.workstation_id} IS NOT NULL
            AND ${tickets.assignee_agent_ticket_id} IS NULL`,
        []
      ),
    ]) > 0;

  return (
    hasRunningAgents(sql) ||
    hasHookedIdleAgents() ||
    hasOpenMergeRequests() ||
    hasOpenTriageTickets() ||
    hasUnassignedIssues()
  );
}

/**
 * Returns true if an agent process should be running in the container. Only
 * this keeps the container awake: other active work starts the container
 * when the reconciler dispatches it, and work it never dispatches must not
 * hold the container forever.
 */
export function hasRunningAgents(sql: SqlStorage): boolean {
  // Stalled agents older than 30min no longer count as active work: they
  // typically represent stuck rows (container crashed hard, /status keeps
  // returning running/unknown). Keeping them in the active set would pin
  // the alarm at its 5s fast cadence indefinitely. The stalled->idle
  // auto-transition in reconcileAgents cleans them up after 2h 30min.
  return (
    countOf([
      ...query(
        sql,
        /* sql */ `SELECT COUNT(*) as cnt FROM ${agent_metadata}
          WHERE ${agent_metadata.status} = 'working'
             OR (${agent_metadata.status} = 'stalled'
                 AND ${agent_metadata.last_activity_at} > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'))`,
        []
      ),
    ]) > 0
  );
}

/** Read the `cnt` column off the first row of a `SELECT COUNT(*) as cnt` query. */
function countOf(rows: ReadonlyArray<Record<string, unknown>>): number {
  return Number(rows[0]?.cnt ?? 0);
}
