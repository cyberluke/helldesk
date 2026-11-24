/**
 * Verify the HELLDESK Adversarial Multimodal Benchmark v0 results.
 *
 * Reads the proof summaries AND the raw proof SQLite databases under
 * `.local/benchmark/v0/` (gitignored, produced on this machine), verifies that
 * every claimed outcome is backed by an executed gate row and an execution
 * evidence artifact, checks the M4 BrowserOS page captures and video, and
 * confirms the Playwright removal.
 *
 * Run from the repository root:
 *   bun run benchmarks/v0/verify-results.ts
 *
 * Writes `benchmarks/v0/results.json` with the verified result summary.
 */
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const benchmarkDir = import.meta.dir;
const repoRoot = join(benchmarkDir, '..', '..');
const localRoot = join(repoRoot, '.local', 'benchmark', 'v0');
const mediaRoot = join(benchmarkDir, 'dashboard', 'media');

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`);
}

function check(id: string, fn: () => string): void {
  try {
    record(id, true, fn());
  } catch (err) {
    record(id, false, err instanceof Error ? err.message : String(err));
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) fail(`missing ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`not a JSON object: ${path}`);
  return parsed as Record<string, unknown>;
}

function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function expectAt(root: unknown, path: string, expected: unknown): void {
  const actual = at(root, path);
  if (actual !== expected) fail(`${path}: expected ${text(expected)}, got ${text(actual)}`);
}

function expectNumber(root: unknown, path: string, expected: number): void {
  const actual = at(root, path);
  if (typeof actual !== 'number' || actual !== expected) fail(`${path}: expected number ${expected}, got ${text(actual)}`);
}

function expectStringIncludes(root: unknown, path: string, expected: string): void {
  const actual = at(root, path);
  if (typeof actual !== 'string' || !actual.includes(expected)) fail(`${path}: expected to include ${expected}, got ${text(actual)}`);
}

function requireString(root: unknown, path: string): string {
  const actual = at(root, path);
  if (typeof actual !== 'string' || actual.length === 0) fail(`${path}: expected non-empty string, got ${text(actual)}`);
  return actual;
}

interface ProofLeg {
  label: string;
  revisionPath: string;
  revisionStatePath: string;
  executionStatusPath: string;
  executionExitPath: string;
  verifiedPath: string;
  gateKey: string;
  expectedRevisionState: string;
  expectedExecutionStatus: 'PASS' | 'FAIL';
  expectedExitCode: number;
  expectedVerified: boolean;
}

