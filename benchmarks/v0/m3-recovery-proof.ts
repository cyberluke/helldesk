/**
 * M3 proof — kill the mutation agent mid-execution, restart the durable state,
 * and verify the same revision retries and completes.
 *
 * This uses the production mission controller and the counter fixture:
 *   1. the mutation agent is a real child process; the proof kills it;
 *   2. the controller returns the revision to PLANNED and the mission to ACTIVE
 *      (bounded transient retry, not a stranded MUTATING state);
 *   3. the SQLite DB is closed and reopened (process restart);
 *   4. a fresh repair runner writes the genuine fix;
 *   5. the host executes the gate, the review passes, VERIFIED_10_10.
 *
 * Run from the repository root:
 *   bun run benchmarks/v0/m3-recovery-proof.ts
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../services/helldesk/local/src/db';
import {
  createMissionRequest,
  getMission,
  getRevision,
  isRevisionVerified10,
  latestGateExecution,
  listEvidence,
  listRevisions,
} from '../../services/helldesk/local/src/mission-repository';
import { advanceMission, type ControllerDeps } from '../../services/helldesk/local/src/mission-controller';
import type { MutationRunner, RepairRequest, RepairResult } from '../../services/helldesk/local/src/mutation-runner';
import { captureMissionBaseline } from '../../services/helldesk/local/src/mission-baseline';

const repoRoot = process.cwd();
const fixture = join(repoRoot, 'benchmarks', 'v0', 'fixture');
const runRoot = join(repoRoot, '.local', 'benchmark', 'v0', 'm3-recovery-proof', new Date().toISOString().replace(/[:.]/g, '-'));
const workspace = join(runRoot, 'workspace');
const gateDataDir = join(runRoot, 'gate-data');
const dbPath = join(runRoot, 'proof.db');
const pidFile = join(runRoot, 'agent.pid');
mkdirSync(runRoot, { recursive: true });
cpSync(fixture, workspace, { recursive: true });

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}
git(['init', '-q']);
git(['config', 'user.email', 'proof@localhost']);
git(['config', 'user.name', 'm3-recovery-proof']);
git(['add', '-A']);
git(['commit', '-qm', 'baseline']);

let db = openDb(dbPath);
db.runMigration();
const taskGates = ['functional_correctness'];
const baseline = captureMissionBaseline({ workspacePath: workspace });
const created = createMissionRequest(db, {
  workspaceId: 'ws_m3_recovery_proof',
  objective: 'Fix src/counter.mjs so increment(n) returns n + 1. The repository test is authoritative.',
  taskGates,
  gateCommands: { functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 30_000 } },
  baseline,
  tickets: [{ title: 'B1', objective: 'Repair increment semantics', dependsOn: [] }],
});
if (created.conflict) throw new Error('unexpected idempotency conflict');
const missionId = created.missionId;
const ticketId = created.ticketIds[0]!;

function makeReview(getDb: () => ReturnType<typeof openDb>): ControllerDeps['review'] {
  return async ({ revisionId }) => {
    const exec = latestGateExecution(getDb(), revisionId, 'functional_correctness');
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
}

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

const firstDeps: ControllerDeps = {
  d: db,
  runner: killedRunner,
  taskGates,
  workspacePathFor: () => workspace,
  gateDataDir,
  review: makeReview(() => db),
};

const firstTick = advanceMission(missionId, firstDeps);
const pidDeadline = Date.now() + 10_000;
while (!existsSync(pidFile) && Date.now() < pidDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!existsSync(pidFile)) throw new Error('mutation agent never wrote its PID');
const agentPid = Number(readFileSync(pidFile, 'utf8').trim());
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/PID', String(agentPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
} else {
  try { process.kill(agentPid, 'SIGKILL'); } catch { /* already gone */ }
}
const firstResult = await firstTick;
const deadDeadline = Date.now() + 5_000;
while (Date.now() < deadDeadline) {
  try { process.kill(agentPid, 0); } catch { break; }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const missionAfterKill = getMission(db, missionId);
const revisionsAfterKill = listRevisions(db, ticketId);
const revisionId = revisionsAfterKill[0]!.revision_id;
const revisionAfterKill = getRevision(db, revisionId);

// Durability: close and reopen the same SQLite DB (process restart), then run a
// fresh repair runner against the same mission/revision.
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
const secondDeps: ControllerDeps = {
  d: db,
  runner: repairRunner,
  taskGates,
  workspacePathFor: () => workspace,
  gateDataDir,
  review: makeReview(() => db),
};
let state = 'ACTIVE';
let guard = 0;
while (state !== 'VERIFIED_10_10' && guard < 12) {
  state = (await advanceMission(missionId, secondDeps)).nextState;
  guard += 1;
}

const finalRevision = getRevision(db, revisionId);
const exec = latestGateExecution(db, revisionId, 'functional_correctness');
const evidence = listEvidence(db, revisionId);
const execEvidence = evidence.find((e) => e.kind === 'execution');
const revisions = listRevisions(db, ticketId);
const retryEvents = db.db
  .query<{ payload: string }, []>(`SELECT payload FROM events_outbox WHERE event_type='revision.retry'`)
  .all()
  .map((row) => JSON.parse(row.payload) as { mission_id?: string; revision_id?: string; attempt?: number });
const retry = retryEvents.find((e) => e.mission_id === missionId && e.revision_id === revisionId);

const summary = {
  runRoot,
  missionId,
  agentPid,
  firstTick: firstResult,
  missionAfterKill,
  revisionAfterKill,
  revisionCountAfterKill: revisionsAfterKill.length,
  retry,
  final: {
    missionState: getMission(db, missionId)?.state,
    revisionState: finalRevision?.state,
    revisions: revisions.length,
    execution: exec,
    executionEvidence: execEvidence?.path ?? null,
    verified: isRevisionVerified10(db, revisionId, taskGates),
    repairMutations: mutations,
  },
};
writeFileSync(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('');
console.log('M3 PROOF — killed mutation agent, durable restart, same revision recovered');
console.log(`run dir: ${runRoot}`);
console.log('');
console.log(`mission: ${missionId}`);
console.log(`agent PID: ${agentPid} (killed)`);
console.log(`after kill: mission=${missionAfterKill?.state} revision=${revisionAfterKill?.state} action=${firstResult.action}`);
console.log(`after kill: revision count=${revisionsAfterKill.length} (same revision retried, no duplicate)`);
console.log(`retry event: ${retry ? `attempt ${retry.attempt}` : '(missing)'}`);
console.log('');
console.log('after DB close/reopen + fresh repair runner:');
console.log(`  mission state: ${getMission(db, missionId)?.state}`);
console.log(`  revision state: ${finalRevision?.state}`);
console.log(`  revisions: ${revisions.length}`);
console.log(`  host execution: ${exec?.status} exit=${exec?.exit_code} candidate=${(exec?.candidate_hash ?? '').slice(0, 12)}…`);
console.log(`  execution evidence: ${execEvidence?.path ?? '(missing)'}`);
console.log(`  isRevisionVerified10: ${isRevisionVerified10(db, revisionId, taskGates)}`);
console.log('');

const ok = firstResult.action === 'infra-retry'
  && firstResult.nextState === 'ACTIVE'
  && missionAfterKill?.state === 'ACTIVE'
  && revisionAfterKill?.state === 'PLANNED'
  && revisionsAfterKill.length === 1
  && Boolean(retry)
  && getMission(db, missionId)?.state === 'VERIFIED_10_10'
  && finalRevision?.state === 'VERIFIED_10_10'
  && revisions.length === 1
  && exec?.status === 'PASS'
  && exec?.exit_code === 0
  && isRevisionVerified10(db, revisionId, taskGates);
db.close();
if (!ok) {
  console.error('M3 RECOVERY PROOF FAILED — assertions did not hold.');
  process.exit(1);
}
console.log('M3 RECOVERY PROOF PASSED — killed agent retried the same revision and verified after restart.');
process.exit(0);
