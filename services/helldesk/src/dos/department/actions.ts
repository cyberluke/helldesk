/**
 * Reconciler action types and application.
 *
 * Actions are the reconciler's outputs — they describe mutations to apply
 * and side effects to execute. Nothing mutates ticket/agent/shift state
 * directly; all mutations flow through applyAction().
 *
 * See reconciliation-spec.md §4.
 */

import { z } from 'zod';
import { tickets } from '../../db/tables/tickets.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { shift_metadata } from '../../db/tables/shift-metadata.table';
import { ticket_dependencies } from '../../db/tables/ticket-dependencies.table';
import { agent_nudges } from '../../db/tables/agent-nudges.table';
import { review_metadata } from '../../db/tables/review-metadata.table';
import { query } from '../../util/query.util';
import { now } from '../../util/id.util';
import * as ticketOps from './tickets';
import * as agentOps from './agents';
import * as reviewQueue from './review-queue';
import * as attendance from './attendance';
import { getWorkstation } from './workstations';
import { parseGitUrl } from '../../util/platform-pr.util';
import type { PRStatusOutcome, PRStatusError } from './department-scm';

const TransitionTicket = z.object({
  type: z.literal('transition_Ticket'),
  ticket_id: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
  actor: z.string(),
});

const AssignTicket = z.object({
  type: z.literal('assign_Ticket'),
  ticket_id: z.string(),
  agent_id: z.string(),
});

const ClearTicketAssignee = z.object({
  type: z.literal('clear_ticket_assignee'),
  ticket_id: z.string(),
});

