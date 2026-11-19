/**
 * Review queue and TicketCase management for the Department DO.
 *
 * After the tickets-centric refactor (#441):
 * - Review queue entries are tickets with type='merge_request' + review_metadata satellite
 * - TicketCases are parent tickets with type='TicketCase' + child step tickets
 */

import { z } from 'zod';
import { tickets, TicketRecord, MergeRequestTicketRecord } from '../../db/tables/tickets.table';
import { review_metadata } from '../../db/tables/review-metadata.table';
import { ticket_dependencies } from '../../db/tables/ticket-dependencies.table';
import { agent_metadata } from '../../db/tables/agent-metadata.table';
import { shift_metadata } from '../../db/tables/shift-metadata.table';
import { ticket_events } from '../../db/tables/ticket-events.table';
import { query } from '../../util/query.util';
import { generateId, now } from '../../util/id.util';
import {
  logTicketEvent,
  getTicket,
  closeTicket,
  updateTicketStatus,
  updateShiftProgress,
  createTicket,
  getShiftForTicket,
  getShiftFeatureBranch,
  getShiftMergeMode,
} from './tickets';
import { getAgent, unhookTicket, updateAgentStatus } from './agents';
import { getWorkstation } from './workstations';
import type { ReviewQueueInput, ReviewQueueEntry, AgentDoneInput, TicketCase } from '../../types';

/**
 * Extract the human-readable failure message from a ticket event's metadata.
 *
 * Two sources:
 *  - status_changed events store it at `metadata.failure_reason.message`
 *  - review_completed / pr_creation_failed events store it at `metadata.message`
 */
