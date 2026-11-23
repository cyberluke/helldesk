import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb } from '../../src/db';
import { canonicalWorkspacePath, registerWorkspace } from '../../src/workspace-registry';
import {
  GitError,
  getCommitDetail,
  getCommitFileDiff,
  listCommitWorkspaces,
  listCommits,
} from '../../src/git-commits';

// `.local/` is the repo's ignored scratch root (never OS tmp).
const SCRATCH = resolve(import.meta.dir, '../../.local');

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const repo = join(SCRATCH, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Git Test']);
  return repo;
}

function commit(repo: string, message: string): void {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
}

describe('git commit observability', () => {
  test('lists commits, details and per-file diffs from a real repository', () => {
    const repo = initRepo('git-commits');
    try {
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'first commit');
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      writeFileSync(join(repo, 'b.txt'), 'new file\n');
      commit(repo, 'second commit\n\nWith a body that matters.');

      const commits = listCommits(repo, 10);
      expect(commits).toHaveLength(2);
      expect(commits[0]!.subject).toBe('second commit');
      expect(commits[0]!.body).toContain('With a body that matters.');
      expect(commits[0]!.authorName).toBe('Git Test');
      expect(commits[1]!.subject).toBe('first commit');

      const detail = getCommitDetail(repo, commits[0]!.sha);
      expect(detail.message).toContain('With a body that matters.');
      expect(detail.stats).toEqual({ files: 2, additions: 2, deletions: 1 });
      expect(detail.files.map(file => file.path)).toEqual(['a.txt', 'b.txt']);
      expect(detail.files.find(file => file.path === 'a.txt')).toMatchObject({
        status: 'M',
        additions: 1,
        deletions: 1,
        binary: false,
      });
      expect(detail.files.find(file => file.path === 'b.txt')).toMatchObject({
        status: 'A',
        additions: 1,
        deletions: 0,
        binary: false,
      });

      const diff = getCommitFileDiff(repo, commits[0]!.sha, 'a.txt');
      expect(diff.patch).toContain('-one');
      expect(diff.patch).toContain('+two');
      expect(diff.binary).toBe(false);
      expect(diff.truncated).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test('reports registered git workspaces and keeps unregistered paths out', () => {
    const repo = initRepo('git-ws');
    const d = openDb(':memory:');
    d.runMigration();
    try {
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'first commit');
      const ws = registerWorkspace(d, { path: repo });

      const workspaces = listCommitWorkspaces(d);
      const entry = workspaces.find(item => item.workspaceId === ws.workspaceId);
      expect(entry).toMatchObject({
        isGit: true,
        dirty: false,
        lastCommitSubject: 'first commit',
        error: null,
      });
      expect(entry?.head).toBeTruthy();
      expect(entry?.branch).toBeTruthy();

      const commits = listCommits(repo, 5);
      expect(() => getCommitDetail(repo, 'not-a-sha')).toThrow(GitError);
      expect(() => getCommitFileDiff(repo, commits[0]!.sha, '../a.txt')).toThrow(GitError);
    } finally {
      d.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test('lists one entry per repository even with two legacy workspace spellings', () => {
    const repo = initRepo('git-ws-dupe');
    const d = openDb(':memory:');
    d.runMigration();
    try {
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      commit(repo, 'first commit');
      // New registration stores the canonical identity.
      const canonical = registerWorkspace(d, { path: repo });
      // Simulate a legacy row registered before canonicalization: same repo,
      // lowercased drive + forward slashes → a different raw-spelling hash.
      const alternate = repo.replace(/\\/g, '/').replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
      expect(alternate).not.toBe(repo);
      const legacyId = `ws_${createHash('sha256').update(alternate).digest('hex').slice(0, 16)}`;
      d.db
        .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?,?,?,?)`)
        .run(legacyId, alternate, 1, '2026-01-01T00:00:00.000Z');

      const key = canonicalWorkspacePath(repo);
      const entries = listCommitWorkspaces(d).filter(item => canonicalWorkspacePath(item.path) === key);
      expect(entries).toHaveLength(1);
      // The older enabled row is the representative; both point at the same repo.
      expect(entries[0]!.workspaceId).toBe(legacyId);
      expect(entries[0]!.lastCommitSubject).toBe('first commit');
      expect(canonical.workspaceId).not.toBe(legacyId);
    } finally {
      d.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 15_000);
});
