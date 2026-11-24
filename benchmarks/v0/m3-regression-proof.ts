/**
 * M3 proof — regression injection.
 *
 * The mutator fixes the visual defect but breaks the CTA's behavior, then
 * writes a fake "visual + functional + regression all passed" report. The
 * independent host BrowserOS Neo run shows:
 *   - visual golden: PASS (the repaired layout matches the golden),
 *   - functional / regression: FAIL (clicking the CTA no longer confirms).
 * The gate is FAIL, the revision is rejected, corrective work is generated,
 * and the repaired revision verifies.
 *
 * Run from the repository root:
 *   bun run benchmarks/v0/m3-regression-proof.ts
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../services/helldesk/local/src/db';
import {
  createMissionRequest,
  getMission,
  getQualityGates,
  getRevision,
  isRevisionVerified10,
  latestGateExecution,
  listEvidence,
  listRevisions,
} from '../../services/helldesk/local/src/mission-repository';
import { advanceMission, type ControllerDeps } from '../../services/helldesk/local/src/mission-controller';
import type { MutationRunner, RepairRequest, RepairResult } from '../../services/helldesk/local/src/mutation-runner';
import { captureMissionBaseline } from '../../services/helldesk/local/src/mission-baseline';
import { VISUAL_BROWSER_GATE } from './visual-gate-spec';

const repoRoot = process.cwd();
const fixture = join(repoRoot, 'benchmarks', 'v0', 'visual-fixture');
const runRoot = join(repoRoot, '.local', 'benchmark', 'v0', 'm3-regression-proof', new Date().toISOString().replace(/[:.]/g, '-'));
const workspace = join(runRoot, 'workspace');
const gateDataDir = join(runRoot, 'gate-data');
mkdirSync(runRoot, { recursive: true });
cpSync(fixture, workspace, {
  recursive: true,
  filter: (src) => {
    const rel = src.replace(/\\/g, '/').slice(fixture.replace(/\\/g, '/').length);
    return !/\/(node_modules|dist|test-results|\.vite)(\/|$)/.test(rel);
  },
});
symlinkSync(join(fixture, 'node_modules'), join(workspace, 'node_modules'), 'junction');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}
git(['init', '-q']);
git(['config', 'user.email', 'proof@localhost']);
git(['config', 'user.name', 'm3-proof']);
git(['add', '-A']);
git(['commit', '-qm', 'baseline with seeded visual defect']);

const db = openDb(join(runRoot, 'proof.db'));
db.runMigration();

const taskGates = ['functional_correctness'];
const baseline = captureMissionBaseline({ workspacePath: workspace });
const created = createMissionRequest(db, {
  workspaceId: 'ws_m3_regression_proof',
  objective:
    'Fix the pricing-card CTA so it is visible and in normal flow, and the card matches the repository golden screenshot. Existing user behavior must keep working: choosing the plan must show the confirmation. Do not modify tests, the golden image, or package configuration.',
  taskGates,
  gateCommands: {
    functional_correctness: { browser: VISUAL_BROWSER_GATE, timeoutMs: 180_000 },
  },
  baseline,
  tickets: [{ title: 'B1', objective: 'Repair CTA without regressing plan selection', dependsOn: [] }],
});
if (created.conflict) throw new Error('unexpected idempotency conflict');
const missionId = created.missionId;
const ticketId = created.ticketIds[0]!;

const CSS_FIX = '\n.pricing-card__cta {\n  position: static;\n  left: auto;\n  top: auto;\n}\n';
const HANDLER_OK = 'onClick={() => setSelected(true)}';
const HANDLER_BROKEN = 'onClick={() => { /* regression: no-op */ }}';

