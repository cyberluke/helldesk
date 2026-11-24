import { describe, it, expect, afterEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeTestDb } from '../helpers';
import {
  addTicket,
  createMission,
  createRevision,
  isRevisionVerified10,
  latestGateExecution,
  listEvidence,
  listGateExecutions,
  type GateCommandSpec,
} from '../../src/mission-repository';
import { runGateExecutions, workspaceTreeIdentity } from '../../src/gate-runner';
import { captureMissionBaseline } from '../../src/mission-baseline';

/**
 * Isolation + provenance tests for the production gate runner.
 *
 * These are deliberately small and deterministic: a git workspace, a Node
 * command, and a temp evidence dir outside the workspace. They prove the
 * non-negotiable mechanics the M1 proof relies on:
 *   - scrubbed environment (no host secrets)
 *   - timeout + full process-tree termination
 *   - protected test-file change => BLOCKED (never PASS)
 *   - evidence/transcripts live outside the source workspace
 *   - re-running the same candidate reuses the revision-bound execution
 */

interface Ctx {
  workspace: string;
  dataDir: string;
  h: ReturnType<typeof makeTestDb>;
  missionId: string;
  ticketId: string;
  revisionId: string;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try { fn(); } catch { /* best effort */ }
  }
});

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8' }).trim();
}

function setup(files: Record<string, string>, opts?: {
  gateCommands?: Record<string, GateCommandSpec>;
  protectedPaths?: string[];
  allowProtectedPaths?: string[];
}): Ctx {
  const h = makeTestDb();
  const workspace = mkdtempSync(join(tmpdir(), 'gt-gate-unit-ws-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-gate-unit-data-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(workspace, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  git(workspace, 'git init -q');
  git(workspace, 'git config user.email test@localhost');
  git(workspace, 'git config user.name test');
  git(workspace, 'git add -A && git commit -qm baseline');

  const baseline = captureMissionBaseline({
    workspacePath: workspace,
    protectedPaths: opts?.protectedPaths,
    allowProtectedPaths: opts?.allowProtectedPaths,
  });
  const gateCommands = opts?.gateCommands;
  const mission = createMission(h.d, {
    workspace_id: 'ws_gate_unit',
    objective: 'gate runner isolation',
    taskGates: gateCommands ? Object.keys(gateCommands) : ['functional_correctness'],
    gateCommands,
    baseline,
  });
  const ticket = addTicket(h.d, mission.mission_id, { title: 'B1', objective: 'gate runner isolation' });
  const revision = createRevision(h.d, { ticket_id: ticket.ticket_id });

  cleanup.push(() => h.close());
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));

  return {
    workspace,
    dataDir,
    h,
    missionId: mission.mission_id,
    ticketId: ticket.ticket_id,
    revisionId: revision.revision_id,
  };
}

const baseFiles: Record<string, string> = {
  'src/counter.mjs': 'export function increment(n) { return n + 1; }\n',
  'test/counter.test.mjs':
    "import { increment } from '../src/counter.mjs';\nif (increment(1) !== 2) process.exit(1);\nconsole.log('PASS');\n",
};

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !isPidAlive(pid);
}