function extractFailureMessage(
  status: string,
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (status !== 'failed' || !metadata) return null;
  const fr = metadata.failure_reason;
  if (typeof fr === 'object' && fr !== null && 'message' in fr) {
    const msg = (fr as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof metadata.message === 'string') return metadata.message;
  return null;
}

export function initReviewQueueTables(_sql: SqlStorage): void {
  // Review queue and TicketCase tables are now part of tickets + satellite tables.
  // Initialization happens in tickets.initTicketTables().
}

const REVIEW_JOIN = /* sql */ `
  SELECT ${tickets}.*,
         ${review_metadata.branch}, ${review_metadata.target_branch},
         ${review_metadata.merge_commit}, ${review_metadata.pr_url},
         ${review_metadata.retry_count},
         ${review_metadata.auto_merge_ready_since},
         ${review_metadata.last_feedback_check_at}
  FROM ${tickets}
  INNER JOIN ${review_metadata} ON ${tickets.ticket_id} = ${review_metadata.ticket_id}
`;

/** Map a parsed MergeRequestTicketRecord to the ReviewQueueEntry API type. */
function toReviewQueueEntry(row: MergeRequestTicketRecord): ReviewQueueEntry {
  return {
    id: row.ticket_id,
    // The soul that submitted the review — stored in metadata (not assignee,
    // which is set to the qualityAssurance when it claims the MR ticket via hookTicket).
    agent_id:
      typeof row.metadata?.source_agent_id === 'string'
        ? row.metadata.source_agent_id
        : (row.created_by ?? ''),
    ticket_id:
      typeof row.metadata?.source_ticket_id === 'string' ? row.metadata.source_ticket_id : row.ticket_id,
    workstation_id: row.workstation_id ?? '',
    branch: row.branch,
    pr_url: row.pr_url,
    status:
      row.status === 'open'
        ? 'pending'
        : row.status === 'in_progress'
          ? 'running'
          : row.status === 'closed'
            ? 'merged'
            : 'failed',
    summary: row.body,
    created_at: row.created_at,
    processed_at: row.updated_at === row.created_at ? null : row.updated_at,
  };
}

export function submitToReviewQueue(sql: SqlStorage, input: ReviewQueueInput): void {
  const id = generateId();
  const timestamp = now();

  // Build metadata — include pr_url if the agent already created a PR so
  // the link is visible via the standard ticket list endpoint.
  const metadata: Record<string, unknown> = {
    source_ticket_id: input.ticket_id,
    source_agent_id: input.agent_id,
  };
  if (input.pr_url) {
    metadata.pr_url = input.pr_url;
  }

  // Resolve the target branch for this MR:
  // - For review-then-land shift tickets → shift's feature branch
  // - For review-and-merge shift tickets → workstation's default branch (land independently)
  // - For standalone tickets → workstation's default branch
  // We pass defaultBranch from the caller so we don't hardcode 'main'.
  const shiftId = getShiftForTicket(sql, input.ticket_id);
  const shiftFeatureBranch = shiftId ? getShiftFeatureBranch(sql, shiftId) : null;
  const shiftMergeMode = shiftId ? getShiftMergeMode(sql, shiftId) : null;
  const targetBranch =
    shiftMergeMode === 'review-then-land' && shiftFeatureBranch
      ? shiftFeatureBranch
      : (input.default_branch ?? 'main');

  if (shiftId) {
    metadata.shift_id = shiftId;
    if (shiftFeatureBranch) {
      metadata.shift_feature_branch = shiftFeatureBranch;
    }
  }

  // Create the merge_request ticket
  query(
    sql,
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
      id,
      'merge_request',
      'open',
      `Review: ${input.branch}`,
      input.summary ?? null,
      input.workstation_id,
      null,
      null, // assignee left null — qualityAssurance claims it via hookTicket
      'medium',
      JSON.stringify(['gt:merge-request']),
      JSON.stringify(metadata),
      input.agent_id, // created_by records who submitted
      timestamp,
      timestamp,
      null,
    ]
  );

  query(
    sql,
    /* sql */ `
      INSERT INTO ${ticket_dependencies} (
        ${ticket_dependencies.columns.ticket_id},
        ${ticket_dependencies.columns.depends_on_ticket_id},
        ${ticket_dependencies.columns.dependency_type}
      ) VALUES (?, ?, 'tracks')
    `,
    [id, input.ticket_id]
  );

  query(
    sql,
    /* sql */ `
      INSERT INTO ${review_metadata} (
        ${review_metadata.columns.ticket_id}, ${review_metadata.columns.branch},
        ${review_metadata.columns.target_branch}, ${review_metadata.columns.merge_commit},
        ${review_metadata.columns.pr_url}, ${review_metadata.columns.retry_count}
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [id, input.branch, targetBranch, null, input.pr_url ?? null, 0]
  );

  logTicketEvent(sql, {
    ticketId: input.ticket_id,
    agentId: input.agent_id,
    eventType: 'review_submitted',
    newValue: input.branch,
    metadata: { branch: input.branch, target_branch: targetBranch },
  });
}

export function completeReview(
  sql: SqlStorage,
  entryId: string,
  status: 'merged' | 'failed'
): void {
  const ticketStatus = status === 'merged' ? 'closed' : 'failed';
  // Delegate to updateTicketStatus so a status_changed event is recorded
  // on the event timeline. It also handles terminal-state guards,
  // closed_at timestamps, and shift progress updates.
  updateTicketStatus(sql, entryId, ticketStatus, 'system');
}

/**
 * Complete a review with full result handling (close ticket on merge, escalate on conflict).
 */
export function completeReviewWithResult(
  sql: SqlStorage,
  input: {
    entry_id: string;
    status: 'merged' | 'failed' | 'conflict';
    message?: string;
    commit_sha?: string;
  }
): void {
  const resolvedStatus = input.status === 'conflict' ? 'failed' : input.status;
  completeReview(sql, input.entry_id, resolvedStatus);

  const entryRows = [
    ...query(sql, /* sql */ `${REVIEW_JOIN} WHERE ${tickets.ticket_id} = ?`, [input.entry_id]),
  ];
  if (entryRows.length === 0) return;
  const parsed = MergeRequestTicketRecord.parse(entryRows[0]);
  const entry = toReviewQueueEntry(parsed);

  logTicketEvent(sql, {
    ticketId: entry.ticket_id,
    agentId: entry.agent_id,
    eventType: 'review_completed',
    newValue: input.status,
    metadata: {
      message: input.message,
      commit_sha: input.commit_sha,
    },
  });

  if (input.status === 'merged') {
    const mergeTimestamp = now();
    console.log(
      `[review-queue] completeReviewWithResult MERGED: entry_id=${input.entry_id} ` +
        `entry.ticket_id (source)=${entry.ticket_id} entry.id (MR)=${entry.id} — ` +
        `calling closeTicket on source`
    );
    closeTicket(sql, entry.ticket_id, entry.agent_id);

    // Close ALL other open/in_progress/failed MR tickets for the same
    // source ticket. During rework cycles, multiple MR tickets accumulate.
    // Without this cleanup, stale MR tickets trigger failReviewWithRework
    // on the next alarm tick, reopening the source ticket that was just
    // closed by this merge.
    query(
      sql,
      /* sql */ `
        UPDATE ${tickets}
        SET ${tickets.columns.status} = 'closed',
            ${tickets.columns.updated_at} = ?,
            ${tickets.columns.closed_at} = ?
        WHERE ${tickets.type} = 'merge_request'
          AND ${tickets.ticket_id} != ?
          AND ${tickets.status} NOT IN ('closed')
          AND ${tickets.ticket_id} IN (
            SELECT dep.${ticket_dependencies.columns.ticket_id}
            FROM ${ticket_dependencies} AS dep
            WHERE dep.${ticket_dependencies.columns.depends_on_ticket_id} = ?
              AND dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
          )
      `,
      [mergeTimestamp, mergeTimestamp, input.entry_id, entry.ticket_id]
    );

    // closeTicket → updateTicketStatus short-circuits when completeReview already
    // set the status to 'closed' via direct SQL, so updateShiftProgress is
    // never reached transitively. Call it explicitly to ensure the shift
    // recounts after the MR ticket is closed.
    updateShiftProgress(sql, entry.ticket_id, mergeTimestamp);

    const sourceTicket = getTicket(sql, entry.ticket_id);
    if (sourceTicket?.type === 'shift') {
      query(
        sql,
        /* sql */ `
          UPDATE ${shift_metadata}
          SET ${shift_metadata.columns.landed_at} = ?
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [now(), entry.ticket_id]
      );
    }
  } else if (input.status === 'conflict') {
    createTicket(sql, {
      type: 'escalation',
      title: `Merge conflict: ${input.message ?? entry.branch}`,
      body: input.message,
      priority: 'high',
      metadata: {
        source_ticket_id: entry.ticket_id,
        source_agent_id: entry.agent_id,
        branch: entry.branch,
        conflict: true,
      },
    });
    // Return source ticket to open so the reconciler's scheduling path handles
    // rework. Clear assignee so the reconciler can match it for dispatch.
    const conflictSourceTicket = getTicket(sql, entry.ticket_id);
    if (
      conflictSourceTicket &&
      conflictSourceTicket.status !== 'closed' &&
      conflictSourceTicket.status !== 'failed'
    ) {
      updateTicketStatus(sql, entry.ticket_id, 'open', entry.agent_id);
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.assignee_agent_ticket_id} = NULL
          WHERE ${tickets.ticket_id} = ?
        `,
        [entry.ticket_id]
      );
    }
  } else if (input.status === 'failed') {
    // Review failed (rework requested): return source ticket to open so
    // the reconciler's scheduling path handles rework. Clear the stale
    // assignee so the reconciler can match it for dispatch (requires
    // assignee IS NULL). This avoids a fire-and-forget rework dispatch
    // race where the dispatch fails and the ticket churns.
    const sourceTicket = getTicket(sql, entry.ticket_id);
    if (sourceTicket && sourceTicket.status !== 'closed' && sourceTicket.status !== 'failed') {
      updateTicketStatus(sql, entry.ticket_id, 'open', entry.agent_id);
      query(
        sql,
        /* sql */ `
          UPDATE ${tickets}
          SET ${tickets.columns.assignee_agent_ticket_id} = NULL
          WHERE ${tickets.ticket_id} = ?
        `,
        [entry.ticket_id]
      );
    }
  }
}

/**
 * Set the platform PR/MR URL on an MR ticket's review_metadata and ticket metadata.
 * Called after a PR is created in the 'pr' merge strategy path.
 * Writes to both review_metadata.pr_url (for query) and tickets.metadata.pr_url
 * (so the URL is available via the standard ticket list endpoint).
 */
/** Get review_metadata for an MR ticket. */
export function getReviewMetadata(
  sql: SqlStorage,
  mrTicketId: string
): { branch: string; target_branch: string; pr_url: string | null } | null {
  const rows = z
    .object({
      branch: z.string(),
      target_branch: z.string(),
      pr_url: z.string().nullable(),
    })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
        SELECT ${review_metadata.columns.branch} as branch,
               ${review_metadata.columns.target_branch} as target_branch,
               ${review_metadata.columns.pr_url} as pr_url
        FROM ${review_metadata}
        WHERE ${review_metadata.ticket_id} = ?
      `,
        [mrTicketId]
      ),
    ]);
  return rows[0] ?? null;
}

