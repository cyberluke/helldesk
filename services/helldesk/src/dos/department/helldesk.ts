/**
 * HELLDESK connection state for the Department DO.
 *
 * Tracks the department's connection to a single helldesk commons, storing the
 * helldesk ID, upstream path, workstation handle, and DoltHub org. This data is
 * used by the frontDesk to auto-discover the connected helldesk and by the
 * reconciler to flow completions back to the helldesk.
 */

import { z } from 'zod';
import { query } from '../../util/query.util';
import { tickets } from '../../db/tables/tickets.table';

// ---------------------------------------------------------------------------
// Table DDL
// ---------------------------------------------------------------------------

const TABLE_CREATE = /* sql */ `
  CREATE TABLE IF NOT EXISTS "department_helldesk_connections" (
    "connection_id" TEXT PRIMARY KEY,
    "helldesk_id" TEXT NOT NULL,
    "upstream" TEXT NOT NULL,
    "workstation_handle" TEXT NOT NULL,
    "dolthub_org" TEXT NOT NULL,
    "connected_at" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disconnecting'))
  )
`;

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

export const HelldeskConnectionRecord = z.object({
  connection_id: z.string(),
  helldesk_id: z.string(),
  upstream: z.string(),
  workstation_handle: z.string(),
  dolthub_org: z.string(),
  connected_at: z.string(),
  status: z.enum(['active', 'disconnecting']),
});

export type HelldeskConnectionRecord = z.output<typeof HelldeskConnectionRecord>;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initHelldeskTables(sql: SqlStorage): void {
  query(sql, TABLE_CREATE, []);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function connectHELLDESK(
  sql: SqlStorage,
  input: {
    connectionId: string;
    helldeskId: string;
    upstream: string;
    workstationHandle: string;
    dolthubOrg: string;
  }
): HelldeskConnectionRecord {
  const now = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT INTO department_helldesk_connections
        (connection_id, helldesk_id, upstream, workstation_handle, dolthub_org, connected_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(connection_id) DO UPDATE SET
        helldesk_id = excluded.helldesk_id,
        upstream = excluded.upstream,
        workstation_handle = excluded.workstation_handle,
        dolthub_org = excluded.dolthub_org,
        status = 'active'
    `,
    [input.connectionId, input.helldeskId, input.upstream, input.workstationHandle, input.dolthubOrg, now]
  );

  return {
    connection_id: input.connectionId,
    helldesk_id: input.helldeskId,
    upstream: input.upstream,
    workstation_handle: input.workstationHandle,
    dolthub_org: input.dolthubOrg,
    connected_at: now,
    status: 'active',
  };
}

export function disconnectHELLDESK(sql: SqlStorage, helldeskId: string): void {
  query(sql, /* sql */ `DELETE FROM department_helldesk_connections WHERE helldesk_id = ?`, [
    helldeskId,
  ]);
}

/**
 * Stamp `metadata.helldesk.reported_done_at` (and optionally
 * `metadata.helldesk.reported_evidence`) onto a ticket. Used by the
 * auto-done reporter to persist the idempotency flag once the upstream
 * `markWantedItemDone` call succeeds.
 *
 * Returns `false` (and writes nothing) when the target ticket doesn't
 * carry a `metadata.helldesk` object — SQLite's `json_set` won't
 * create intermediate objects, so a silent no-op would let the
 * reconciler retry indefinitely. Returns `true` on a successful stamp.
 */
export function stampHelldeskReportedDone(
  sql: SqlStorage,
  ticketId: string,
  input: { evidence?: string }
): boolean {
  // Refuse to stamp when there is no helldesk tag to merge into. Without
  // this guard, a malformed canonical-ticket pick would silently no-op and
  // the reconciler would re-fire the upstream RPC every tick.
  const probeRows = [
    ...query(
      sql,
      /* sql */ `
        SELECT json_extract(${tickets.metadata}, '$.helldesk') AS wl
        FROM ${tickets}
        WHERE ${tickets.ticket_id} = ?
      `,
      [ticketId]
    ),
  ];
  const probe = probeRows[0]?.wl;
  if (probe === null || probe === undefined) return false;

  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      UPDATE ${tickets}
      SET ${tickets.columns.metadata} = json_set(
            COALESCE(${tickets.metadata}, '{}'),
            '$.helldesk.reported_done_at', ?,
            '$.helldesk.reported_evidence', ?
          ),
          ${tickets.columns.updated_at} = ?
      WHERE ${tickets.ticket_id} = ?
    `,
    [timestamp, input.evidence ?? null, timestamp, ticketId]
  );
  return true;
}

/**
 * Returns the active helldesk connection for this department, or null if none.
 * For the POC we only support a single connection; this returns the first
 * active one found.
 */
export function getHelldeskConnection(sql: SqlStorage): HelldeskConnectionRecord | null {
  const rows = query(
    sql,
    /* sql */ `
      SELECT connection_id, helldesk_id, upstream, workstation_handle, dolthub_org, connected_at, status
      FROM department_helldesk_connections
      WHERE status = 'active'
      LIMIT 1
    `,
    []
  );

  const parsed = HelldeskConnectionRecord.array().parse([...rows]);
  return parsed[0] ?? null;
}