describe('gate-runner — isolation and provenance', () => {
  it('scrubs host secrets, stores evidence outside the workspace, and reuses the same candidate execution', async () => {
    const ctx = setup({
      ...baseFiles,
      'test/env.mjs': "console.log(process.env.HELLDESK_TEST_SECRET ?? 'absent');\n",
    });
    process.env.HELLDESK_TEST_SECRET = 'topsecret';
    process.env.OPENAI_API_KEY = 'sk-should-not-leak';
    try {
      const commands: Record<string, GateCommandSpec> = {
        functional_correctness: { command: 'node test/env.mjs', timeoutMs: 20_000 },
      };
      const first = await runGateExecutions({
        d: ctx.h.d,
        missionId: ctx.missionId,
        revisionId: ctx.revisionId,
        workspacePath: ctx.workspace,
        dataDir: ctx.dataDir,
        commands,
      });
      expect(first.executions).toHaveLength(1);
      const exec = first.executions[0]!;
      expect(exec.status).toBe('PASS');
      expect(exec.exit_code).toBe(0);
      expect(exec.candidate_hash.length).toBeGreaterThanOrEqual(40);

      const evidence = listEvidence(ctx.h.d, ctx.revisionId);
      const executionEvidence = evidence.find((e) => e.kind === 'execution');
      expect(executionEvidence).toBeDefined();
      expect(executionEvidence!.bytes).toBeGreaterThan(0);
      expect((executionEvidence!.path ?? '').replace(/\\/g, '/')).toContain('/gate-runs/');
      expect((executionEvidence!.path ?? '').replace(/\\/g, '/').startsWith(ctx.workspace.replace(/\\/g, '/'))).toBe(false);

      // The stdout transcript records the scrubbed result, not the host secret.
      const stdoutPath = join(dirname(executionEvidence!.path!), 'stdout.log');
      const stdoutText = readFileSync(stdoutPath, 'utf8');
      expect(stdoutText).toContain('absent');
      expect(stdoutText).not.toContain('topsecret');
      const resultJson = readFileSync(executionEvidence!.path!, 'utf8');
      expect(resultJson).not.toContain('topsecret');
      expect(exec.test_file_hashes_json).toContain('test/counter.test.mjs');

      // Idempotent per (revision, gate, candidate hash): no duplicate run.
      const second = await runGateExecutions({
        d: ctx.h.d,
        missionId: ctx.missionId,
        revisionId: ctx.revisionId,
        workspacePath: ctx.workspace,
        dataDir: ctx.dataDir,
        commands,
      });
      expect(second.executions[0]!.gate_execution_id).toBe(exec.gate_execution_id);
      expect(listGateExecutions(ctx.h.d, ctx.revisionId)).toHaveLength(1);
    } finally {
      delete process.env.HELLDESK_TEST_SECRET;
      delete process.env.OPENAI_API_KEY;
    }
  }, 45_000);

  it('marks a changed protected test file BLOCKED even when the modified test would pass', async () => {
    const ctx = setup(baseFiles);
    // The mutator tries to make the gate pass by editing the test.
    writeFileSync(join(ctx.workspace, 'test', 'counter.test.mjs'), 'console.log("PASS");\n', 'utf8');
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 20_000 },
    };
    const result = await runGateExecutions({
      d: ctx.h.d,
      missionId: ctx.missionId,
      revisionId: ctx.revisionId,
      workspacePath: ctx.workspace,
      dataDir: ctx.dataDir,
      commands,
    });
    const exec = result.executions[0]!;
    expect(exec.status).toBe('BLOCKED');
    expect(exec.exit_code).toBeNull();
    expect(exec.protected_paths_json).toContain('test/counter.test.mjs');
    expect(isRevisionVerified10(ctx.h.d, ctx.revisionId, ['functional_correctness'])).toBe(false);
  }, 45_000);

  it('blocks a COMMITTED protected-test tamper that would pass (baseline, not HEAD)', async () => {
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 20_000 },
    };
    const ctx = setup(baseFiles, { gateCommands: commands });
    // Replace the authoritative test with a guaranteed PASS and COMMIT it.
    // A current-HEAD comparison would see no diff; the immutable baseline must
    // still reject the revision.
    writeFileSync(join(ctx.workspace, 'test', 'counter.test.mjs'), 'console.log("PASS");\n', 'utf8');
    git(ctx.workspace, 'git add -A && git commit -qm "tamper protected test"');

    const result = await runGateExecutions({
      d: ctx.h.d,
      missionId: ctx.missionId,
      revisionId: ctx.revisionId,
      workspacePath: ctx.workspace,
      dataDir: ctx.dataDir,
      commands,
    });
    const exec = result.executions[0]!;
    expect(exec.status).toBe('BLOCKED');
    expect(exec.exit_code).toBeNull();
    expect(exec.protected_paths_json).toContain('test/counter.test.mjs');
    expect(exec.protected_paths_json).toContain('modified');
    expect(isRevisionVerified10(ctx.h.d, ctx.revisionId, ['functional_correctness'])).toBe(false);
  }, 45_000);

  it('blocks committed deletion and rename of protected test files', async () => {
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 20_000 },
    };
    const deleted = setup(baseFiles, { gateCommands: commands });
    rmSync(join(deleted.workspace, 'test', 'counter.test.mjs'), { force: true });
    git(deleted.workspace, 'git add -A && git commit -qm "delete protected test"');
    const deleteResult = await runGateExecutions({
      d: deleted.h.d,
      missionId: deleted.missionId,
      revisionId: deleted.revisionId,
      workspacePath: deleted.workspace,
      dataDir: deleted.dataDir,
      commands,
    });
    expect(deleteResult.executions[0]!.status).toBe('BLOCKED');
    expect(deleteResult.executions[0]!.protected_paths_json).toContain('deleted');

    const renamed = setup(baseFiles, { gateCommands: commands });
    git(renamed.workspace, 'git mv test/counter.test.mjs test/counter-renamed.test.mjs');
    git(renamed.workspace, 'git add -A && git commit -qm "rename protected test"');
    const renameResult = await runGateExecutions({
      d: renamed.h.d,
      missionId: renamed.missionId,
      revisionId: renamed.revisionId,
      workspacePath: renamed.workspace,
      dataDir: renamed.dataDir,
      commands,
    });
    const renameExec = renameResult.executions[0]!;
    expect(renameExec.status).toBe('BLOCKED');
    expect(renameExec.protected_paths_json).toContain('test/counter.test.mjs');
    expect(renameExec.protected_paths_json).toContain('test/counter-renamed.test.mjs');
  }, 45_000);

  it('blocks a protected test replaced by a symlink (symlink identity is compared)', async () => {
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 20_000 },
    };
    const ctx = setup(baseFiles, { gateCommands: commands });
    const testPath = join(ctx.workspace, 'test', 'counter.test.mjs');
    const target = join(ctx.workspace, 'test', 'always-pass.mjs');
    writeFileSync(target, 'console.log("PASS");\n', 'utf8');
    rmSync(testPath, { force: true });
    try {
      symlinkSync(target, testPath, 'file');
    } catch {
      // Windows without symlink privilege: the comparison still covers the
      // mode change if the symlink could be created. The production code
      // hashes symlink targets; this environment normally allows it.
      return;
    }
    git(ctx.workspace, 'git add -A && git commit -qm "symlink tamper"');
    const result = await runGateExecutions({
      d: ctx.h.d,
      missionId: ctx.missionId,
      revisionId: ctx.revisionId,
      workspacePath: ctx.workspace,
      dataDir: ctx.dataDir,
      commands,
    });
    const exec = result.executions[0]!;
    expect(exec.status).toBe('BLOCKED');
    expect(exec.exit_code).toBeNull();
    expect(exec.protected_paths_json).toContain('test/counter.test.mjs');
  }, 45_000);

  it('allows an explicitly authorized protected-file change', async () => {
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 20_000 },
    };
    const ctx = setup(baseFiles, {
      gateCommands: commands,
      allowProtectedPaths: ['test/counter.test.mjs'],
    });
    writeFileSync(join(ctx.workspace, 'test', 'counter.test.mjs'), 'console.log("PASS");\n', 'utf8');
    git(ctx.workspace, 'git add -A && git commit -qm "authorized test update"');
    const result = await runGateExecutions({
      d: ctx.h.d,
      missionId: ctx.missionId,
      revisionId: ctx.revisionId,
      workspacePath: ctx.workspace,
      dataDir: ctx.dataDir,
      commands,
    });
    const exec = result.executions[0]!;
    expect(exec.status).toBe('PASS');
    expect(exec.exit_code).toBe(0);
    expect(exec.protected_paths_json).toContain('"allowed"');
  }, 45_000);

  it('terminates the full process tree on timeout and never reports PASS', async () => {
    const ctx = setup({
      ...baseFiles,
      'test/linger.mjs': [
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
        "console.log(`PID=${child.pid}`);",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    });
    const commands: Record<string, GateCommandSpec> = {
      functional_correctness: {
        command: 'node test/linger.mjs',
        timeoutMs: 1_500,
      },
    };
    const result = await runGateExecutions({
      d: ctx.h.d,
      missionId: ctx.missionId,
      revisionId: ctx.revisionId,
      workspacePath: ctx.workspace,
      dataDir: ctx.dataDir,
      commands,
    });
    const exec = result.executions[0]!;
    expect(exec.status).toBe('TIMEOUT');
    expect(exec.status).not.toBe('PASS');
    const evidence = listEvidence(ctx.h.d, ctx.revisionId).find((e) => e.kind === 'execution');
    expect(evidence).toBeDefined();
    const stdoutText = readFileSync(join(dirname(evidence!.path!), 'stdout.log'), 'utf8');
    const match = /PID=(\d+)/.exec(stdoutText);
    expect(match).not.toBeNull();
    const pid = Number(match![1]);
    expect(Number.isFinite(pid)).toBe(true);
    expect(await waitForDead(pid)).toBe(true);
    expect(latestGateExecution(ctx.h.d, ctx.revisionId, 'functional_correctness')?.status).toBe('TIMEOUT');
  }, 45_000);
});

