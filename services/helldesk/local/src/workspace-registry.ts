import type { Db } from './db';
import { now } from './ids';

/** Flexible workspace registration input (defaults applied inside). */
export interface RegisterInput {
  path: string;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
}

/** Local workspace registration + discovery. Git stays optional. */
export interface Workspace {
  workspaceId: string;
  path: string;
  enabled: boolean;
  createdAt: string;
}

export function registerWorkspace(d: Db, cfg: RegisterInput): Workspace {
  // Deterministic id derived from the path so re-registration is a no-op.
  const id = `ws_${sha256(cfg.path).slice(0, 16)}`;
  d.db
    .query(
      `INSERT INTO workspaces (workspace_id, path, enabled, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET path=excluded.path, enabled=excluded.enabled`
    )
    .run(id, cfg.path, cfg.enabled === false ? 0 : 1, now());
  return { workspaceId: id, path: cfg.path, enabled: cfg.enabled !== false, createdAt: now() };
}

import { createHash } from 'node:crypto';
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function getWorkspace(d: Db, workspaceId: string): Workspace | null {
  const row = d.db
    .query<{ workspace_id: string; path: string; enabled: number; created_at: string }, [string]>(
      `SELECT workspace_id, path, enabled, created_at FROM workspaces WHERE workspace_id=?`
    )
    .get(workspaceId);
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    path: row.path,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function listWorkspaces(d: Db): Workspace[] {
  return d.db
    .query<{ workspace_id: string; path: string; enabled: number; created_at: string }, []>(
      `SELECT workspace_id, path, enabled, created_at FROM workspaces ORDER BY created_at DESC`
    )
    .all()
    .map((r) => ({
      workspaceId: r.workspace_id,
      path: r.path,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
    }));
}

/** Discover a workspaceId for a config path (register on-demand via API). */
export function findWorkspaceByPath(d: Db, path: string): Workspace | null {
  const row = d.db
    .query<{ workspace_id: string; path: string; enabled: number; created_at: string }, [string]>(
      `SELECT workspace_id, path, enabled, created_at FROM workspaces WHERE path=?`
    )
    .get(path);
  return row
    ? { workspaceId: row.workspace_id, path: row.path, enabled: row.enabled === 1, createdAt: row.created_at }
    : null;
}