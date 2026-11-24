/**
 * gate-runner.ts — host-executed acceptance gates.
 *
 * The invariant this module exists to enforce:
 *
 *   An agent cannot certify its own work. Only independently executed evidence
 *   can satisfy an execution gate.
 *
 * A mission persists its executable gate commands OUTSIDE the writable
 * workspace. For each revision, this module:
 *
 *   1. materializes the candidate tree into an isolated worktree outside the
 *      source workspace (temp git index + write-tree + archive, or a filtered
 *      copy for non-git workspaces);
 *   2. binds the execution to the immutable candidate tree hash + revision id;
 *   3. runs each command with a scrubbed environment, bounded timeout and
 *      process-tree termination;
 *   4. records real provenance (command, exit code, duration, stdout/stderr
 *      digests, env fingerprint, candidate hash, test-file hashes, protected
 *      paths) as content-addressed evidence outside the workspace;
 *   5. persists a gate_executions history row.
 *
 * The Quality Oracle reads gate_executions independently; a reviewer can never
 * turn an executed FAIL into PASS.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Db } from './db';
import {
  addEvidence,
  getMissionBaseline,
  getMissionGateCommands,
  insertGateExecution,
  latestGateExecution,
  type GateCommandSpec,
  type GateExecutionRow,
  type GateExecutionStatus,
} from './mission-repository';
import type { MissionBaseline } from './mission-baseline';
import { runBrowserGate, type BrowserGateResult } from './browser-gate';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_FILES = 4_000;
const MAX_TEST_HASH_FILES = 800;
const MAX_TEST_HASH_BYTES = 2 * 1024 * 1024;

/** Files that must not change between the base and the candidate. A changed
 *  protected path is a scope violation, independent of whether the command
 *  exits 0. */
export const DEFAULT_PROTECTED_PATHS = [
  // Tests and test data.
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/test.mjs',
  '**/test.js',
  '**/test.ts',
  '**/server.test.*',
  '**/index.test.*',
  // Gate/test configuration: a mutator must not rewrite the commands or
  // runner configuration that decide PASS.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'yarn.lock',
  'tsconfig.json',
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/jest.config.*',
  '.github/workflows/**',
];

