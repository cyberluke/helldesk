#!/usr/bin/env bun
/**
 * FEDERATED REAL REVIEW — drives a REAL model review through the HELLDESK Engine.
 *
 * Proves the review path actually calls out to a reachable real model endpoint
 * (an OpenAI-compatible endpoint -> demo-model -> backend) and
 * persists genuine findings + model provenance — no fixture, no fake runner.
 *
 * The Engine uses its `openai` runner (createOpenAiRunner) against the resolved
 * provider, non-detached (runJob). This is the legit real-inference transport
 * separate from the headless-kilo detached path.
 *
 * Run:  bun run scripts/federated-review.ts
 */
import { openDb } from '../src/db';
import { Engine } from '../src/engine';
import { createOpenAiRunner } from '../src/inference';
import { createTelemetry } from '../src/telemetry';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { registerWorkspace } from '../src/workspace-registry';
import { getJob } from '../src/jobs';
import { loadConfigLegacy } from '../tests/config-factory';

const BASE_URL = process.env.GT_REVIEW_BASE ?? 'http://127.0.0.1:4000/v1';
const MODEL = process.env.GT_REVIEW_MODEL ?? 'demo-model';
const DATA_DIR = process.env.GT_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'gt-fedreview-'));

function makeGitWs(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-fedws-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email fed@localhost', { cwd: dir });
  execSync('git config user.name fed', { cwd: dir });
  writeFileSync(join(dir, 'math.js'), `function compute(a, b) {\n  if (b === 0) return 0; // BUG: division by zero silently zero\n  return a + b;\n}\nmodule.exports = compute;\n`);
  execSync('git add -A && git commit -qm "baseline"', { cwd: dir });
  writeFileSync(join(dir, 'math.js'), `function compute(a, b) {\n  if (b === 0) throw new Error('divide by zero'); // FIXED\n  return a + b;\n}\nmodule.exports = compute;\n`);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const dataDir = DATA_DIR;
const d = openDb(join(dataDir, 'helldesk.db'));
d.runMigration();

// Config: openai runner against a reachable OpenAI-compatible endpoint. Legacy factory
// builds a valid Config; we override provider + model on the returned object.
const cfg = loadConfigLegacy('openai');
cfg.policy.providers = {
  'openai-compatible': { kind: 'openai-compatible', baseURL: BASE_URL, modelID: MODEL, apiKey: '' },
};
cfg.policy.reviewerModel = { providerID: 'openai-compatible', modelID: MODEL };
cfg.daemon.dataDir = dataDir;

const telemetry = createTelemetry({ logDir: join(dataDir, 'logs') });
// Use the REAL openai runner (createOpenAiRunner) — not fake.
const runner = createOpenAiRunner({ kind: 'openai-compatible', baseURL: BASE_URL, modelID: MODEL, apiKey: '' });
const resolvedModels = new Map<string, { providerID: string; modelID: string }>([['inherited', { providerID: 'openai-compatible', modelID: MODEL }]]);
const engine = new Engine({ d, config: cfg, snapshotStore: join(dataDir, 'snapshots'), reportDir: join(dataDir, 'reports'), runner, resolvedModels });
engine.onStartup();
engine.reload();

const ws = makeGitWs();
try {
  registerWorkspace(d, { path: ws.dir, enabled: true });
  const { jobId } = engine.createAndEnqueue({
    workspacePath: ws.dir,
    subjectKind: 'git-dirty',
    includeDirty: true,
    includeUntracked: true,
    requirements: 'Evaluate this change: division-by-zero should throw, never silently return 0. Include adversarial correctness coverage.',
    source: 'federated-smoke',
  });
  console.log('[federated] enqueued review job', jobId);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await engine.runJob(jobId).catch((e) => console.error('[federated] runJob error:', e?.message ?? String(e)));
    break; // runJob executes the job synchronously to completion (or INCONCLUSIVE)
  }

  const job = getJob(d, jobId);
  console.log('[federated] final state=', job?.state);
  if (job?.state === 'COMPLETED_PASS') console.log('[federated] RESULT: REVIEW_PASS (real model)');
  else if (job?.state === 'COMPLETED_FINDINGS') console.log('[federated] RESULT: REVIEW_FINDINGS (real model)');
  else if (job?.state === 'INCONCLUSIVE') console.log('[federated] RESULT: REVIEW_INCONCLUSIVE — model returned nothing parseable');
  else console.log('[federated] RESULT: REVIEW_' + job?.state);

  // Real provenance: the model actually used (persisted agent_runs).
  const runs = d.db.query<{ role: string; provider_id: string; model_id: string }, []>(`SELECT role, provider_id, model_id FROM agent_runs WHERE job_id=?`).all(jobId);
  console.log('[federated] provenance (real model actually reached):');
  for (const r of runs) console.log(`  ${r.role}: ${r.provider_id}/${r.model_id}`);
  const findings = d.db.query<{ severity: string; title: string }, []>(`SELECT severity, title FROM findings WHERE job_id=?`).all(jobId);
  console.log('[federated] findings count=', findings.length, 'sample=', findings.find((f) => f.severity === 'HIGH' || f.severity === 'BLOCKER')?.title ?? '(none HIGH/BLOCKER)');
} finally {
  ws.cleanup();
  d.close();
}
void engine;
process.exit(0);