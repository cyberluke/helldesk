import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { gitAsync } from './git-async';

/**
 * Immutable, content-hashed review subjects.
 *
 * Supports:
 *  - git HEAD / arbitrary commit / base..head range / merge-base...head range
 *  - dirty working tree (staged + unstaged + untracked) captured deterministically
 *  - plain filesystem folder with no .git
 *
 * The snapshot is frozen at enqueue time: even if the developer edits the
 * original repo afterwards, reviewers read the pinned Git objects / blob
 * store, never the live working tree. If an immutable view cannot be
 * obtained, we return INCONCLUSIVE_SNAPSHOT rather than silently reviewing
 * later edits.
 */

export type SubjectKind =
  | 'git-head'
  | 'git-commit'
  | 'git-range'
  | 'git-dirty'
  | 'git-mixed'
  | 'fs-folder';

const GIT_PATH_EXCLUDES = ['/node_modules/', '/.git/', '/dist/', '/.next/', '/coverage/', '/build/'];

export class SnapshotError extends Error {
  readonly kind: 'snapshot' | 'inconclusive' | 'unsupported';
  constructor(kind: 'snapshot' | 'inconclusive' | 'unsupported', message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.kind = kind;
  }
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return gitAsync(cwd, args, { timeoutMs: 30_000 }).then((r) => {
    if (!r.ok) {
      throw new Error(`git ${args.slice(0, 2).join(' ')} failed (exit ${r.code ?? 'unknown'}): ${r.stderr.trim()}`);
    }
    return r.stdout;
  });
}

function isGitRepo(workspacePath: string): boolean {
  if (!existsSync(join(workspacePath, '.git'))) return false;
  return true;
}

export function assertGitRepo(workspaceId: string, workspacePath: string): void {
  if (!isGitRepo(workspacePath)) {
    throw new SnapshotError('unsupported', `Workspace ${workspaceId} is not a git repo (${workspacePath})`);
  }
}

export async function gitHead(workspacePath: string): Promise<string> {
  try {
    return (await runGit(workspacePath, ['rev-parse', 'HEAD'])).trim();
  } catch {
    throw new SnapshotError('unsupported', `No HEAD in git repo at ${workspacePath}`);
  }
}

export async function resolveCommit(workspacePath: string, ref: string): Promise<string> {
  try {
    return (await runGit(workspacePath, ['rev-parse', `${ref}^{commit}`])).trim();
  } catch {
    throw new SnapshotError('unsupported', `Cannot resolve commit ${ref}`);
  }
}

async function collectGitFiles(workspacePath: string, base: string, head: string, want: 'names' | 'diff'): Promise<string> {
  // Use --name-only for names or full diff for content. Both read pinned objects.
  if (want === 'names') {
    return runGit(workspacePath, ['diff', '--name-only', base, head]);
  }
  return runGit(workspacePath, ['diff', base, head]);
}

/** Compact set of changed files between base and head, excluding ignored paths. */
export async function gitChangedFiles(workspacePath: string, base: string | null, head: string): Promise<string[]> {
  const out = await runGit(workspacePath, base ? ['diff', '--name-only', base, head] : ['diff-tree', '--no-commit-id', '--name-only', '-r', head]);
  const files = out.split('\n').filter((f) => f.trim().length > 0).map((f) => f.replace(/\\/g, '/'));
  return files.filter((f) => !GIT_PATH_EXCLUDES.some((e) => f.includes(e)));
}