export interface GateRunOptions {
  d: Db;
  missionId: string;
  revisionId: string;
  workspacePath: string;
  /** Storage root for worktrees + transcripts. Must be OUTSIDE the workspace. */
  dataDir: string;
  /** Explicit commands (tests/benchmark harness); otherwise loaded from the mission. */
  commands?: Record<string, GateCommandSpec>;
  /** Explicit immutable mission baseline; otherwise loaded from the mission. */
  baseline?: MissionBaseline | null;
  /** Re-run even if an execution for the same candidate hash already exists. */
  force?: boolean;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface GateRunSummary {
  candidateHash: string;
  worktreePath: string;
  executions: GateExecutionRow[];
}

interface CandidateMaterialization {
  candidateHash: string;
  worktreePath: string;
  cleanup(): void;
}

/** A protected file's immutable identity at a point in time. Symlinks hash
 *  their target, so retargeting is a modification (not a no-op). */
export interface ProtectedFileRecord {
  path: string;
  sha256: string;
  mode: 'file' | 'symlink';
  size: number;
  target?: string;
}

export interface ProtectedChange {
  path: string;
  reason: 'added' | 'deleted' | 'modified' | 'mode-changed';
}

interface CommandResult {
  status: GateExecutionStatus;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

interface ScrubbedEnv {
  env: Record<string, string>;
  fingerprint: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'run';
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeSlashes(glob).replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const c = normalized[i]!;
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isProtectedPath(relPath: string, protectedPaths: string[]): boolean {
  const normalized = normalizeSlashes(relPath);
  return protectedPaths.some((glob) => globToRegExp(glob).test(normalized));
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/** Minimal, explicit environment allow-list. Never forwards tokens, API keys,
 *  provider config or credential-bearing variables to the gate child. */
function scrubbedEnv(extra: Record<string, string> = {}): ScrubbedEnv {
  const allow = new Set([
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'COMSPEC', 'ComSpec',
    'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL',
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (!allow.has(key)) continue;
    env[key] = value;
  }
  // Belt-and-braces: even an allow-listed name must not look secret-bearing.
  for (const key of Object.keys(env)) {
    if (/token|secret|password|credential|api[_-]?key|authorization|auth/i.test(key)) delete env[key];
  }
  Object.assign(env, { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', HELLDESK_GATE: '1' }, extra);
  const fingerprint = sha256(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    bun: process.versions.bun ?? null,
    keys: Object.keys(env).sort(),
    pathHash: sha256(env.PATH ?? env.Path ?? ''),
  }));
  return { env, fingerprint };
}

function runGit(args: string[], cwd: string, env: Record<string, string>): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').toString(),
    stderr: (r.stderr ?? '').toString(),
    status: r.status,
  };
}

/** Identity of the CURRENT writable workspace as an immutable git tree.
 *
 *  This is the SAME identity `materializeCandidate` binds a gate execution to
 *  (temp index + `git add -A` + `write-tree`, respecting .gitignore). Comparing
 *  the two answers the only question that matters at certification time:
 *
 *      is the tree about to be stamped VERIFIED_10_10 the tree the host
 *      actually executed the gates against?
 *
 *  A mutation session (or any other writer) that keeps editing the workspace
 *  after the gates ran MUST NOT be certifiable. The check is read-only: it uses
 *  a throwaway index and object directory, so HEAD and the real index are never
 *  touched.
 */
export function workspaceTreeIdentity(workspacePath: string): {
  ok: boolean;
  hash: string | null;
  reason?: string;
} {
  if (!existsSync(workspacePath)) return { ok: false, hash: null, reason: 'workspace-missing' };
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], workspacePath, process.env as Record<string, string>);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return { ok: false, hash: null, reason: 'not-a-git-worktree' };
  }
  let scratch = '';
  try {
    const gitDirRaw = runGit(['rev-parse', '--git-dir'], workspacePath, process.env as Record<string, string>).stdout.trim();
    if (!gitDirRaw) return { ok: false, hash: null, reason: 'git-dir-unresolved' };
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(workspacePath, gitDirRaw);
    scratch = mkdtempSync(join(tmpdir(), 'helldesk-tree-'));
    const tempObjects = join(scratch, 'objects');
    mkdirSync(tempObjects, { recursive: true });
    const gitEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      GIT_INDEX_FILE: join(scratch, 'index'),
      GIT_OBJECT_DIRECTORY: tempObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDir, 'objects'),
    };
    const add = runGit(['add', '-A'], workspacePath, gitEnv);
    if (!add.ok) return { ok: false, hash: null, reason: `git-add-failed: ${add.stderr.slice(0, 300)}` };
    const tree = runGit(['write-tree'], workspacePath, gitEnv);
    const hash = tree.stdout.trim();
    if (!tree.ok || !/^[0-9a-f]{40,64}$/i.test(hash)) {
      return { ok: false, hash: null, reason: `git-write-tree-failed: ${tree.stderr.slice(0, 300)}` };
    }
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, hash: null, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

function listTreeFiles(root: string, maxFiles = MAX_TREE_FILES): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) out.push(normalizeSlashes(relative(root, full)));
      else if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(normalizeSlashes(relative(root, full)));
    }
  };
  walk(root);
  return out.sort();
}

/** Hash every protected file/symlink in a materialized tree. Symlinks hash
 *  their target, so retargeting is detected. Bounded to avoid pathological
 *  repositories; an unreadable protected file is omitted and therefore shows
 *  up as deleted on comparison (fail-closed). */
