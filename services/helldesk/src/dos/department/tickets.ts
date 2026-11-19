/**
 * Ticket CRUD operations for the Department DO.
 * After the tickets-centric refactor (#441), all object types are tickets.
 */

import { z } from 'zod';
import {
  tickets,
  TicketRecord,
  createTableTickets,
  getIndexesTickets,
  migrateTickets,
} from '../../db/tables/tickets.table';
import {
  ticket_events,
  TicketEventRecord,
  createTableTicketEvents,
  getIndexesTicketEvents,
} from '../../db/tables/ticket-events.table';
import {
  ticket_dependencies,
  createTableTicketDependencies,
  getIndexesTicketDependencies,
} from '../../db/tables/ticket-dependencies.table';
import {
  agent_metadata,
  createTableAgentMetadata,
  migrateAgentMetadata,
} from '../../db/tables/agent-metadata.table';
import {
  review_metadata,
  createTableReviewMetadata,
  migrateReviewMetadata,
} from '../../db/tables/review-metadata.table';
import {
  escalation_metadata,
  createTableEscalationMetadata,
} from '../../db/tables/escalation-metadata.table';
import {
  shift_metadata,
  createTableShiftMetadata,
  migrateShiftMetadata,
} from '../../db/tables/shift-metadata.table';
import { department_events } from '../../db/tables/department-events.table';
import { query } from '../../util/query.util';
import { generateId, now } from '../../util/id.util';
import type {
  CreateTicketInput,
  TicketFilter,
  Ticket,
  TicketStatus,
  TicketPriority,
  TicketType,
} from '../../types';
import type { TicketEventType } from '../../db/tables/ticket-events.table';
import type { FailureReason } from './types';

export function initTicketTables(sql: SqlStorage): void {
  // Create all tables first (IF NOT EXISTS — safe for existing DOs)
  query(sql, createTableTickets(), []);
  query(sql, createTableTicketEvents(), []);
  query(sql, createTableTicketDependencies(), []);
  query(sql, createTableAgentMetadata(), []);
  query(sql, createTableReviewMetadata(), []);
  query(sql, createTableEscalationMetadata(), []);
  query(sql, createTableShiftMetadata(), []);

  // Migration: drop CHECK constraints from existing tables.
  // Must run BEFORE index creation — rebuilding a table drops its indexes.
  dropCheckConstraints(sql);

  // Migrations: add columns to existing tables (idempotent)
  for (const stmt of [
    ...migrateTickets(),
    ...migrateShiftMetadata(),
    ...migrateAgentMetadata(),
    ...migrateReviewMetadata(),
  ]) {
    try {
      query(sql, stmt, []);
    } catch {
      // Column already exists — expected after first run
    }
  }

  // Create indexes after migrations (IF NOT EXISTS — idempotent)
  for (const idx of getIndexesTickets()) {
    query(sql, idx, []);
  }
  for (const idx of getIndexesTicketEvents()) {
    query(sql, idx, []);
  }
  for (const idx of getIndexesTicketDependencies()) {
    query(sql, idx, []);
  }
}

/**
 * Detect tables with CHECK constraints and recreate them without.
 * Uses SQLite's "CREATE TABLE ... AS SELECT" pattern to rebuild.
 *
 * Idempotent: if a table has no CHECK constraints, it's skipped.
 */
function dropCheckConstraints(sql: SqlStorage): void {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT name, sql as create_sql
        FROM sqlite_master
        WHERE type = 'table'
          AND sql LIKE '%check(%'
      `,
      []
    ),
  ];

  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.create_sql !== 'string') continue;
    const tableName = row.name;
    const originalSql = row.create_sql;

    // Strip all check(...) clauses from the CREATE TABLE statement.
    // Handles nested parens like check(status in ('open', 'closed')).
    const cleanedSql = originalSql.replace(
      /,?\s*check\s*\((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/gi,
      ''
    );

    // Skip if nothing changed (shouldn't happen given the WHERE clause)
    if (cleanedSql === originalSql) continue;

    const tmpName = `_${tableName}_migrate`;
    try {
      query(sql, /* sql */ `ALTER TABLE "${tableName}" RENAME TO "${tmpName}"`, []);
      query(sql, cleanedSql, []);
      query(sql, /* sql */ `INSERT INTO "${tableName}" SELECT * FROM "${tmpName}"`, []);
      query(sql, /* sql */ `DROP TABLE "${tmpName}"`, []);
    } catch (err) {
      // If migration fails mid-way, try to restore the original table
      try {
        query(sql, /* sql */ `DROP TABLE IF EXISTS "${tableName}"`, []);
        query(sql, /* sql */ `ALTER TABLE "${tmpName}" RENAME TO "${tableName}"`, []);
      } catch {
        // Best effort — the original table name should still be usable
      }
      console.warn(`[tickets] CHECK constraint migration failed for ${tableName}:`, err);
    }
  }
}

export function createTicket(sql: SqlStorage, input: CreateTicketInput): Ticket {
  const id = generateId();
  const timestamp = now();

  const labels = JSON.stringify(input.labels ?? []);
  const metadata = JSON.stringify(input.metadata ?? {});

  query(
    sql,
    /* sql */ `
      INSERT INTO ${tickets} (
        ${tickets.columns.ticket_id},
        ${tickets.columns.type},
        ${tickets.columns.status},
        ${tickets.columns.title},
        ${tickets.columns.body},
        ${tickets.columns.workstation_id},
        ${tickets.columns.parent_ticket_id},
        ${tickets.columns.assignee_agent_ticket_id},
        ${tickets.columns.priority},
        ${tickets.columns.labels},
        ${tickets.columns.metadata},
        ${tickets.columns.created_by},
        ${tickets.columns.created_at},
        ${tickets.columns.updated_at},
        ${tickets.columns.closed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.type,
      'open',
      input.title,
      input.body ?? null,
      input.workstation_id ?? null,
      input.parent_ticket_id ?? null,
      input.assignee_agent_ticket_id ?? null,
      input.priority ?? 'medium',
      labels,
      metadata,
      input.created_by ?? null,
      timestamp,
      timestamp,
      null,
    ]
  );

  const ticket = getTicket(sql, id);
  if (!ticket) throw new Error('Failed to create ticket');

  logTicketEvent(sql, {
    ticketId: id,
    agentId: input.assignee_agent_ticket_id ?? null,
    eventType: 'created',
    newValue: 'open',
    metadata: { type: input.type, title: input.title },
  });

  return ticket;
}

