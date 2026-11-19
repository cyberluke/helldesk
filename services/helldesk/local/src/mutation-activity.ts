import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Live observability into what a MUTATING agent is actually doing in its output
 * workspace. This turns the blind "state=MUTATING" into an answerable question:
 * is the extraction progressing (source files being written / commits created)
 * or is the agent stuck (only git churn, no source edits in a long window)?
 *
 * Pure FS + git sampling; never starts a process we didn't already own. Bounded
 * and cheap: only runs on-demand from the mission detail GET handler, never in a
 * hot loop. All git calls are wrapped so a non-git or locked workspace degrades
 * gracefully instead of throwing.
 */

export interface MutationActivity {
  /** Workspace path being sampled (the registered mission workspace). */
  workspacePath: string;
  /** If the workspace root is missing entirely → misconfigured binding. */
  workspaceMissing: boolean;
  /** Git HEAD short sha, \`null\` when the workspace has no HEAD (empty init). */
  head: string | null;
  /** True when the current HEAD has diverged from the baseline d6a3aaa (real work). */
  advancedBeyondBaseline: boolean;
  /** Number of files with an mtime inside the last windowMs (source touch = activity). */
  filesTouchedInWindow: number;
  /** The single most recently written non-.git file path (relative, truncated). */
  newestSourceFile: string | null;
  /** Age in seconds of the newest non-.git file write (0 = seconds ago). */
  newestSourceAgeMs: number | null;
  /** Number of commits ahead of origin/main (0 = nothing committed yet). */
  commitsAhead: number;
  /** Recent short commit subjects (up to 3), newest first. */
  recentCommits: string[];
  /** git status porcelain count of dirty/untracked entries (0 = clean tree). */
  dirtyEntries: number;
  /** Rough classification the operator-console can render as a health dot. */
  verdict: 'working' | 'stalled' | 'no-output-checkout' | 'missing';
}

const BASELINE = 'd6a3aaa'; // NAI_Game_Framework baseline seed (the acceptance anchor).
const DEFAULT_WINDOW_MS = 5 * 60_000; // consider a file "touched" if written in the last 5 min.

const SRC_EXT = /\.(ts|tsx|js|jsx|rs|md|json|toml|py|ml|svelte|vue|html|css|ps1|mjs)$/i;

function runGit(dir: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', shell: false, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] as const }).trim();
  } catch {
    return '';
  }
}

/** Number of tracked files in a workspace's git tree (0 if not a git repo). Cheap. */
export function countTrackedFiles(workspacePath: string): number {
  if (!workspacePath) return 0;
  const out = runGit(workspacePath, ['ls-files']).split('\n').filter(Boolean);
  return out.length;
}

export function sampleMutationActivity(workspacePath: string): MutationActivity {
  const base: MutationActivity = {
    workspacePath,
    workspaceMissing: false,
    head: null,
    advancedBeyondBaseline: false,
    filesTouchedInWindow: 0,
    newestSourceFile: null,
    newestSourceAgeMs: null,
    commitsAhead: 0,
    recentCommits: [],
    dirtyEntries: 0,
    verdict: 'missing',
  };

  if (!workspacePath || !workspacePath.trim()) return { ...base, verdict: 'missing' };
  let root = workspacePath;
  try {
    const st = statSync(root);
    if (!st.isDirectory()) return { ...base, verdict: 'missing' };
  } catch {
    return { ...base, workspaceMissing: true, verdict: 'missing' };
  }

  // If the registered workspace is a bare workdir, point at its output checkout.
  const possible = [root, join(root, 'output'), join(root, 'work', 'output')];
  const output = possible.find((p) => {
    try { return statSync(join(p, '.git')).isDirectory(); } catch { return false; }
  });
  if (output) root = output;

  const head = runGit(root, ['rev-parse', '--short', 'HEAD']) || null;
  const advancedBeyondBaseline = !!head && head !== BASELINE;
  const commitsAheadRaw = runGit(root, ['rev-list', '--count', 'origin/main..HEAD']);
  const commitsAhead = /^\d+$/.test(commitsAheadRaw) ? Number(commitsAheadRaw) : 0;
  const recentCommits = runGit(root, ['log', '--oneline', '-3']).split('\n').filter(Boolean);
  const dirtyEntries = (runGit(root, ['status', '--porcelain']).split('\n').filter(Boolean)).length;

  // Source-churn: how many source files were written in the last windowMs?
  let filesTouchedInWindow = 0;
  let newest: { path: string; ageMs: number } | null = null;
  const dirs = [root];
  const guard = 20_000;
  const seen = new Set<string>();
  const now = Date.now();
  while (dirs.length && seen.size < guard) {
    const cur = dirs.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true } as never) as unknown as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (seen.size >= guard) break;
      if (e.name === '.git') continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        dirs.push(full);
      } else if (e.isFile() && SRC_EXT.test(e.name)) {
        try {
          const st = statSync(full);
          const ageMs = now - st.mtimeMs;
          if (ageMs <= DEFAULT_WINDOW_MS) filesTouchedInWindow++;
          if (newest === null || ageMs < newest.ageMs) newest = { path: relative(root, full).replace(/\\/g, '/'), ageMs };
        } catch {
          /* skip */
        }
      }
    }
    seen.add(cur);
  }

  // Verdict: working = real source writes or new commits; stalled = nothing new.
  const sourceTouched = filesTouchedInWindow > 0 || (newest !== null && newest.ageMs <= DEFAULT_WINDOW_MS);
  const active = sourceTouched || commitsAhead > 0 || dirtyEntries > 0;
  // A bare `rev-parse --short HEAD` can transiently return empty while the repo
  // is mid-mutation (git ref lock / IN_PROGRESS state) even though the checkout
  // is real and has commit history. `no-output-checkout` must mean "this is not
  // a git checkout at all", not "git was momentarily busy". If recent commits or
  // an ahead count resolve, classify on activity like a normal repo.
  const hasResolvableHistory = recentCommits.length > 0 || head !== null || commitsAhead > 0;
  const verdict: MutationActivity['verdict'] = sourceTouched || commitsAhead > 0
    ? 'working'
    : (!hasResolvableHistory && head === null
        ? 'no-output-checkout'
        : (active ? 'working' : 'stalled'));

  return {
    workspacePath: root,
    workspaceMissing: false,
    head,
    advancedBeyondBaseline,
    filesTouchedInWindow,
    newestSourceFile: newest?.path ?? null,
    newestSourceAgeMs: newest?.ageMs ?? null,
    commitsAhead,
    recentCommits,
    dirtyEntries,
    verdict,
  };
}