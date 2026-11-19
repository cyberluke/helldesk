/**
 * ComplianceWitness & Deacon attendance functions for the DepartmentDO alarm handler.
 *
 * All mechanical checks run as deterministic code. Ambiguous situations
 * produce triage request tickets (type='issue', label='gt:triage-request')
 * with structured context for an on-demand LLM triage agent to resolve.
 *
 * See #442 for the full design.
 */

import { z } from 'zod';
import { tickets, TicketRecord as TicketRecordSchema } from '../../db/tables/tickets.table';
import { query } from '../../util/query.util';
import { createTicket } from './tickets';

const LOG = '[attendance]';

// ── Thresholds ──────────────────────────────────────────────────────

/** Escalate to frontDesk after second threshold */
export const GUPP_ESCALATE_MS = 60 * 60_000; // 1h
/** Force-stop agent after third threshold */
export const GUPP_FORCE_STOP_MS = 2 * 60 * 60_000; // 2h
/** Agents dead/completed for longer than this are GC'd */
export const AGENT_GC_RETENTION_MS = 24 * 60 * 60_000; // 24h

/** Maximum number of open triage request tickets allowed at once */
export const MAX_OPEN_TRIAGE_REQUESTS = 5;

// ── Triage request types ────────────────────────────────────────────

export type TriageType =
  | 'dirty_soul'
  | 'stuck_agent'
  | 'help_request'
  | 'zombie_confirm'
  | 'crash_loop'
  | 'escalation';

export type TriageRequestMetadata = {
  triage_type: TriageType;
  agent_ticket_id: string | null;
  /** The ticket the agent was hooked to when the triage request was created.
   *  Resolve actions should target this ticket, not the agent's current hook
   *  (which may have changed by the time the triage agent resolves it). */
  hooked_ticket_id: string | null;
  context: Record<string, unknown>;
  options: string[];
};

// ── Triage request creation ─────────────────────────────────────────

/** Label used to identify triage request tickets (type='issue'). */
export const TRIAGE_REQUEST_LABEL = 'gt:triage-request';

/** Label used to identify the triage agent's batch ticket. */
export const TRIAGE_BATCH_LABEL = 'gt:triage';

/** SQL LIKE pattern for querying triage request tickets by label. */
export const TRIAGE_LABEL_LIKE = `%"${TRIAGE_REQUEST_LABEL}"%`;

/** Label used to mark tickets that should not yet be dispatched by the reconciler. */
export const HELD_LABEL = 'gt:held';

/** SQL LIKE pattern for querying held tickets by label. */
export const HELD_LABEL_LIKE = `%"${HELD_LABEL}"%`;

/** Create a triage request ticket for the LLM triage agent to resolve. */
export function createTriageRequest(
  sql: SqlStorage,
  params: {
    triageType: TriageType;
    agentTicketId: string | null;
    /** The ticket the agent was hooked to at the time of the request. */
    hookedTicketId?: string | null;
    title: string;
    context: Record<string, unknown>;
    options: string[];
    workstationId?: string;
  }
): void {
  // Deduplicate: skip if an open triage request of the same type already
  // exists for this agent
  if (params.agentTicketId) {
    const existing = [
      ...query(
        sql,
        /* sql */ `
          SELECT ${tickets.ticket_id} FROM ${tickets}
          WHERE ${tickets.type} = 'issue'
            AND ${tickets.labels} LIKE ?
            AND ${tickets.status} = 'open'
            AND ${tickets.assignee_agent_ticket_id} = ?
            AND json_extract(${tickets.metadata}, '$.triage_type') = ?
          LIMIT 1
        `,
        [TRIAGE_LABEL_LIKE, params.agentTicketId, params.triageType]
      ),
    ];
    if (existing.length > 0) return;
  }

  // Global cap: skip if there are already too many open *automatic* triage
  // requests (attendance-generated). Escalations are exempt from both the gate
  // and the count — they are agent/user initiated and silently dropping
  // them would leave the escalation ticket with no automated follow-up.
  if (params.triageType !== 'escalation') {
    const openCountRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT COUNT(*) AS cnt FROM ${tickets}
          WHERE ${tickets.type} = 'issue'
            AND ${tickets.labels} LIKE ?
            AND ${tickets.status} = 'open'
            AND json_extract(${tickets.metadata}, '$.triage_type') != 'escalation'
        `,
        [TRIAGE_LABEL_LIKE]
      ),
    ];
    const openCount = Number(z.object({ cnt: z.number() }).parse(openCountRows[0]).cnt);
    if (openCount >= MAX_OPEN_TRIAGE_REQUESTS) {
      console.warn(
        `${LOG} createTriageRequest: global cap reached (${openCount} open), skipping type=${params.triageType}`
      );
      return;
    }
  }

  const metadata: TriageRequestMetadata = {
    triage_type: params.triageType,
    agent_ticket_id: params.agentTicketId,
    hooked_ticket_id: params.hookedTicketId ?? null,
    context: params.context,
    options: params.options,
  };

  createTicket(sql, {
    type: 'issue',
    title: params.title,
    body: JSON.stringify(params.context),
    priority: 'medium',
    metadata,
    labels: [TRIAGE_REQUEST_LABEL],
    assignee_agent_ticket_id: params.agentTicketId ?? undefined,
    workstation_id: params.workstationId,
  });

  console.log(
    `${LOG} createTriageRequest: type=${params.triageType} agent=${params.agentTicketId ?? 'none'}`
  );
}

// ── Pending triage requests ─────────────────────────────────────────

/** Count open triage request tickets (issue tickets with gt:triage-request label). */
export function countPendingTriageRequests(sql: SqlStorage): number {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(*) AS cnt FROM ${tickets}
        WHERE ${tickets.type} = 'issue'
          AND ${tickets.labels} LIKE ?
          AND ${tickets.status} = 'open'
      `,
      [TRIAGE_LABEL_LIKE]
    ),
  ];
  return Number(z.object({ cnt: z.number() }).parse(rows[0]).cnt);
}

/** List open triage request tickets for the triage agent prompt. */
export function listPendingTriageRequests(sql: SqlStorage): z.output<typeof TicketRecordSchema>[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${tickets}
        WHERE ${tickets.type} = 'issue'
          AND ${tickets.labels} LIKE ?
          AND ${tickets.status} = 'open'
        ORDER BY ${tickets.created_at} ASC
        LIMIT 20
      `,
      [TRIAGE_LABEL_LIKE]
    ),
  ];
  return TicketRecordSchema.array().parse(rows);
}