export function getTicket(sql: SqlStorage, ticketId: string): Ticket | null {
  const rows = [
    ...query(sql, /* sql */ `SELECT * FROM ${tickets} WHERE ${tickets.ticket_id} = ?`, [ticketId]),
  ];
  if (rows.length === 0) return null;
  return TicketRecord.parse(rows[0]);
}

export function listTickets(sql: SqlStorage, filter: TicketFilter): Ticket[] {
  const limit = filter.limit ?? 100;
  const offset = filter.offset ?? 0;

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${tickets}
        WHERE (? IS NULL OR ${tickets.status} = ?)
          AND (? IS NULL OR ${tickets.type} = ?)
          AND (? IS NULL OR ${tickets.assignee_agent_ticket_id} = ?)
          AND (? IS NULL OR ${tickets.parent_ticket_id} = ?)
          AND (? IS NULL OR ${tickets.workstation_id} = ?)
        ORDER BY ${tickets.created_at} DESC
        LIMIT ? OFFSET ?
      `,
      [
        filter.status ?? null,
        filter.status ?? null,
        filter.type ?? null,
        filter.type ?? null,
        filter.assignee_agent_ticket_id ?? null,
        filter.assignee_agent_ticket_id ?? null,
        filter.parent_ticket_id ?? null,
        filter.parent_ticket_id ?? null,
        filter.workstation_id ?? null,
        filter.workstation_id ?? null,
        limit,
        offset,
      ]
    ),
  ];

  return TicketRecord.array().parse(rows);
}

export function updateTicketStatus(
  sql: SqlStorage,
  ticketId: string,
  status: string,
  agentId: string | null,
  failureReason?: FailureReason
): Ticket {
  const ticket = getTicket(sql, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  // No-op if already in the target status — avoids redundant events
  if (ticket.status === status) return ticket;

  // HARD INVARIANT: terminal states (closed/failed) are immutable.
  // Once a ticket reaches a terminal state, no recovery function, stale MR
  // failure, or race condition should ever change its status. Return the
  // ticket as-is (no-op, not an error) so callers don't need to pre-check.
  if (ticket.status === 'closed' || ticket.status === 'failed') {
    console.warn(
      `[tickets] updateTicketStatus: blocked ${ticket.status} → ${status} for ticket=${ticketId} — terminal state is immutable`
    );
    return ticket;
  }

  const oldStatus = ticket.status;
  const timestamp = now();
  const closedAt = status === 'closed' ? timestamp : ticket.closed_at;

  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.status} = ?,
          ${tickets.columns.updated_at} = ?,
          ${tickets.columns.closed_at} = ?
      WHERE ${tickets.ticket_id} = ?
    `,
    [status, timestamp, closedAt, ticketId]
  );

  logTicketEvent(sql, {
    ticketId,
    agentId,
    eventType: 'status_changed',
    oldValue: oldStatus,
    newValue: status,
    metadata: failureReason && status === 'failed' ? { failure_reason: failureReason } : {},
  });

  if (status === 'closed' || status === 'failed') {
    updateShiftProgress(sql, ticketId, timestamp);
  }

  const updated = getTicket(sql, ticketId);
  if (!updated) throw new Error(`Ticket ${ticketId} not found after update`);
  return updated;
}

/**
 * If ticketId is tracked by a shift (via ticket_dependencies 'tracks'),
 * recount closed tickets and update shift_metadata. Auto-lands the
 * shift when all tracked tickets are closed.
 */