export function setReviewPrUrl(sql: SqlStorage, entryId: string, prUrl: string): boolean {
  // Reject non-HTTPS URLs to prevent storing garbage from LLM output.
  // Invalid URLs would cause pollPendingPRs to poll indefinitely.
  if (!prUrl.startsWith('https://')) {
    console.warn(`[review-queue] setReviewPrUrl: rejecting non-HTTPS pr_url: ${prUrl}`);
    return false;
  }
  query(
    sql,
    /* sql */ `
      UPDATE ${review_metadata}
      SET ${review_metadata.columns.pr_url} = ?
      WHERE ${review_metadata.ticket_id} = ?
    `,
    [prUrl, entryId]
  );

  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.pr_url', ?)
      WHERE ${tickets.ticket_id} = ?
    `,
    [prUrl, entryId]
  );
  return true;
}

/**
 * Set an MR ticket status to 'in_review' (maps to ticket status 'in_progress').
 * Used when the PR strategy creates a PR and waits for human review.
 */
export function markReviewInReview(sql: SqlStorage, entryId: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.status} = 'in_progress',
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.ticket_id} = ?
    `,
    [new Date().toISOString(), entryId]
  );
}

export function agentDone(sql: SqlStorage, agentId: string, input: AgentDoneInput): void {
  const agent = getAgent(sql, agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  if (!agent.current_hook_ticket_id) {
    // The agent was unhooked by a recovery path between when the agent
    // finished work and when it called gt_done.
    //
    // For refineries, this is critical: the qualityAssurance may have actually
    // completed work (merged a PR, posted a review) but its hook was
    // cleared by zombie detection. We need to make progress without
    // landing PRs the qualityAssurance did NOT actually approve.
    if (agent.role === 'qualityAssurance') {
      const recentMrRows = [
        ...query(
          sql,
          /* sql */ `
            SELECT ${tickets.ticket_id}
            FROM ${tickets}
            WHERE ${tickets.type} = 'merge_request'
              AND ${tickets.assignee_agent_ticket_id} = ?
              AND ${tickets.status} NOT IN ('closed', 'failed')
            ORDER BY ${tickets.updated_at} DESC
            LIMIT 1
          `,
          [agentId]
        ),
      ];
      if (recentMrRows.length > 0) {
        const mrTicketId = z.object({ ticket_id: z.string() }).parse(recentMrRows[0]).ticket_id;
        console.log(
          `[review-queue] agentDone: unhooked qualityAssurance ${agentId} — recovering MR ticket ${mrTicketId}`
        );
        if (input.pr_url) {
          // QualityAssurance created/landed a PR. Trust the URL: storing it
          // moves the MR to in_review where poll_pr decides the merge.
          const stored = setReviewPrUrl(sql, mrTicketId, input.pr_url);
          if (stored) {
            markReviewInReview(sql, mrTicketId);
          } else {
            completeReviewWithResult(sql, {
              entry_id: mrTicketId,
              status: 'failed',
              message: `QualityAssurance provided invalid pr_url: ${input.pr_url}`,
            });
          }
        } else {
          // No pr_url and no hook: we can NOT prove the qualityAssurance
          // actually merged. Previously we optimistically marked the
          // MR as 'merged' — but the same race that cleared the hook
          // (idle+hooked+live-ticket reconciler rule firing on a phantom
          // dispatch_failed) ALSO fires when the qualityAssurance is mid-review
          // and decided to call gt_request_changes. In that case the
          // qualityAssurance wanted rework, gt_request_changes failed with
          // "not hooked", and the qualityAssurance's fallback gt_done() call
          // would silently land the PR it was trying to reject.
          //
          // Fail the review instead: this returns the source ticket to
          // 'open' and surfaces the problem so the next dispatch can
          // re-review properly. Also raise an escalation so a human
          // sees what happened.
          console.warn(
            `[review-queue] agentDone: unhooked qualityAssurance ${agentId} called gt_done without pr_url ` +
              `for MR ${mrTicketId} — failing review (cannot confirm merge)`
          );
          completeReviewWithResult(sql, {
            entry_id: mrTicketId,
            status: 'failed',
            message:
              input.summary ??
              'QualityAssurance called gt_done without a pr_url after losing its hook — cannot confirm merge',
          });
          createTicket(sql, {
            type: 'escalation',
            title: 'QualityAssurance gt_done without pr_url after hook loss',
            body:
              `QualityAssurance ${agentId} called gt_done with no pr_url while unhooked from MR ${mrTicketId}. ` +
              `The hook was likely cleared by the reconciler after a phantom dispatch failure ` +
              `while the SDK session was still alive. The MR has been failed (not merged) so a human ` +
              `can verify whether the qualityAssurance's intended outcome was 'approve and merge' or ` +
              `'request changes'. Summary from qualityAssurance: ${input.summary ?? '(none)'}`,
            priority: 'high',
            metadata: {
              source_ticket_id: mrTicketId,
              source_agent_id: agentId,
              kind: 'quality_assurance_unhooked_done',
            },
          });
        }
        return;
      }
    }

    console.warn(
      `[review-queue] agentDone: agent ${agentId} (role=${agent.role}) has no hooked ticket — ignoring`
    );
    return;
  }

  // Triage batch tickets don't produce code — close and unhook without
  // submitting to the review queue. Only applies to system-created triage
  // tickets (created_by = 'attendance'). User-created tickets that happen to carry
  // the gt:triage label go through normal review flow.
  const hookedTicket = getTicket(sql, agent.current_hook_ticket_id);
  if (hookedTicket?.labels.includes('gt:triage') && hookedTicket.created_by === 'attendance') {
    closeTicket(sql, agent.current_hook_ticket_id, agentId);
    unhookTicket(sql, agentId);
    return;
  }

  // Rework tickets skip the review queue entirely. The soul pushed commits
  // to an existing branch (the one the qualityAssurance already reviewed). Closing
  // the rework ticket unblocks the MR ticket, and the reconciler re-dispatches
  // the qualityAssurance to re-review.
  if (hookedTicket?.labels.includes('gt:rework')) {
    console.log(
      `[review-queue] agentDone: rework ticket ${agent.current_hook_ticket_id} — closing directly (skip review)`
    );
    closeTicket(sql, agent.current_hook_ticket_id, agentId);
    unhookTicket(sql, agentId);
    return;
  }

  // PR-fixup tickets skip the review queue. The soul pushed fixup commits
  // to an existing PR branch — no separate review is needed.
  // PR-conflict tickets also skip the review queue: the soul rebased and
  // force-pushed the branch to resolve conflicts — closing the ticket unblocks
  // the parent MR ticket so poll_pr can re-check mergeable_state.
  if (hookedTicket?.labels.includes('gt:pr-fixup') || hookedTicket?.labels.includes('gt:pr-conflict')) {
    console.log(
      `[review-queue] agentDone: ${hookedTicket.labels.includes('gt:pr-conflict') ? 'pr-conflict' : 'pr-fixup'} ticket ${agent.current_hook_ticket_id} — closing directly (skip review)`
    );
    closeTicket(sql, agent.current_hook_ticket_id, agentId);
    unhookTicket(sql, agentId);
    return;
  }

  // PR-feedback tickets (address review comments, fix CI) skip the review
  // queue. The soul pushed commits to the existing PR branch — closing
  // the feedback ticket unblocks the parent MR ticket so poll_pr can re-check
  // CI status or the reconciler can re-dispatch the qualityAssurance for re-review.
  if (hookedTicket?.labels.includes('gt:pr-feedback')) {
    console.log(
      `[review-queue] agentDone: pr-feedback ticket ${agent.current_hook_ticket_id} — closing directly (skip review)`
    );
    closeTicket(sql, agent.current_hook_ticket_id, agentId);
    unhookTicket(sql, agentId);
    return;
  }

  if (agent.role === 'qualityAssurance') {
    // The qualityAssurance handles merging (direct strategy) or PR creation (pr strategy)
    // itself. When it calls gt_done:
    //  - With pr_url: qualityAssurance created a PR → store URL, mark as in_review, poll it
    //  - Without pr_url: qualityAssurance merged directly → mark as merged
    const mrTicketId = agent.current_hook_ticket_id;

    if (input.pr_url) {
      // PR strategy: qualityAssurance created a PR via gh/glab CLI.
      // Validate the URL — LLM output may contain garbage URLs.
      const stored = setReviewPrUrl(sql, mrTicketId, input.pr_url);
      if (stored) {
        markReviewInReview(sql, mrTicketId);
        logTicketEvent(sql, {
          ticketId: mrTicketId,
          agentId,
          eventType: 'pr_created',
          newValue: input.pr_url,
          metadata: { pr_url: input.pr_url, created_by: 'qualityAssurance' },
        });
      } else {
        // Invalid URL — fail the review so it doesn't poll forever
        completeReviewWithResult(sql, {
          entry_id: mrTicketId,
          status: 'failed',
          message: `QualityAssurance provided invalid pr_url: ${input.pr_url}`,
        });
        logTicketEvent(sql, {
          ticketId: mrTicketId,
          agentId,
          eventType: 'pr_creation_failed',
          metadata: { pr_url: input.pr_url, reason: 'invalid_url' },
        });
      }
    } else {
      // Direct strategy: qualityAssurance already merged and pushed
      completeReviewWithResult(sql, {
        entry_id: mrTicketId,
        status: 'merged',
        message: input.summary ?? 'Merged by qualityAssurance agent',
      });
    }

    unhookTicket(sql, agentId);
    // Set qualityAssurance to idle immediately — the review is done and the
    // qualityAssurance is available for new work. Without this, the reconciler
    // sees the qualityAssurance as 'working' and won't dispatch the next MR ticket
    // until agentCompleted fires (when the container process eventually exits).
    updateAgentStatus(sql, agentId, 'idle');
    return;
  }

  const sourceTicket = agent.current_hook_ticket_id;

  if (!agent.workstation_id) {
    console.warn(
      `[review-queue] agentDone: agent ${agentId} has null workstation_id — review entry may fail in submitToReviewQueue`
    );
  }

  // Resolve the workstation's default branch so submitToReviewQueue can use it
  // instead of hardcoding 'main' for standalone/review-and-merge tickets.
  const workstationId = agent.workstation_id ?? '';
  const workstation = workstationId ? getWorkstation(sql, workstationId) : null;

  submitToReviewQueue(sql, {
    agent_id: agentId,
    ticket_id: sourceTicket,
    workstation_id: workstationId,
    branch: input.branch,
    pr_url: input.pr_url,
    summary: input.summary,
    default_branch: workstation?.default_branch,
  });

  // Transition the source ticket to in_review — the soul's work is done
  // but the qualityAssurance hasn't reviewed it yet. The MR ticket tracks the merge
  // lifecycle. The source ticket retains its assignee so we know which agent
  // worked on it. It will be closed (or returned to in_progress) by the
  // qualityAssurance after review.
  unhookTicket(sql, agentId);
  updateTicketStatus(sql, sourceTicket, 'in_review', agentId);
}

/**
 * Result from agentCompleted indicating whether a rework was triggered.
 * When non-null, the DepartmentDO caller should dispatch a soul for the
 * source ticket.
 */
export type AgentCompletedResult = {
  reworkSourceTicketId: string | null;
};

/**
 * Called by the container when an agent process completes (or fails).
 * Closes/fails the ticket and unhooks the agent.
 *
 * For refineries that exit with 'completed' without having merged,
 * this triggers the rework flow: the MR ticket is failed and the source
 * ticket is returned to in_progress so a soul can be re-dispatched.
 */
export function agentCompleted(
  sql: SqlStorage,
  agentId: string,
  input: { status: 'completed' | 'failed'; reason?: string }
): AgentCompletedResult {
  const result: AgentCompletedResult = { reworkSourceTicketId: null };
  const agent = getAgent(sql, agentId);
  if (!agent) return result;

  if (agent.current_hook_ticket_id) {
    if (agent.role === 'qualityAssurance') {
      // NEVER fail or unhook a qualityAssurance from agentCompleted.
      // agentCompleted races with gt_done: the process exits, the
      // container sends /completed, but gt_done's HTTP request may
      // still be in flight. If we unhook here, a recovery path can
      // fire between agentCompleted and gt_done, resetting the MR ticket
      // that's about to be closed by gt_done.
      //
      // Leave the hook intact. gt_done will close + unhook if the
      // merge succeeded. The reconciler (which checks for status='working')
      // handles the case where gt_done never arrives.
      //
      // No-op for the ticket — just fall through to mark agent idle.
    } else {
      // For non-refineries: if the agent exited with 'failed', fail the ticket.
      // If it exited with 'completed', check whether gt_done already ran:
      //  - If the ticket is in_review/closed/failed → gt_done already handled it, no-op on ticket
      //  - If the ticket is still in_progress → agent was killed (idle timer, OOM, etc.)
      //    before calling gt_done. Don't close the ticket — just unhook. The reconciler's
      //    Rule 3 will reset it to open after the staleness timeout.
      const hookedTicket = getTicket(sql, agent.current_hook_ticket_id);
      if (input.status === 'failed') {
        updateTicketStatus(sql, agent.current_hook_ticket_id, 'failed', agentId, {
          code: 'agent_failed',
          message: 'Agent exited with failed status',
          source: 'container',
        });
      } else if (hookedTicket && hookedTicket.status === 'in_progress') {
        if (input.reason === 'container eviction') {
          // Container eviction: WIP was force-pushed and eviction context
          // was written on the ticket body. Reset to open and clear the
          // stale assignee so the reconciler can re-dispatch immediately.
          console.log(
            `[review-queue] agentCompleted: soul ${agentId} evicted — ` +
              `resetting ticket ${agent.current_hook_ticket_id} to open`
          );
          updateTicketStatus(sql, agent.current_hook_ticket_id, 'open', agentId);
          query(
            sql,
            /* sql */ `
              UPDATE ${tickets}
              SET ${tickets.columns.assignee_agent_ticket_id} = NULL
              WHERE ${tickets.ticket_id} = ?
            `,
            [agent.current_hook_ticket_id]
          );
        } else {
          // Agent exited 'completed' but ticket is still in_progress — gt_done was never called.
          // Don't close the ticket. Rule 3 will handle rework.
          console.log(
            `[review-queue] agentCompleted: soul ${agentId} exited without gt_done — ` +
              `ticket ${agent.current_hook_ticket_id} stays in_progress (Rule 3 will recover)`
          );
        }
      } else if (hookedTicket && hookedTicket.status === 'open') {
        // Ticket is open (wasn't dispatched yet or was already reset). No-op.
      } else {
        // Ticket is in_review, closed, or failed — gt_done already ran. No-op on ticket.
      }
      unhookTicket(sql, agentId);
    }
  }

  // Mark agent idle — but ONLY if it hasn't been re-dispatched (status
  // still 'working' on new work) since gt_done ran. agentCompleted can
  // arrive after the agent has been re-hooked and dispatched for a new
  // ticket. Without this guard, the stale completion event would clobber
  // the live dispatch.
  // For refineries, preserve dispatch_attempts so Rule 6's circuit-breaker
  // can track cumulative re-dispatch attempts across idle→dispatch cycles.
  // Resetting to 0 here was enabling infinite loops (#1342). Non-refineries
  // reset to 0 because they unhook above and get a fresh counter on hookTicket.
  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.status} = 'idle',
          ${agent_metadata.columns.dispatch_attempts} = CASE
            WHEN ${agent_metadata.columns.role} = 'qualityAssurance' THEN ${agent_metadata.columns.dispatch_attempts}
            ELSE 0
          END
      WHERE ${agent_metadata.ticket_id} = ?
        AND NOT (
          ${agent_metadata.columns.status} = 'working'
          AND ${agent_metadata.columns.current_hook_ticket_id} IS NOT NULL
        )
    `,
    [agentId]
  );

  return result;
}

/**
 * 24 hours in milliseconds — MR tickets in_review longer than this are "stale".
 */
const STALE_PR_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** Zod schema for a single enriched MR ticket row from the needsAttention query. */
const MrTicketRow = z.object({
  ticket_id: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.string().transform((v): Record<string, unknown> => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }),
  // review_metadata columns
  branch: z.string(),
  target_branch: z.string(),
  merge_commit: z.string().nullable(),
  pr_url: z.string().nullable(),
  retry_count: z.number(),
  // source ticket (via ticket_dependencies tracks)
  source_ticket_id: z.string().nullable(),
  source_ticket_title: z.string().nullable(),
  source_ticket_status: z.string().nullable(),
  source_ticket_body: z.string().nullable(),
  // shift info (via metadata.shift_id → shift_metadata)
  shift_id: z.string().nullable(),
  shift_title: z.string().nullable(),
  shift_total_tickets: z.number().nullable(),
  shift_closed_tickets: z.number().nullable(),
  shift_feature_branch: z.string().nullable(),
  shift_merge_mode: z.string().nullable(),
  // agent info (via metadata.source_agent_id → agent_metadata)
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_role: z.string().nullable(),
  // workstation name
  workstation_name: z.string().nullable(),
  // failure event metadata (correlated subquery for failed MR tickets)
  failure_event_metadata: z
    .string()
    .nullable()
    .transform((v): Record<string, unknown> | null => {
      if (!v) return null;
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        return null;
      }
    }),
});

/** Zod schema for an enriched activity log event row. */
const ActivityLogRow = z.object({
  ticket_event_id: z.string(),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  event_metadata: z.string().transform((v): Record<string, unknown> => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }),
  event_created_at: z.string(),
  // associated ticket info
  ticket_title: z.string().nullable(),
  ticket_type: z.string().nullable(),
  ticket_status: z.string().nullable(),
  ticket_workstation_id: z.string().nullable(),
  ticket_metadata: z
    .string()
    .nullable()
    .transform((v): Record<string, unknown> => {
      try {
        return v ? (JSON.parse(v) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }),
  // agent info
  agent_name: z.string().nullable(),
  agent_role: z.string().nullable(),
  // workstation info
  workstation_name: z.string().nullable(),
  // source ticket (resolved via ticket_dependencies tracks join)
  source_ticket_id: z.string().nullable(),
  source_ticket_title: z.string().nullable(),
  source_ticket_status: z.string().nullable(),
  // review metadata
  rm_branch: z.string().nullable(),
  rm_target_branch: z.string().nullable(),
  rm_merge_commit: z.string().nullable(),
  rm_pr_url: z.string().nullable(),
  // shift info
  shift_id: z.string().nullable(),
  shift_title: z.string().nullable(),
  shift_total_tickets: z.number().nullable(),
  shift_closed_tickets: z.number().nullable(),
  shift_feature_branch: z.string().nullable(),
  shift_merge_mode: z.string().nullable(),
});

export type MergeQueueParams = {
  workstationId?: string;
  limit?: number;
  since?: string;
};

export type MergeQueueData = {
  needsAttention: {
    openPRs: MergeQueueItem[];
    failedReviews: MergeQueueItem[];
    stalePRs: MergeQueueItem[];
  };
  activityLog: ActivityLogEntry[];
};

export type MergeQueueItem = {
  mrTicket: {
    ticket_id: string;
    status: string;
    title: string;
    body: string | null;
    workstation_id: string | null;
    created_at: string;
    updated_at: string;
    metadata: Record<string, unknown>;
  };
  reviewMetadata: {
    branch: string;
    target_branch: string;
    merge_commit: string | null;
    pr_url: string | null;
    retry_count: number;
  };
  sourceTicket: {
    ticket_id: string;
    title: string;
    status: string;
    body: string | null;
  } | null;
  shift: {
    shift_id: string;
    title: string;
    total_tickets: number;
    closed_tickets: number;
    feature_branch: string | null;
    merge_mode: string | null;
  } | null;
  agent: {
    agent_id: string;
    name: string;
    role: string;
  } | null;
  workstationName: string | null;
  staleSince: string | null;
  failureReason: string | null;
};

export type ActivityLogEntry = {
  event: {
    ticket_event_id: string;
    ticket_id: string;
    agent_id: string | null;
    event_type: string;
    old_value: string | null;
    new_value: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  };
  mrTicket: {
    ticket_id: string;
    title: string;
    type: string;
    status: string;
    workstation_id: string | null;
    metadata: Record<string, unknown>;
  } | null;
  sourceTicket: {
    ticket_id: string;
    title: string;
    status: string;
  } | null;
  shift: {
    shift_id: string;
    title: string;
    total_tickets: number;
    closed_tickets: number;
    feature_branch: string | null;
    merge_mode: string | null;
  } | null;
  agent: {
    agent_id: string;
    name: string;
    role: string;
  } | null;
  workstationName: string | null;
  reviewMetadata: {
    pr_url: string | null;
    branch: string | null;
    target_branch: string | null;
    merge_commit: string | null;
  } | null;
};

/**
 * Query all data the Merge Queue page needs: MR tickets needing attention
 * (open PRs, failed reviews, stale PRs) and a recent activity log.
 */
export function getMergeQueueData(sql: SqlStorage, params: MergeQueueParams): MergeQueueData {
  const workstationId = params.workstationId ?? null;

  // Statuses: in_progress = "in review" (PR created, awaiting merge),
  //           open = pending review, failed = review failed
  // We fetch all non-closed MR tickets for the needs-attention section.
  const mrRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          ${tickets.ticket_id},
          ${tickets.status},
          ${tickets.title},
          ${tickets.body},
          ${tickets.workstation_id},
          ${tickets.created_at},
          ${tickets.updated_at},
          ${tickets.metadata},
          ${review_metadata.branch},
          ${review_metadata.target_branch},
          ${review_metadata.merge_commit},
          ${review_metadata.pr_url},
          ${review_metadata.retry_count},
          src.${tickets.columns.ticket_id} AS source_ticket_id,
          src.${tickets.columns.title} AS source_ticket_title,
          src.${tickets.columns.status} AS source_ticket_status,
          src.${tickets.columns.body} AS source_ticket_body,
          cm.${shift_metadata.columns.ticket_id} AS shift_id,
          shift_Ticket.${tickets.columns.title} AS shift_title,
          cm.${shift_metadata.columns.total_tickets} AS shift_total_tickets,
          cm.${shift_metadata.columns.closed_tickets} AS shift_closed_tickets,
          cm.${shift_metadata.columns.feature_branch} AS shift_feature_branch,
          cm.${shift_metadata.columns.merge_mode} AS shift_merge_mode,
          am.${agent_metadata.columns.ticket_id} AS agent_id,
          agent_Ticket.${tickets.columns.title} AS agent_name,
          am.${agent_metadata.columns.role} AS agent_role,
          workstation.name AS workstation_name,
          (SELECT ${ticket_events.metadata}
           FROM ${ticket_events}
           WHERE ${ticket_events.ticket_id} = ${tickets.ticket_id}
             AND ${ticket_events.event_type} IN ('review_completed', 'pr_creation_failed')
           ORDER BY ${ticket_events.created_at} DESC
           LIMIT 1) AS failure_event_metadata
        FROM ${tickets}
        INNER JOIN ${review_metadata}
          ON ${tickets.ticket_id} = ${review_metadata.ticket_id}
        LEFT JOIN ${ticket_dependencies} AS dep
          ON dep.${ticket_dependencies.columns.ticket_id} = ${tickets.ticket_id}
          AND dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
        LEFT JOIN ${tickets} AS src
          ON src.${tickets.columns.ticket_id} = dep.${ticket_dependencies.columns.depends_on_ticket_id}
        LEFT JOIN ${shift_metadata} AS cm
          ON cm.${shift_metadata.columns.ticket_id} = json_extract(${tickets.metadata}, '$.shift_id')
        LEFT JOIN ${tickets} AS shift_Ticket
          ON shift_Ticket.${tickets.columns.ticket_id} = cm.${shift_metadata.columns.ticket_id}
        LEFT JOIN ${agent_metadata} AS am
          ON am.${agent_metadata.columns.ticket_id} = json_extract(${tickets.metadata}, '$.source_agent_id')
        LEFT JOIN ${tickets} AS agent_Ticket
          ON agent_Ticket.${tickets.columns.ticket_id} = am.${agent_metadata.columns.ticket_id}
        LEFT JOIN workstations AS workstation
          ON workstation.id = ${tickets.workstation_id}
        WHERE ${tickets.type} = 'merge_request'
          AND ${tickets.status} IN ('open', 'in_progress', 'in_review', 'failed')
          AND (? IS NULL OR ${tickets.workstation_id} = ?)
        ORDER BY ${tickets.created_at} DESC
      `,
      [workstationId, workstationId]
    ),
  ];

  const parsedMrRows = MrTicketRow.array().parse(mrRows);
  const staleThreshold = new Date(Date.now() - STALE_PR_THRESHOLD_MS).toISOString();

  const openPRs: MergeQueueItem[] = [];
  const failedReviews: MergeQueueItem[] = [];
  const stalePRs: MergeQueueItem[] = [];

  for (const row of parsedMrRows) {
    const item = mrTicketRowToItem(row);

    if (row.status === 'failed') {
      failedReviews.push(item);
    } else if (row.pr_url && row.status === 'in_progress') {
      // in_progress with pr_url = PR created, awaiting human merge
      if (row.updated_at < staleThreshold) {
        item.staleSince = row.updated_at;
        stalePRs.push(item);
      } else {
        openPRs.push(item);
      }
    }
    // open/in_review without pr_url are pending queue items, not shown in needs-attention
  }

  const limit = params.limit ?? 50;
  const since = params.since ?? null;

  const eventRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT
          ${ticket_events.ticket_event_id},
          ${ticket_events.ticket_id},
          ${ticket_events.agent_id},
          ${ticket_events.event_type},
          ${ticket_events.old_value},
          ${ticket_events.new_value},
          ${ticket_events.metadata} AS event_metadata,
          ${ticket_events.created_at} AS event_created_at,
          b.${tickets.columns.title} AS ticket_title,
          b.${tickets.columns.type} AS ticket_type,
          b.${tickets.columns.status} AS ticket_status,
          b.${tickets.columns.workstation_id} AS ticket_workstation_id,
          b.${tickets.columns.metadata} AS ticket_metadata,
          agent_Ticket.${tickets.columns.title} AS agent_name,
          am.${agent_metadata.columns.role} AS agent_role,
          workstation.name AS workstation_name,
          src.${tickets.columns.ticket_id} AS source_ticket_id,
          src.${tickets.columns.title} AS source_ticket_title,
          src.${tickets.columns.status} AS source_ticket_status,
          rm.${review_metadata.columns.branch} AS rm_branch,
          rm.${review_metadata.columns.target_branch} AS rm_target_branch,
          rm.${review_metadata.columns.merge_commit} AS rm_merge_commit,
          rm.${review_metadata.columns.pr_url} AS rm_pr_url,
          cm.${shift_metadata.columns.ticket_id} AS shift_id,
          shift_Ticket.${tickets.columns.title} AS shift_title,
          cm.${shift_metadata.columns.total_tickets} AS shift_total_tickets,
          cm.${shift_metadata.columns.closed_tickets} AS shift_closed_tickets,
          cm.${shift_metadata.columns.feature_branch} AS shift_feature_branch,
          cm.${shift_metadata.columns.merge_mode} AS shift_merge_mode
        FROM ${ticket_events}
        INNER JOIN ${tickets} AS b
          ON b.${tickets.columns.ticket_id} = ${ticket_events.ticket_id}
        LEFT JOIN ${agent_metadata} AS am
          ON am.${agent_metadata.columns.ticket_id} = ${ticket_events.agent_id}
        LEFT JOIN ${tickets} AS agent_Ticket
          ON agent_Ticket.${tickets.columns.ticket_id} = ${ticket_events.agent_id}
        LEFT JOIN ${ticket_dependencies} AS dep
          ON dep.${ticket_dependencies.columns.ticket_id} = b.${tickets.columns.ticket_id}
          AND dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
        LEFT JOIN ${tickets} AS src
          ON src.${tickets.columns.ticket_id} = dep.${ticket_dependencies.columns.depends_on_ticket_id}
        LEFT JOIN ${review_metadata} AS rm
          ON rm.${review_metadata.columns.ticket_id} = ${ticket_events.ticket_id}
        LEFT JOIN ${shift_metadata} AS cm
          ON cm.${shift_metadata.columns.ticket_id} = json_extract(b.${tickets.columns.metadata}, '$.shift_id')
        LEFT JOIN ${tickets} AS shift_Ticket
          ON shift_Ticket.${tickets.columns.ticket_id} = cm.${shift_metadata.columns.ticket_id}
        LEFT JOIN workstations AS workstation
          ON workstation.id = b.${tickets.columns.workstation_id}
        WHERE ${ticket_events.event_type} IN (
          'review_submitted', 'review_completed', 'pr_created',
          'pr_creation_failed', 'rework_requested', 'status_changed'
        )
          AND (? IS NULL OR b.${tickets.columns.workstation_id} = ?)
          AND (? IS NULL OR ${ticket_events.created_at} > ?)
        ORDER BY ${ticket_events.created_at} DESC
        LIMIT ?
      `,
      [workstationId, workstationId, since, since, limit]
    ),
  ];

  const parsedEventRows = ActivityLogRow.array().parse(eventRows);

  const activityLog: ActivityLogEntry[] = parsedEventRows.map(eventRowToEntry);

  return {
    needsAttention: { openPRs, failedReviews, stalePRs },
    activityLog,
  };
}

function mrTicketRowToItem(row: z.output<typeof MrTicketRow>): MergeQueueItem {
  return {
    mrTicket: {
      ticket_id: row.ticket_id,
      status: row.status,
      title: row.title,
      body: row.body,
      workstation_id: row.workstation_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      metadata: row.metadata,
    },
    reviewMetadata: {
      branch: row.branch,
      target_branch: row.target_branch,
      merge_commit: row.merge_commit,
      pr_url: row.pr_url,
      retry_count: row.retry_count,
    },
    sourceTicket: row.source_ticket_id
      ? {
          ticket_id: row.source_ticket_id,
          title: row.source_ticket_title ?? '',
          status: row.source_ticket_status ?? '',
          body: row.source_ticket_body ?? null,
        }
      : null,
    shift: row.shift_id
      ? {
          shift_id: row.shift_id,
          title: row.shift_title ?? '',
          total_tickets: row.shift_total_tickets ?? 0,
          closed_tickets: row.shift_closed_tickets ?? 0,
          feature_branch: row.shift_feature_branch,
          merge_mode: row.shift_merge_mode,
        }
      : null,
    agent: row.agent_id
      ? {
          agent_id: row.agent_id,
          name: row.agent_name ?? '',
          role: row.agent_role ?? '',
        }
      : null,
    workstationName: row.workstation_name,
    staleSince: null,
    failureReason: extractFailureMessage(row.status, row.failure_event_metadata),
  };
}

function eventRowToEntry(row: z.output<typeof ActivityLogRow>): ActivityLogEntry {
  // Source ticket resolution:
  // - Events on MR tickets (pr_created, pr_creation_failed, rework_requested):
  //   resolved via ticket_dependencies LEFT JOIN (source_ticket_id/title/status columns)
  // - Events on source tickets (review_submitted, review_completed):
  //   the event's ticket IS the source ticket — use the ticket columns directly
  const isMrTicketEvent = row.ticket_type === 'merge_request';

  const resolvedSourceTicket = isMrTicketEvent
    ? row.source_ticket_id
      ? {
          ticket_id: row.source_ticket_id,
          title: row.source_ticket_title ?? '',
          status: row.source_ticket_status ?? '',
        }
      : null
    : row.ticket_title
      ? {
          ticket_id: row.ticket_id,
          title: row.ticket_title,
          status: row.ticket_status ?? '',
        }
      : null;

  return {
    event: {
      ticket_event_id: row.ticket_event_id,
      ticket_id: row.ticket_id,
      agent_id: row.agent_id,
      event_type: row.event_type,
      old_value: row.old_value,
      new_value: row.new_value,
      metadata: row.event_metadata,
      created_at: row.event_created_at,
    },
    mrTicket: row.ticket_title
      ? {
          ticket_id: row.ticket_id,
          title: row.ticket_title,
          type: row.ticket_type ?? 'merge_request',
          status: row.ticket_status ?? '',
          workstation_id: row.ticket_workstation_id,
          metadata: row.ticket_metadata,
        }
      : null,
    sourceTicket: resolvedSourceTicket,
    shift: row.shift_id
      ? {
          shift_id: row.shift_id,
          title: row.shift_title ?? '',
          total_tickets: row.shift_total_tickets ?? 0,
          closed_tickets: row.shift_closed_tickets ?? 0,
          feature_branch: row.shift_feature_branch,
          merge_mode: row.shift_merge_mode,
        }
      : null,
    agent: row.agent_id
      ? {
          agent_id: row.agent_id,
          name: row.agent_name ?? '',
          role: row.agent_role ?? '',
        }
      : null,
    workstationName: row.workstation_name,
    reviewMetadata:
      row.rm_branch !== null
        ? {
            pr_url: row.rm_pr_url,
            branch: row.rm_branch,
            target_branch: row.rm_target_branch,
            merge_commit: row.rm_merge_commit,
          }
        : null,
  };
}

/**
 * Create a TicketCase: a parent ticket with type='TicketCase', child step tickets
 * linked via parent_ticket_id, and step ordering via ticket_dependencies.
 */
export function createTicketCase(sql: SqlStorage, ticketId: string, formula: unknown): TicketCase {
  const id = generateId();
  const timestamp = now();
  const formulaArr = Array.isArray(formula) ? formula : [];

  query(
    sql,
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
      id,
      'TicketCase',
      'open',
      `TicketCase for ticket ${ticketId}`,
      null,
      null,
      null,
      null,
      'medium',
      JSON.stringify(['gt:TicketCase']),
      JSON.stringify({ source_ticket_id: ticketId, formula }),
      null,
      timestamp,
      timestamp,
      null,
    ]
  );

  let prevStepId: string | null = null;
  for (let i = 0; i < formulaArr.length; i++) {
    const stepId = generateId();
    const step: unknown = formulaArr[i];

    query(
      sql,
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
        stepId,
        'issue',
        'open',
        z.object({ title: z.string() }).safeParse(step).data?.title ?? `Step ${i + 1}`,
        typeof step === 'string' ? step : JSON.stringify(step),
        null,
        id,
        null,
        'medium',
        JSON.stringify([`gt:ticket-case-step`, `step:${i}`]),
        JSON.stringify({ step_index: i, step_data: step }),
        null,
        timestamp,
        timestamp,
        null,
      ]
    );

    if (prevStepId) {
      query(
        sql,
        /* sql */ `
          INSERT INTO ${ticket_dependencies} (
            ${ticket_dependencies.columns.ticket_id},
            ${ticket_dependencies.columns.depends_on_ticket_id},
            ${ticket_dependencies.columns.dependency_type}
          ) VALUES (?, ?, ?)
        `,
        [stepId, prevStepId, 'blocks']
      );
    }
    prevStepId = stepId;
  }

  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.metadata} = json_set(${tickets.metadata}, '$.ticket_case_ticket_id', ?)
      WHERE ${tickets.ticket_id} = ?
    `,
    [id, ticketId]
  );

  const mol = getTicketCase(sql, id);
  if (!mol) throw new Error('Failed to create TicketCase');
  return mol;
}