export function hashProtectedFiles(root: string, protectedPaths: string[]): ProtectedFileRecord[] {
  const out: ProtectedFileRecord[] = [];
  let count = 0;
  for (const rel of listTreeFiles(root)) {
    if (count >= MAX_TEST_HASH_FILES) break;
    if (!isProtectedPath(rel, protectedPaths)) continue;
    const full = join(root, rel);
    try {
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full);
        out.push({ path: rel, sha256: sha256(`symlink:${target}`), mode: 'symlink', size: 0, target });
        count += 1;
      } else if (stat.isFile()) {
        if (stat.size > MAX_TEST_HASH_BYTES) continue;
        const buf = readFileSync(full);
        out.push({
          path: rel,
          sha256: createHash('sha256').update(buf).digest('hex'),
          mode: 'file',
          size: stat.size,
        });
        count += 1;
      }
    } catch {
      /* unreadable files are omitted; the missing hash is still visible */
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Compare protected identities. This is independent of git history, so it
 *  catches committed changes, uncommitted changes, renames (delete + add),
 *  deletions and symlink retargeting equally. */
export function diffProtectedFiles(
  baseline: ProtectedFileRecord[],
  candidate: ProtectedFileRecord[],
): ProtectedChange[] {
  const base = new Map(baseline.map((f) => [f.path, f]));
  const cand = new Map(candidate.map((f) => [f.path, f]));
  const changes: ProtectedChange[] = [];
  for (const [path, b] of base) {
    const c = cand.get(path);
    if (!c) changes.push({ path, reason: 'deleted' });
    else if (b.mode !== c.mode) changes.push({ path, reason: 'mode-changed' });
    else if (b.sha256 !== c.sha256) changes.push({ path, reason: 'modified' });
  }
  for (const path of cand.keys()) {
    if (!base.has(path)) changes.push({ path, reason: 'added' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function candidateCopyFilter(workspacePath: string) {
  const excluded = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', '.local']);
  return (src: string): boolean => {
    const rel = normalizeSlashes(relative(workspacePath, src));
    if (!rel || rel === '.') return true;
    const parts = rel.split('/');
    return !parts.some((part) => excluded.has(part));
  };
}

function copyCandidate(workspacePath: string, treeRoot: string): void {
  // Filter out heavy/generated directories; the gate command gets a clean
  // product tree. node_modules is linked back read-only by linkNodeModules().
  cpSync(workspacePath, treeRoot, {
    recursive: true,
    dereference: false,
    filter: candidateCopyFilter(workspacePath),
  });
}

function linkNodeModules(workspacePath: string, treeRoot: string): void {
  const src = join(workspacePath, 'node_modules');
  const dest = join(treeRoot, 'node_modules');
  if (!existsSync(src) || existsSync(dest)) return;
  try {
    symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    /* dependency-less gates still run; a missing node_modules is visible to the command */
  }
}

function hashTreeManifest(root: string): string {
  const lines: string[] = [];
  for (const rel of listTreeFiles(root)) {
    const full = join(root, rel);
    try {
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
      const buf = readFileSync(full);
      lines.push(`${rel}\0${createHash('sha256').update(buf).digest('hex')}`);
    } catch {
      lines.push(`${rel}\0unreadable`);
    }
  }
  return sha256(lines.join('\n'));
}

export function materializeCandidate(opts: {
  workspacePath: string;
  dataDir: string;
  revisionId: string;
  /** Link the source workspace's node_modules for executable gates. Baseline
   *  capture does not need dependencies, so it can skip the junction. */
  linkDependencies?: boolean;
}): CandidateMaterialization {
  const { workspacePath, dataDir, revisionId } = opts;
  if (!existsSync(workspacePath)) throw new Error(`gate workspace does not exist: ${workspacePath}`);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (isWithin(workspacePath, dataDir)) {
    throw new Error('gate dataDir must be outside the source workspace');
  }

  const workRoot = join(dataDir, 'gate-worktrees', safeId(revisionId));
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  const treeRoot = join(workRoot, 'tree');
  mkdirSync(treeRoot, { recursive: true });

  let candidateHash = '';
  let usedGit = false;

  // ── Preferred path: an immutable git tree from a TEMP index. This never
  //    touches the workspace index/HEAD and captures dirty + untracked files
  //    (respecting .gitignore).
  const inside = runGit(['rev-parse', '--is-inside-work-tree'], workspacePath, process.env as Record<string, string>);
  if (inside.ok && inside.stdout.trim() === 'true') {
    try {
      const gitDirRaw = runGit(['rev-parse', '--git-dir'], workspacePath, process.env as Record<string, string>).stdout.trim();
      const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(workspacePath, gitDirRaw);
      const objectsDir = isAbsolute(gitDir) ? join(gitDir, 'objects') : resolve(workspacePath, gitDir, 'objects');
      const tempIndex = join(workRoot, 'index');
      const tempObjects = join(workRoot, 'objects');
      const archive = join(workRoot, 'candidate.tar');
      mkdirSync(tempObjects, { recursive: true });
      const gitEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        GIT_INDEX_FILE: tempIndex,
        GIT_OBJECT_DIRECTORY: tempObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsDir,
      };
      const add = runGit(['add', '-A'], workspacePath, gitEnv);
      if (!add.ok) throw new Error(`git add -A failed: ${add.stderr.slice(0, 400)}`);
      const writeTree = runGit(['write-tree'], workspacePath, gitEnv);
      if (!writeTree.ok) throw new Error(`git write-tree failed: ${writeTree.stderr.slice(0, 400)}`);
      candidateHash = writeTree.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(candidateHash)) throw new Error('git write-tree returned an invalid tree hash');
      const archiveResult = spawnSync('git', ['archive', '--format=tar', `--output=${archive}`, candidateHash], {
        cwd: workspacePath,
        env: gitEnv,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (archiveResult.status !== 0) {
        throw new Error(`git archive failed: ${(archiveResult.stderr ?? '').toString().slice(0, 400)}`);
      }
      const untar = spawnSync('tar', ['-xf', archive, '-C', treeRoot], {
        cwd: workRoot,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (untar.status !== 0) {
        throw new Error(`tar extraction failed: ${(untar.stderr ?? '').toString().slice(0, 400)}`);
      }
      usedGit = true;
    } catch {
      // Fall through to the plain-copy path. The candidate hash then comes from
      // the file manifest; protected-file hashing/comparison still runs against
      // the captured tree.
      rmSync(treeRoot, { recursive: true, force: true });
      mkdirSync(treeRoot, { recursive: true });
      candidateHash = '';
    }
  }

  if (!usedGit) {
    copyCandidate(workspacePath, treeRoot);
    candidateHash = hashTreeManifest(treeRoot);
  }

  if (opts.linkDependencies !== false) linkNodeModules(workspacePath, treeRoot);

  return {
    candidateHash: usedGit ? candidateHash : `fs:${candidateHash}`,
    worktreePath: treeRoot,
    cleanup() {
      try {
        rmSync(workRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15_000,
      });
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function runBoundedCommand(opts: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const started = Date.now();
  const maxBytes = Math.max(1024, opts.maxOutputBytes);
  return await new Promise<CommandResult>((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: string | undefined;

    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = isWin ? ['/d', '/s', '/c', opts.command] : ['-c', opts.command];
    let child;
    try {
      child = spawn(shell, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
      });
    } catch (err) {
      resolvePromise({
        status: 'ERROR',
        exitCode: null,
        durationMs: Date.now() - started,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const finish = (status: GateExecutionStatus, exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onAbort);
      resolvePromise({
        status,
        exitCode,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        timedOut,
        error,
      });
    };

    const onAbort = (): void => {
      timedOut = true;
      killProcessTree(child.pid);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, opts.timeoutMs);
    opts.signal?.addEventListener?.('abort', onAbort);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) return;
      const text = chunk.toString('utf8');
      const room = maxBytes - stdoutBytes;
      stdout += text.slice(0, room);
      stdoutBytes += Math.min(Buffer.byteLength(text, 'utf8'), room);
      if (stdoutBytes >= maxBytes) stdout += '\n[stdout truncated by gate-runner]\n';
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) return;
      const text = chunk.toString('utf8');
      const room = maxBytes - stderrBytes;
      stderr += text.slice(0, room);
      stderrBytes += Math.min(Buffer.byteLength(text, 'utf8'), room);
      if (stderrBytes >= maxBytes) stderr += '\n[stderr truncated by gate-runner]\n';
    });
    child.on('error', (err) => {
      spawnError = err.message;
      finish('ERROR', null, spawnError);
    });
    child.on('close', (code) => {
      if (timedOut) {
        finish('TIMEOUT', code, `command exceeded ${opts.timeoutMs}ms; process tree terminated`);
        return;
      }
      if (spawnError) {
        finish('ERROR', code ?? null, spawnError);
        return;
      }
      finish(code === 0 ? 'PASS' : 'FAIL', code ?? null);
    });
  });
}

function buildEvidenceDir(dataDir: string, revisionId: string, gateKey: string): string {
  const dir = join(
    dataDir,
    'gate-runs',
    safeId(revisionId),
    `${safeId(gateKey)}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveCwd(treeRoot: string, cwd: string | undefined): string {
  if (!cwd) return treeRoot;
  if (isAbsolute(cwd)) throw new Error('gate cwd must be workspace-relative');
  const resolved = resolve(treeRoot, cwd);
  if (!isWithin(treeRoot, resolved)) throw new Error('gate cwd escapes the candidate worktree');
  return resolved;
}

function checkExpectedArtifacts(treeRoot: string, expected: string[] | undefined): string[] {
  if (!expected?.length) return [];
  const missing: string[] = [];
  for (const rel of expected) {
    const resolved = resolve(treeRoot, rel);
    if (!isWithin(treeRoot, resolved) || !existsSync(resolved)) missing.push(rel);
  }
  return missing;
}

/**
 * Execute every mission-defined gate for one revision in an isolated candidate
 * tree. Returns the persisted execution rows. Idempotent per (revision, gate,
 * candidate hash) unless `force` is true.
 */
export async function runGateExecutions(opts: GateRunOptions): Promise<GateRunSummary> {
  const commands = opts.commands ?? getMissionGateCommands(opts.d, opts.missionId);
  const gateKeys = Object.keys(commands).sort();
  if (!gateKeys.length) return { candidateHash: '', worktreePath: '', executions: [] };

  if (isWithin(opts.workspacePath, opts.dataDir)) {
    throw new Error('gate dataDir must be outside the source workspace');
  }

  const candidate = materializeCandidate({
    workspacePath: opts.workspacePath,
    dataDir: opts.dataDir,
    revisionId: opts.revisionId,
  });

  // The immutable mission baseline is authoritative for protected paths. It is
  // independent of git history, so a committed test tamper is caught exactly
  // like an uncommitted one; renames/deletions/symlink retargeting are caught
  // by the protected identity set.
  const baseline = opts.baseline !== undefined ? opts.baseline : getMissionBaseline(opts.d, opts.missionId);
  const protectedPaths = baseline?.protectedPaths?.length ? baseline.protectedPaths : DEFAULT_PROTECTED_PATHS;
  const candidateProtected = hashProtectedFiles(candidate.worktreePath, protectedPaths);
  const allChanges = baseline ? diffProtectedFiles(baseline.protectedFiles, candidateProtected) : [];
  const allowedGlobs = baseline?.allowProtectedPaths ?? [];
  const allowedChanges = allChanges.filter((c) => isProtectedPath(c.path, allowedGlobs));
  const protectedChanged = allChanges.filter((c) => !allowedChanges.some((a) => a.path === c.path && a.reason === c.reason));
  const baselineMissing = !baseline;
  const testFileHashes = Object.fromEntries(candidateProtected.map((f) => [f.path, f.sha256]));
  const protectedRecord = {
    paths: protectedPaths,
    allow: allowedGlobs,
    changed: protectedChanged,
    allowed: allowedChanges,
    baselinePresent: !baselineMissing,
  };

  const executions: GateExecutionRow[] = [];
  try {
    for (const gateKey of gateKeys) {
      const spec = commands[gateKey]!;
      if (!opts.force) {
        const previous = latestGateExecution(opts.d, opts.revisionId, gateKey);
        if (previous && previous.candidate_hash === candidate.candidateHash) {
          executions.push(previous);
          continue;
        }
      }

      const startedAt = new Date().toISOString();
      const evidenceDir = buildEvidenceDir(opts.dataDir, opts.revisionId, gateKey);
      const stdoutPath = join(evidenceDir, 'stdout.log');
      const stderrPath = join(evidenceDir, 'stderr.log');
      const resultPath = join(evidenceDir, 'result.json');

      let status: GateExecutionStatus;
      let exitCode: number | null = null;
      let durationMs = 0;
      let stdout = '';
      let stderr = '';
      let error: string | undefined;
      let missingArtifacts: string[] = [];
      let cwd = '';
      let browser: BrowserGateResult['browser'] | null = null;
      let commandLabel = spec.command ?? (spec.browser ? `browser-gate:${spec.browser.url}` : '');
      // Gates that produce screenshots/reports (browser gate, coverage, etc.)
      // get an evidence directory OUTSIDE the candidate tree. The agent's
      // workspace cannot see or edit the transcript.
      const scrubbed = scrubbedEnv({ HELLDESK_EVIDENCE_DIR: evidenceDir });

      if (baselineMissing) {
        status = 'BLOCKED';
        error = 'mission baseline missing; executable gate cannot verify protected paths';
        stderr = error;
      } else if (protectedChanged.length > 0) {
        status = 'BLOCKED';
        error = `protected path(s) changed: ${protectedChanged.slice(0, 20).map((c) => `${c.path} (${c.reason})`).join(', ')}`;
        stderr = error;
      } else {
        try {
          if (spec.browser) {
            const browserResult = await runBrowserGate({
              spec: spec.browser,
              candidateRoot: candidate.worktreePath,
              evidenceDir,
              env: scrubbed.env,
            });
            status = browserResult.status;
            exitCode = browserResult.exitCode;
            durationMs = browserResult.durationMs;
            stdout = browserResult.stdout;
            stderr = browserResult.stderr;
            error = browserResult.browser.error;
            browser = browserResult.browser;
            cwd = candidate.worktreePath;
            commandLabel = `browser-gate:${browserResult.browser.url}`;
          } else if (spec.command) {
            cwd = resolveCwd(candidate.worktreePath, spec.cwd);
            const timeoutMs = Math.min(Math.max(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
            const result = await runBoundedCommand({
              command: spec.command,
              cwd,
              env: scrubbed.env,
              timeoutMs,
              maxOutputBytes: opts.maxOutputBytes ?? MAX_OUTPUT_BYTES,
              signal: opts.signal,
            });
            status = result.status;
            exitCode = result.exitCode;
            durationMs = result.durationMs;
            stdout = result.stdout;
            stderr = result.stderr;
            error = result.error;
          } else {
            throw new Error('gate has neither a command nor a browser spec');
          }
          if (status === 'PASS') {
            missingArtifacts = checkExpectedArtifacts(candidate.worktreePath, spec.expectedArtifacts);
            if (missingArtifacts.length > 0) {
              status = 'FAIL';
              exitCode = exitCode ?? 1;
              stderr += `\n[gate-runner] missing expected artifacts: ${missingArtifacts.join(', ')}`;
            }
          }
        } catch (err) {
          status = 'ERROR';
          error = err instanceof Error ? err.message : String(err);
          stderr = error;
        }
      }

      const finishedAt = new Date().toISOString();
      writeFileSync(stdoutPath, stdout, 'utf8');
      writeFileSync(stderrPath, stderr, 'utf8');
      const stdoutSha = sha256(stdout);
      const stderrSha = sha256(stderr);
      const result = {
        gateKey,
        revisionId: opts.revisionId,
        candidateHash: candidate.candidateHash,
        command: commandLabel,
        cwd: cwd ? normalizeSlashes(relative(candidate.worktreePath, cwd)) || '.' : '.',
        status,
        exitCode,
        durationMs,
        browser,
        stdout: { sha256: stdoutSha, bytes: Buffer.byteLength(stdout, 'utf8') },
        stderr: { sha256: stderrSha, bytes: Buffer.byteLength(stderr, 'utf8') },
        envFingerprint: scrubbed.fingerprint,
        testFileHashes,
        protectedPaths,
        protectedChanged,
        protectedAllowed: allowedChanges,
        baselinePresent: !baselineMissing,
        missingArtifacts,
        error: error ?? null,
        startedAt,
        finishedAt,
      };
      const resultJson = JSON.stringify(result, null, 2);
      writeFileSync(resultPath, resultJson, 'utf8');
      const resultHash = createHash('sha256').update(resultJson).digest('hex');
      const evidence = addEvidence(opts.d, {
        revision_id: opts.revisionId,
        kind: 'execution',
        path: resultPath,
        sha256: resultHash,
        bytes: Buffer.byteLength(resultJson, 'utf8'),
        producer: 'helldesk-gate-runner',
        command: commandLabel,
        exit_code: exitCode ?? undefined,
        metadata: {
          gateKey,
          candidateHash: candidate.candidateHash,
          status,
          durationMs,
          browser,
          stdoutSha256: stdoutSha,
          stderrSha256: stderrSha,
          envFingerprint: scrubbed.fingerprint,
          testFileHashes,
          protectedPaths,
          protectedChanged,
          protectedAllowed: allowedChanges,
          baselinePresent: !baselineMissing,
          missingArtifacts,
          worktree: candidate.worktreePath,
          stdoutPath,
          stderrPath,
        },
      });

      const row = insertGateExecution(opts.d, {
        revision_id: opts.revisionId,
        gate_key: gateKey,
        candidate_hash: candidate.candidateHash,
        command: commandLabel,
        cwd: cwd ? normalizeSlashes(relative(candidate.worktreePath, cwd)) || '.' : null,
        status,
        exit_code: exitCode,
        duration_ms: durationMs,
        stdout_sha256: stdoutSha,
        stderr_sha256: stderrSha,
        stdout_bytes: Buffer.byteLength(stdout, 'utf8'),
        stderr_bytes: Buffer.byteLength(stderr, 'utf8'),
        evidence_artifact_id: evidence.artifact_id,
        env_json: JSON.stringify({ fingerprint: scrubbed.fingerprint }),
        test_file_hashes_json: JSON.stringify(testFileHashes),
        protected_paths_json: JSON.stringify(protectedRecord),
        started_at: startedAt,
        finished_at: finishedAt,
      });
      executions.push(row);
    }
  } finally {
    candidate.cleanup();
  }

  return {
    candidateHash: candidate.candidateHash,
    worktreePath: candidate.worktreePath,
    executions,
  };
}