export function updateShiftProgress(sql: SqlStorage, ticketId: string, timestamp: string): void {
  const shiftRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.depends_on_ticket_id}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'tracks'
      `,
      [ticketId]
    ),
  ];
  if (shiftRows.length === 0) return;

  for (const row of shiftRows) {
    const shiftId = z.object({ depends_on_ticket_id: z.string() }).parse(row).depends_on_ticket_id;

    // Skip if this isn't actually a shift (e.g. MR ticket 'tracks' its source ticket,
    // which may not be a shift). No shift_metadata row → not a shift.
    const metaCheck = [
      ...query(
        sql,
        /* sql */ `
          SELECT 1 FROM ${shift_metadata}
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [shiftId]
      ),
    ];
    if (metaCheck.length === 0) continue;

    // Count tracked tickets that are fully done: closed/failed AND have no
    // pending merge_request child tickets. This prevents marking a shift as
    // ready_to_land while reviews are still in flight.
    const countRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT COUNT(1) AS count FROM ${ticket_dependencies} AS tracked
          INNER JOIN ${tickets} AS tracked_Ticket
            ON tracked.${ticket_dependencies.columns.ticket_id} = tracked_Ticket.${tickets.columns.ticket_id}
          WHERE tracked.${ticket_dependencies.columns.depends_on_ticket_id} = ?
            AND tracked.${ticket_dependencies.columns.dependency_type} = 'tracks'
            AND tracked_Ticket.${tickets.columns.status} IN ('closed', 'failed')
            AND NOT EXISTS (
              SELECT 1 FROM ${ticket_dependencies} AS mr_dep
              INNER JOIN ${tickets} AS mr_Ticket
                ON mr_dep.${ticket_dependencies.columns.ticket_id} = mr_Ticket.${tickets.columns.ticket_id}
              WHERE mr_dep.${ticket_dependencies.columns.depends_on_ticket_id} = tracked_Ticket.${tickets.columns.ticket_id}
                AND mr_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
                AND mr_Ticket.${tickets.columns.type} = 'merge_request'
                AND mr_Ticket.${tickets.columns.status} IN ('open', 'in_progress')
            )
        `,
        [shiftId]
      ),
    ];
    const closedCount = z.object({ count: z.number() }).parse(countRows[0]).count;

    query(
      sql,
      /* sql */ `
        UPDATE ${shift_metadata}
        SET ${shift_metadata.columns.closed_tickets} = ?
        WHERE ${shift_metadata.ticket_id} = ?
      `,
      [closedCount, shiftId]
    );

    const metaRows = [
      ...query(
        sql,
        /* sql */ `
          SELECT ${shift_metadata.total_tickets}
          FROM ${shift_metadata}
          WHERE ${shift_metadata.ticket_id} = ?
        `,
        [shiftId]
      ),
    ];
    const totalTickets = z.object({ total_tickets: z.number() }).parse(metaRows[0]).total_tickets;

    if (closedCount >= totalTickets && totalTickets > 0) {
      // For review-then-land shifts with a feature branch, don't auto-close
      // the shift yet — it needs a final merge of the feature branch into
      // main. For review-and-merge shifts (where each ticket already landed
      // independently), auto-close immediately.
      const featureBranch = getShiftFeatureBranch(sql, shiftId);
      const mergeMode = getShiftMergeMode(sql, shiftId);

      if (featureBranch && mergeMode === 'review-then-land') {
        // Mark the shift as ready to land by storing a flag in metadata.
        // The reconciler will detect this and create the final landing
        // MR (feature branch → main).
        query(
          sql,
          /* sql */ `
            UPDATE ${tickets}
            SET ${tickets.columns.metadata} = json_set(COALESCE(${tickets.metadata}, '{}'), '$.ready_to_land', 1),
                ${tickets.columns.updated_at} = ?
            WHERE ${tickets.ticket_id} = ?
          `,
          [timestamp, shiftId]
        );
        query(
          sql,
          /* sql */ `
            UPDATE ${shift_metadata}
            SET ${shift_metadata.columns.closed_tickets} = ?
            WHERE ${shift_metadata.ticket_id} = ?
          `,
          [closedCount, shiftId]
        );
      } else {
        // No feature branch — auto-land immediately (backwards compatible)
        query(
          sql,
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
          sql,
          /* sql */ `
            UPDATE ${shift_metadata}
            SET ${shift_metadata.columns.landed_at} = ?
            WHERE ${shift_metadata.ticket_id} = ?
          `,
          [timestamp, shiftId]
        );
      }
    }
  }
}

/**
 * Check if a ticket has unresolved 'blocks' dependencies.
 *
 * A blocker is resolved only when:
 * 1. The blocker ticket itself is closed or failed, AND
 * 2. The blocker has no pending merge_request child tickets (open/in_progress).
 *
 * Condition (2) prevents dispatching downstream tickets before the qualityAssurance
 * has reviewed and merged the upstream ticket's work. Without this, the
 * downstream soul would start on a codebase missing the upstream changes.
 */
export function hasUnresolvedBlockers(sql: SqlStorage, ticketId: string): boolean {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT COUNT(1) AS count
        FROM ${ticket_dependencies} AS dep
        INNER JOIN ${tickets} AS blocker
          ON dep.${ticket_dependencies.columns.depends_on_ticket_id} = blocker.${tickets.columns.ticket_id}
        WHERE dep.${ticket_dependencies.columns.ticket_id} = ?
          AND dep.${ticket_dependencies.columns.dependency_type} = 'blocks'
          AND (
            blocker.${tickets.columns.status} NOT IN ('closed', 'failed')
            OR EXISTS (
              SELECT 1 FROM ${ticket_dependencies} AS mr_dep
              INNER JOIN ${tickets} AS mr_Ticket
                ON mr_dep.${ticket_dependencies.columns.ticket_id} = mr_Ticket.${tickets.columns.ticket_id}
              WHERE mr_dep.${ticket_dependencies.columns.depends_on_ticket_id} = blocker.${tickets.columns.ticket_id}
                AND mr_dep.${ticket_dependencies.columns.dependency_type} = 'tracks'
                AND mr_Ticket.${tickets.columns.type} = 'merge_request'
                AND mr_Ticket.${tickets.columns.status} IN ('open', 'in_progress')
            )
          )
      `,
      [ticketId]
    ),
  ];
  return z.object({ count: z.number() }).parse(rows[0]).count > 0;
}