/**
 * Get a TicketCase by its ticket_id. Derives current_step and status from children.
 */
export function getTicketCase(sql: SqlStorage, TicketCaseId: string): TicketCase | null {
  const ticket = getTicket(sql, TicketCaseId);
  if (!ticket || ticket.type !== 'TicketCase') return null;

  const steps = getStepTickets(sql, TicketCaseId);
  const closedCount = steps.filter(s => s.status === 'closed').length;
  const failedCount = steps.filter(s => s.status === 'failed').length;

  const currentStep = closedCount;
  const status =
    failedCount > 0
      ? 'failed'
      : closedCount >= steps.length && steps.length > 0
        ? 'completed'
        : 'active';

  const formula: unknown = ticket.metadata?.formula ?? [];

  return {
    id: TicketCaseId,
    ticket_id: String(ticket.metadata?.source_ticket_id ?? TicketCaseId),
    formula,
    current_step: currentStep,
    status,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
  };
}

function getStepTickets(sql: SqlStorage, TicketCaseId: string): TicketRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${tickets}
        WHERE ${tickets.parent_ticket_id} = ?
        ORDER BY ${tickets.created_at} ASC
      `,
      [TicketCaseId]
    ),
  ];
  return TicketRecord.array().parse(rows);
}

export function getTicketCaseForTicket(sql: SqlStorage, ticketId: string): TicketCase | null {
  const ticket = getTicket(sql, ticketId);
  if (!ticket) return null;
  const TicketCaseId: unknown = ticket.metadata?.ticket_case_ticket_id;
  if (typeof TicketCaseId !== 'string') return null;
  return getTicketCase(sql, TicketCaseId);
}

export function getTicketCaseCurrentStep(
  sql: SqlStorage,
  agentId: string
): { TicketCase: TicketCase; step: unknown } | null {
  const agent = getAgent(sql, agentId);
  if (!agent?.current_hook_ticket_id) return null;

  const mol = getTicketCaseForTicket(sql, agent.current_hook_ticket_id);
  if (!mol || mol.status !== 'active') return null;

  const formula = mol.formula;
  if (!Array.isArray(formula)) return null;

  const step: unknown = (formula as unknown[])[mol.current_step] ?? null;
  return { TicketCase: mol, step };
}

export function advanceTicketCaseStep(
  sql: SqlStorage,
  agentId: string,
  _summary: string
): TicketCase | null {
  const current = getTicketCaseCurrentStep(sql, agentId);
  if (!current) return null;

  const { TicketCase } = current;

  const steps = getStepTickets(sql, TicketCase.id);
  const currentStepTicket = steps[TicketCase.current_step];
  if (currentStepTicket) {
    const timestamp = now();
    query(
      sql,
      /* sql */ `
        UPDATE ${tickets}
        SET ${tickets.columns.status} = 'closed',
            ${tickets.columns.closed_at} = ?,
            ${tickets.columns.updated_at} = ?
        WHERE ${tickets.ticket_id} = ?
      `,
      [timestamp, timestamp, currentStepTicket.ticket_id]
    );
  }

  const formula = TicketCase.formula;
  const nextStep = TicketCase.current_step + 1;
  const isComplete = !Array.isArray(formula) || nextStep >= formula.length;

  if (isComplete) {
    const timestamp = now();
    query(
      sql,
      /* sql */ `
        UPDATE ${tickets}
        SET ${tickets.columns.status} = 'closed',
            ${tickets.columns.closed_at} = ?,
            ${tickets.columns.updated_at} = ?
        WHERE ${tickets.ticket_id} = ?
      `,
      [timestamp, timestamp, TicketCase.id]
    );
  }

  return getTicketCase(sql, TicketCase.id);
}
