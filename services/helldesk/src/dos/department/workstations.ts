/**
 * Workstation registry for the Department DO.
 * Workstations are now SQL rows in the Department DO instead of KV entries.
 */

import { z } from 'zod';
import { query } from '../../util/query.util';
import { type WorkstationOverrideConfig, WorkstationOverrideConfigSchema } from '../../types';

const WORKSTATION_TABLE_CREATE = /* sql */ `
  CREATE TABLE IF NOT EXISTS "workstations" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "git_url" TEXT NOT NULL DEFAULT '',
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "config" TEXT DEFAULT '{}',
    "created_at" TEXT NOT NULL
  )
`;

const WORKSTATION_INDEX = /* sql */ `CREATE UNIQUE INDEX IF NOT EXISTS idx_workstations_name ON workstations(name)`;

export const WorkstationRecord = z.object({
  id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  config: z
    .string()
    .transform((v): unknown => {
      try {
        return JSON.parse(v) as unknown;
      } catch {
        return {};
      }
    })
    .pipe(WorkstationOverrideConfigSchema),
  created_at: z.string(),
});

export type WorkstationRecord = z.output<typeof WorkstationRecord>;

export function initWorkstationTables(sql: SqlStorage): void {
  query(sql, WORKSTATION_TABLE_CREATE, []);
  query(sql, WORKSTATION_INDEX, []);
}

export function addWorkstation(
  sql: SqlStorage,
  input: {
    workstationId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }
): WorkstationRecord {
  const timestamp = new Date().toISOString();
  try {
    query(
      sql,
      /* sql */ `
        INSERT INTO workstations (id, name, git_url, default_branch, config, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          git_url = excluded.git_url,
          default_branch = excluded.default_branch
      `,
      [input.workstationId, input.name, input.gitUrl, input.defaultBranch, '{}', timestamp]
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: workstations.name')) {
      // A workstation with this name already exists under a different ID.
      // Clean up the stale entry only if it's truly orphaned (has no
      // open or in-progress tickets). Otherwise surface the conflict.
      const staleWorkstation = query(sql, /* sql */ `SELECT id FROM workstations WHERE name = ? AND id != ?`, [
        input.name,
        input.workstationId,
      ]);
      const staleId = [...staleWorkstation][0]?.id as string | undefined;
      if (staleId) {
        const activeTickets = query(
          sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM tickets WHERE workstation_id = ? AND status IN ('open', 'in_progress')`,
          [staleId]
        );
        const count = Number([...activeTickets][0]?.cnt ?? 0);
        if (count > 0) {
          throw new Error(
            `A workstation named "${input.name}" already exists (id=${staleId}) with ${count} active ticket(s). ` +
              `Delete it first before creating a new workstation with the same name.`
          );
        }
        // Truly orphaned — safe to remove
        query(sql, /* sql */ `DELETE FROM workstations WHERE id = ?`, [staleId]);
      }
      query(
        sql,
        /* sql */ `
          INSERT INTO workstations (id, name, git_url, default_branch, config, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            git_url = excluded.git_url,
            default_branch = excluded.default_branch
        `,
        [input.workstationId, input.name, input.gitUrl, input.defaultBranch, '{}', timestamp]
      );
    } else {
      throw err;
    }
  }

  const workstation = getWorkstation(sql, input.workstationId);
  if (!workstation) throw new Error('Failed to create workstation');
  return workstation;
}

export function getWorkstation(sql: SqlStorage, workstationId: string): WorkstationRecord | null {
  const rows = [...query(sql, /* sql */ `SELECT * FROM workstations WHERE id = ?`, [workstationId])];
  if (rows.length === 0) return null;
  return WorkstationRecord.parse(rows[0]);
}

export function listWorkstations(sql: SqlStorage): WorkstationRecord[] {
  const rows = [...query(sql, /* sql */ `SELECT * FROM workstations ORDER BY created_at ASC`, [])];
  return WorkstationRecord.array().parse(rows);
}

export function removeWorkstation(sql: SqlStorage, workstationId: string): void {
  query(sql, /* sql */ `DELETE FROM workstations WHERE id = ?`, [workstationId]);
}

export function updateWorkstationConfig(sql: SqlStorage, workstationId: string, config: WorkstationOverrideConfig): void {
  const existing = getWorkstation(sql, workstationId);
  const merged = WorkstationOverrideConfigSchema.parse({ ...(existing?.config ?? {}), ...config });
  query(sql, /* sql */ `UPDATE workstations SET config = ? WHERE id = ?`, [JSON.stringify(merged), workstationId]);
}