/** Insert a dependency between two tickets. */
export function insertDependency(
  sql: SqlStorage,
  ticketId: string,
  dependsOnTicketId: string,
  dependencyType: 'blocks' | 'tracks' | 'parent-child'
): void {
  query(
    sql,
    /* sql */ `
      INSERT OR IGNORE INTO ${ticket_dependencies} (
        ${ticket_dependencies.columns.ticket_id},
        ${ticket_dependencies.columns.depends_on_ticket_id},
        ${ticket_dependencies.columns.dependency_type}
      ) VALUES (?, ?, ?)
    `,
    [ticketId, dependsOnTicketId, dependencyType]
  );
}

/**
 * Atomically replace all 'blocks' edges for a ticket.
 * Deletes existing blockers then inserts the provided list.
 * Self-loops are silently skipped.
 */
export function setDependencies(sql: SqlStorage, ticketId: string, dependsOnTicketIds: string[]): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${ticket_dependencies}
      WHERE ${ticket_dependencies.ticket_id} = ?
        AND ${ticket_dependencies.dependency_type} = 'blocks'
    `,
    [ticketId]
  );
  for (const depId of dependsOnTicketIds) {
    if (depId === ticketId) continue; // no self-loops
    query(
      sql,
      /* sql */ `
        INSERT OR IGNORE INTO ${ticket_dependencies} (
          ${ticket_dependencies.columns.ticket_id},
          ${ticket_dependencies.columns.depends_on_ticket_id},
          ${ticket_dependencies.columns.dependency_type}
        ) VALUES (?, ?, 'blocks')
      `,
      [ticketId, depId]
    );
  }
}

/**
 * Add a ticket to a shift's tracking.
 * Inserts a 'tracks' edge and increments total_tickets — but only when the
 * edge is genuinely new (INSERT OR IGNORE returns 0 changes if it already
 * exists, so we check before updating the counter).
 * Returns whether the ticket was newly added (true) or already tracked (false).
 */
export function shiftAddTicket(sql: SqlStorage, shiftId: string, ticketId: string): boolean {
  const existing = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.ticket_id} = ?
          AND ${ticket_dependencies.depends_on_ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'tracks'
      `,
      [ticketId, shiftId]
    ),
  ];
  if (existing.length > 0) return false;

  query(
    sql,
    /* sql */ `
      INSERT INTO ${ticket_dependencies} (
        ${ticket_dependencies.columns.ticket_id},
        ${ticket_dependencies.columns.depends_on_ticket_id},
        ${ticket_dependencies.columns.dependency_type}
      ) VALUES (?, ?, 'tracks')
    `,
    [ticketId, shiftId]
  );
  query(
    sql,
    /* sql */ `
      UPDATE ${shift_metadata}
      SET ${shift_metadata.columns.total_tickets} = ${shift_metadata.columns.total_tickets} + 1
      WHERE ${shift_metadata.ticket_id} = ?
    `,
    [shiftId]
  );
  return true;
}

/**
 * Remove a ticket from a shift's tracking.
 * Deletes the 'tracks' edge, decrements total_tickets (floor 0), and removes
 * any 'blocks' edges between this ticket and other tickets in the same shift.
 * Returns whether the ticket was actually tracked (true) or not found (false).
 */