describe('gate-runner — candidate identity (evidence-drift guard)', () => {
  it('binds the EXACT working-tree content and changes when a writer edits it', () => {
    const ctx = setup(baseFiles);
    const clean = workspaceTreeIdentity(ctx.workspace);
    expect(clean.ok).toBe(true);
    expect(clean.hash).toBe(git(ctx.workspace, 'git show -s --format=%T HEAD'));
    expect(workspaceTreeIdentity(ctx.workspace).hash).toBe(clean.hash);

    // A writer that edits after the gates ran moves the identity: this is the
    // M6 evidence-drift defect the controller must fail closed on.
    writeFileSync(join(ctx.workspace, 'src', 'counter.mjs'), 'export function increment(n) { return n + 2; }\n', 'utf8');
    const dirty = workspaceTreeIdentity(ctx.workspace);
    expect(dirty.ok).toBe(true);
    expect(dirty.hash).not.toBe(clean.hash);

    // .gitignore'd content is NOT part of the candidate identity.
    writeFileSync(join(ctx.workspace, '.gitignore'), 'node_modules/\n', 'utf8');
    git(ctx.workspace, 'git add .gitignore && git commit -qm ignore');
    const beforeIgnored = workspaceTreeIdentity(ctx.workspace).hash;
    mkdirSync(join(ctx.workspace, 'node_modules'), { recursive: true });
    writeFileSync(join(ctx.workspace, 'node_modules', 'x.js'), 'ignored', 'utf8');
    const ignored = workspaceTreeIdentity(ctx.workspace);
    expect(ignored.reason ?? 'ok').toBe('ok');
    expect(ignored.hash).toBe(beforeIgnored);
  }, 20_000);

  it('reports not-a-git-worktree instead of inventing an identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-gate-nogit-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const identity = workspaceTreeIdentity(dir);
    expect(identity.ok).toBe(false);
    expect(identity.hash).toBeNull();
    expect(identity.reason).toBe('not-a-git-worktree');
  });
});