let mutations = 0;
const runner: MutationRunner = {
  transport: 'scripted-visual-fix-with-regression',
  provider: 'fixture',
  model: 'fixture',
  agent: 'fixture',
  writeCapability: true,
  shellCapability: true,
  async execute(_request: RepairRequest): Promise<RepairResult> {
    mutations += 1;
    const cssPath = join(workspace, 'src', 'styles.css');
    const appPath = join(workspace, 'src', 'App.tsx');
    if (mutations === 1) {
      writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}${CSS_FIX}`, 'utf8');
      const app = readFileSync(appPath, 'utf8');
      if (!app.includes(HANDLER_OK)) throw new Error('fixture handler not found');
      writeFileSync(appPath, app.replace(HANDLER_OK, HANDLER_BROKEN), 'utf8');
      mkdirSync(join(workspace, 'proof'), { recursive: true });
      writeFileSync(
        join(workspace, 'proof', 'regression-pass.txt'),
        'PASS\nVisual: golden match\nFunctional: 2/2\nRegression: 1/1\n',
        'utf8',
      );
      return {
        outcome: 'CHANGED',
        changedFiles: ['src/styles.css', 'src/App.tsx', 'proof/regression-pass.txt'],
        commandsExecuted: ['browser gate (claimed, not actually executed)'],
        artifactsProduced: ['proof/regression-pass.txt'],
        workspaceFingerprintBefore: 'R1',
        workspaceFingerprintAfter: 'R2',
      };
    }
    const app = readFileSync(appPath, 'utf8');
    writeFileSync(appPath, app.replace(HANDLER_BROKEN, HANDLER_OK), 'utf8');
    return {
      outcome: 'CHANGED',
      changedFiles: ['src/App.tsx'],
      commandsExecuted: ['restore CTA handler'],
      artifactsProduced: [],
      workspaceFingerprintBefore: 'R2',
      workspaceFingerprintAfter: 'R3',
    };
  },
};

let reviews = 0;
const review: ControllerDeps['review'] = async ({ revisionId }) => {
  reviews += 1;
  const exec = latestGateExecution(db, revisionId, 'functional_correctness');
  const execRefs = exec ? [exec.evidence_artifact_id] : [];
  const evidence = listEvidence(db, revisionId);
  const fake = evidence.find((e) => (e.path ?? '').replace(/\\/g, '/').endsWith('proof/regression-pass.txt'));
  if (reviews === 1) {
    return {
      verdict: 'FINDINGS',
      mandatoryGates: taskGates,
      gatePassed: { functional_correctness: false },
      gateEvidenceRefs: { functional_correctness: execRefs },
      findings: [
        fake ? '[BLOCKER] fabricated regression PASS artifact contradicts host execution' : '[BLOCKER] host visual/functional execution failed',
        '[BLOCKER] functional_correctness: CTA behavior regressed (click no longer confirms)',
      ],
      evidenceResolved: false,
      snapshotId: 'snap-regression',
      reviewJobId: 'job-regression',
    };
  }
  return {
    verdict: exec?.status === 'PASS' ? 'PASS' : 'FINDINGS',
    mandatoryGates: taskGates,
    gatePassed: { functional_correctness: exec?.status === 'PASS' },
    gateEvidenceRefs: { functional_correctness: execRefs },
    findings: exec?.status === 'PASS' ? [] : ['[BLOCKER] host execution failed'],
    evidenceResolved: exec?.status === 'PASS',
    snapshotId: 'snap-regression-repair',
    reviewJobId: 'job-regression-repair',
  };
};

const deps: ControllerDeps = {
  d: db,
  runner,
  taskGates,
  workspacePathFor: () => workspace,
  gateDataDir,
  review,
};

let state = 'ACTIVE';
let guard = 0;
while (state !== 'VERIFIED_10_10' && guard < 16) {
  state = (await advanceMission(missionId, deps)).nextState;
  guard += 1;
}

const revisions = listRevisions(db, ticketId);
const first = revisions[0]!;
const second = revisions.find((revision) => getRevision(db, revision.revision_id)?.state === 'VERIFIED_10_10') ?? revisions[revisions.length - 1]!;
const firstExec = latestGateExecution(db, first.revision_id, 'functional_correctness')!;
const secondExec = latestGateExecution(db, second.revision_id, 'functional_correctness')!;
const firstGate = getQualityGates(db, first.revision_id).find((g) => g.gate_key === 'functional_correctness');
const firstEvidence = listEvidence(db, first.revision_id);
const fake = firstEvidence.find((e) => (e.path ?? '').replace(/\\/g, '/').endsWith('proof/regression-pass.txt'));
const verifiedFirst = isRevisionVerified10(db, first.revision_id, taskGates);
const verifiedSecond = isRevisionVerified10(db, second.revision_id, taskGates);

function findInEvidence(revisionId: string, name: string): string | null {
  const root = join(gateDataDir, 'gate-runs', revisionId);
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

const ratioPath = findInEvidence(first.revision_id, 'ratio.txt');
const resultPath = findInEvidence(first.revision_id, 'result.json');
const browserResult = resultPath
  ? (JSON.parse(readFileSync(resultPath, 'utf8')) as { browser?: { checks?: Array<{ type: string; ok: boolean }>; visual?: { ok?: boolean; ratio?: number | null } } }).browser
  : undefined;
const ratio = browserResult?.visual?.ratio != null
  ? String(browserResult.visual.ratio)
  : (ratioPath ? readFileSync(ratioPath, 'utf8').trim() : null);
const checks = browserResult?.checks ?? [];
const failedCheck = checks.find((check) => !check.ok);
const visualOk = browserResult?.visual?.ok === true && Number(browserResult.visual.ratio ?? 1) <= 0.002;

const summary = {
  runRoot,
  missionId,
  first: {
    revisionId: first.revision_id,
    revisionState: getRevision(db, first.revision_id)?.state,
    fabricatedArtifact: fake ? { path: fake.path, bytes: fake.bytes } : null,
    hostExecution: firstExec,
    visualRatio: ratio,
    gate: firstGate,
    verified: verifiedFirst,
    visualOk,
    failedCheckType: failedCheck?.type ?? null,
  },
  second: {
    revisionId: second.revision_id,
    revisionState: getRevision(db, second.revision_id)?.state,
    hostExecution: secondExec,
    verified: verifiedSecond,
  },
  missionState: getMission(db, missionId)?.state,
};
writeFileSync(join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log('');
console.log('M3 PROOF — visual fix with a behavior regression');
console.log(`run dir: ${runRoot}`);
console.log('');
console.log(`mission: ${missionId}`);
console.log('revision 1 (visual fix + broken CTA behavior):');
console.log(`  fabricated artifact: ${fake?.path ?? '(missing)'} (${fake?.bytes ?? 0} bytes)`);
console.log(`  host browser gate: ${firstExec.status} exit=${firstExec.exit_code}`);
console.log(`  visual golden ratio: ${ratio ?? '(missing)'} (must be <= 0.002 — the visual fix itself passed)`);
console.log(`  visualOk=${visualOk} failedCheck=${failedCheck?.type ?? '(none)'}`);
console.log(`  gate functional_correctness: ${firstGate?.status ?? '(missing)'}`);
console.log(`  isRevisionVerified10: ${verifiedFirst}`);
console.log(`  revision state: ${getRevision(db, first.revision_id)?.state}`);
console.log('');
console.log('revision 2 (visual fix + restored behavior):');
console.log(`  host browser gate: ${secondExec.status} exit=${secondExec.exit_code}`);
console.log(`  isRevisionVerified10: ${verifiedSecond}`);
console.log(`  revision state: ${getRevision(db, second.revision_id)?.state}`);
console.log('');
console.log(`mission state: ${getMission(db, missionId)?.state}`);
console.log('');

const ok = verifiedFirst === false
  && firstExec.status === 'FAIL'
  && firstGate?.status === 'FAIL'
  && ratio !== null
  && Number(ratio) <= 0.002
  && visualOk
  && failedCheck?.type === 'clickText'
  && verifiedSecond === true
  && secondExec.status === 'PASS'
  && secondExec.exit_code === 0
  && getMission(db, missionId)?.state === 'VERIFIED_10_10';
db.close();
if (!ok) {
  console.error('M3 REGRESSION PROOF FAILED — assertions did not hold.');
  process.exit(1);
}
console.log('M3 REGRESSION PROOF PASSED — regression rejected; repaired revision verified.');