export function shiftRemoveTicket(sql: SqlStorage, shiftId: string, ticketId: string): boolean {
  const existing = [
    ...query(
      sql,
      /* sql */ `
        SELECT 1 FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.ticket_id} = ?
          AND ${ticket_dependencies.depends_on_ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'tracks'
      `,
      [ticketId, shiftId]
    ),
  ];
  if (existing.length === 0) return false;

  query(
    sql,
    /* sql */ `
      DELETE FROM ${ticket_dependencies}
      WHERE ${ticket_dependencies.ticket_id} = ?
        AND ${ticket_dependencies.depends_on_ticket_id} = ?
        AND ${ticket_dependencies.dependency_type} = 'tracks'
    `,
    [ticketId, shiftId]
  );
  query(
    sql,
    /* sql */ `
      UPDATE ${shift_metadata}
      SET ${shift_metadata.columns.total_tickets} = MAX(0, ${shift_metadata.columns.total_tickets} - 1)
      WHERE ${shift_metadata.ticket_id} = ?
    `,
    [shiftId]
  );

  const siblingRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.ticket_id}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'tracks'
      `,
      [shiftId]
    ),
  ];
  const siblingIds = z
    .object({ ticket_id: z.string() })
    .array()
    .parse(siblingRows)
    .map(r => r.ticket_id);

  if (siblingIds.length > 0) {
    // Delete 'blocks' edges where ticketId is the blocker of a sibling
    for (const siblingId of siblingIds) {
      query(
        sql,
        /* sql */ `
          DELETE FROM ${ticket_dependencies}
          WHERE ${ticket_dependencies.ticket_id} = ?
            AND ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'blocks'
        `,
        [siblingId, ticketId]
      );
    }
    // Delete 'blocks' edges where ticketId depends on a sibling
    for (const siblingId of siblingIds) {
      query(
        sql,
        /* sql */ `
          DELETE FROM ${ticket_dependencies}
          WHERE ${ticket_dependencies.ticket_id} = ?
            AND ${ticket_dependencies.depends_on_ticket_id} = ?
            AND ${ticket_dependencies.dependency_type} = 'blocks'
        `,
        [ticketId, siblingId]
      );
    }
  }

  return true;
}

/**
 * Find tickets that were blocked by `closedTicketId` and are now fully unblocked
 * (all their 'blocks' dependencies are resolved).
 */
export function getNewlyUnblockedTickets(sql: SqlStorage, closedTicketId: string): string[] {
  const dependentRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.ticket_id}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'blocks'
      `,
      [closedTicketId]
    ),
  ];

  const dependentIds = z
    .object({ ticket_id: z.string() })
    .array()
    .parse(dependentRows)
    .map(r => r.ticket_id);

  return dependentIds.filter(id => !hasUnresolvedBlockers(sql, id));
}

/**
 * Partial update of a ticket's editable fields.
 * Only fields explicitly provided in `fields` are updated.
 * Writes a `fields_updated` ticket_event for auditability.
 */
