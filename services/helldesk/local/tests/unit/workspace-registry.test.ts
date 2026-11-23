import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openDb } from '../../src/db';
import {
  applyWorkspaceDedupe,
  canonicalWorkspacePath,
  findWorkspaceByPath,
  listWorkspaces,
  planWorkspaceDedupe,
  registerWorkspace,
} from '../../src/workspace-registry';

const sha16 = (input: string): string => createHash('sha256').update(input).digest('hex').slice(0, 16);

describe('workspace canonical identity', () => {
  test('canonicalizes Windows drive case, separators and trailing slashes', () => {
    const canonical = canonicalWorkspacePath('D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework');
    expect(canonical).toBe('d:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework');
    expect(canonicalWorkspacePath('d:/_SATIN_AI/NAI-OS/NAI_Game_Framework')).toBe(canonical);
    expect(canonicalWorkspacePath('D:/_SATIN_AI/NAI-OS/NAI_Game_Framework/')).toBe(canonical);
    expect(canonicalWorkspacePath('C:\\src\\kilo-gastown-local')).toBe('c:\\src\\kilo-gastown-local');
    expect(canonicalWorkspacePath('C:/src/kilo-gastown-local')).toBe('c:\\src\\kilo-gastown-local');
    expect(canonicalWorkspacePath('D:\\')).toBe('d:\\');
    // POSIX paths keep their case; only the drive letter is normalized.
    expect(canonicalWorkspacePath('/opt/Repo')).toBe('/opt/Repo');
  });

  test('re-registering a legacy spelling reuses the original row (no third identity)', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const legacyPath = 'D:\\_SATIN_AI\\NAI-OS\\NAI_Game_Framework';
      const legacyId = `ws_${sha16(legacyPath)}`;
      d.db
        .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?,?,?,?)`)
        .run(legacyId, legacyPath, 1, '2026-01-01T00:00:00.000Z');

      const registered = registerWorkspace(d, { path: 'd:/_SATIN_AI/NAI-OS/NAI_Game_Framework' });
      expect(registered.workspaceId).toBe(legacyId);
      expect(listWorkspaces(d)).toHaveLength(1);
      expect(findWorkspaceByPath(d, 'D:/_SATIN_AI/NAI-OS/NAI_Game_Framework')?.workspaceId).toBe(legacyId);
    } finally {
      d.close();
    }
  });

  test('creates a canonical id for a fresh path and reuses it for variants', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const first = registerWorkspace(d, { path: 'D:\\Repo_New' });
      expect(first.path).toBe('d:\\Repo_New');
      const again = registerWorkspace(d, { path: 'd:/Repo_New/' });
      expect(again.workspaceId).toBe(first.workspaceId);
      expect(listWorkspaces(d)).toHaveLength(1);
    } finally {
      d.close();
    }
  });

  test('admin dedupe rewrites references and removes the duplicate row', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const keep = registerWorkspace(d, { path: 'D:\\Repo_Dupe' });
      const legacyPath = 'D:/Repo_Dupe';
      const legacyId = `ws_${sha16(legacyPath)}`;
      d.db
        .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?,?,?,?)`)
        .run(legacyId, legacyPath, 1, '2026-02-01T00:00:00.000Z');
      d.db
        .query(`INSERT INTO autonomy_missions (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run('mis_dupe_a', keep.workspaceId, 'keep mission', 'ACTIVE', 'ender-1', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      d.db
        .query(`INSERT INTO autonomy_missions (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
        .run('mis_dupe_b', legacyId, 'legacy mission', 'ACTIVE', 'ender-1', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');

      const plan = planWorkspaceDedupe(d);
      expect(plan).toHaveLength(1);
      // The OLDEST enabled row wins so historical mission bindings are preserved.
      expect(plan[0]!.representative.workspaceId).toBe(legacyId);
      // An explicit keep wins (the live session workspace id must never change).
      const keptPlan = planWorkspaceDedupe(d, { keep: [keep.workspaceId] });
      expect(keptPlan[0]!.representative.workspaceId).toBe(keep.workspaceId);
      const result = applyWorkspaceDedupe(d);
      expect(result.removed).toBe(1);
      expect(result.leftover).toEqual([]);
      expect(listWorkspaces(d)).toHaveLength(1);
      const references = d.db
        .query<{ workspace_id: string }, []>(`SELECT workspace_id FROM autonomy_missions WHERE mission_id IN ('mis_dupe_a','mis_dupe_b')`)
        .all();
      expect(references.every((row) => row.workspace_id === legacyId)).toBe(true);
      expect(keep.workspaceId).not.toBe(legacyId);
    } finally {
      d.close();
    }
  });
});
