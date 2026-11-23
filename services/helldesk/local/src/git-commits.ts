/**
 * git-commits.ts — read-only git history for the operator console.
 *
 * HELLDESK missions write real commits into their workspace. The operator must
 * be able to see WHAT was committed, by whom, and the full per-file diff —
 * without opening an IDE or trusting a summary. This module is the only place
 * that shells out to git; every argument is passed as an argv array (never a
 * shell string), the workspace comes from the registered workspace table (never
 * a client path), and commit ids / file paths are validated before git sees them.
 *
 * Read-only: log/show/diff/rev-parse/status only. No checkout, reset, fetch,
 * commit, or working-tree writes.
 */
import { execFileSync } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import type { Db } from './db';
import { canonicalWorkspacePath, getWorkspace, listWorkspaces, type Workspace } from './workspace-registry';

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 12 * 1024 * 1024;
const MAX_COMMIT_LIMIT = 200;
const MAX_DETAIL_FILES = 400;
const MAX_PATCH_CHARS = 1_000_000;
const FIELD = '\x1f';
const RECORD = '\x1e';

export class GitError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'GitError';
  }
}

function runGit(cwd: string, args: string[], maxBuffer = GIT_MAX_BUFFER, timeoutMs = GIT_TIMEOUT_MS): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error as { code?: string; stderr?: Buffer | string; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString('utf8') ?? '';
    if (err.code === 'ENOENT') throw new GitError('git is not installed or not on PATH');
    if (err.code === 'ETIMEDOUT') throw new GitError('git command timed out');
    const detail = stderr.trim() || err.message || 'git command failed';
    throw new GitError(detail.split('\n')[0] ?? 'git command failed', detail);
  }
}

function assertGitRepo(path: string): void {
  // Registered workspace paths are absolute. Reject anything else so a path can
  // never be mistaken for a git option (e.g. a leading dash).
  if (!isAbsolute(path)) throw new GitError('workspace path must be absolute');
  if (!existsSync(path)) throw new GitError('workspace path does not exist');
  const inside = runGit(path, ['rev-parse', '--is-inside-work-tree']).trim();
  if (inside !== 'true') throw new GitError('workspace is not a git working tree');
}

export function isCommitId(value: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(value);
}

/** Resolve a short/full commit id to a verified full commit, or reject. */
export function resolveCommit(path: string, sha: string): string {
  if (!isCommitId(sha)) throw new GitError('invalid commit id');
  const full = runGit(path, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new GitError('commit not found');
  return full;
}

function safeGitPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new GitError('invalid file path');
  }
  if (normalized.split('/').some(segment => segment === '..')) {
    throw new GitError('invalid file path');
  }
  return normalized;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  parents: string[];
  refs: string[];
  subject: string;
  body: string;
}

export interface CommitWorkspace {
  workspaceId: string;
  path: string;
  name: string;
  enabled: boolean;
  isGit: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean | null;
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  error: string | null;
  /** Workspace used by an active (not yet verified/cancelled) mission. */
  activeMissionId: string | null;
  activeMissionState: string | null;
  /** Scratch/test checkout (`.local/`, git-ws-*, temp) — hidden by default in the console. */
  scratch: boolean;
}

export interface CommitFile {
  path: string;
  oldPath: string | null;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetail extends CommitSummary {
  message: string;
  stats: { files: number; additions: number; deletions: number };
  files: CommitFile[];
  truncated: boolean;
}

export interface CommitFileDiff {
  sha: string;
  path: string;
  oldPath: string | null;
  status: CommitFile['status'];
  binary: boolean;
  patch: string;
  truncated: boolean;
}

/**
 * Scratch/test repositories are real git repos, but they are not operator
 * projects. Hide them from the default Commits selector (the UI can opt in).
 */
function isScratchPath(input: string): boolean {
  const path = input.replace(/\\/g, '/').toLowerCase();
  return (
    path.includes('/.local/') ||
    path.includes('/appdata/local/temp/') ||
    /\/gt-git-|\/git-ws-|\/chat-scratch-|\/smoke-/.test(path)
  );
}

function parseCommitFields(fields: string[]): CommitSummary | null {
  if (fields.length < 12) return null;
  const [
    sha, shortSha, authorName, authorEmail, authoredAt, committerName, committerEmail,
    committedAt, parents, refs, subject, ...bodyParts
  ] = fields;
  if (!sha || !shortSha) return null;
  return {
    sha,
    shortSha,
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authoredAt: authoredAt ?? '',
    committerName: committerName ?? '',
    committerEmail: committerEmail ?? '',
    committedAt: committedAt ?? '',
    parents: (parents ?? '').split(' ').filter(Boolean),
    refs: (refs ?? '').split(',').map(r => r.trim()).filter(Boolean),
    subject: subject ?? '',
    body: bodyParts.join(FIELD).trim(),
  };
}

function commitFormatArgs(limit: number): string[] {
  return [
    'log',
    `-n${limit}`,
    '--no-color',
    '--date=iso-strict',
    `--format=${RECORD}%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cn${FIELD}%ce${FIELD}%cI${FIELD}%P${FIELD}%D${FIELD}%s${FIELD}%b`,
  ];
}

export function listCommits(path: string, limit = 80): CommitSummary[] {
  assertGitRepo(path);
  const clamped = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_COMMIT_LIMIT);
  const raw = runGit(path, commitFormatArgs(clamped));
  return raw
    .split(RECORD)
    .slice(1)
    .map(record => parseCommitFields(record.split(FIELD)))
    .filter((commit): commit is CommitSummary => commit !== null);
}