export function updateTicketFields(
  sql: SqlStorage,
  ticketId: string,
  fields: Partial<{
    title: string;
    body: string | null;
    priority: TicketPriority;
    labels: string[];
    status: TicketStatus;
    metadata: Record<string, unknown>;
    type: TicketType;
    workstation_id: string | null;
    parent_ticket_id: string | null;
  }>,
  actorId: string
): Ticket {
  const ticket = getTicket(sql, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

  // Delegate status changes to updateTicketStatus so they produce a
  // status_changed event (with old/new values), respect the terminal
  // state guard, and carry structured failureReason metadata.
  if (fields.status !== undefined && fields.status !== ticket.status) {
    updateTicketStatus(sql, ticketId, fields.status, actorId);
  }

  const timestamp = now();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (fields.title !== undefined) {
    setClauses.push(`${tickets.columns.title} = ?`);
    values.push(fields.title);
  }
  if (fields.body !== undefined) {
    setClauses.push(`${tickets.columns.body} = ?`);
    values.push(fields.body);
  }
  if (fields.priority !== undefined) {
    setClauses.push(`${tickets.columns.priority} = ?`);
    values.push(fields.priority);
  }
  if (fields.labels !== undefined) {
    setClauses.push(`${tickets.columns.labels} = ?`);
    values.push(JSON.stringify(fields.labels));
  }
  if (fields.metadata !== undefined) {
    setClauses.push(`${tickets.columns.metadata} = ?`);
    values.push(JSON.stringify(fields.metadata));
  }
  if (fields.type !== undefined) {
    setClauses.push(`${tickets.columns.type} = ?`);
    values.push(fields.type);
  }
  if (fields.workstation_id !== undefined) {
    setClauses.push(`${tickets.columns.workstation_id} = ?`);
    values.push(fields.workstation_id);
  }
  if (fields.parent_ticket_id !== undefined) {
    setClauses.push(`${tickets.columns.parent_ticket_id} = ?`);
    values.push(fields.parent_ticket_id);
  }

  if (setClauses.length > 0) {
    setClauses.push(`${tickets.columns.updated_at} = ?`);
    values.push(timestamp);
    values.push(ticketId);

    sql.exec(
      /* sql */ `UPDATE ${tickets} SET ${setClauses.join(', ')} WHERE ${tickets.ticket_id} = ?`,
      ...values
    );

    const nonStatusFields = Object.keys(fields).filter(k => k !== 'status');
    if (nonStatusFields.length > 0) {
      logTicketEvent(sql, {
        ticketId,
        agentId: actorId,
        eventType: 'fields_updated',
        newValue: nonStatusFields.join(','),
        metadata: { changed: nonStatusFields, actor: actorId },
      });
    }
  }

  const updated = getTicket(sql, ticketId);
  if (!updated) throw new Error(`Ticket ${ticketId} not found after update`);
  return updated;
}

export function closeTicket(sql: SqlStorage, ticketId: string, agentId: string): Ticket {
  return updateTicketStatus(sql, ticketId, 'closed', agentId);
}

/**
 * Delete a ticket (and its descendants). When `workstationId` is supplied, the ticket
 * must belong to that workstation — otherwise the function returns without deleting.
 * This protects mutation endpoints that have only verified ownership of a
 * workstation, not of the specific ticket being targeted.
 */
export function deleteTicket(sql: SqlStorage, ticketId: string, workstationId?: string): boolean {
  if (workstationId) {
    const row = TicketRecord.pick({ ticket_id: true, workstation_id: true })
      .array()
      .parse([
        ...query(
          sql,
          /* sql */ `SELECT ${tickets.ticket_id}, ${tickets.workstation_id} FROM ${tickets} WHERE ${tickets.ticket_id} = ?`,
          [ticketId]
        ),
      ]);
    if (row.length === 0 || row[0].workstation_id !== workstationId) return false;
  }

  // Recursively delete child tickets (e.g. TicketCase steps) before the parent
  const children = TicketRecord.pick({ ticket_id: true })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.parent_ticket_id} = ?`,
        [ticketId]
      ),
    ]);
  for (const { ticket_id } of children) {
    deleteTicket(sql, ticket_id);
  }

  query(
    sql,
    /* sql */ `
      UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_ticket_id} = NULL,
          ${agent_metadata.columns.status} = 'idle'
      WHERE ${agent_metadata.current_hook_ticket_id} = ?
    `,
    [ticketId]
  );

  query(
    sql,
    /* sql */ `DELETE FROM ${ticket_dependencies} WHERE ${ticket_dependencies.ticket_id} = ? OR ${ticket_dependencies.depends_on_ticket_id} = ?`,
    [ticketId, ticketId]
  );

  query(sql, /* sql */ `DELETE FROM ${ticket_events} WHERE ${ticket_events.ticket_id} = ?`, [ticketId]);

  query(sql, /* sql */ `DELETE FROM ${agent_metadata} WHERE ${agent_metadata.ticket_id} = ?`, [
    ticketId,
  ]);
  query(sql, /* sql */ `DELETE FROM ${review_metadata} WHERE ${review_metadata.ticket_id} = ?`, [
    ticketId,
  ]);
  query(
    sql,
    /* sql */ `DELETE FROM ${escalation_metadata} WHERE ${escalation_metadata.ticket_id} = ?`,
    [ticketId]
  );
  query(sql, /* sql */ `DELETE FROM ${shift_metadata} WHERE ${shift_metadata.ticket_id} = ?`, [
    ticketId,
  ]);

  // Remove any pending/processed reconciler events targeting this ticket or
  // this agent (agents are themselves tickets, so deleteTicket is used for both).
  // Without this, ticket_cancelled / container_status / … events that reference
  // a deleted ticket make applyEvent throw forever on every alarm tick.
  query(
    sql,
    /* sql */ `DELETE FROM ${department_events}
               WHERE ${department_events.ticket_id} = ? OR ${department_events.agent_id} = ?`,
    [ticketId, ticketId]
  );

  query(sql, /* sql */ `DELETE FROM ${tickets} WHERE ${tickets.ticket_id} = ?`, [ticketId]);
  return true;
}

/**
 * Delete many tickets (and their descendants). When `workstationId` is supplied, the
 * input `ticketIds` list is filtered in SQL to keep only tickets actually
 * belonging to that workstation — any others are silently skipped. This prevents
 * cross-workstation deletion when the caller has only authorized one workstation.
 */
export function deleteTickets(sql: SqlStorage, ticketIds: string[], workstationId?: string): number {
  if (ticketIds.length === 0) return 0;

  // Dynamic IN clauses use sql.exec directly — the type-safe query()
  // wrapper can't infer placeholder count from runtime-built strings.
  const ph = (ids: string[]) => ids.map(() => '?').join(',');

  let rootIds = ticketIds;
  if (workstationId) {
    const ownedRows = TicketRecord.pick({ ticket_id: true })
      .array()
      .parse([
        ...sql.exec(
          /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.workstation_id} = ? AND ${tickets.ticket_id} IN (${ph(ticketIds)})`,
          workstationId,
          ...ticketIds
        ),
      ]);
    rootIds = ownedRows.map(r => r.ticket_id);
    if (rootIds.length === 0) return 0;
  }

  const allIds = new Set(rootIds);

  const childRows = [
    ...sql.exec(
      /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.parent_ticket_id} IN (${ph(rootIds)})`,
      ...rootIds
    ),
  ];
  const childIds = TicketRecord.pick({ ticket_id: true })
    .array()
    .parse(childRows)
    .map(r => r.ticket_id);

  if (childIds.length > 0) {
    for (const childId of childIds) {
      allIds.add(childId);
    }
    const deeperIds = collectChildTicketIds(sql, childIds);
    for (const id of deeperIds) {
      allIds.add(id);
    }
  }

  const allIdsArr = [...allIds];
  const placeholders = ph(allIdsArr);

  sql.exec(
    /* sql */ `UPDATE ${agent_metadata}
      SET ${agent_metadata.columns.current_hook_ticket_id} = NULL,
          ${agent_metadata.columns.status} = 'idle'
      WHERE ${agent_metadata.current_hook_ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );

  sql.exec(
    /* sql */ `DELETE FROM ${ticket_dependencies} WHERE ${ticket_dependencies.ticket_id} IN (${placeholders}) OR ${ticket_dependencies.depends_on_ticket_id} IN (${placeholders})`,
    ...allIdsArr,
    ...allIdsArr
  );

  sql.exec(
    /* sql */ `DELETE FROM ${ticket_events} WHERE ${ticket_events.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );

  sql.exec(
    /* sql */ `DELETE FROM ${agent_metadata} WHERE ${agent_metadata.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );
  sql.exec(
    /* sql */ `DELETE FROM ${review_metadata} WHERE ${review_metadata.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );
  sql.exec(
    /* sql */ `DELETE FROM ${escalation_metadata} WHERE ${escalation_metadata.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );
  sql.exec(
    /* sql */ `DELETE FROM ${shift_metadata} WHERE ${shift_metadata.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );

  // Remove any reconciler events referencing these tickets/agents. See
  // deleteTicket above for rationale.
  sql.exec(
    /* sql */ `DELETE FROM ${department_events}
               WHERE ${department_events.ticket_id} IN (${placeholders})
                  OR ${department_events.agent_id} IN (${placeholders})`,
    ...allIdsArr,
    ...allIdsArr
  );

  sql.exec(
    /* sql */ `DELETE FROM ${tickets} WHERE ${tickets.ticket_id} IN (${placeholders})`,
    ...allIdsArr
  );

  return allIdsArr.length;
}

function collectChildTicketIds(sql: SqlStorage, parentIds: string[]): string[] {
  if (parentIds.length === 0) return [];
  const childRows = [
    ...sql.exec(
      /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${tickets.parent_ticket_id} IN (${parentIds.map(() => '?').join(',')})`,
      ...parentIds
    ),
  ];
  const childIds = TicketRecord.pick({ ticket_id: true })
    .array()
    .parse(childRows)
    .map(r => r.ticket_id);
  if (childIds.length === 0) return [];
  const deeperIds = collectChildTicketIds(sql, childIds);
  return [...childIds, ...deeperIds];
}

export function deleteTicketsByStatus(sql: SqlStorage, status: TicketStatus, type?: TicketType): number {
  const conditions: string[] = [`${tickets.status} = ?`];
  const values: unknown[] = [status];

  if (type) {
    conditions.push(`${tickets.type} = ?`);
    values.push(type);
  }

  const rows = [
    ...sql.exec(
      /* sql */ `SELECT ${tickets.ticket_id} FROM ${tickets} WHERE ${conditions.join(' AND ')}`,
      ...values
    ),
  ];
  const ticketIds = TicketRecord.pick({ ticket_id: true })
    .array()
    .parse(rows)
    .map(r => r.ticket_id);

  if (ticketIds.length === 0) return 0;
  return deleteTickets(sql, ticketIds);
}

export function logTicketEvent(
  sql: SqlStorage,
  params: {
    ticketId: string;
    agentId: string | null;
    eventType: TicketEventType;
    oldValue?: string | null;
    newValue?: string | null;
    metadata?: Record<string, unknown>;
  }
): void {
  query(
    sql,
    /* sql */ `
      INSERT INTO ${ticket_events} (
        ${ticket_events.columns.ticket_event_id},
        ${ticket_events.columns.ticket_id},
        ${ticket_events.columns.agent_id},
        ${ticket_events.columns.event_type},
        ${ticket_events.columns.old_value},
        ${ticket_events.columns.new_value},
        ${ticket_events.columns.metadata},
        ${ticket_events.columns.created_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      generateId(),
      params.ticketId,
      params.agentId,
      params.eventType,
      params.oldValue ?? null,
      params.newValue ?? null,
      JSON.stringify(params.metadata ?? {}),
      now(),
    ]
  );
}

export function listTicketEvents(
  sql: SqlStorage,
  options: {
    ticketId?: string;
    since?: string;
    limit?: number;
  }
): TicketEventRecord[] {
  const limit = options.limit ?? 100;
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${ticket_events}
        WHERE (? IS NULL OR ${ticket_events.ticket_id} = ?)
          AND (? IS NULL OR ${ticket_events.created_at} > ?)
        ORDER BY ${ticket_events.created_at} DESC
        LIMIT ?
      `,
      [
        options.ticketId ?? null,
        options.ticketId ?? null,
        options.since ?? null,
        options.since ?? null,
        limit,
      ]
    ),
  ];
  return TicketEventRecord.array().parse(rows);
}