function verifyProofDb(runRoot: string, summary: Record<string, unknown>, legs: ProofLeg[], missionPath: string): string {
  const dbPath = join(runRoot, 'proof.db');
  if (!existsSync(dbPath)) fail(`missing proof DB ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  try {
    const missionId = requireString(summary, 'missionId');
    const expectedMissionState = requireString(summary, missionPath);
    const mission = db
      .query<{ state: string }, [string]>('SELECT state FROM autonomy_missions WHERE mission_id = ?')
      .get(missionId);
    if (mission?.state !== expectedMissionState) {
      fail(`mission ${missionId}: DB state ${mission?.state ?? 'missing'} != summary ${expectedMissionState}`);
    }
    for (const leg of legs) {
      const revisionId = requireString(summary, leg.revisionPath);
      const expectedRevision = requireString(summary, leg.revisionStatePath);
      if (expectedRevision !== leg.expectedRevisionState) {
        fail(`${leg.label}: summary revision ${expectedRevision} != expected ${leg.expectedRevisionState}`);
      }
      const revision = db
        .query<{ state: string }, [string]>('SELECT state FROM ticket_revisions WHERE revision_id = ?')
        .get(revisionId);
      if (revision?.state !== leg.expectedRevisionState) {
        fail(`${leg.label} ${revisionId}: DB revision ${revision?.state ?? 'missing'} != ${leg.expectedRevisionState}`);
      }
      const execution = db
        .query<{ status: string; exit_code: number | null; evidence_artifact_id: string | null }, [string, string]>(
          `SELECT status, exit_code, evidence_artifact_id FROM gate_executions
           WHERE revision_id = ? AND gate_key = ?
           ORDER BY started_at ASC LIMIT 1`,
        )
        .get(revisionId, leg.gateKey);
      if (execution?.status !== leg.expectedExecutionStatus) {
        fail(`${leg.label}: DB gate ${execution?.status ?? 'missing'} != ${leg.expectedExecutionStatus}`);
      }
      if (execution.exit_code !== leg.expectedExitCode) {
        fail(`${leg.label}: DB gate exit ${execution.exit_code ?? 'missing'} != ${leg.expectedExitCode}`);
      }
      if (!execution.evidence_artifact_id) fail(`${leg.label}: gate has no execution evidence artifact`);
      const artifact = db
        .query<{ kind: string; producer: string; sha256: string; bytes: number }, [string]>(
          'SELECT kind, producer, sha256, bytes FROM evidence_artifacts WHERE artifact_id = ?',
        )
        .get(execution.evidence_artifact_id);
      if (!artifact) fail(`${leg.label}: evidence artifact ${execution.evidence_artifact_id} missing`);
      if (artifact.kind !== 'execution') fail(`${leg.label}: evidence kind ${artifact.kind} != execution`);
      if (artifact.producer !== 'helldesk-gate-runner') fail(`${leg.label}: evidence producer ${artifact.producer}`);
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) fail(`${leg.label}: evidence sha256 malformed`);
      if (artifact.bytes <= 0) fail(`${leg.label}: evidence artifact is empty`);
      const gate = db
        .query<{ status: string; evidence_refs_json: string; evaluator: string }, [string, string]>(
          `SELECT status, evidence_refs_json, evaluator FROM quality_gate_results
           WHERE revision_id = ? AND gate_key = ?
           ORDER BY checked_at DESC LIMIT 1`,
        )
        .get(revisionId, leg.gateKey);
      if (gate?.status !== leg.expectedExecutionStatus) fail(`${leg.label}: quality gate ${gate?.status ?? 'missing'}`);
      if (gate.evaluator !== 'quality-oracle') fail(`${leg.label}: quality gate evaluator ${gate.evaluator}`);
      if (!gate.evidence_refs_json.includes(execution.evidence_artifact_id)) {
        fail(`${leg.label}: quality gate does not reference execution evidence ${execution.evidence_artifact_id}`);
      }
      const summaryStatus = requireString(summary, leg.executionStatusPath);
      if (summaryStatus !== leg.expectedExecutionStatus) fail(`${leg.label}: summary gate ${summaryStatus}`);
      const summaryExit = at(summary, leg.executionExitPath);
      if (summaryExit !== leg.expectedExitCode) fail(`${leg.label}: summary exit ${text(summaryExit)}`);
      const summaryVerified = at(summary, leg.verifiedPath);
      if (summaryVerified !== leg.expectedVerified) fail(`${leg.label}: summary verified ${text(summaryVerified)}`);
    }
    return `${missionId} / ${legs.map((leg) => `${leg.label}:${leg.expectedRevisionState}+${leg.expectedExecutionStatus}`).join(' ')}`;
  } finally {
    db.close();
  }
}

function pngSize(path: string): { width: number; height: number; bytes: number } {
  const buf = readFileSync(path);
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') fail(`not a PNG: ${path}`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

interface MediaReport {
  video: { file: string; bytes: number; durationSeconds: number; width: number; height: number };
  webp: { file: string; bytes: number; width: number; height: number; animated: boolean };
  captures: Array<{ file: string; width: number; height: number; bytes: number }>;
}

function webpInfo(path: string): { width: number; height: number; bytes: number; animated: boolean } {
  const buf = readFileSync(path);
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    fail(`not a WebP: ${path}`);
  }
  if (buf.toString('ascii', 12, 16) !== 'VP8X') fail(`WebP is missing VP8X: ${path}`);
  if (!buf.includes(Buffer.from('ANIM'))) fail(`WebP is not animated: ${path}`);
  const width = buf.readUIntLE(24, 3) + 1;
  const height = buf.readUIntLE(27, 3) + 1;
  return { width, height, bytes: buf.length, animated: true };
}

function verifyMedia(): MediaReport {
  const captures = [
    'dashboard-overview.png',
    'dashboard-kanban.png',
    'dashboard-verified.png',
    'dashboard-transcript.png',
    'dashboard-diff.png',
    'dashboard-observability.png',
  ].map((file) => {
    const path = join(mediaRoot, file);
    if (!existsSync(path)) fail(`missing capture ${path}`);
    const size = pngSize(path);
    if (size.width !== 2048 || size.height !== 1152) fail(`${file}: expected 2048x1152, got ${size.width}x${size.height}`);
    return { file, ...size };
  });
  const videoPath = join(mediaRoot, 'dashboard-demo.gif');
  if (!existsSync(videoPath)) fail(`missing GIF ${videoPath}`);
  const bytes = statSync(videoPath).size;
  if (bytes < 300_000) fail(`GIF suspiciously small: ${bytes} bytes`);
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=width,height,nb_frames',
    '-of', 'json',
    videoPath,
  ], { encoding: 'utf8' });
  if (probe.error) fail(`ffprobe unavailable: ${probe.error.message}`);
  if (probe.status !== 0) fail(`ffprobe failed: ${probe.stderr}`);
  const parsed = JSON.parse(probe.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ width?: number; height?: number; nb_frames?: string }>;
  };
  const duration = Number(parsed.format?.duration);
  const stream = parsed.streams?.[0];
  const frames = Number(stream?.nb_frames);
  if (!Number.isFinite(duration) || Math.abs(duration - 33.5) > 1.5) fail(`GIF duration ${duration} != 33.5s`);
  if (stream?.width !== 480 || stream?.height !== 270) {
    fail(`GIF is ${stream?.width}x${stream?.height}, expected 480x270`);
  }
  if (!Number.isFinite(frames) || frames < 300) fail(`GIF has ${stream?.nb_frames} frames, expected an animation`);
  const webpPath = join(mediaRoot, 'dashboard-demo.webp');
  if (!existsSync(webpPath)) fail(`missing WebP ${webpPath}`);
  const webp = webpInfo(webpPath);
  if (webp.width !== 480 || webp.height !== 270) fail(`WebP is ${webp.width}x${webp.height}, expected 480x270`);
  return {
    video: { file: 'dashboard-demo.gif', bytes, durationSeconds: Number(duration.toFixed(2)), width: 480, height: 270 },
    webp: { file: 'dashboard-demo.webp', ...webp },
    captures,
  };
}

function verifyNoPlaywright(): string {
  const fixture = join(repoRoot, 'benchmarks', 'v0', 'visual-fixture');
  const obsolete = [
    'playwright.config.ts',
    'tests/functional.spec.ts',
    'tests/regression.spec.ts',
    'tests/visual.spec.ts',
  ];
  for (const file of obsolete) {
    if (existsSync(join(fixture, file))) fail(`obsolete Playwright file still present: ${file}`);
  }
  const pkg = readJson(join(fixture, 'package.json'));
  for (const section of ['dependencies', 'devDependencies']) {
    const deps = pkg[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name.includes('playwright')) fail(`${section} still depends on ${name}`);
    }
  }
  return 'no Playwright dependency, config, or spec remains';
}

const proofRuns = {
  m1: {
    dir: join(localRoot, 'm1-proof', '2026-11-23T22-06-36-163Z'),
    label: 'M1 fabricated test proof',
  },
  m2: {
    dir: join(localRoot, 'm2-proof', '2026-11-24T00-21-02-322Z'),
    label: 'M2 fabricated visual proof',
  },
  m3: {
    dir: join(localRoot, 'm3-regression-proof', '2026-11-24T00-29-25-787Z'),
    label: 'M3 regression proof',
  },
  recovery: {
    dir: join(localRoot, 'm3-recovery-proof', '2026-11-23T22-18-00-064Z'),
    label: 'M3 worker recovery',
  },
};

const summaryM1 = readJson(join(proofRuns.m1.dir, 'summary.json'));
const summaryM2 = readJson(join(proofRuns.m2.dir, 'summary.json'));
const summaryM3 = readJson(join(proofRuns.m3.dir, 'summary.json'));
const summaryRecovery = readJson(join(proofRuns.recovery.dir, 'summary.json'));

check('M1.host-executed-journal', () => {
  expectAt(summaryM1, 'missionState', 'VERIFIED_10_10');
  expectAt(summaryM1, 'first.revisionState', 'REJECTED');
  expectAt(summaryM1, 'first.hostExecution.status', 'FAIL');
  expectNumber(summaryM1, 'first.hostExecution.exit_code', 1);
  expectAt(summaryM1, 'first.verified', false);
  expectAt(summaryM1, 'second.revisionState', 'VERIFIED_10_10');
  expectAt(summaryM1, 'second.hostExecution.status', 'PASS');
  expectNumber(summaryM1, 'second.hostExecution.exit_code', 0);
  expectAt(summaryM1, 'second.verified', true);
  const db = verifyProofDb(proofRuns.m1.dir, summaryM1, [
    {
      label: 'fabricated PASS',
      revisionPath: 'first.revisionId',
      revisionStatePath: 'first.revisionState',
      executionStatusPath: 'first.hostExecution.status',
      executionExitPath: 'first.hostExecution.exit_code',
      verifiedPath: 'first.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'REJECTED',
      expectedExecutionStatus: 'FAIL',
      expectedExitCode: 1,
      expectedVerified: false,
    },
    {
      label: 'genuine repair',
      revisionPath: 'second.revisionId',
      revisionStatePath: 'second.revisionState',
      executionStatusPath: 'second.hostExecution.status',
      executionExitPath: 'second.hostExecution.exit_code',
      verifiedPath: 'second.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'VERIFIED_10_10',
      expectedExecutionStatus: 'PASS',
      expectedExitCode: 0,
      expectedVerified: true,
    },
  ], 'missionState');
  return `fabricated PASS rejected; repaired revision verified (${db})`;
});

check('M2.browser-visual-proof', () => {
  expectAt(summaryM2, 'missionState', 'VERIFIED_10_10');
  expectAt(summaryM2, 'first.revisionState', 'REJECTED');
  expectAt(summaryM2, 'first.hostExecution.status', 'FAIL');
  expectStringIncludes(summaryM2, 'first.hostExecution.command', 'browser-gate:');
  expectStringIncludes(summaryM2, 'first.visual.reason', 'size mismatch');
  expectAt(summaryM2, 'first.verified', false);
  expectAt(summaryM2, 'second.revisionState', 'VERIFIED_10_10');
  expectAt(summaryM2, 'second.hostExecution.status', 'PASS');
  expectAt(summaryM2, 'second.verified', true);
  const db = verifyProofDb(proofRuns.m2.dir, summaryM2, [
    {
      label: 'fabricated visual PASS',
      revisionPath: 'first.revisionId',
      revisionStatePath: 'first.revisionState',
      executionStatusPath: 'first.hostExecution.status',
      executionExitPath: 'first.hostExecution.exit_code',
      verifiedPath: 'first.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'REJECTED',
      expectedExecutionStatus: 'FAIL',
      expectedExitCode: 1,
      expectedVerified: false,
    },
    {
      label: 'CSS repair',
      revisionPath: 'second.revisionId',
      revisionStatePath: 'second.revisionState',
      executionStatusPath: 'second.hostExecution.status',
      executionExitPath: 'second.hostExecution.exit_code',
      verifiedPath: 'second.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'VERIFIED_10_10',
      expectedExecutionStatus: 'PASS',
      expectedExitCode: 0,
      expectedVerified: true,
    },
  ], 'missionState');
  return `BrowserOS gate rejected fabricated visual PASS; CSS repair verified (${db})`;
});

check('M3.regression-proof', () => {
  expectAt(summaryM3, 'missionState', 'VERIFIED_10_10');
  expectAt(summaryM3, 'first.revisionState', 'REJECTED');
  expectAt(summaryM3, 'first.hostExecution.status', 'FAIL');
  expectStringIncludes(summaryM3, 'first.hostExecution.command', 'browser-gate:');
  expectAt(summaryM3, 'first.visualRatio', '0');
  expectAt(summaryM3, 'first.visualOk', true);
  expectAt(summaryM3, 'first.failedCheckType', 'clickText');
  expectAt(summaryM3, 'first.verified', false);
  expectAt(summaryM3, 'second.revisionState', 'VERIFIED_10_10');
  expectAt(summaryM3, 'second.hostExecution.status', 'PASS');
  expectAt(summaryM3, 'second.verified', true);
  const db = verifyProofDb(proofRuns.m3.dir, summaryM3, [
    {
      label: 'visual-clean / functional regression',
      revisionPath: 'first.revisionId',
      revisionStatePath: 'first.revisionState',
      executionStatusPath: 'first.hostExecution.status',
      executionExitPath: 'first.hostExecution.exit_code',
      verifiedPath: 'first.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'REJECTED',
      expectedExecutionStatus: 'FAIL',
      expectedExitCode: 1,
      expectedVerified: false,
    },
    {
      label: 'functional repair',
      revisionPath: 'second.revisionId',
      revisionStatePath: 'second.revisionState',
      executionStatusPath: 'second.hostExecution.status',
      executionExitPath: 'second.hostExecution.exit_code',
      verifiedPath: 'second.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'VERIFIED_10_10',
      expectedExecutionStatus: 'PASS',
      expectedExitCode: 0,
      expectedVerified: true,
    },
  ], 'missionState');
  return `visual ratio 0 but clickText failed; repair verified (${db})`;
});

check('M3.worker-recovery', () => {
  expectAt(summaryRecovery, 'firstTick.action', 'infra-retry');
  expectAt(summaryRecovery, 'firstTick.nextState', 'ACTIVE');
  expectAt(summaryRecovery, 'revisionAfterKill.state', 'PLANNED');
  expectNumber(summaryRecovery, 'revisionCountAfterKill', 1);
  expectNumber(summaryRecovery, 'retry.attempt', 1);
  const killedRevision = requireString(summaryRecovery, 'revisionAfterKill.revision_id');
  const retriedRevision = requireString(summaryRecovery, 'retry.revision_id');
  if (killedRevision !== retriedRevision) fail('retry used a different revision');
  expectAt(summaryRecovery, 'final.missionState', 'VERIFIED_10_10');
  expectAt(summaryRecovery, 'final.revisionState', 'VERIFIED_10_10');
  expectNumber(summaryRecovery, 'final.revisions', 1);
  expectAt(summaryRecovery, 'final.verified', true);
  expectNumber(summaryRecovery, 'final.repairMutations', 1);
  const db = verifyProofDb(proofRuns.recovery.dir, summaryRecovery, [
    {
      label: 'same revision after kill',
      revisionPath: 'final.execution.revision_id',
      revisionStatePath: 'final.revisionState',
      executionStatusPath: 'final.execution.status',
      executionExitPath: 'final.execution.exit_code',
      verifiedPath: 'final.verified',
      gateKey: 'functional_correctness',
      expectedRevisionState: 'VERIFIED_10_10',
      expectedExecutionStatus: 'PASS',
      expectedExitCode: 0,
      expectedVerified: true,
    },
  ], 'final.missionState');
  return `killed agent retried revision ${killedRevision} without duplication (${db})`;
});

let media: MediaReport | null = null;
check('M4.dashboard-media', () => {
  media = verifyMedia();
  return `${media.video.file} ${media.video.durationSeconds}s ${media.video.width}x${media.video.height}; ${media.webp.file} ${media.webp.bytes} bytes; ${media.captures.length} page captures`;
});

check('M4.no-playwright', () => verifyNoPlaywright());

check('M4.demo-proof-mission', () => {
  const missionId = requireString(summaryM3, 'missionId');
  if (missionId !== 'mis_a1b1beb2914447ada9f00a616c3eb2bc') fail(`unexpected demo mission ${missionId}`);
  return `dashboard demo projects ${missionId} (M3 proof)`;
});

const failed = checks.filter((entry) => !entry.ok);
const pass = failed.length === 0;
const result = {
  benchmark: 'HELLDESK Adversarial Multimodal Benchmark v0',
  generatedAt: new Date().toISOString(),
  pass,
  checks,
  proofRuns: {
    m1: {
      run: '2026-11-23T22-06-36-163Z',
      mission: requireString(summaryM1, 'missionId'),
      fabricated: requireString(summaryM1, 'first.revisionId'),
      repaired: requireString(summaryM1, 'second.revisionId'),
    },
    m2: {
      run: '2026-11-24T00-21-02-322Z',
      mission: requireString(summaryM2, 'missionId'),
      fabricated: requireString(summaryM2, 'first.revisionId'),
      repaired: requireString(summaryM2, 'second.revisionId'),
    },
    m3: {
      run: '2026-11-24T00-29-25-787Z',
      mission: requireString(summaryM3, 'missionId'),
      regression: requireString(summaryM3, 'first.revisionId'),
      repaired: requireString(summaryM3, 'second.revisionId'),
    },
    recovery: {
      run: '2026-11-23T22-18-00-064Z',
      mission: requireString(summaryRecovery, 'missionId'),
      revision: requireString(summaryRecovery, 'revisionAfterKill.revision_id'),
    },
    demo: {
      controlPlane: '127.0.0.1:4791',
      dashboard: '127.0.0.1:8792',
      proofMission: requireString(summaryM3, 'missionId'),
      capture: 'BrowserOS Neo MCP screenshot tool',
    },
  },
  media: media ?? {
    video: { file: 'dashboard-demo.gif', bytes: 0, durationSeconds: 0, width: 0, height: 0 },
    webp: { file: 'dashboard-demo.webp', bytes: 0, width: 0, height: 0, animated: false },
    captures: [],
  },
};

writeFileSync(join(benchmarkDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`\nRESULT ${pass ? 'PASS' : 'FAIL'} ${checks.length - failed.length}/${checks.length}`);
console.log(`WROTE ${join(benchmarkDir, 'results.json')}`);
if (!pass) process.exitCode = 1;
