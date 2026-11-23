#!/usr/bin/env bun
/**
 * Federated MISSION E2E — drives the REAL autonomous loop to (ideally)
 * VERIFIED_10_10 using real tool-driven inference end-to-end:
 *
 *   - mutation:  writable actuator against a real git workspace fixes the
 *                seeded bug:
 *                  RUNNER=openai -> OpenAiMutationRunner (WRITE+SHELL tools,
 *                                    deepseek via an OpenAI-compatible endpoint)
 *                  RUNNER=codex  -> real ChatGPT Codex CLI
 *                                    (codex exec -m gpt-6-luna)
 *   - evidence:  controller captures real content SHA-256 of changed files
 *   - review:    tool-capable OpenAI reviewer (review_* snapshot tools) -> PASS
 *                (reviewer stays on the reachable OpenAI-compatible route; the Codex CLI
 *                has no HTTP OpenAI-compatible reviewer surface)
 *   - oracle:    every mandatory gate PASS with a resolved evidence artifact
 *
 * Requires a reachable OpenAI-compatible endpoint for the reviewer. Defaults to
 * an OpenAI-compatible endpoint (demo-model). No local kilo binary needed.
 *
 * Run:   bun run scripts/mission-smoke.ts
 * Env:   GT_MUTATION_RUNNER (openai|codex|kilo)
 *        GT_MUTATION_MODEL / GT_MUTATION_BASE (mutation actuator; codex->gpt-6-luna)
 *        GT_REVIEW_MODEL / GT_REVIEW_BASE / GT_REVIEW_PROVIDER (reviewer route)
 *        GT_CODEX_BIN (codex binary override)
 *        GT_TASK_GATES (comma-separated, task-specific acceptance gates)
 *        GT_MAX_ADVANCES (infra watchdog only; default 750 — NOT a
 *                         valid-FINDINGS terminal)
 */
import { loadConfig, type Config } from '../src/config';
import { openDb } from '../src/db';
import { Engine, makeRunner } from '../src/engine';
import { createTelemetry } from '../src/telemetry';
import { createMission, addTicket, getMission, listRevisions, getQualityGates } from '../src/mission-repository';
import { advanceMission } from '../src/mission-controller';
import { makeControllerDeps } from '../src/engine-review-hook';
import { registerWorkspace } from '../src/workspace-registry';
import { fingerprintWorkspace } from '../src/mutation-runner';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// REVIEWER route. The DeepSeek proxy (demo-model) cannot reliably emit
// the strict reviewer JSON (constant PARSE_FAILURE/ZERO_COVERAGE/INCONCLUSIVE),
// so the DEFAULT reviewer is gpt-6-luna via the real codex CLI (createCodexRunner),
// which returns the strict JSON deterministically. Set GT_REVIEW_RUNNER=openai to
// fall back to the HTTP OpenAI route.
const REVIEW_RUNNER = process.env.GT_REVIEW_RUNNER ?? 'codex';
const REVIEW_ENDPOINT = process.env.GT_REVIEW_BASE ?? 'http://127.0.0.1:4000/v1';
const REVIEW_MODEL = process.env.GT_REVIEW_MODEL ?? (REVIEW_RUNNER === 'codex' ? 'gpt-6-luna' : 'demo-model');
const REVIEW_PROVIDER = process.env.GT_REVIEW_PROVIDER ?? (REVIEW_RUNNER === 'codex' ? 'codex' : 'openai-compatible');

// MUTATION actuator: 'openai' (HTTP OpenAI-compatible tools) | 'codex' (real
// ChatGPT Codex CLI, codex exec -m gpt-6-luna) | 'kilo' (headless Kilo SDK).
const RUNNER = process.env.GT_MUTATION_RUNNER ?? 'openai';
const MUT_MODEL = RUNNER === 'codex'
  ? (process.env.GT_MUTATION_MODEL ?? 'gpt-6-luna')
  : (process.env.GT_MUTATION_MODEL ?? 'demo-model');
const MUT_ENDPOINT = process.env.GT_MUTATION_BASE ?? REVIEW_ENDPOINT;
const MUT_PROVIDER = RUNNER === 'codex' ? 'codex' : REVIEW_PROVIDER;
const CODEX_BIN = process.env.GT_CODEX_BIN ?? '';
const DATA_DIR = process.env.GT_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'gt-fed-mission-'));

function loadFederatedConfig(): Config {
  const base = loadConfig();
  const cfg: Config = {
    ...base,
    daemon: { ...base.daemon, dataDir: DATA_DIR, port: 4792, detachedWorkers: false },
    policy: {
      ...base.policy,
      // Reviewer runner: 'codex' (real gpt-6-luna reviewer) or 'openai' (DeepSeek).
      runner: REVIEW_RUNNER,
      providers: { [REVIEW_PROVIDER]: { kind: 'openai-compatible', baseURL: REVIEW_ENDPOINT, modelID: REVIEW_MODEL, apiKey: '' } },
      reviewerModel: { providerID: REVIEW_PROVIDER, modelID: REVIEW_MODEL },
      reviewerModelA: { providerID: REVIEW_PROVIDER, modelID: REVIEW_MODEL },
      reviewerModelB: { providerID: REVIEW_PROVIDER, modelID: REVIEW_MODEL },
    },
    autonomy: {
      enabled: true,
      mutationRunner: RUNNER,
      kiloBin: CODEX_BIN,
      providerID: MUT_PROVIDER,
      modelID: MUT_MODEL,
      baseURL: MUT_ENDPOINT,
      apiKey: '',
    },
    workspaces: [],
  };
  return cfg;
}

