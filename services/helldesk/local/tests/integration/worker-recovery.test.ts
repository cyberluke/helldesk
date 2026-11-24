import { describe, it, expect } from 'bun:test';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db';
import {
  createMissionRequest,
  getMission,
  getRevision,
  isRevisionVerified10,
  latestGateExecution,
  listEvidence,
  listRevisions,
} from '../../src/mission-repository';
import { advanceMission, type ControllerDeps } from '../../src/mission-controller';
import type { MutationRunner, RepairRequest, RepairResult } from '../../src/mutation-runner';
import { captureMissionBaseline } from '../../src/mission-baseline';

/**
 * M3 — kill the mutation agent mid-execution, close/reopen the durable DB, and
 * let the mission retry the SAME revision on a new process. The transient
 * failure must not strand the mission; the retry must execute the real gate and
 * reach VERIFIED_10_10.
 */
const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', '..', 'benchmarks', 'v0', 'fixture');

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8' }).trim();
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidAlive(pid);
}

describe('M3 — killed mutation agent recovers across a durable restart', () => {
  it('retries the same revision after the agent is killed and verifies the repair', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'gt-recovery-'));
    const workspace = join(runRoot, 'workspace');
    const gateDataDir = join(runRoot, 'gate-data');
    const dbPath = join(runRoot, 'recovery.db');
    const pidFile = join(runRoot, 'agent.pid');
    cpSync(FIXTURE, workspace, { recursive: true });
    git(workspace, 'git init -q');
    git(workspace, 'git config user.email test@localhost');
    git(workspace, 'git config user.name test');
    git(workspace, 'git add -A && git commit -qm baseline');

    let db = openDb(dbPath);
    db.runMigration();
    try {
      const taskGates = ['functional_correctness'];
      const baseline = captureMissionBaseline({ workspacePath: workspace });
      const created = createMissionRequest(db, {
        workspaceId: 'ws_recovery',
        objective: 'Fix increment(n) so it returns n + 1; the repository test is authoritative.',
        taskGates,
        gateCommands: { functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 30_000 } },
        baseline,
        tickets: [{ title: 'B1', objective: 'Repair increment', dependsOn: [] }],
      });
      if (created.conflict) throw new Error('unexpected idempotency conflict');
      const { missionId, ticketIds } = created;
      const ticketId = ticketIds[0]!;

      // Phase 1: spawn a real child process as the "mutation agent", let the
      // controller enter MUTATING, then kill the agent tree.
      const killedRunner: MutationRunner = {
        transport: 'killable-child',
        provider: 'fixture',
        model: 'fixture',
        agent: 'fixture',
        writeCapability: true,
        shellCapability: true,
        async execute(_request: RepairRequest): Promise<RepairResult> {
          const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          writeFileSync(pidFile, String(child.pid), 'utf8');
          await new Promise<void>((resolve) => child.on('exit', () => resolve()));
          throw new Error('simulated mutation agent kill');
        },
      };
      const review: ControllerDeps['review'] = async ({ revisionId }) => {
        const exec = latestGateExecution(db, revisionId, 'functional_correctness');
        const refs = exec ? [exec.evidence_artifact_id] : [];
        return {
          verdict: exec?.status === 'PASS' ? 'PASS' : 'FINDINGS',
          mandatoryGates: taskGates,
          gatePassed: { functional_correctness: exec?.status === 'PASS' },
          gateEvidenceRefs: { functional_correctness: refs },
          findings: exec?.status === 'PASS' ? [] : ['[BLOCKER] host execution failed'],
          evidenceResolved: exec?.status === 'PASS',
          snapshotId: 'snap-recovery',
          reviewJobId: 'job-recovery',
        };
      };
      const firstDeps: ControllerDeps = {
        d: db,
        runner: killedRunner,
        taskGates,
        workspacePathFor: () => workspace,
        gateDataDir,
        review,
      };

      const firstTick = advanceMission(missionId, firstDeps);
      const pidDeadline = Date.now() + 10_000;
      while (!existsSync(pidFile) && Date.now() < pidDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isFinite(pid)).toBe(true);
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      const firstResult = await firstTick;
      expect(firstResult.nextState).toBe('ACTIVE');
      expect(firstResult.action).toBe('infra-retry');
      expect(await waitForDead(pid)).toBe(true);

      const missionAfterKill = getMission(db, missionId);
      expect(missionAfterKill?.state).toBe('ACTIVE');
      const revisionsAfterKill = listRevisions(db, ticketId);
      expect(revisionsAfterKill).toHaveLength(1);
      const revisionId = revisionsAfterKill[0]!.revision_id;
      expect(getRevision(db, revisionId)?.state).toBe('PLANNED');

      // Phase 2: simulate a process restart: close and reopen the same DB, with
      // a fresh runner. The mission/revision must survive and retry.
      db.close();
      db = openDb(dbPath);
      db.runMigration();

      let mutations = 0;
      const repairRunner: MutationRunner = {
        transport: 'repair-after-restart',
        provider: 'fixture',
        model: 'fixture',
        agent: 'fixture',
        writeCapability: true,
        shellCapability: true,
        async execute(_request: RepairRequest): Promise<RepairResult> {
          mutations += 1;
          writeFileSync(
            join(workspace, 'src', 'counter.mjs'),
            'export function increment(n) {\n  return n + 1;\n}\n',
            'utf8',
          );
          return {
            outcome: 'CHANGED',
            changedFiles: ['src/counter.mjs'],
            commandsExecuted: ['write src/counter.mjs'],
            artifactsProduced: [],
            workspaceFingerprintBefore: 'K1',
            workspaceFingerprintAfter: 'K2',
          };
        },
      };
      const review2: ControllerDeps['review'] = async ({ revisionId: rev }) => {
        const exec = latestGateExecution(db, rev, 'functional_correctness');
        const refs = exec ? [exec.evidence_artifact_id] : [];
        return {
          verdict: exec?.status === 'PASS' ? 'PASS' : 'FINDINGS',
          mandatoryGates: taskGates,
          gatePassed: { functional_correctness: exec?.status === 'PASS' },
          gateEvidenceRefs: { functional_correctness: refs },
          findings: exec?.status === 'PASS' ? [] : ['[BLOCKER] execution failed'],
          evidenceResolved: exec?.status === 'PASS',
          snapshotId: 'snap-recovery-2',
          reviewJobId: 'job-recovery-2',
        };
      };
      const secondDeps: ControllerDeps = {
        d: db,
        runner: repairRunner,
        taskGates,
        workspacePathFor: () => workspace,
        gateDataDir,
        review: review2,
      };
      let state = 'ACTIVE';
      let guard = 0;
      while (state !== 'VERIFIED_10_10' && guard < 12) {
        state = (await advanceMission(missionId, secondDeps)).nextState;
        guard += 1;
      }
      expect(state).toBe('VERIFIED_10_10');
      expect(mutations).toBeGreaterThanOrEqual(1);
      expect(getMission(db, missionId)?.state).toBe('VERIFIED_10_10');

      const revisions = listRevisions(db, ticketId);
      expect(revisions).toHaveLength(1); // same revision retried, not a new one
      expect(revisions[0]!.revision_id).toBe(revisionId);
      expect(getRevision(db, revisionId)?.state).toBe('VERIFIED_10_10');
      const exec = latestGateExecution(db, revisionId, 'functional_correctness');
      expect(exec?.status).toBe('PASS');
      expect(exec?.exit_code).toBe(0);
      expect(isRevisionVerified10(db, revisionId, taskGates)).toBe(true);
      expect(listEvidence(db, revisionId).some((e) => e.kind === 'execution' && e.exit_code === 0)).toBe(true);

      // The durable retry event exists and references this mission.
      const retryEvents = db.db
        .query<{ payload: string }, []>(`SELECT payload FROM events_outbox WHERE event_type='revision.retry'`)
        .all()
        .map((row) => JSON.parse(row.payload) as { mission_id?: string; revision_id?: string });
      expect(retryEvents.some((e) => e.mission_id === missionId && e.revision_id === revisionId)).toBe(true);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60_000);
});