const CreateMrTicket = z.object({
  type: z.literal('create_mr_Ticket'),
  source_ticket_id: z.string(),
  agent_id: z.string(),
  workstation_id: z.string(),
  branch: z.string(),
  target_branch: z.string(),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

const CreateLandingMr = z.object({
  type: z.literal('create_landing_mr'),
  shift_id: z.string(),
  workstation_id: z.string(),
  feature_branch: z.string(),
  target_branch: z.string(),
});

const CloseSiblingMrs = z.object({
  type: z.literal('close_sibling_mrs'),
  source_ticket_id: z.string(),
  exclude_mr_id: z.string(),
});

const SetReviewPrUrl = z.object({
  type: z.literal('set_review_pr_url'),
  ticket_id: z.string(),
  pr_url: z.string(),
});

const TransitionAgent = z.object({
  type: z.literal('transition_agent'),
  agent_id: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  reason: z.string(),
});

const HookAgent = z.object({
  type: z.literal('hook_agent'),
  agent_id: z.string(),
  ticket_id: z.string(),
});

const UnhookAgent = z.object({
  type: z.literal('unhook_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

const ClearAgentCheckpoint = z.object({
  type: z.literal('clear_agent_checkpoint'),
  agent_id: z.string(),
});

const ResetAgentDispatchAttempts = z.object({
  type: z.literal('reset_agent_dispatch_attempts'),
  agent_id: z.string(),
});

const DeleteAgent = z.object({
  type: z.literal('delete_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

const UpdateShiftProgress = z.object({
  type: z.literal('update_shift_progress'),
  shift_id: z.string(),
  closed_tickets: z.number(),
});

const SetShiftReadyToLand = z.object({
  type: z.literal('set_shift_ready_to_land'),
  shift_id: z.string(),
});

const CloseShift = z.object({
  type: z.literal('close_shift'),
  shift_id: z.string(),
});

const FailShift = z.object({
  type: z.literal('fail_shift'),
  shift_id: z.string(),
  reason: z.string(),
});

const DispatchAgent = z.object({
  type: z.literal('dispatch_agent'),
  agent_id: z.string(),
  ticket_id: z.string(),
  workstation_id: z.string(),
});

const StopAgent = z.object({
  type: z.literal('stop_agent'),
  agent_id: z.string(),
  reason: z.string(),
});

const PollPr = z.object({
  type: z.literal('poll_pr'),
  ticket_id: z.string(),
  pr_url: z.string(),
});

const SendNudge = z.object({
  type: z.literal('send_nudge'),
  agent_id: z.string(),
  message: z.string(),
  tier: z.enum(['warn', 'escalate', 'force_stop']),
});

const CreateTriageRequest = z.object({
  type: z.literal('create_triage_request'),
  agent_id: z.string(),
  triage_type: z.string(),
  reason: z.string(),
});

const NotifyFrontDesk = z.object({
  type: z.literal('notifyFrontDesk'),
  message: z.string(),
});

const MergePr = z.object({
  type: z.literal('merge_pr'),
  ticket_id: z.string(),
  pr_url: z.string(),
});

const EmitEvent = z.object({
  type: z.literal('emit_event'),
  event_name: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const ReportHelldeskDone = z.object({
  type: z.literal('report_helldesk_done'),
  /** The ticket the reporter stamps `reported_done_at` on once the RPC succeeds. */
  canonical_ticket_id: z.string(),
  helldesk_id: z.string(),
  item_id: z.string(),
  evidence: z.string(),
});

export const Action = z.discriminatedUnion('type', [
  // Ticket mutations
  TransitionTicket,
  AssignTicket,
  ClearTicketAssignee,
  CreateMrTicket,
  CreateLandingMr,
  CloseSiblingMrs,
  SetReviewPrUrl,
  // Agent mutations
  TransitionAgent,
  ResetAgentDispatchAttempts,
  HookAgent,
  UnhookAgent,
  ClearAgentCheckpoint,
  DeleteAgent,
  // Shift mutations
  UpdateShiftProgress,
  SetShiftReadyToLand,
  CloseShift,
  FailShift,
  // Side effects
  DispatchAgent,
  StopAgent,
  PollPr,
  MergePr,
  SendNudge,
  CreateTriageRequest,
  NotifyFrontDesk,
  EmitEvent,
  ReportHelldeskDone,
]);

export type Action = z.infer<typeof Action>;

// These aren't validated at construction time (they're built by the
// reconciler itself), so we export plain type aliases for convenience.

export type TransitionTicket = z.infer<typeof TransitionTicket>;
export type AssignTicket = z.infer<typeof AssignTicket>;
export type ClearTicketAssignee = z.infer<typeof ClearTicketAssignee>;
export type CreateMrTicket = z.infer<typeof CreateMrTicket>;
export type CreateLandingMr = z.infer<typeof CreateLandingMr>;
export type CloseSiblingMrs = z.infer<typeof CloseSiblingMrs>;
export type SetReviewPrUrl = z.infer<typeof SetReviewPrUrl>;
export type TransitionAgent = z.infer<typeof TransitionAgent>;
export type ResetAgentDispatchAttempts = z.infer<typeof ResetAgentDispatchAttempts>;
export type HookAgent = z.infer<typeof HookAgent>;
export type UnhookAgent = z.infer<typeof UnhookAgent>;
export type ClearAgentCheckpoint = z.infer<typeof ClearAgentCheckpoint>;
export type DeleteAgent = z.infer<typeof DeleteAgent>;
export type UpdateShiftProgress = z.infer<typeof UpdateShiftProgress>;
export type SetShiftReadyToLand = z.infer<typeof SetShiftReadyToLand>;
export type CloseShift = z.infer<typeof CloseShift>;
export type FailShift = z.infer<typeof FailShift>;
export type DispatchAgent = z.infer<typeof DispatchAgent>;
export type StopAgent = z.infer<typeof StopAgent>;
export type PollPr = z.infer<typeof PollPr>;
export type MergePr = z.infer<typeof MergePr>;
export type SendNudge = z.infer<typeof SendNudge>;
export type CreateTriageRequest = z.infer<typeof CreateTriageRequest>;
export type NotifyFrontDesk = z.infer<typeof NotifyFrontDesk>;
export type EmitEvent = z.infer<typeof EmitEvent>;
export type ReportHelldeskDone = z.infer<typeof ReportHelldeskDone>;

// applyAction needs access to departmentDO-level resources for side effects.
// The SQL handle is for synchronous mutations; the rest are for async
// side effects (dispatch, stop, poll, nudge).

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export type MergeStateStatus =
  | 'CLEAN'
  | 'BLOCKED'
  | 'BEHIND'
  | 'DIRTY'
  | 'HAS_HOOKS'
  | 'UNKNOWN'
  | null;

/** Result of checking PR feedback (unresolved comments + failing CI checks). */
export type PRFeedbackCheckResult = {
  hasUnresolvedComments: boolean;
  hasFailingChecks: boolean;
  allChecksPass: boolean;
  /** True when the check-runs response was paginated and not all runs were
   *  inspected. allChecksPass is already false in this case, but
   *  hasFailingChecks only reflects the runs we actually saw. */
  hasUncheckedRuns: boolean;
  /** True when the PR requires human approval per branch protection
   *  (reviewDecision === 'REVIEW_REQUIRED' or mergeStateStatus === 'BLOCKED'). */
  awaitingApproval: boolean;
  /** True when a reviewer has actively requested changes
   *  (reviewDecision === 'CHANGES_REQUESTED'). */
  changesRequested: boolean;
  reviewDecision: ReviewDecision;
  mergeStateStatus: MergeStateStatus;
  isDraft: boolean;
};

export type ApplyActionContext = {
  sql: SqlStorage;
  departmentId: string;
  /** Dispatch an agent to its container. Returns true if container accepted. */
  dispatchAgent: (agentId: string, ticketId: string, workstationId: string) => Promise<boolean>;
  /** Stop an agent's container process. */
  stopAgent: (agentId: string) => Promise<void>;
  /** Check a PR's status via GitHub/GitLab API. Returns PRStatusOutcome. */
  checkPRStatus: (prUrl: string) => Promise<PRStatusOutcome>;
  /** Check PR for unresolved review comments and failing CI checks. */
  checkPRFeedback: (prUrl: string) => Promise<PRFeedbackCheckResult | null>;
  /** Merge a PR via GitHub/GitLab API. */
  mergePR: (prUrl: string) => Promise<boolean>;
  /** Queue a nudge message for an agent. */
  queueNudge: (agentId: string, message: string, tier: string) => Promise<void>;
  /** Insert a department_event for deferred processing (e.g. pr_status_changed). */
  insertEvent: (
    eventType: string,
    params: { agent_id?: string | null; ticket_id?: string | null; payload?: Record<string, unknown> }
  ) => void;
  /** Emit an analytics/WebSocket event. */
  emitEvent: (data: Record<string, unknown>) => void;
  /** Get the current department config (read lazily). */
  getDepartmentConfig: () => Promise<{
    qualityAssurance?: {
      auto_merge?: boolean;
      auto_resolve_pr_feedback?: boolean;
      auto_merge_delay_minutes?: number | null;
    };
  }>;
  /**
   * Mark a helldesk wanted item as done upstream and stamp
   * `metadata.helldesk.reported_done_at` on the canonical ticket. Returns
   * true on success, false otherwise; failures are logged and do not throw.
   * The reconciler retries on the next tick because the local stamp is
   * the idempotency gate.
   */
  reportHelldeskDone: (input: {
    helldeskId: string;
    itemId: string;
    evidence: string;
    canonicalTicketId: string;
  }) => Promise<boolean>;
};

const LOG = '[actions]';

/** Fail MR ticket after this many consecutive null poll results (#1632). */
const PR_POLL_NULL_THRESHOLD = 10;

/** Fail MR ticket after this many consecutive non-transient errors (invalid_response). */
const PR_POLL_NON_TRANSIENT_THRESHOLD = 3;

/** Minimum interval between PR polls per MR ticket (ms) (#1632). */
export const PR_POLL_INTERVAL_MS = 60_000; // 1 minute

function providerLabel(provider: 'github' | 'gitlab'): string {
  return provider === 'github' ? 'GitHub' : 'GitLab';
}

function failureMessageFor(error: PRStatusError): string {
  switch (error.kind) {
    case 'owner_lookup_failed':
      return 'Department ownership lookup failed repeatedly. Retry when the service is available.';
    case 'no_token':
      return (
        `No ${providerLabel(error.provider)} token resolved for this department. Tried (in order): ` +
        error.resolutionChain.map(s => `\`${s}\``).join(', ') +
        `. Configure one of these in department or workstation settings. ` +
        `Note: soul agents use their own container credentials and ` +
        `may have created the PR successfully — that does not imply the ` +
        `department worker can poll PR status.`
      );
    case 'http_error':
      if (error.status === 401) {
        return `Department's ${providerLabel(error.provider)} token is invalid or expired (HTTP 401). Refresh the token in department settings.`;
      }
      if (error.status === 403) {
        const scopeHint =
          error.provider === 'github'
            ? 'Ensure the token has `pull-requests: read` scope on the repo, or check for a secondary rate limit.'
            : 'Ensure the token has permission to read merge requests in the project.';
        return `Department's ${providerLabel(error.provider)} token lacks permission for this PR (HTTP 403). ${scopeHint}`;
      }
      if (error.status === 404) {
        return `${error.provider === 'github' ? 'PR' : 'MR'} not found (HTTP 404). Was the branch deleted before it could be polled, or is the URL wrong?`;
      }
      return `${error.provider} API returned HTTP ${error.status} ${error.statusText}. ${error.transient ? 'Retrying.' : 'Not retryable.'}`;
    case 'invalid_response':
      return (
        `${error.provider} API returned an unexpected response shape ` +
        `(${error.reason})${error.sampleKeys ? `; top-level keys: ${error.sampleKeys.join(', ')}` : ''}. ` +
        `Please file a bug — the API contract may have drifted.`
      );
    case 'unrecognized_url':
      return `PR URL format not recognized: ${error.url}. Expected GitHub PR or GitLab MR URL.`;
    case 'host_mismatch':
      return `Refusing to send GitLab token to unexpected host \`${error.got}\` (configured: \`${error.expected}\`).`;
  }
}

function shouldFailImmediately(error: PRStatusError): boolean {
  switch (error.kind) {
    case 'no_token':
      return true;
    case 'unrecognized_url':
      return true;
    case 'host_mismatch':
      return true;
    case 'http_error':
      return !error.transient;
    case 'owner_lookup_failed':
    case 'invalid_response':
      return false;
  }
}

function shouldCountAsTransient(error: PRStatusError): boolean {
  return error.kind === 'owner_lookup_failed' || (error.kind === 'http_error' && error.transient);
}

type PollCounterState = {
  pollTransientCount: number;
  pollNonTransientCount: number;
  shouldFail: boolean;
};

function nextPollCounterState(error: PRStatusError, current: PollCounterState): PollCounterState {
  if (shouldCountAsTransient(error)) {
    const pollTransientCount = current.pollTransientCount + 1;
    return {
      pollTransientCount,
      pollNonTransientCount: 0,
      shouldFail: pollTransientCount >= PR_POLL_NULL_THRESHOLD,
    };
  }

  const pollNonTransientCount = current.pollNonTransientCount + 1;
  return {
    pollTransientCount: 0,
    pollNonTransientCount,
    shouldFail: pollNonTransientCount >= PR_POLL_NON_TRANSIENT_THRESHOLD,
  };
}

/**
 * Apply a single action. Synchronous SQL mutations happen inline.
 * Async side effects (container dispatch, PR polling, etc.) are returned
 * as a deferred function to be executed after all SQL is committed.
 *
 * See reconciliation-spec.md §5.4.
 */
export function applyAction(ctx: ApplyActionContext, action: Action): (() => Promise<void>) | null {
  const { sql, departmentId } = ctx;

  switch (action.type) {
    // ── Ticket mutations ──────────────────────────────────────────

    case 'transition_Ticket': {
      try {
        const failureReason =
          action.to === 'failed'
            ? { code: 'reconciler', message: action.reason, source: 'scheduler' }
            : undefined;
        ticketOps.updateTicketStatus(sql, action.ticket_id, action.to, action.actor, failureReason);
      } catch (err) {
        console.warn(`${LOG} transition_Ticket failed: ticket=${action.ticket_id} to=${action.to}`, err);
      }
      return null;
    }

    case 'assign_Ticket': {
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.assignee_agent_ticket_id} = ?,
              ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [action.agent_id, now(), action.ticket_id]
      );
      return null;
    }

    case 'clear_ticket_assignee': {
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.assignee_agent_ticket_id} = NULL,
              ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [now(), action.ticket_id]
      );
      // Also unhook any agents still pointing at this ticket, to prevent
      // split-brain where the ticket looks unassigned but agents still hold hooks.
      const hookedAgents = z
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
            [action.ticket_id]
          ),
        ]);
      for (const row of hookedAgents) {
        agentOps.unhookTicket(sql, row.ticket_id);
      }
      return null;
    }

    case 'create_mr_Ticket': {
      reviewQueue.submitToReviewQueue(sql, {
        agent_id: action.agent_id,
        ticket_id: action.source_ticket_id,
        workstation_id: action.workstation_id,
        branch: action.branch,
        pr_url: action.pr_url,
        summary: action.summary,
      });
      return null;
    }

    case 'create_landing_mr': {
      const timestamp = now();
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.metadata} = json_set(
            COALESCE(${tickets.columns.metadata}, '{}'),
            '$.landing_mr_attempts',
            COALESCE(json_extract(${tickets.columns.metadata}, '$.landing_mr_attempts'), 0) + 1,
            '$.last_landing_mr_attempt_at', ?
          ),
          ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [timestamp, timestamp, action.shift_id]
      );
      reviewQueue.submitToReviewQueue(sql, {
        agent_id: 'system',
        ticket_id: action.shift_id,
        workstation_id: action.workstation_id,
        branch: action.feature_branch,
        default_branch: action.target_branch,
      });
      return null;
    }

    case 'close_sibling_mrs': {
      // Find sibling MR tickets, then close each via updateTicketStatus for
      // proper terminal guard + ticket event logging.
      const siblingRows = z
        .object({ ticket_id: z.string() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
            SELECT ${tickets.ticket_id}
            FROM ${tickets}
            WHERE ${tickets.type} = 'merge_request'
              AND ${tickets.ticket_id} != ?
              AND ${tickets.status} NOT IN ('closed', 'failed')
              AND ${tickets.ticket_id} IN (
                SELECT dep.${ticket_dependencies.columns.ticket_id}
                FROM ${ticket_dependencies} AS dep
                WHERE dep.${ticket_dependencies.columns.depends_on_ticket_id} = ?
                  AND dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
              )
          `,
            [action.exclude_mr_id, action.source_ticket_id]
          ),
        ]);
      for (const row of siblingRows) {
        ticketOps.updateTicketStatus(sql, row.ticket_id, 'closed', 'system');
      }
      return null;
    }

    case 'set_review_pr_url': {
      reviewQueue.setReviewPrUrl(sql, action.ticket_id, action.pr_url);
      return null;
    }

    // ── Agent mutations ─────────────────────────────────────────

    case 'transition_agent': {
      try {
        agentOps.updateAgentStatus(sql, action.agent_id, action.to);
      } catch (err) {
        console.warn(
          `${LOG} transition_agent failed: agent=${action.agent_id} to=${action.to}`,
          err
        );
      }
      return null;
    }

    case 'reset_agent_dispatch_attempts': {
      const agentRows = z
        .object({ current_hook_ticket_id: z.string().nullable() })
        .array()
        .parse([
          ...query(
            sql,
            /* sql */ `
              SELECT ${agent_metadata.columns.current_hook_ticket_id}
              FROM ${agent_metadata}
              WHERE ${agent_metadata.columns.ticket_id} = ?
            `,
            [action.agent_id]
          ),
        ]);
      const hookedTicketId = agentRows[0]?.current_hook_ticket_id;

      query(
        sql,
        /* sql */ `
          UPDATE ${agent_metadata}
          SET ${agent_metadata.columns.dispatch_attempts} = 0
          WHERE ${agent_metadata.ticket_id} = ?
        `,
        [action.agent_id]
      );

      if (hookedTicketId) {
        const ticketRows = [
          ...query(
            sql,
            /* sql */ `
              SELECT ${tickets.columns.status}, ${tickets.columns.type}
              FROM ${tickets}
              WHERE ${tickets.ticket_id} = ?
            `,
            [hookedTicketId]
          ),
        ];
        const status = ticketRows[0]?.status;
        const type = ticketRows[0]?.type;

        query(
          sql,
          /* sql */ `
            UPDATE ${tickets}
            SET ${tickets.columns.dispatch_attempts} = 0,
                ${tickets.columns.last_dispatch_attempt_at} = NULL
            WHERE ${tickets.ticket_id} = ?
          `,
          [hookedTicketId]
        );

        if (status === 'failed') {
          ticketOps.updateTicketStatus(sql, hookedTicketId, 'open', 'system');
        }

        if (type === 'merge_request') {
          query(
            sql,
            /* sql */ `
              UPDATE ${review_metadata}
              SET ${review_metadata.columns.retry_count} = 0
              WHERE ${review_metadata.ticket_id} = ?
            `,
            [hookedTicketId]
          );
        }
      }
      return null;
    }

    case 'hook_agent': {
      try {
        agentOps.hookTicket(sql, action.agent_id, action.ticket_id);
      } catch (err) {
        console.warn(
          `${LOG} hook_agent failed: agent=${action.agent_id} ticket=${action.ticket_id}`,
          err
        );
      }
      return null;
    }

    case 'unhook_agent': {
      agentOps.unhookTicket(sql, action.agent_id);
      return null;
    }

    case 'clear_agent_checkpoint': {
      agentOps.writeCheckpoint(sql, action.agent_id, null);
      return null;
    }

    case 'delete_agent': {
      try {
        agentOps.deleteAgent(sql, action.agent_id);
      } catch (err) {
        console.warn(`${LOG} delete_agent failed: agent=${action.agent_id}`, err);
      }
      return null;
    }

    // ── Shift mutations ────────────────────────────────────────

    case 'update_shift_progress': {
      query(
        sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.closed_tickets} = ?
          WHERE ${shift_metadata.columns.ticket_id} = ?
        `,
        [action.closed_tickets, action.shift_id]
      );
      return null;
    }

    case 'set_shift_ready_to_land': {
      const timestamp = now();
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.ready_to_land', 1),
              ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [timestamp, action.shift_id]
      );
      return null;
    }

    case 'close_shift': {
      ticketOps.updateTicketStatus(sql, action.shift_id, 'closed', 'system');
      query(
        sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.landed_at} = ?
          WHERE ${shift_metadata.columns.ticket_id} = ?
        `,
        [now(), action.shift_id]
      );
      return null;
    }

    case 'fail_shift': {
      ticketOps.updateTicketStatus(sql, action.shift_id, 'failed', 'system');
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.metadata} = json_set(
            COALESCE(${tickets.columns.metadata}, '{}'),
            '$.failureReason', 'landing_mr_exhausted',
            '$.failureMessage', ?
          ),
          ${tickets.columns.updated_at} = ?
          WHERE ${tickets.ticket_id} = ?
        `,
        [action.reason, now(), action.shift_id]
      );
      return null;
    }

    // ── Side effects (deferred) ─────────────────────────────────

    case 'dispatch_agent': {
      // Resolve agent if not yet assigned (agent_id is '' for Rule 1 dispatches)
      let agentId = action.agent_id;
      const ticketId = action.ticket_id;
      const workstationId = action.workstation_id;

      if (!agentId) {
        // Need to get-or-create an agent for this ticket.
        // Infer role from ticket type: MR tickets need refineries, issue tickets need souls.
        const targetTicket = ticketOps.getTicket(sql, ticketId);
        const role = targetTicket?.type === 'merge_request' ? 'qualityAssurance' : 'soul';
        try {
          const agent = agentOps.getOrCreateAgent(sql, role, workstationId, departmentId);
          agentOps.hookTicket(sql, agent.id, ticketId);
          agentId = agent.id;
        } catch (err) {
          console.warn(`${LOG} dispatch_agent: failed to hook agent for ticket=${ticketId}`, err);
          return null;
        }
      }

      // Set agent to working and ticket to in_progress synchronously.
      // dispatch_attempts are NOT incremented here — scheduling.dispatchAgent()
      // is the single source of truth for both agent_metadata and ticket counters.
      agentOps.updateAgentStatus(sql, agentId, 'working');
      ticketOps.updateTicketStatus(sql, ticketId, 'in_progress', agentId);

      const capturedAgentId = agentId;
      return async () => {
        // Best-effort dispatch. If it fails, the agent stays 'working'
        // and the ticket stays 'in_progress'. The reconciler detects the
        // mismatch on the next tick (idle agent hooked to in_progress
        // ticket) and retries dispatch.
        await ctx.dispatchAgent(capturedAgentId, ticketId, workstationId).catch(err => {
          console.warn(
            `${LOG} dispatch_agent: container start failed for agent=${capturedAgentId} ticket=${ticketId}`,
            err
          );
        });
      };
    }

    case 'stop_agent': {
      return async () => {
        try {
          await ctx.stopAgent(action.agent_id);
        } catch (err) {
          console.warn(`${LOG} stop_agent failed: agent=${action.agent_id}`, err);
        }
      };
    }

    case 'poll_pr': {
      // Touch updated_at and record last_poll_at synchronously so the ticket
      // doesn't look stale to Rule 4 (orphaned PR review, 30 min timeout).
      // Without this, active polling keeps the PR alive but updated_at was
      // set once at PR creation and never refreshed, causing a false
      // "orphaned" failure after 30 minutes.
      const timestamp = now();
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.updated_at} = ?,
              ${tickets.columns.metadata} = json_set(
                COALESCE(${tickets.columns.metadata}, '{}'),
                '$.last_poll_at', ?
              )
          WHERE ${tickets.ticket_id} = ?
        `,
        [timestamp, timestamp, action.ticket_id]
      );

      return async () => {
        try {
          const outcome = await ctx.checkPRStatus(action.pr_url);
          if (outcome.ok) {
            // Successful poll — reset both consecutive error counters
            query(
              sql,
              /* sql */ `
                UPDATE ${tickets}
                SET ${tickets.columns.metadata} = json_set(
                  COALESCE(${tickets.columns.metadata}, '{}'),
                  '$.poll_transient_count', 0,
                  '$.poll_non_transient_count', 0,
                  '$.poll_error_kind', NULL
                )
                WHERE ${tickets.ticket_id} = ?
              `,
              [action.ticket_id]
            );
            const { status, mergeable_state } = outcome.result;
            if (status !== 'open') {
              ctx.insertEvent('pr_status_changed', {
                ticket_id: action.ticket_id,
                payload: { pr_url: action.pr_url, pr_state: status },
              });
              return;
            }

            const departmentConfig = await ctx.getDepartmentConfig();
            const qualityAssuranceConfig = departmentConfig.qualityAssurance;
            if (!qualityAssuranceConfig) return;

            if (mergeable_state === 'unknown') {
              // GitHub is still computing mergeability — skip this poll and
              // check again on the next tick. Do NOT treat 'unknown' as clean
              // or dirty to avoid prematurely clearing has_conflicts or
              // emitting pr_conflict_detected before GitHub has a definitive answer.
              return;
            }

            if (mergeable_state === 'dirty') {
              // PR has merge conflicts — emit event ONCE per conflict episode.
              // The reconciler decides whether to create a conflict ticket or an escalation
              // based on the workstation's auto_resolve_merge_conflicts config.
              const conflictMetaRows = z
                .object({ has_conflicts: z.unknown() })
                .array()
                .parse([
                  ...query(
                    sql,
                    /* sql */ `
                      SELECT json_extract(${tickets.columns.metadata}, '$.has_conflicts') AS has_conflicts
                      FROM ${tickets}
                      WHERE ${tickets.ticket_id} = ?
                    `,
                    [action.ticket_id]
                  ),
                ]);
              const alreadyMarked =
                conflictMetaRows[0]?.has_conflicts === 1 ||
                conflictMetaRows[0]?.has_conflicts === true;

              if (!alreadyMarked) {
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${tickets}
                    SET ${tickets.columns.metadata} = json_set(
                      COALESCE(${tickets.columns.metadata}, '{}'),
                      '$.has_conflicts', 1,
                      '$.conflicts_detected_at', ?
                    ),
                    ${tickets.columns.updated_at} = ?
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [now(), now(), action.ticket_id]
                );

                const mrMetaRows = z
                  .object({ source_ticket_id: z.string().nullable(), branch: z.string().nullable() })
                  .array()
                  .parse([
                    ...query(
                      sql,
                      /* sql */ `
                        SELECT
                          json_extract(${tickets.columns.metadata}, '$.source_ticket_id') AS source_ticket_id,
                          ${review_metadata.columns.branch} AS branch
                        FROM ${tickets}
                        INNER JOIN ${review_metadata} ON ${review_metadata.ticket_id} = ${tickets.ticket_id}
                        WHERE ${tickets.ticket_id} = ?
                      `,
                      [action.ticket_id]
                    ),
                  ]);
                const sourceTicket = mrMetaRows[0]?.source_ticket_id ?? null;
                const conflictBranch = mrMetaRows[0]?.branch ?? '';

                ctx.insertEvent('pr_conflict_detected', {
                  ticket_id: action.ticket_id,
                  payload: {
                    mr_ticket_id: action.ticket_id,
                    source_ticket_id: sourceTicket,
                    pr_url: action.pr_url,
                    branch: conflictBranch,
                  },
                });
              }

              // A dirty PR must not proceed to the auto-merge timer — reset the
              // grace-period clock so the timer starts fresh once conflicts are resolved.
              query(
                sql,
                /* sql */ `
                  UPDATE ${review_metadata}
                  SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                  WHERE ${review_metadata.ticket_id} = ?
                    AND ${review_metadata.columns.auto_merge_ready_since} IS NOT NULL
                `,
                [action.ticket_id]
              );
              return;
            } else if (
              mergeable_state === 'clean' ||
              mergeable_state === 'blocked' ||
              mergeable_state === 'has_hooks'
            ) {
              // Conflict definitively resolved — clear the has_conflicts flag.
              // 'clean': no conflicts, all checks pass.
              // 'blocked': no conflicts but checks are failing (e.g. required reviews).
              // 'has_hooks': no conflicts but pre-receive hooks are pending.
              // 'unknown' is handled above (GitHub still computing — retry next poll).
              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_remove(
                    COALESCE(${tickets.columns.metadata}, '{}'),
                    '$.has_conflicts',
                    '$.conflicts_detected_at'
                  ),
                  ${tickets.columns.updated_at} = ?
                  WHERE ${tickets.ticket_id} = ?
                    AND json_extract(${tickets.columns.metadata}, '$.has_conflicts') IS NOT NULL
                `,
                [now(), action.ticket_id]
              );
            }

            const wantsAutoResolve = qualityAssuranceConfig.auto_resolve_pr_feedback === true;
            const wantsAutoMerge =
              qualityAssuranceConfig.auto_merge !== false &&
              qualityAssuranceConfig.auto_merge_delay_minutes !== null &&
              qualityAssuranceConfig.auto_merge_delay_minutes !== undefined;

            // Fetch feedback once and reuse for both auto-resolve and auto-merge.
            // Each checkPRFeedback call makes 3+ GitHub API requests (GraphQL +
            // check-runs + commit status), so deduplicating halves our API usage.
            const feedback =
              wantsAutoResolve || wantsAutoMerge ? await ctx.checkPRFeedback(action.pr_url) : null;

            if (feedback) {
              const prevAwaitingRows = z
                .object({ awaiting_approval: z.unknown() })
                .array()
                .parse([
                  ...query(
                    sql,
                    /* sql */ `
                      SELECT json_extract(${tickets.columns.metadata}, '$.awaiting_approval') AS awaiting_approval
                      FROM ${tickets}
                      WHERE ${tickets.ticket_id} = ?
                    `,
                    [action.ticket_id]
                  ),
                ]);
              const wasAwaiting =
                prevAwaitingRows[0]?.awaiting_approval === 1 ||
                prevAwaitingRows[0]?.awaiting_approval === true;
              const nowAwaiting = feedback.awaitingApproval;

              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_set(
                    COALESCE(${tickets.columns.metadata}, '{}'),
                    '$.awaiting_approval', ?,
                    '$.review_decision', ?,
                    '$.merge_state_status', ?
                  ),
                  ${tickets.columns.updated_at} = ?
                  WHERE ${tickets.ticket_id} = ?
                `,
                [
                  nowAwaiting ? 1 : 0,
                  feedback.reviewDecision ?? null,
                  feedback.mergeStateStatus ?? null,
                  now(),
                  action.ticket_id,
                ]
              );

              if (nowAwaiting && !wasAwaiting) {
                const createdRows = z
                  .object({ created_at: z.string() })
                  .array()
                  .parse([
                    ...query(
                      sql,
                      /* sql */ `
                        SELECT ${tickets.columns.created_at}
                        FROM ${tickets}
                        WHERE ${tickets.ticket_id} = ?
                      `,
                      [action.ticket_id]
                    ),
                  ]);
                const durationSinceCreatedMs = createdRows[0]
                  ? Date.now() - new Date(createdRows[0].created_at).getTime()
                  : 0;

                ctx.emitEvent({
                  event: 'pr.awaiting_approval_detected',
                  departmentId,
                  ticketId: action.ticket_id,
                  prUrl: action.pr_url,
                  label: feedback.reviewDecision ?? '',
                  reason: feedback.mergeStateStatus ?? '',
                  durationMs: durationSinceCreatedMs,
                });
              } else if (!nowAwaiting && wasAwaiting) {
                const observedRows = z
                  .object({ awaiting_approval_observed_at: z.string().nullable() })
                  .array()
                  .parse([
                    ...query(
                      sql,
                      /* sql */ `
                        SELECT json_extract(${tickets.columns.metadata}, '$.awaiting_approval_observed_at') AS awaiting_approval_observed_at
                        FROM ${tickets}
                        WHERE ${tickets.ticket_id} = ?
                      `,
                      [action.ticket_id]
                    ),
                  ]);
                const observedAt = observedRows[0]?.awaiting_approval_observed_at;
                const awaitingApprovalDurationMs = observedAt
                  ? Date.now() - new Date(observedAt).getTime()
                  : 0;

                ctx.emitEvent({
                  event: 'pr.awaiting_approval_resolved',
                  departmentId,
                  ticketId: action.ticket_id,
                  prUrl: action.pr_url,
                  label: feedback.reviewDecision ?? '',
                  reason: feedback.mergeStateStatus ?? '',
                  durationMs: awaitingApprovalDurationMs,
                });
              }

              if (nowAwaiting) {
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${tickets}
                    SET ${tickets.columns.metadata} = json_set(
                      COALESCE(${tickets.columns.metadata}, '{}'),
                      '$.awaiting_approval_observed_at', ?
                    )
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [now(), action.ticket_id]
                );
              } else {
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${tickets}
                    SET ${tickets.columns.metadata} = json_remove(
                      COALESCE(${tickets.columns.metadata}, '{}'),
                      '$.awaiting_approval_observed_at'
                    )
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [action.ticket_id]
                );
              }
            }

            if (
              wantsAutoResolve &&
              feedback &&
              (feedback.hasUnresolvedComments ||
                feedback.hasFailingChecks ||
                feedback.hasUncheckedRuns)
            ) {
              // Re-verify the PR is still open before creating a feedback ticket.
              // The checkPRFeedback call above takes ~2s (3+ GitHub API calls).
              // If the PR was merged externally during that window, inserting
              // pr_feedback_detected would create a feedback ticket for a merged
              // PR — leading to a duplicate PR on an already-merged branch.
              const freshOutcome = await ctx.checkPRStatus(action.pr_url);
              if (!freshOutcome.ok || freshOutcome.result.status !== 'open') {
                console.log(
                  `${LOG} poll_pr: PR status changed to '${freshOutcome.ok ? freshOutcome.result.status : 'error'}' during feedback check, skipping feedback for ticket=${action.ticket_id}`
                );
              } else {
                const existingFeedback = hasExistingFeedbackTicket(sql, action.ticket_id);
                if (!existingFeedback) {
                  const prMeta = parsePrUrl(action.pr_url);
                  const rmRows = z
                    .object({ branch: z.string() })
                    .array()
                    .parse([
                      ...query(
                        sql,
                        /* sql */ `
                          SELECT ${review_metadata.columns.branch}
                          FROM ${review_metadata}
                          WHERE ${review_metadata.ticket_id} = ?
                        `,
                        [action.ticket_id]
                      ),
                    ]);
                  const branch = rmRows[0]?.branch ?? '';

                  ctx.insertEvent('pr_feedback_detected', {
                    ticket_id: action.ticket_id,
                    payload: {
                      mr_ticket_id: action.ticket_id,
                      pr_url: action.pr_url,
                      pr_number: prMeta?.prNumber ?? 0,
                      repo: prMeta?.repo ?? '',
                      branch,
                      has_unresolved_comments: feedback.hasUnresolvedComments,
                      has_failing_checks: feedback.hasFailingChecks,
                      has_unchecked_runs: feedback.hasUncheckedRuns,
                    },
                  });
                }

                query(
                  sql,
                  /* sql */ `
                    UPDATE ${review_metadata}
                    SET ${review_metadata.columns.last_feedback_check_at} = ?
                    WHERE ${review_metadata.ticket_id} = ?
                  `,
                  [now(), action.ticket_id]
                );
              }
            }

            if (wantsAutoMerge) {
              if (!feedback) return;

              const allGreen =
                !feedback.hasUnresolvedComments &&
                !feedback.hasFailingChecks &&
                feedback.allChecksPass &&
                !feedback.awaitingApproval &&
                !feedback.changesRequested;

              console.log(
                `${LOG} poll_pr: ticket=${action.ticket_id} allGreen=${allGreen} unresolved=${feedback.hasUnresolvedComments} failing=${feedback.hasFailingChecks} allPass=${feedback.allChecksPass} unchecked=${feedback.hasUncheckedRuns} awaitingApproval=${feedback.awaitingApproval} changesRequested=${feedback.changesRequested}`
              );

              if (allGreen) {
                const readySinceRows = z
                  .object({ auto_merge_ready_since: z.string().nullable() })
                  .array()
                  .parse([
                    ...query(
                      sql,
                      /* sql */ `
                        SELECT ${review_metadata.columns.auto_merge_ready_since}
                        FROM ${review_metadata}
                        WHERE ${review_metadata.ticket_id} = ?
                      `,
                      [action.ticket_id]
                    ),
                  ]);

                const readySince = readySinceRows[0]?.auto_merge_ready_since;

                console.log(
                  `${LOG} poll_pr: ticket=${action.ticket_id} readySince=${readySince ?? 'null'} rows=${readySinceRows.length}`
                );

                if (!readySince) {
                  query(
                    sql,
                    /* sql */ `
                      UPDATE ${review_metadata}
                      SET ${review_metadata.columns.auto_merge_ready_since} = ?
                      WHERE ${review_metadata.ticket_id} = ?
                    `,
                    [now(), action.ticket_id]
                  );
                } else {
                  const elapsed = Date.now() - new Date(readySince).getTime();
                  const delayMs = (qualityAssuranceConfig.auto_merge_delay_minutes ?? 0) * 60_000;
                  console.log(
                    `${LOG} poll_pr: ticket=${action.ticket_id} elapsed=${elapsed}ms delay=${delayMs}ms shouldMerge=${elapsed >= delayMs}`
                  );
                  if (elapsed >= delayMs) {
                    console.log(
                      `${LOG} poll_pr: inserting pr_auto_merge event for ticket=${action.ticket_id}`
                    );
                    ctx.insertEvent('pr_auto_merge', {
                      ticket_id: action.ticket_id,
                      payload: {
                        mr_ticket_id: action.ticket_id,
                        pr_url: action.pr_url,
                      },
                    });
                  }
                }
              } else {
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${review_metadata}
                    SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                    WHERE ${review_metadata.ticket_id} = ?
                  `,
                  [action.ticket_id]
                );
              }
            }
          } else {
            const error = outcome.error;

            // Store the latest error kind for analytics
            query(
              sql,
              /* sql */ `
                UPDATE ${tickets}
                SET ${tickets.columns.metadata} = json_set(
                  COALESCE(${tickets.columns.metadata}, '{}'),
                  '$.poll_error_kind', ?
                )
                WHERE ${tickets.ticket_id} = ?
              `,
              [error.kind, action.ticket_id]
            );

            const failWorkstationRows = z
              .object({ workstation_id: z.string().nullable() })
              .array()
              .parse([
                ...query(
                  sql,
                  /* sql */ `
                    SELECT ${tickets.columns.workstation_id}
                    FROM ${tickets}
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [action.ticket_id]
                ),
              ]);
            const failWorkstationId = failWorkstationRows[0]?.workstation_id ?? '';

            if (shouldFailImmediately(error)) {
              console.warn(
                `${LOG} poll_pr: immediate-fail error kind=${error.kind} for ticket=${action.ticket_id}, failing`
              );
              ticketOps.updateTicketStatus(sql, action.ticket_id, 'failed', 'system');
              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_set(
                    COALESCE(${tickets.columns.metadata}, '{}'),
                    '$.failureReason', 'pr_poll_failed',
                    '$.failureKind', ?,
                    '$.failureMessage', ?
                  )
                  WHERE ${tickets.ticket_id} = ?
                `,
                [error.kind, failureMessageFor(error), action.ticket_id]
              );
              ctx.emitEvent({
                event: 'pr.poll_failed',
                departmentId,
                ticketId: action.ticket_id,
                workstationId: failWorkstationId,
                reason: error.kind,
                label: 'provider' in error ? error.provider : '',
                statusCode: error.kind === 'http_error' ? error.status : undefined,
              });
            } else if (shouldCountAsTransient(error)) {
              // Transient HTTP and owner lookup errors count toward the 10-strike threshold.
              // Migrate legacy poll_null_count into poll_transient_count on first read.
              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_set(
                    COALESCE(${tickets.columns.metadata}, '{}'),
                    '$.poll_transient_count',
                    COALESCE(
                      json_extract(${tickets.columns.metadata}, '$.poll_transient_count'),
                      json_extract(${tickets.columns.metadata}, '$.poll_null_count'),
                      0
                    ) + 1,
                    '$.poll_non_transient_count', 0
                  )
                  WHERE ${tickets.ticket_id} = ?
                `,
                [action.ticket_id]
              );
              const rows = [
                ...query(
                  sql,
                  /* sql */ `
                    SELECT json_extract(${tickets.columns.metadata}, '$.poll_transient_count') AS transient_count
                    FROM ${tickets}
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [action.ticket_id]
                ),
              ];
              const transientCount = Number(rows[0]?.transient_count ?? 0);
              if (transientCount >= PR_POLL_NULL_THRESHOLD) {
                console.warn(
                  `${LOG} poll_pr: ${transientCount} consecutive transient errors for ticket=${action.ticket_id}, failing`
                );
                ticketOps.updateTicketStatus(sql, action.ticket_id, 'failed', 'system');
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${tickets}
                    SET ${tickets.columns.metadata} = json_set(
                      COALESCE(${tickets.columns.metadata}, '{}'),
                      '$.failureReason', 'pr_poll_failed',
                      '$.failureKind', ?,
                      '$.failureMessage', ?
                    )
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [error.kind, failureMessageFor(error), action.ticket_id]
                );
                ctx.emitEvent({
                  event: 'pr.poll_failed',
                  departmentId,
                  ticketId: action.ticket_id,
                  workstationId: failWorkstationId,
                  reason: error.kind,
                  label: 'provider' in error ? error.provider : '',
                  statusCode: error.kind === 'http_error' ? error.status : undefined,
                });
              }
            } else {
              // Non-transient, non-immediate errors (invalid_response only)
              // count toward a lower 3-strike threshold.
              // No legacy poll_null_count migration needed: invalid_response
              // is a new error kind that couldn't have accumulated under the
              // old transient/null classification.
              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_set(
                    COALESCE(${tickets.columns.metadata}, '{}'),
                    '$.poll_non_transient_count',
                    COALESCE(
                      json_extract(${tickets.columns.metadata}, '$.poll_non_transient_count'),
                      0
                    ) + 1,
                    '$.poll_transient_count', 0
                  )
                  WHERE ${tickets.ticket_id} = ?
                `,
                [action.ticket_id]
              );
              const rows = [
                ...query(
                  sql,
                  /* sql */ `
                    SELECT json_extract(${tickets.columns.metadata}, '$.poll_non_transient_count') AS non_transient_count
                    FROM ${tickets}
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [action.ticket_id]
                ),
              ];
              const nonTransientCount = Number(rows[0]?.non_transient_count ?? 0);
              if (nonTransientCount >= PR_POLL_NON_TRANSIENT_THRESHOLD) {
                console.warn(
                  `${LOG} poll_pr: ${nonTransientCount} consecutive non-transient errors kind=${error.kind} for ticket=${action.ticket_id}, failing`
                );
                ticketOps.updateTicketStatus(sql, action.ticket_id, 'failed', 'system');
                query(
                  sql,
                  /* sql */ `
                    UPDATE ${tickets}
                    SET ${tickets.columns.metadata} = json_set(
                      COALESCE(${tickets.columns.metadata}, '{}'),
                      '$.failureReason', 'pr_poll_failed',
                      '$.failureKind', ?,
                      '$.failureMessage', ?
                    )
                    WHERE ${tickets.ticket_id} = ?
                  `,
                  [error.kind, failureMessageFor(error), action.ticket_id]
                );
                ctx.emitEvent({
                  event: 'pr.poll_failed',
                  departmentId,
                  ticketId: action.ticket_id,
                  workstationId: failWorkstationId,
                  reason: error.kind,
                  label: 'provider' in error ? error.provider : '',
                  statusCode: error.kind === 'http_error' ? error.status : undefined,
                });
              }
            }
          }
        } catch (err) {
          console.warn(`${LOG} poll_pr failed: ticket=${action.ticket_id} url=${action.pr_url}`, err);
        }
      };
    }

    case 'merge_pr': {
      // Validate the PR URL matches the workstation's repository before merging.
      // Prevents merging an unrelated repo if a buggy qualityAssurance stores a wrong URL.
      const mrTicket = ticketOps.getTicket(sql, action.ticket_id);
      if (mrTicket?.workstation_id) {
        const workstation = getWorkstation(sql, mrTicket.workstation_id);
        if (workstation?.git_url) {
          const workstationCoords = parseGitUrl(workstation.git_url);
          const prMeta = parsePrUrl(action.pr_url);
          if (workstationCoords && prMeta) {
            const workstationRepo = `${workstationCoords.owner}/${workstationCoords.repo}`;
            if (workstationRepo !== prMeta.repo) {
              console.warn(
                `${LOG} merge_pr: PR repo "${prMeta.repo}" does not match workstation repo "${workstationRepo}" — refusing to merge`
              );
              // Clear the pending flag to avoid retry loops
              query(
                sql,
                /* sql */ `
                  UPDATE ${tickets}
                  SET ${tickets.columns.metadata} = json_remove(COALESCE(${tickets.metadata}, '{}'), '$.auto_merge_pending'),
                      ${tickets.columns.updated_at} = ?
                  WHERE ${tickets.ticket_id} = ?
                `,
                [now(), action.ticket_id]
              );
              return null;
            }
          }
        }
      }

      return async () => {
        try {
          // Re-check feedback immediately before merging to avoid acting on
          // stale state. If a reviewer posted new comments or CI regressed
          // since the last poll, abort and reset the timer.
          const freshFeedback = await ctx.checkPRFeedback(action.pr_url);
          if (
            freshFeedback &&
            (freshFeedback.hasUnresolvedComments ||
              freshFeedback.hasFailingChecks ||
              !freshFeedback.allChecksPass ||
              freshFeedback.awaitingApproval ||
              freshFeedback.changesRequested)
          ) {
            console.log(
              `${LOG} merge_pr: fresh feedback check found issues, aborting merge for ticket=${action.ticket_id}`
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${tickets}
                SET ${tickets.columns.metadata} = json_remove(COALESCE(${tickets.metadata}, '{}'), '$.auto_merge_pending'),
                    ${tickets.columns.updated_at} = ?
                WHERE ${tickets.ticket_id} = ?
              `,
              [now(), action.ticket_id]
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${review_metadata}
                SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                WHERE ${review_metadata.ticket_id} = ?
              `,
              [action.ticket_id]
            );
            return;
          }

          const merged = await ctx.mergePR(action.pr_url);
          if (merged) {
            ctx.insertEvent('pr_status_changed', {
              ticket_id: action.ticket_id,
              payload: { pr_url: action.pr_url, pr_state: 'merged' },
            });
          } else {
            // Merge failed (405/409: branch protection, merge conflict, stale head, etc.)
            // Clear auto_merge_pending so we resume normal polling on the next tick.
            // Also reset the auto_merge_ready_since timer so it re-evaluates freshness.
            query(
              sql,
              /* sql */ `
                UPDATE ${tickets}
                SET ${tickets.columns.metadata} = json_remove(COALESCE(${tickets.metadata}, '{}'), '$.auto_merge_pending'),
                    ${tickets.columns.updated_at} = ?
                WHERE ${tickets.ticket_id} = ?
              `,
              [now(), action.ticket_id]
            );
            query(
              sql,
              /* sql */ `
                UPDATE ${review_metadata}
                SET ${review_metadata.columns.auto_merge_ready_since} = NULL
                WHERE ${review_metadata.ticket_id} = ?
              `,
              [action.ticket_id]
            );
            console.warn(
              `${LOG} merge_pr: merge failed, cleared auto_merge_pending for ticket=${action.ticket_id}`
            );
          }
        } catch (err) {
          console.warn(`${LOG} merge_pr failed: ticket=${action.ticket_id} url=${action.pr_url}`, err);
          // Clear pending flag on unexpected errors too
          query(
            sql,
            /* sql */ `
              UPDATE ${tickets}
              SET ${tickets.columns.metadata} = json_remove(COALESCE(${tickets.metadata}, '{}'), '$.auto_merge_pending'),
                  ${tickets.columns.updated_at} = ?
              WHERE ${tickets.ticket_id} = ?
            `,
            [now(), action.ticket_id]
          );
          query(
            sql,
            /* sql */ `
              UPDATE ${review_metadata}
              SET ${review_metadata.columns.auto_merge_ready_since} = NULL
              WHERE ${review_metadata.ticket_id} = ?
            `,
            [action.ticket_id]
          );
        }
      };
    }

    case 'send_nudge': {
      // Insert nudge record synchronously.
      // Explicitly set created_at to ISO 8601 so it matches the format used
      // by hasRecentNudge's cutoff comparison (#1412). SQLite's default
      // datetime('now') produces 'YYYY-MM-DD HH:MM:SS' (space separator)
      // which compares incorrectly against JS toISOString().
      const nudgeId = crypto.randomUUID();
      query(
        sql,
        /* sql */ `
          INSERT INTO ${agent_nudges} (
            ${agent_nudges.columns.nudge_id},
            ${agent_nudges.columns.agent_ticket_id},
            ${agent_nudges.columns.message},
            ${agent_nudges.columns.mode},
            ${agent_nudges.columns.priority},
            ${agent_nudges.columns.source},
            ${agent_nudges.columns.created_at},
            ${agent_nudges.columns.expires_at}
          ) VALUES (?, ?, ?, 'immediate', 'urgent', ?, ?, ?)
        `,
        [
          nudgeId,
          action.agent_id,
          action.message,
          `reconciler:${action.tier}`,
          new Date().toISOString(),
          null,
        ]
      );

      return async () => {
        try {
          await ctx.queueNudge(action.agent_id, action.message, action.tier);
        } catch (err) {
          console.warn(`${LOG} send_nudge failed: agent=${action.agent_id}`, err);
        }
      };
    }

    case 'create_triage_request': {
      try {
        attendance.createTriageRequest(sql, {
          triageType: action.triage_type as attendance.TriageType,
          agentTicketId: action.agent_id,
          title: `Triage: ${action.reason}`,
          context: { reason: action.reason },
          options: ['RESTART', 'CLOSE', 'ESCALATE'],
        });
      } catch (err) {
        console.warn(`${LOG} create_triage_request failed: agent=${action.agent_id}`, err);
      }
      return null;
    }

    case 'notifyFrontDesk': {
      console.log(`${LOG} notifyFrontDesk: department=${departmentId} msg=${action.message}`);
      return null;
    }

    case 'emit_event': {
      ctx.emitEvent({ event: action.event_name, departmentId, ...action.data });
      return null;
    }

    case 'report_helldesk_done': {
      const { helldesk_id, item_id, evidence, canonical_ticket_id } = action;
      return async () => {
        const ok = await ctx.reportHelldeskDone({
          helldeskId: helldesk_id,
          itemId: item_id,
          evidence,
          canonicalTicketId: canonical_ticket_id,
        });
        if (!ok) {
          console.warn(
            `${LOG} report_helldesk_done: deferred call returned false for item=${item_id}; will retry next tick`
          );
        }
      };
    }

    default: {
      const _exhaustive: never = action;
      console.warn(`${LOG} applyAction: unknown action type`, _exhaustive);
      return null;
    }
  }
}

