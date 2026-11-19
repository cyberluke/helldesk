/**
 * Department event recording and draining for the reconciler.
 *
 * Events are facts recorded by RPC handlers. The reconciler drains them
 * on each alarm tick and applies state transitions. See reconciliation-spec.md §3.
 */

import { z } from 'zod';
import {
  department_events,
  DepartmentEventRecord,
  createTableDepartmentEvents,
  getIndexesDepartmentEvents,
} from '../../db/tables/department-events.table';
import type { DepartmentEventType } from '../../db/tables/department-events.table';
import { query } from '../../util/query.util';
import { generateId, now } from '../../util/id.util';

/** Create the department_events table and indexes. Idempotent. */
export function initDepartmentEventsTable(sql: SqlStorage): void {
  query(sql, createTableDepartmentEvents(), []);
  for (const idx of getIndexesDepartmentEvents()) {
    query(sql, idx, []);
  }
}

/**
 * Insert a new event into the department_events table.
 * Events start with processed_at = NULL and are consumed by drainEvents().
 */
export function insertEvent(
  sql: SqlStorage,
  eventType: DepartmentEventType,
  params: {
    agent_id?: string | null;
    ticket_id?: string | null;
    payload?: Record<string, unknown>;
  } = {}
): string {
  const eventId = generateId();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${department_events} (
        ${department_events.columns.event_id},
        ${department_events.columns.event_type},
        ${department_events.columns.agent_id},
        ${department_events.columns.ticket_id},
        ${department_events.columns.payload},
        ${department_events.columns.created_at},
        ${department_events.columns.processed_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      eventId,
      eventType,
      params.agent_id ?? null,
      params.ticket_id ?? null,
      JSON.stringify(params.payload ?? {}),
      now(),
      null,
    ]
  );
  return eventId;
}

/**
 * Upsert a container_status event for an agent. Instead of inserting a new
 * event every tick (which floods the table at 5s intervals × N agents),
 * this reuses an existing unprocessed container_status event for the same
 * agent if the status hasn't changed — just bumping the timestamp. A fresh
 * event is only inserted when the status actually changes or no prior
 * unprocessed event exists.
 */
export function upsertContainerStatus(
  sql: SqlStorage,
  agentId: string,
  payload: { status: string; exit_reason?: string | null }
): void {
  // Check for an existing unprocessed container_status event for this agent
  const existing = z
    .object({ event_id: z.string(), payload: z.string() })
    .array()
    .parse([
      ...query(
        sql,
        /* sql */ `
          SELECT ${department_events.columns.event_id} as event_id,
                 ${department_events.columns.payload} as payload
          FROM ${department_events}
          WHERE ${department_events.columns.event_type} = 'container_status'
            AND ${department_events.columns.agent_id} = ?
            AND ${department_events.columns.processed_at} IS NULL
          ORDER BY ${department_events.columns.created_at} DESC
          LIMIT 1
        `,
        [agentId]
      ),
    ]);

  if (existing.length > 0) {
    let prevPayload: Record<string, unknown> = {};
    try {
      prevPayload = JSON.parse(existing[0].payload) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    if (prevPayload.status === payload.status) {
      // Same status — just bump the timestamp, don't create a new event
      query(
        sql,
        /* sql */ `
          UPDATE ${department_events}
          SET ${department_events.columns.created_at} = ?
          WHERE ${department_events.columns.event_id} = ?
        `,
        [now(), existing[0].event_id]
      );
      return;
    }
  }

  // Status changed or no prior event — insert a new one
  insertEvent(sql, 'container_status', {
    agent_id: agentId,
    payload: {
      status: payload.status,
      ...(payload.exit_reason ? { exit_reason: payload.exit_reason } : {}),
    },
  });
}

/**
 * Drain all unprocessed events, ordered by creation time.
 * Returns events with processed_at = NULL, oldest first.
 */
export function drainEvents(sql: SqlStorage): DepartmentEventRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT ${department_events.event_id}, ${department_events.event_type},
               ${department_events.agent_id}, ${department_events.ticket_id},
               ${department_events.payload}, ${department_events.created_at},
               ${department_events.processed_at}
        FROM ${department_events}
        WHERE ${department_events.processed_at} IS NULL
        ORDER BY ${department_events.created_at} ASC
      `,
      []
    ),
  ];
  return DepartmentEventRecord.array().parse(rows);
}

/** Mark an event as processed so it won't be returned by drainEvents again. */
export function markProcessed(sql: SqlStorage, eventId: string): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${department_events}
      SET ${department_events.columns.processed_at} = ?
      WHERE ${department_events.event_id} = ?
    `,
    [now(), eventId]
  );
}

/**
 * Delete old processed events beyond the retention window.
 * Only deletes events that have been processed (processed_at IS NOT NULL)
 * and whose created_at is older than the cutoff.
 */
export function pruneOldEvents(sql: SqlStorage, retentionMs: number): number {
  const cutoff = new Date(Date.now() - retentionMs).toISOString();
  const deleted = [
    ...query(
      sql,
      /* sql */ `
        DELETE FROM ${department_events}
        WHERE ${department_events.processed_at} IS NOT NULL
          AND ${department_events.created_at} < ?
        RETURNING ${department_events.event_id}
      `,
      [cutoff]
    ),
  ];
  return deleted.length;
}

/** Count unprocessed events (useful for metrics). */
export function pendingEventCount(sql: SqlStorage): number {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT count(*) as cnt FROM ${department_events}
        WHERE ${department_events.processed_at} IS NULL
      `,
      []
    ),
  ];
  const row = rows[0];
  return typeof row?.cnt === 'number' ? row.cnt : 0;
}
