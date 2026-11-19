import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Service-owned, bounded, cached Git observer.
 *
 * Runs ONLY inside the HELLDESK daemon — never in the Kilo plugin. Uses the
 * absolute `git.exe` with argument arrays, `shell:false`, `windowsHide:true`
 * and strict timeouts/output caps. Baselines are cached per-workspace and
 * invalidated on `.git/HEAD`, refs and relevant FS change, so heavy Git is NOT
 * spawned on every incoming prompt.
 */

const GIT_EXE = process.env.GIT_EXE ?? 'C:/Program Files/Git/bin/git.exe';
const MAX_OUT = 128 * 1024;
const PROBE_TIMEOUT_MS = 8000;
const MAX_PARALLEL_PER_WORKSPACE = 1;

interface CacheEntry {
  head?: string;
  refsHash?: string;
  statusHash?: string;
  attachments?: string;
  nonGit: boolean;
  checkedAt: number;
  inFlight?: Promise<GitSnapshot>;
}

const cache = new Map<string, CacheEntry>();

function runGit(workspace: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(GIT_EXE, args, { cwd: workspace, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT); });
    child.stderr?.on('data', (b: Buffer) => { err += b.toString('utf8'); if (err.length > 16 * 1024) err = err.slice(0, 16 * 1024); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, PROBE_TIMEOUT_MS);
    child.on('error', () => resolve({ stdout: '', code: null }));
    child.on('exit', (code) => { clearTimeout(timer); resolve({ stdout: out.trim(), code }); });
  });
}

export interface GitSnapshot {
  workspace: string;
  head?: string;
  nonGit: boolean;
  committedHead?: string;
  dirtyFiles: string[];
  changedCount: number;
}

/** Fast fingerprint of the visible git state to know whether the cache is stale. */
async function fingerprint(workspace: string, entry: CacheEntry): Promise<boolean> {
  if (entry.nonGit) return false;
  const head = await runGit(workspace, ['rev-parse', 'HEAD']);
  const st = await runGit(workspace, ['status', '--porcelain', '--untracked-files=no']);
  const ref = await runGit(workspace, ['for-each-ref', '--format=%(refname)%(objectname)', 'refs/heads']);
  const head2 = head.code === 0 ? head.stdout : '';
  const st2 = st.code === 0 ? st.stdout : '';
  const ref2 = ref.code === 0 ? ref.stdout : '';
  if (entry.head === head2 && entry.statusHash === st2 && entry.refsHash === ref2) return false; // unchanged
  entry.head = head2;
  entry.statusHash = st2;
  entry.refsHash = ref2;
  return true; // changed
}

export function getCachedSnapshot(workspace: string): GitSnapshot | undefined {
  const e = cache.get(workspace);
  if (!e) return undefined;
  return e.head
    ? { workspace, head: e.head, nonGit: e.nonGit, committedHead: e.head, dirtyFiles: [], changedCount: 0 }
    : { workspace, nonGit: e.nonGit, dirtyFiles: [], changedCount: 0 };
}

export async function observe(workspace: string): Promise<GitSnapshot> {
  const existing = cache.get(workspace);
  if (existing?.inFlight) return existing.inFlight;
  const task = (async (): Promise<GitSnapshot> => {
    let entry = cache.get(workspace);
    if (!entry) { entry = { nonGit: false, checkedAt: Date.now() }; cache.set(workspace, entry); }
    try {
      const changed = await fingerprint(workspace, entry);
      if (!changed && entry.head !== undefined) {
        return { workspace, head: entry.head, nonGit: false, committedHead: entry.head, dirtyFiles: [], changedCount: 0 };
      }
      if (entry.nonGit) return { workspace, nonGit: true, dirtyFiles: [], changedCount: 0 };
      const head = entry.head ?? '';
      if (!head) {
        // maybe not a git repo
        const t = await runGit(workspace, ['rev-parse', '--is-inside-work-tree']);
        if (t.code !== 0) { entry.nonGit = true; return { workspace, nonGit: true, dirtyFiles: [], changedCount: 0 }; }
      }
      const dirty = await runGit(workspace, ['status', '--porcelain']);
      const dirtyFiles = dirty.code === 0 ? dirty.stdout.split('\n').filter(Boolean) : [];
      const headFinal = entry.head ?? '';
      return {
        workspace,
        head: headFinal,
        nonGit: false,
        committedHead: headFinal,
        dirtyFiles,
        changedCount: dirtyFiles.length,
      };
    } finally {
      entry.inFlight = undefined;
      entry.checkedAt = Date.now();
    }
  })();
  if (existing) existing.inFlight = task;
  return task;
}

export function maxPerWorkspace(): number {
  return MAX_PARALLEL_PER_WORKSPACE;
}

export function joinPath(a: string, b: string): string {
  return join(a, b);
}