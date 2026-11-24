/**
 * mission-baseline.ts — immutable protected-path baseline captured at mission
 * admission.
 *
 * The current-HEAD comparison was a real hole: a mutator could commit a
 * modified test (or retarget a symlink, delete a fixture, or rewrite
 * package.json) and HEAD would move with it. This module captures the
 * protected identities ONCE, before any mutation, and the gate runner compares
 * every candidate against that baseline. Git history is irrelevant.
 *
 * Stored on `autonomy_missions.baseline_json` (migration 0022). The baseline
 * contains only protected files (tests, gate/test configuration, benchmark
 * fixtures supplied by the mission), not the whole repository.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PROTECTED_PATHS,
  hashProtectedFiles,
  materializeCandidate,
  type ProtectedFileRecord,
} from './gate-runner';

export interface MissionBaseline {
  version: 1;
  capturedAt: string;
  /** Git HEAD at admission when the workspace is a git repository. */
  gitCommit: string | null;
  /** Candidate tree hash at admission when the workspace is a git repository. */
  gitTree: string | null;
  /** Resolved protected globs (defaults + per-gate + mission-supplied). */
  protectedPaths: string[];
  /** Explicit operator authorization for otherwise-protected paths. */
  allowProtectedPaths: string[];
  /** Immutable identities of every protected file at admission. */
  protectedFiles: ProtectedFileRecord[];
}

function headCommit(workspacePath: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40,64}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/**
 * Capture the mission's immutable protected-path baseline. Call this ONCE at
 * mission admission, before any mutator runs, and persist the result on the
 * mission row. The snapshot tree is temporary; only the manifest is stored.
 */
export function captureMissionBaseline(opts: {
  workspacePath: string;
  protectedPaths?: string[];
  allowProtectedPaths?: string[];
  /** Optional temp root for tests; defaults to the OS temp directory. */
  tempRoot?: string;
}): MissionBaseline {
  const protectedPaths = unique([...DEFAULT_PROTECTED_PATHS, ...(opts.protectedPaths ?? [])]);
  const allowProtectedPaths = unique(opts.allowProtectedPaths ?? []);
  const tempRoot = opts.tempRoot ?? mkdtempSync(join(tmpdir(), 'helldesk-baseline-'));
  const snapshot = materializeCandidate({
    workspacePath: opts.workspacePath,
    dataDir: tempRoot,
    revisionId: `baseline-${Date.now()}`,
    linkDependencies: false,
  });
  try {
    return {
      version: 1,
      capturedAt: new Date().toISOString(),
      gitCommit: headCommit(opts.workspacePath),
      gitTree: snapshot.candidateHash.startsWith('fs:') ? null : snapshot.candidateHash,
      protectedPaths,
      allowProtectedPaths,
      protectedFiles: hashProtectedFiles(snapshot.worktreePath, protectedPaths),
    };
  } finally {
    snapshot.cleanup();
    if (!opts.tempRoot) {
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