/** Deterministic dirty-state capture: staged + unstaged + untracked. */
export async function captureDirty(workspacePath: string): Promise<{ patch: string; untracked: string; changedFiles: string[] }> {
  let patch = '';
  let changedFiles: string[] = [];
  try {
    // Tracked file names changed in the working tree (staged + unstaged),
    // so a git-dirty snapshot lists them even with no committed delta. Deduped.
    changedFiles = [
      ...(await runGit(workspacePath, ['diff', '--name-only', '--no-color'])).split('\n'),
      ...(await runGit(workspacePath, ['diff', '--cached', '--name-only', '--no-color'])).split('\n'),
    ].filter(Boolean).filter((f, i, a) => a.indexOf(f) === i);
    patch = await runGit(workspacePath, ['diff', '--no-color']);
  } catch { /* no staged/unstaged diff */ }
  let untracked = '';
  try {
    const files = (await runGit(workspacePath, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    const parts: string[] = [];
    for (const f of files) {
      if (GIT_PATH_EXCLUDES.some((e) => f.includes(e))) continue;
      const p = join(workspacePath, f);
      if (!existsSync(p)) continue;
      try {
        const data = readFileSync(p);
        parts.push(`___FILE___ ${f}\n` + data.toString('utf-8') + '\n');
      } catch { /* skip unreadable */ }
    }
    untracked = parts.join('');
  } catch { /* no untracked */ }
  // Use the whole file list (tracked status) to build untracked hash even if ls-files failed.
  return { patch, untracked, changedFiles };
}

/**
 * Build an immutable snapshot of a git subject. Returns a manifest with a
 * content-addressed blob store under `snapshotStore` so large repos are not
 * fully cloned/copied: we only materialize the changed files and diffs.
 */
export interface SnapshotResult {
  snapshotId: string;
  kind: SubjectKind;
  baseHash: string | null;
  headHash: string | null;
  dirtyHash: string | null;
  untrackedHash: string | null;
  manifestHash: string;
  diffBlobPath: string;
  manifestBlobPath: string;
  changedFiles: string[];
  diff: string;
  requirements: string;
}

export async function captureGitSnapshot(opts: {
  workspacePath: string;
  kind: SubjectKind;
  base?: string | null;
  head?: string;
  includeDirty?: boolean;
  includeUntracked?: boolean;
  snapshotStore: string;
  requirements?: string;
}): Promise<SnapshotResult> {
  const {
    workspacePath,
    kind,
    includeDirty = true,
    includeUntracked = true,
    snapshotStore,
    requirements = '',
  } = opts;
  const rel = (p: string) => p.replace(/\\/g, '/');
  const snapshotId = 'snap_' + (opts.kind === 'fs-folder' ? 'fs' : 'git') + '_' + sha256(`${workspacePath}:${Date.now()}:${Math.random()}`).slice(0, 24);
  mkdirSync(snapshotStore, { recursive: true });

  let baseHash: string | null = null;
  let headHash: string | null = null;
  let dirtyHash: string | null = null;
  let untrackedHashD: string | null = null;
  let changedFiles: string[] = [];
  let diff = '';
  let kindLocal: SubjectKind = kind;

  if (kind === 'git-head') {
    const head = opts.head ?? await gitHead(workspacePath);
    headHash = await resolveCommit(workspacePath, head);
    const base = opts.base ?? `${headHash}~1`;
    try {
      baseHash = await resolveCommit(workspacePath, base);
    } catch {
      baseHash = null; // root commit (no parent) — review the single commit
    }
    kindLocal = 'git-head';
    changedFiles = baseHash
      ? await gitChangedFiles(workspacePath, baseHash, headHash)
      : await gitChangedFiles(workspacePath, null, headHash);
    diff = baseHash ? await runGit(workspacePath, ['diff', baseHash, headHash]) : await runGit(workspacePath, ['show', '--format=fuller', '--no-color', headHash]);
  } else if (kind === 'git-commit') {
    const head = opts.head ?? await gitHead(workspacePath);
    headHash = await resolveCommit(workspacePath, head);
    const base = opts.base ?? `${headHash}~1`;
    try {
      baseHash = await resolveCommit(workspacePath, base);
    } catch {
      baseHash = null; // root commit
    }
    kindLocal = 'git-commit';
    changedFiles = baseHash
      ? await gitChangedFiles(workspacePath, baseHash, headHash)
      : await gitChangedFiles(workspacePath, null, headHash);
    diff = baseHash ? await runGit(workspacePath, ['diff', baseHash, headHash]) : await runGit(workspacePath, ['show', '--format=fuller', '--no-color', headHash]);
  } else if (kind === 'git-range') {
    if (!opts.base || !opts.head) throw new SnapshotError('snapshot', 'git-range requires base and head');
    baseHash = await resolveCommit(workspacePath, opts.base);
    headHash = await resolveCommit(workspacePath, opts.head);
    kindLocal = 'git-range';
    changedFiles = await gitChangedFiles(workspacePath, baseHash, headHash);
    diff = await runGit(workspacePath, ['diff', baseHash, headHash]);
  } else if (kind === 'git-dirty' || kind === 'git-mixed') {
    const head = opts.head ?? await gitHead(workspacePath);
    headHash = await resolveCommit(workspacePath, head);
    baseHash = opts.base ?? `${headHash}~1`;
    try { baseHash = await resolveCommit(workspacePath, baseHash); } catch { baseHash = null; }
    kindLocal = kind;
    // committed diff for the range
    if (baseHash) {
      changedFiles = await gitChangedFiles(workspacePath, baseHash, headHash);
      diff = await runGit(workspacePath, ['diff', baseHash, headHash]);
    }
    // append dirty patch
    const dirty = await captureDirty(workspacePath);
    if (includeDirty && dirty.patch.trim().length > 0) {
      if (baseHash) diff += '\n\n=== WORKING TREE (staged+unstaged) ===\n' + dirty.patch;
      dirtyHash = sha256(dirty.patch);
      // The dirty working-tree files are part of this review subject even if
      // nothing was committed between base..head. Without this, a git-dirty
      // subject with only uncommitted edits reports changedFiles=[] and the
      // A/adjudicator reviewers see an empty change set.
      changedFiles = [...changedFiles, ...dirty.changedFiles].filter((f, i, a) => a.indexOf(f) === i);
    }
    if (includeUntracked && dirty.untracked.trim().length > 0) {
      untrackedHashD = sha256(dirty.untracked);
    }
  } else {
    throw new SnapshotError('unsupported', `Git snapshot does not support kind ${kind}`);
  }

  // This branch only handles git kinds (fs-folder returned above).
  if (changedFiles.length === 0 && diff.trim().length === 0 && !dirtyHash && !untrackedHashD) {
    throw new SnapshotError('inconclusive', `No changed content captured for kind ${kind} on ${workspacePath}`);
  }

  // Materialize a read-only blob store of changed file contents at pinned revisions.
  await materializeChangedBlobs(workspacePath, baseHash, headHash, changedFiles, snapshotStore, snapshotId);

  const manifest = {
    snapshotId,
    kind: kindLocal,
    workspacePath,
    baseHash,
    headHash,
    dirtyHash,
    untrackedHash: untrackedHashD,
    changedFiles,
    diffBytes: Buffer.byteLength(diff),
    requirements,
    createdAt: new Date().toISOString(),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestHash = sha256(manifestJson);
  const manifestBlobPath = join(snapshotStore, `${snapshotId}.manifest.json`);
  const diffBlobPath = join(snapshotStore, `${snapshotId}.diff`);
  writeFileSync(manifestBlobPath, manifestJson);
  writeFileSync(diffBlobPath, diff);

  return {
    snapshotId,
    kind: kindLocal,
    baseHash,
    headHash,
    dirtyHash,
    untrackedHash: untrackedHashD,
    manifestHash,
    diffBlobPath,
    manifestBlobPath,
    changedFiles,
    diff,
    requirements,
  };
}

/** Materialize changed-file contents into the snapshot store (bounded). */
export async function materializeChangedBlobs(
  workspacePath: string,
  baseHash: string | null,
  headHash: string | null,
  changedFiles: string[],
  store: string,
  snapshotId: string
): Promise<{ blobs: string[]; skipped: string[] }> {
  const blobs: string[] = [];
  const skipped: string[] = [];
  const dir = join(store, snapshotId, 'files');
  mkdirSync(dir, { recursive: true });
  const maxBytes = 4 * 1024 * 1024;
  let total = 0;
  for (const f of changedFiles) {
    if (GIT_PATH_EXCLUDES.some((e) => f.includes(e))) {
      skipped.push(f);
      continue;
    }
    if (!headHash) { skipped.push(f); continue; }
    let content: string;
    try {
      content = await runGit(workspacePath, ['show', `${headHash}:${f}`]);
    } catch {
      // binary or absent at head — try base
      if (baseHash) {
        try { content = await runGit(workspacePath, ['show', `${baseHash}:${f}`]); }
        catch { skipped.push(f); continue; }
      } else { skipped.push(f); continue; }
    }
    total += Buffer.byteLength(content);
    if (total > maxBytes) {
      skipped.push(f);
      continue;
    }
    const safe = f.replace(/\\/g, '/').replace(/[/\\]/g, '__');
    const p = join(dir, safe);
    try {
      writeFileSync(p, content);
      blobs.push(relative(store, p).replace(/\\/g, '/'));
    } catch { skipped.push(f); }
  }
  return { blobs, skipped };
}

/** Read a file at a pinned revision from a snapshot. */
export function readSnapshotBlob(store: string, snapshotDir: string, relPath: string): string | null {
  const safe = relPath.replace(/^[/\\]+/, '').replace(/\\/g, '/').replace(/[/\\]/g, '__');
  const p = join(store, snapshotDir, 'files', safe);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

/** Build a manifest for a plain (non-git) folder snapshot. */
export function fsFolderSnapshot(opts: {
  workspacePath: string;
  fsPath?: string;
  snapshotStore: string;
  requirements?: string;
}): SnapshotResult {
  const root = resolve(opts.fsPath ?? opts.workspacePath);
  if (!existsSync(root)) throw new SnapshotError('unsupported', `Folder does not exist: ${root}`);
  const snapshotId = 'snap_fs_' + sha256(`${root}:${Date.now()}:${Math.random()}`).slice(0, 24);
  mkdirSync(opts.snapshotStore, { recursive: true });
  const manifest: { files: Array<{ path: string; hash: string; bytes: number }> } = { files: [] };
  const excluded = ['.git', 'node_modules', 'dist', 'build', '.next', 'coverage'];
  const stack = [root];
  let scanned = 0;
  const storeDir = join(opts.snapshotStore, snapshotId, 'files');
  mkdirSync(storeDir, { recursive: true });
  const maxFiles = 2000;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (excluded.includes(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) {
        const relPath = relative(root, full).replace(/\\/g, '/');
        try {
          const data = readFileSync(full);
          const hash = sha256(data);
          const safe = relPath.replace(/[/\\]/g, '__');
          writeFileSync(join(storeDir, safe), data);
          manifest.files.push({ path: relPath, hash, bytes: data.byteLength });
          if (++scanned > maxFiles) break;
        } catch { /* skip unreadable */ }
      }
    }
    if (scanned > maxFiles) break;
  }
  if (manifest.files.length === 0) {
    throw new SnapshotError('inconclusive', `No reviewable files in folder ${root}`);
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestHash = sha256(manifestJson);
  const manifestBlobPath = join(opts.snapshotStore, `${snapshotId}.manifest.json`);
  const diffBlobPath = join(opts.snapshotStore, `${snapshotId}.diff`);
  writeFileSync(manifestBlobPath, manifestJson);
  // For folders the "diff" is the full file listing summary.
  writeFileSync(diffBlobPath, manifest.files.map((f) => `${f.hash.slice(0, 12)} ${f.bytes} ${f.path}`).join('\n'));
  return {
    snapshotId,
    kind: 'fs-folder',
    baseHash: null,
    headHash: null,
    dirtyHash: null,
    untrackedHash: null,
    manifestHash,
    diffBlobPath,
    manifestBlobPath,
    changedFiles: manifest.files.map((f) => f.path),
    diff: '',
    requirements: opts.requirements ?? '',
  };
}

/** Compose the immutable fingerprint for a target. */
export function targetFingerprint(input: {
  workspaceId: string;
  kind: SubjectKind;
  baseHash: string | null;
  headHash: string | null;
  dirtyHash: string | null;
  untrackedHash: string | null;
  policyVersion: string;
  reviewerConfigVersion: string;
}): string {
  const data = [
    input.workspaceId,
    input.kind,
    input.baseHash ?? '',
    input.headHash ?? '',
    input.dirtyHash ?? '',
    input.untrackedHash ?? '',
    input.policyVersion,
    input.reviewerConfigVersion,
  ].join('|');
  return sha256(data);
}

export { isGitRepo, GIT_PATH_EXCLUDES };