/** Check if an MR ticket already has a non-terminal feedback ticket blocking it. */
function hasExistingFeedbackTicket(sql: SqlStorage, mrTicketId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${ticket_dependencies} bd
        INNER JOIN ${tickets} fb ON fb.${tickets.columns.ticket_id} = bd.${ticket_dependencies.columns.depends_on_ticket_id}
        WHERE bd.${ticket_dependencies.columns.ticket_id} = ?
          AND bd.${ticket_dependencies.columns.dependency_type} = 'blocks'
          AND fb.${tickets.columns.labels} LIKE '%gt:pr-feedback%'
          AND fb.${tickets.columns.status} NOT IN ('closed', 'failed')
        LIMIT 1
      `,
      [mrTicketId]
    ),
  ];
  return rows.length > 0;
}

/** Parse a GitHub/GitLab PR URL to extract repo and PR number. */
function parsePrUrl(prUrl: string): { repo: string; prNumber: number } | null {
  // GitHub: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (ghMatch) {
    return { repo: ghMatch[1], prNumber: parseInt(ghMatch[2], 10) };
  }
  // GitLab: https://{host}/{path}/-/merge_requests/{iid}
  const glMatch = prUrl.match(/^https:\/\/[^/]+\/(.+)\/-\/merge_requests\/(\d+)/);
  if (glMatch) {
    return { repo: glMatch[1], prNumber: parseInt(glMatch[2], 10) };
  }
  return null;
}

// Exported for testing
export { hasExistingFeedbackTicket as _hasExistingFeedbackTicket, parsePrUrl as _parsePrUrl };
export {
  failureMessageFor as _failureMessageFor,
  nextPollCounterState as _nextPollCounterState,
  shouldFailImmediately as _shouldFailImmediately,
  shouldCountAsTransient as _shouldCountAsTransient,
};