/**
 * Return all dependency edges for a given ticket (both directions).
 * - blockers: tickets that block this ticket (this ticket depends_on them)
 * - blocked_by_this: tickets that this ticket blocks (they depend_on this ticket)
 * - tracks: shifts this ticket is tracked by
 */
export function getTicketDependencies(
  sql: SqlStorage,
  ticketId: string
): {
  blockers: Array<{ ticket_id: string; depends_on_ticket_id: string; dependency_type: string }>;
  dependents: Array<{ ticket_id: string; depends_on_ticket_id: string; dependency_type: string }>;
} {
  const DependencyRow = z.object({
    ticket_id: z.string(),
    depends_on_ticket_id: z.string(),
    dependency_type: z.string(),
  });

  // Forward: tickets this ticket depends on (its blockers / the shifts it tracks)
  const blockerRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.ticket_id}, ${ticket_dependencies.depends_on_ticket_id},
               ${ticket_dependencies.dependency_type}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.ticket_id} = ?
      `,
      [ticketId]
    ),
  ];

  // Reverse: tickets that depend on this ticket
  const dependentRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.ticket_id}, ${ticket_dependencies.depends_on_ticket_id},
               ${ticket_dependencies.dependency_type}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.depends_on_ticket_id} = ?
      `,
      [ticketId]
    ),
  ];

  return {
    blockers: DependencyRow.array().parse(blockerRows),
    dependents: DependencyRow.array().parse(dependentRows),
  };
}

