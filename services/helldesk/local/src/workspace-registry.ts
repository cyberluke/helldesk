import type { Db } from './db';
import { now } from './ids';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';

/** Flexible workspace registration input (defaults applied inside). */
export interface RegisterInput {
  path: string;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
}

/**
 * One repository, one workspace identity.
 *
 * Windows paths are case-insensitive for the drive and accept both `\` and `/`,
 * so `D:\_SATIN_AI\NAI-OS\NAI_Game_Framework`, `d:\_SATIN_AI\...` and
 * `D:/_SATIN_AI/...` all name the SAME git repo. Hashing the raw spelling used
 * to create two workspace rows (and therefore a duplicated Commits dropdown)
 * for one repository. Registration and lookup now share this canonical form.
 *
 * Only the drive letter is lowercased; the rest of the path is left untouched
 * because a POSIX path (or a case-sensitive Windows volume) may legitimately
 * distinguish case.
 */
export function canonicalWorkspacePath(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  const isWindows = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
  const normalized = isWindows ? win32.normalize(raw) : posix.normalize(raw);
  const withoutTrailing = normalized.length > 3 && /[\\/]$/.test(normalized)
    ? normalized.replace(/[\\/]+$/, '')
    : normalized;
  return /^[a-zA-Z]:/.test(withoutTrailing)
    ? withoutTrailing[0]!.toLowerCase() + withoutTrailing.slice(1)
    : withoutTrailing;
}

/** Local workspace registration + discovery. Git stays optional. */
export interface Workspace {
  workspaceId: string;
  path: string;
  enabled: boolean;
  createdAt: string;
}

export function registerWorkspace(d: Db, cfg: RegisterInput): Workspace {
  const canonical = canonicalWorkspacePath(cfg.path);
  const enabled = cfg.enabled !== false;
  // Deterministic id derived from the CANONICAL path so a slash/casing variant
  // re-registers the same workspace instead of creating a duplicate.
  const id = `ws_${sha256(canonical).slice(0, 16)}`;
  const existing = getWorkspace(d, id);
  if (existing) {
    d.db.query(`UPDATE workspaces SET enabled=? WHERE workspace_id=?`).run(enabled ? 1 : 0, id);
    return { ...existing, enabled };
  }
  // Legacy rows were hashed from the raw spelling. Reuse the first equivalent
  // row rather than creating a third identity for the same repository.
  const legacy = listWorkspaces(d).find((ws) => canonicalWorkspacePath(ws.path) === canonical);
  if (legacy) {
    d.db.query(`UPDATE workspaces SET enabled=? WHERE workspace_id=?`).run(enabled ? 1 : 0, legacy.workspaceId);
    return { ...legacy, enabled };
  }
  d.db
    .query(
      `INSERT INTO workspaces (workspace_id, path, enabled, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET path=excluded.path, enabled=excluded.enabled`
    )
    .run(id, canonical, enabled ? 1 : 0, now());
  return { workspaceId: id, path: canonical, enabled, createdAt: now() };
}

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
export interface WorkspaceDedupeGroup {
  canonicalPath: string;
  representative: Workspace;
  duplicates: Workspace[];
}

export interface WorkspaceDedupeResult {
  groups: WorkspaceDedupeGroup[];
  updated: Record<string, number>;
  removed: number;
  leftover: string[];
}

/** Dry-run: groups of workspace rows that name the SAME repository. */
export function planWorkspaceDedupe(d: Db, options?: { keep?: string[] }): WorkspaceDedupeGroup[] {
  const groups = new Map<string, Workspace[]>();
  for (const ws of listWorkspaces(d)) {
    const key = canonicalWorkspacePath(ws.path);
    const bucket = groups.get(key) ?? [];
    bucket.push(ws);
    groups.set(key, bucket);
  }
  const plan: WorkspaceDedupeGroup[] = [];
  const keep = new Set(options?.keep ?? []);
  for (const [canonicalPath, bucket] of groups) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => {
      // An explicit keep (e.g. the ACTIVE session workspace id) always wins, so
      // merging aliases never changes the workspace identity a live session uses.
      const aKeep = keep.has(a.workspaceId);
      const bKeep = keep.has(b.workspaceId);
      if (aKeep !== bKeep) return aKeep ? -1 : 1;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const [representative, ...duplicates] = sorted;
    plan.push({ canonicalPath, representative: representative!, duplicates });
  }
  return plan;
}

/**
 * One-time admin merge of duplicate workspace identities. Rewrites every
 * `workspace_id` reference to the representative row inside a transaction, then
 * deletes duplicates that have no remaining references. The caller must stop the
 * daemon and take a backup first (see scripts/dedupe-workspaces.ts).
 */
export function applyWorkspaceDedupe(d: Db, options?: { keep?: string[] }): WorkspaceDedupeResult {
  const groups = planWorkspaceDedupe(d, options);
  const updated: Record<string, number> = {};
  const leftover: string[] = [];
  let removed = 0;
  const tables = d.db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((row) => row.name)
    .filter((name) => name !== 'workspaces');
  const referencingTables = tables.filter((name) => {
    const columns = d.db
      .query<{ name: string }, []>(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)
      .all();
    return columns.some((column) => column.name === 'workspace_id');
  });
  d.tx((t) => {
    for (const group of groups) {
      for (const duplicate of group.duplicates) {
        for (const table of referencingTables) {
          const result = t
            .query(`UPDATE OR IGNORE "${table}" SET workspace_id=? WHERE workspace_id=?`)
            .run(group.representative.workspaceId, duplicate.workspaceId);
          if (result.changes > 0) updated[table] = (updated[table] ?? 0) + result.changes;
        }
        const remaining = referencingTables.reduce((sum, table) => {
          const row = t
            .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM "${table}" WHERE workspace_id=?`)
            .get(duplicate.workspaceId);
          return sum + (row?.n ?? 0);
        }, 0);
        if (remaining === 0) {
          t.query(`DELETE FROM workspaces WHERE workspace_id=?`).run(duplicate.workspaceId);
          removed += 1;
        } else {
          leftover.push(`${duplicate.workspaceId} still referenced by ${remaining} row(s)`);
        }
      }
    }
  });
  return { groups, updated, removed, leftover };
}

export function findWorkspaceByPath(d: Db, path: string): Workspace | null {
  const row = d.db
    .query<{ workspace_id: string; path: string; enabled: number; created_at: string }, [string]>(
      `SELECT workspace_id, path, enabled, created_at FROM workspaces WHERE path=?`
    )
    .get(path);
  if (row) {
    return { workspaceId: row.workspace_id, path: row.path, enabled: row.enabled === 1, createdAt: row.created_at };
  }
  // Legacy exact-spelling lookup → canonical fallback (`D:\Repo` vs `d:/Repo`).
  const canonical = canonicalWorkspacePath(path);
  return listWorkspaces(d).find((ws) => canonicalWorkspacePath(ws.path) === canonical) ?? null;
}