function gitDateAndSubject(path: string): { at: string | null; subject: string | null } {
  try {
    const raw = runGit(path, ['log', '-1', '--no-color', `--format=%aI${FIELD}%s`]).trim();
    const [at, subject] = raw.split(FIELD);
    return { at: at ?? null, subject: subject ?? null };
  } catch {
    return { at: null, subject: null };
  }
}

const workspaceCache = new WeakMap<Db, { at: number; rows: CommitWorkspace[] }>();
const WORKSPACE_CACHE_MS = 10_000;

export function listCommitWorkspaces(d: Db): CommitWorkspace[] {
  const cached = workspaceCache.get(d);
  const now = Date.now();
  if (cached && now - cached.at <= WORKSPACE_CACHE_MS) return cached.rows;

  const activeMissions = new Map<string, { missionId: string; state: string }>();
  try {
    for (const row of d.db
      .query<{ mission_id: string; workspace_id: string; state: string }, []>(
        `SELECT mission_id, workspace_id, state FROM autonomy_missions
          WHERE state NOT IN ('VERIFIED_10_10','CANCELLED')
          ORDER BY updated_at DESC`
      )
      .all()) {
      if (!activeMissions.has(row.workspace_id)) {
        activeMissions.set(row.workspace_id, { missionId: row.mission_id, state: row.state });
      }
    }
  } catch { /* older DB before missions exist — no grouping */ }

  const rows = representativeWorkspaces(listWorkspaces(d))
    .map((ws: Workspace): CommitWorkspace => {
      const active = activeMissions.get(ws.workspaceId);
      const base = {
        workspaceId: ws.workspaceId,
        path: ws.path,
        name: basename(ws.path) || ws.path,
        enabled: ws.enabled,
        activeMissionId: active?.missionId ?? null,
        activeMissionState: active?.state ?? null,
        scratch: isScratchPath(ws.path),
      };
      try {
        assertGitRepo(ws.path);
        // An initialized repo with no commits is still a git workspace; report
        // it honestly instead of marking it "not a repo".
        let head: string | null = null;
        let branch: string | null = null;
        try {
          head = runGit(ws.path, ['rev-parse', '--short', 'HEAD']).trim() || null;
          branch = runGit(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null;
        } catch {
          // no commits yet
        }
        // `--no-optional-locks` avoids index refresh waits while a mutation agent
        // is running git; a short timeout keeps the console responsive. `null`
        // means "unknown", never "clean".
        let dirty: boolean | null = null;
        try {
          dirty =
            runGit(
              ws.path,
              ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
              GIT_MAX_BUFFER,
              3_000,
            ).trim().length > 0;
        } catch {
          dirty = null;
        }
        const last = gitDateAndSubject(ws.path);
        return {
          ...base,
          isGit: true,
          branch,
          head,
          dirty,
          lastCommitAt: last.at,
          lastCommitSubject: last.subject,
          error: null,
        };
      } catch (error) {
        return {
          ...base,
          isGit: false,
          branch: null,
          head: null,
          dirty: null,
          lastCommitAt: null,
          lastCommitSubject: null,
          error: error instanceof Error ? error.message : 'not a git repository',
        };
      }
    })
    // The commits console only consumes git workspaces. Returning dozens of
    // registered non-git fixtures made the selector noisy and wasted git calls.
    .filter((workspace: CommitWorkspace) => workspace.isGit)
    .sort((a, b) => (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? ''));

  workspaceCache.set(d, { at: now, rows });
  return rows;
}

/**
 * One entry per repository in the operator dropdown. Legacy databases may hold
 * two workspace rows for the same folder (`D:\Repo` and `d:/Repo` were hashed
 * as different identities). Keep the ENABLED, OLDEST row so links and mission
 * bindings keep pointing at the original registration.
 */
function representativeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const picked = new Map<string, Workspace>();
  for (const ws of workspaces) {
    const key = canonicalWorkspacePath(ws.path);
    const prev = picked.get(key);
    if (!prev) {
      picked.set(key, ws);
      continue;
    }
    const better = (!prev.enabled && ws.enabled)
      || (prev.enabled === ws.enabled && ws.createdAt < prev.createdAt);
    if (better) picked.set(key, ws);
  }
  return [...picked.values()];
}