/**
 * Return all 'blocks' dependency edges for tickets tracked by a shift.
 * Used to render the DAG in the shift UI.
 */
export function getShiftDependencyEdges(
  sql: SqlStorage,
  shiftId: string
): Array<{ ticket_id: string; depends_on_ticket_id: string }> {
  const EdgeRow = z.object({
    ticket_id: z.string(),
    depends_on_ticket_id: z.string(),
  });

  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT dep.${ticket_dependencies.columns.ticket_id},
               dep.${ticket_dependencies.columns.depends_on_ticket_id}
        FROM ${ticket_dependencies} AS dep
        WHERE dep.${ticket_dependencies.columns.dependency_type} = 'blocks'
          AND dep.${ticket_dependencies.columns.ticket_id} IN (
            SELECT tracked.${ticket_dependencies.columns.ticket_id}
            FROM ${ticket_dependencies} AS tracked
            WHERE tracked.${ticket_dependencies.columns.depends_on_ticket_id} = ?
              AND tracked.${ticket_dependencies.columns.dependency_type} = 'tracks'
          )
          AND dep.${ticket_dependencies.columns.depends_on_ticket_id} IN (
            SELECT tracked2.${ticket_dependencies.columns.ticket_id}
            FROM ${ticket_dependencies} AS tracked2
            WHERE tracked2.${ticket_dependencies.columns.depends_on_ticket_id} = ?
              AND tracked2.${ticket_dependencies.columns.dependency_type} = 'tracks'
          )
      `,
      [shiftId, shiftId]
    ),
  ];

  return EdgeRow.array().parse(rows);
}

/**
 * Find the shift a ticket belongs to (if any) via 'tracks' dependencies.
 * Returns the shift ticket_id or null.
 */
export function getShiftForTicket(sql: SqlStorage, ticketId: string): string | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${ticket_dependencies.depends_on_ticket_id}
        FROM ${ticket_dependencies}
        WHERE ${ticket_dependencies.ticket_id} = ?
          AND ${ticket_dependencies.dependency_type} = 'tracks'
      `,
      [ticketId]
    ),
  ];
  if (rows.length === 0) return null;
  return z.object({ depends_on_ticket_id: z.string() }).parse(rows[0]).depends_on_ticket_id;
}

/**
 * Get the merge_mode for a shift from shift_metadata.
 * Defaults to 'review-then-land' if not set.
 */
export function getShiftMergeMode(
  sql: SqlStorage,
  shiftId: string
): 'review-then-land' | 'review-and-merge' {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${shift_metadata.merge_mode}
        FROM ${shift_metadata}
        WHERE ${shift_metadata.ticket_id} = ?
      `,
      [shiftId]
    ),
  ];
  if (rows.length === 0) return 'review-then-land';
  const mode = z.object({ merge_mode: z.string().nullable() }).parse(rows[0]).merge_mode;
  if (mode === 'review-and-merge') return 'review-and-merge';
  return 'review-then-land';
}

/**
 * Get the feature_branch for a shift from shift_metadata.
 */
export function getShiftFeatureBranch(sql: SqlStorage, shiftId: string): string | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${shift_metadata.feature_branch}
        FROM ${shift_metadata}
        WHERE ${shift_metadata.ticket_id} = ?
      `,
      [shiftId]
    ),
  ];
  if (rows.length === 0) return null;
  return z.object({ feature_branch: z.string().nullable() }).parse(rows[0]).feature_branch;
}