/** A real git workspace with a seeded bug the mutation agent should fix. */
function makeBuggyWs(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-fedws-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email fed@localhost', { cwd: dir });
  execSync('git config user.name fed', { cwd: dir });
  writeFileSync(join(dir, 'math.js'), `function divide(a, b) {\n  if (b === 0) return 0; // BUG: division by zero silently zeroes\n  return a / b;\n}\nmodule.exports = divide;\n`);
  execSync('git add -A && git commit -qm "baseline"', { cwd: dir });
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

process.on('unhandledRejection', (e) => { console.error('[fed-mission] UNHANDLED REJECTION:', e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(3); });
process.on('uncaughtException', (e) => { console.error('[fed-mission] UNCAUGHT:', e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(4); });

const cfg = loadFederatedConfig();
const dataDir = cfg.daemon.dataDir ?? DATA_DIR;
const d = openDb(join(dataDir, 'helldesk.db'));
d.runMigration();
const telemetry = createTelemetry({ logDir: join(dataDir, 'logs') });
const resolvedModels = new Map<string, { providerID: string; modelID: string }>([['inherited', { providerID: REVIEW_PROVIDER, modelID: REVIEW_MODEL }]]);
const runner = makeRunner(cfg, telemetry);
void runner;
const engine = new Engine({ d, config: cfg, snapshotStore: join(dataDir, 'snapshots'), reportDir: join(dataDir, 'reports'), runner, resolvedModels });
// NOTE: runJob (in-process) uses `this.runner` = createOpenAiRunner (tools). We
// do NOT enable detachedWorkers so the review runs in-process with review_* tools.
engine.onStartup();
engine.reload();

const ws = makeBuggyWs();
try {
  const registered = registerWorkspace(d, { path: ws.dir, enabled: true });
  const mission = createMission(d, { workspace_id: registered.workspaceId, objective: 'division by zero must throw an Error, never silently return 0' });
  const ticket = addTicket(d, mission.mission_id, { title: 'B1', objective: 'division by zero should throw, never return 0' });
  console.log('[fed-mission] ws=', ws.dir);
  console.log('[fed-mission] mission', mission.mission_id, 'ticket', ticket.ticket_id);

  const deps = makeControllerDeps(engine, {
    mutationRunner: RUNNER, kiloBin: CODEX_BIN, providerID: MUT_PROVIDER, modelID: MUT_MODEL, baseURL: MUT_ENDPOINT,
    // Task-specific acceptance gates for a divide-by-zero mission — NOT the
    // turbine-diagnostic default. The mutation must satisfy these explicitly.
    taskGates: process.env.GT_TASK_GATES
      ? process.env.GT_TASK_GATES.split(',').map((s) => s.trim()).filter(Boolean)
      : ['zero_division_contract', 'coercion_semantics', 'boundary_tests', 'test_execution_pass', 'no_regression'],
  });
  console.log('[fed-mission] mutation transport =', deps.runner.transport, 'provider=', deps.runner.provider, 'model=', deps.runner.model);

  // Autonomous Ender loop: valid FINDINGS are new input for the next revision,
  // NOT a terminal. Keep mutating + re-reviewing the SAME mission until it is
  // VERIFIED_10_10 or genuinely externally blocked. There is NO artificial
  // advance budget for valid-FINDINGS convergence (CTO directive). A large
  // watchdog only guards against an infrastructure wedge (no progress at all),
  // never against a mission that keeps producing valid findings.
  let guard = 0;
  const MAX_ADVANCES = Number(process.env.GT_MAX_ADVANCES ?? '750'); // infra watchdog only
  let out = await advanceMission(mission.mission_id, deps);
  console.log('[fed-mission] advance#1 ->', out.action, 'next=', out.nextState);
  while (out.nextState !== 'VERIFIED_10_10' && out.nextState !== 'BLOCKED_EXTERNAL' && out.nextState !== 'CANCELLED' && guard < MAX_ADVANCES) {
    out = await advanceMission(mission.mission_id, deps);
    console.log('[fed-mission] advance ->', out.action, 'next=', out.nextState);
    guard += 1;
  }

  const revs = listRevisions(d, ticket.ticket_id);
  const last = revs.at(-1);
  const gates = last ? getQualityGates(d, last.revision_id) : [];
  console.log('[fed-mission] final mission state=', getMission(d, mission.mission_id)?.state);
  console.log('[fed-mission] revisions=', revs.length, 'last=', last?.state);
  console.log('[fed-mission] quality gates=', gates.map((g) => `${g.gate_key}:${g.status}`).join(', '));
  console.log('[fed-mission] RESULT=' + getMission(d, mission.mission_id)?.state);
} finally {
  ws.cleanup();
  d.close();
}
engine.close?.();
process.exit(0);