function parseNameStatus(raw: string): Map<string, { status: CommitFile['status']; oldPath: string | null }> {
  const result = new Map<string, { status: CommitFile['status']; oldPath: string | null }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = (parts[0] ?? '').charAt(0) as CommitFile['status'];
    if (!code) continue;
    if ((code === 'R' || code === 'C') && parts.length >= 3) {
      result.set(parts[2]!, { status: code, oldPath: parts[1]! });
    } else if (parts[1]) {
      result.set(parts[1], { status: code, oldPath: null });
    }
  }
  return result;
}

function parseNumstatZ(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const result = new Map<string, { additions: number | null; deletions: number | null }>();
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const parts = token.split('\t');
    const additions = parts[0] === '-' ? null : Number(parts[0]);
    const deletions = parts[1] === '-' ? null : Number(parts[1]);
    const inlinePath = parts[2];
    if (inlinePath) {
      result.set(inlinePath, { additions, deletions });
      continue;
    }
    // Rename/copy records: add\tdel\t\0old\0new\0
    const oldPath = tokens[++i];
    const newPath = tokens[++i];
    if (newPath) result.set(newPath, { additions, deletions });
    if (oldPath && !newPath) result.set(oldPath, { additions, deletions });
  }
  return result;
}

function firstParent(path: string, sha: string): string | null {
  const raw = runGit(path, ['rev-list', '--parents', '-n', '1', sha]).trim();
  const parts = raw.split(' ');
  return parts.length > 1 ? parts[1]! : null;
}

export function getCommitDetail(path: string, sha: string): CommitDetail {
  assertGitRepo(path);
  const full = resolveCommit(path, sha);
  const summary = parseCommitFields(
    runGit(path, ['show', '-s', '--no-color', `--format=%H${FIELD}%h${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%cn${FIELD}%ce${FIELD}%cI${FIELD}%P${FIELD}%D${FIELD}%s${FIELD}%b`, full]).split(FIELD),
  );
  if (!summary) throw new GitError('commit metadata unavailable');

  const parent = firstParent(path, full);
  const diffArgs = parent
    ? ['diff', '--no-color', '--name-status', '-M', parent, full]
    : ['show', '--no-color', '--format=', '--name-status', '-M', full];
  const numstatArgs = parent
    ? ['diff', '--no-color', '--numstat', '-M', '-z', parent, full]
    : ['show', '--no-color', '--format=', '--numstat', '-M', '-z', full];
  const nameStatus = parseNameStatus(runGit(path, diffArgs));
  const numstat = parseNumstatZ(runGit(path, numstatArgs));

  const allFiles: CommitFile[] = [...nameStatus.entries()].map(([filePath, meta]) => {
    const stats = numstat.get(filePath);
    return {
      path: filePath,
      oldPath: meta.oldPath,
      status: meta.status,
      additions: stats?.additions ?? null,
      deletions: stats?.deletions ?? null,
      binary: stats?.additions === null || stats?.deletions === null,
    };
  });
  const files = allFiles.slice(0, MAX_DETAIL_FILES);
  return {
    ...summary,
    message: [summary.subject, summary.body].filter(Boolean).join('\n\n'),
    stats: {
      files: allFiles.length,
      additions: allFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: allFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    },
    files,
    truncated: allFiles.length > files.length,
  };
}

export function getCommitFileDiff(
  path: string,
  sha: string,
  filePath: string,
  opts?: { oldPath?: string | null; context?: number },
): CommitFileDiff {
  assertGitRepo(path);
  const full = resolveCommit(path, sha);
  const safePath = safeGitPath(filePath);
  const safeOldPath = opts?.oldPath ? safeGitPath(opts.oldPath) : null;
  const context = Math.min(Math.max(Math.trunc(opts?.context ?? 3), 0), 50);
  const parent = firstParent(path, full);
  const diffFor = (target: string): string => {
    const args = parent
      ? ['diff', '--no-color', '--no-ext-diff', `--unified=${context}`, '-M', parent, full, '--', target]
      : ['show', '--no-color', '--no-ext-diff', `--unified=${context}`, '--format=', full, '--', target];
    return runGit(path, args);
  };

  let patch = diffFor(safePath);
  if (!patch.trim() && safeOldPath) patch = diffFor(safeOldPath);

  const binary = /^Binary files .* differ$/m.test(patch) || patch.startsWith('GIT binary patch');
  const truncated = patch.length > MAX_PATCH_CHARS;
  const status = /^new file mode/m.test(patch)
    ? 'A'
    : /^deleted file mode/m.test(patch)
      ? 'D'
      : safeOldPath
        ? 'R'
        : 'M';
  return {
    sha: full,
    path: safePath,
    oldPath: safeOldPath,
    status,
    binary,
    patch: truncated ? patch.slice(0, MAX_PATCH_CHARS) : patch,
    truncated,
  };
}

/** Resolve + validate a workspace id coming from the HTTP query string. */
export function requireWorkspace(d: Db, workspaceId: string | null): Workspace {
  if (!workspaceId) throw new GitError('workspaceId is required');
  const ws = getWorkspace(d, workspaceId);
  if (!ws) throw new GitError('workspace not found');
  return ws;
}
