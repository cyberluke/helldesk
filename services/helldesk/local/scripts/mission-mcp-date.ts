#!/usr/bin/env bun
/**
 * Federated MISSION E2E — the PROVABLE MCP datetime server mission.
 *
 * Mission: the MCP server (`server.mjs`) must expose get_current_datetime that
 * prints the CURRENT wall-clock time formatted with the OS-DEFAULT locale
 * (Intl.DateTimeFormat(undefined)), never a hardcoded seed and never hardcoded
 * en-US. `test.mjs` is a binary oracle (exit 1 while bug present, exit 0 after).
 *
 * Transport split (P0 Phase 11: gpt-6-luna mutation + DeepSeek reviewer):
 *   - mutation:  real ChatGPT Codex CLI (codex exec -m gpt-6-luna) — writes files.
 *   - reviewer:  DeepSeek via LiteLLM (fast, reliable strict JSON now that tool
 *                instructions are stripped from the reviewer prompt).
 *
 * Run for a month autonomously: valid FINDINGS are new input for the next
 * revision; the loop continues until VERIFIED_10_10 (or a genuine external
 * blocker). No artificial advance budget for valid-FINDINGS convergence.
 *
 * Env: GT_MUTATION_RUNNER=codex  GT_REVIEW_RUNNER=openai (defaults)
 *      GT_MISSION_WS=<path to a git workspace with the seeded server+test>
 */
import { loadConfig, type Config } from '../src/config';
import { openDb } from '../src/db';
import { Engine, makeRunner } from '../src/engine';
import { createTelemetry } from '../src/telemetry';
import { createMission, addTicket, getMission, listRevisions, getQualityGates } from '../src/mission-repository';
import { advanceMission } from '../src/mission-controller';
import { makeControllerDeps } from '../src/engine-review-hook';
import { registerWorkspace } from '../src/workspace-registry';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Mission workspace (must already exist as a git repo with the seeded bug).
// The seed workspace is stable; override with GT_MISSION_WS if relocated.
const MISSION_WS = resolve(process.env.GT_MISSION_WS ?? 'C:\\Users\\LUKES~1.COR\\AppData\\Local\\Temp\\kilo\\mcp-date-mission');

// Reviewer: by default the real ChatGPT Codex CLI (gpt-6-luna), matching the
// confirmed correct path (gpt-6-luna for BOTH mutation and review). Slower than
// the HTTP OpenAI route but deterministically emits strict reviewer JSON (DeepSeek
// on some proxies flip-flops PASS/INCONCLUSIVE and cannot converge).
const REVIEW_RUNNER = process.env.GT_REVIEW_RUNNER ?? 'codex';
const REVIEW_ENDPOINT = process.env.GT_REVIEW_BASE ?? 'http://127.0.0.1:4000/v1';
const REVIEW_MODEL = process.env.GT_REVIEW_MODEL ?? (REVIEW_RUNNER === 'codex' ? 'gpt-6-luna' : 'differential_sseproxy');
const REVIEW_PROVIDER = process.env.GT_REVIEW_PROVIDER ?? (REVIEW_RUNNER === 'codex' ? 'codex' : 'litellm-edge');
const RUNNER = process.env.GT_MUTATION_RUNNER ?? 'codex';
const MUT_MODEL = process.env.GT_MUTATION_MODEL ?? 'gpt-6-luna';
const MUT_PROVIDER = 'codex';
const MUT_ENDPOINT = process.env.GT_MUTATION_BASE ?? REVIEW_ENDPOINT;
const CODEX_BIN = process.env.GT_CODEX_BIN ?? '';
// Stable, persistent data dir (NOT a temp dir) so the mission + review state
// survives daemon restarts/crashes across the month-long run.
const DATA_DIR = process.env.GT_DATA_DIR ?? join(tmpdir(), 'gt-mcp-mission-persist');

function loadConfigFor(): Config {
  const base = loadConfig();
  return {
    ...base,
    daemon: { ...base.daemon, dataDir: DATA_DIR, port: 4793, detachedWorkers: false },
    policy: {
      ...base.policy,
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
}

process.on('unhandledRejection', (e) => { console.error('[mcp-mission] UNHANDLED REJECTION:', e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(3); });
process.on('uncaughtException', (e) => { console.error('[mcp-mission] UNCAUGHT:', e instanceof Error ? (e.stack ?? e.message) : String(e)); process.exit(4); });

if (!MISSION_WS) { console.error('set GT_MISSION_WS to the seeded mission workspace'); process.exit(2); }

const cfg = loadConfigFor();
const d = openDb(join(cfg.daemon.dataDir ?? DATA_DIR, 'helldesk.db'));
d.runMigration();
const telemetry = createTelemetry({ logDir: join(DATA_DIR, 'logs') });
const resolvedModels = new Map<string, { providerID: string; modelID: string }>([['inherited', { providerID: REVIEW_PROVIDER, modelID: REVIEW_MODEL }]]);
const runner = makeRunner(cfg, telemetry);
void runner;
const engine = new Engine({ d, config: cfg, snapshotStore: join(DATA_DIR, 'snapshots'), reportDir: join(DATA_DIR, 'reports'), runner, resolvedModels });
engine.onStartup();
engine.reload();

const registered = registerWorkspace(d, { path: MISSION_WS, enabled: true });

// Resumable: if THIS data dir already has a mission, reuse it (do not re-seed).
// This lets the driver be killed and restarted (or crash) and pick the mission
// back up where `advanceMission` recovery leaves it — the engine re-drives stuck
// MUTATING / EVIDENCE_CAPTURED / VERIFYING revisions and in-flight review jobs.
const existing = d.db.query<{ mission_id: string }>(`SELECT mission_id FROM autonomy_missions WHERE workspace_id=? LIMIT 1`).get(registered.workspaceId);
const mission = existing
  ? { mission_id: existing.mission_id }
  : createMission(d, { workspace_id: registered.workspaceId, objective: 'the MCP datetime server must return the CURRENT wall-clock time formatted with the OS-default locale (Intl.DateTimeFormat(undefined)); never a hardcoded seed timestamp and never a hardcoded en-US format; test.mjs must pass (exit 0)' });
const ticket = d.db.query<{ ticket_id: string }, [string]>(`SELECT ticket_id FROM mission_tickets WHERE mission_id=? ORDER BY rowid ASC LIMIT 1`).get(mission.mission_id)
  ?? addTicket(d, mission.mission_id, { title: 'B1', objective: 'server.mjs get_current_datetime returns current time in OS-default locale; test.mjs green' });
console.log('[mcp-mission] ws=', MISSION_WS, existing ? '(resumed)' : '(seeded)');
console.log('[mcp-mission] mission', mission.mission_id, 'ticket', ticket.ticket_id);

const deps = makeControllerDeps(engine, {
  mutationRunner: RUNNER, kiloBin: CODEX_BIN, providerID: MUT_PROVIDER, modelID: MUT_MODEL, baseURL: MUT_ENDPOINT,
  // Task-specific acceptance gates for THIS mission — not turbine diagnostics.
  taskGates: ['os_locale_used', 'current_time_not_seed', 'test_execution_pass', 'wire_path_ok', 'no_hardcoded_locale'],
});
console.log('[mcp-mission] mutation transport =', deps.runner.transport, 'provider=', deps.runner.provider, 'model=', deps.runner.model);

// Persistent autonomous loop. With gpt-6-luna mutation + reviewer, each cycle is
// slow (1-3 min per codex exec); a large watchdog only guards against a hard
// infrastructure wedge (no progress at all), NEVER against valid-FINDINGS or a
// slow-but-progressing mission. Runs until VERIFIED_10_10 / terminal/hard-block.
const MAX_ADVANCES = Number(process.env.GT_MAX_ADVANCES ?? '100000'); // infra watchdog only
let guard = 0;
let out = await advanceMission(mission.mission_id, deps);
console.log('[mcp-mission] advance#1 ->', out.action, 'next=', out.nextState);
let lastAction = out.action;
let stagnantSince = Date.now();
while (out.nextState !== 'VERIFIED_10_10' && out.nextState !== 'BLOCKED_EXTERNAL' && out.nextState !== 'CANCELLED' && guard < MAX_ADVANCES) {
  out = await advanceMission(mission.mission_id, deps);
  if (out.action !== lastAction || out.nextState !== 'ACTIVE') {
    console.log('[mcp-mission] advance ->', out.action, 'next=', out.nextState);
    lastAction = out.action;
  }
  // Infra wedge watchdog: if nothing changes for a long wall-clock window (e.g.
  // a review subprocess wedged and never returns), the loop will still spin on
  // `revision-...-in-flight`; cap progressless iterations at once per N to avoid
  // busy-spinning while a slow codex review is genuinely in flight.
  guard += 1;
  if (out.action.startsWith('revision-') && guard % 5 === 0) await new Promise((r) => setTimeout(r, 3000));
  void stagnantSince;
}

const revs = listRevisions(d, ticket.ticket_id);
const last = revs.at(-1);
const gates = last ? getQualityGates(d, last.revision_id) : [];
console.log('[mcp-mission] final mission state=', getMission(d, mission.mission_id)?.state);
console.log('[mcp-mission] revisions=', revs.length, 'last=', last?.state);
console.log('[mcp-mission] quality gates=', gates.map((g) => `${g.gate_key}:${g.status}`).join(', '));
console.log('[mcp-mission] RESULT=' + getMission(d, mission.mission_id)?.state);

d.close();
engine.close?.();
process.exit(0);