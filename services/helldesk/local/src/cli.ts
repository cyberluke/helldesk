#!/usr/bin/env bun
import { loadConfig, defaultDataDir, defaultDbPath } from './config';
import { newRuntimeConfigStore } from './config-runtime';
import { openDb } from './db';
import { Engine, makeRunner } from './engine';
import { createTelemetry } from './telemetry';
import { join, normalize, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Programmatic / manual review entry (HEAD, commit, base..head, dirty, folder).
 *
 * Works without VS Code or the Kilo plugin. Uses the configured runner
 * (fake/openai) or iTunes the engine headlessly. For the real Kilo SDK path
 * use the plugin.
 *
 * Examples:
 *   bun run src/cli.ts head --path C:/repo
 *   bun run src/cli.ts commit --path C:/repo --ref abc123
 *   bun run src/cli.ts range --path C:/repo --base main --head feature
 *   bun run src/cli.ts dirty --path C:/repo
 *   bun run src/cli.ts folder --path C:/some/folder
 *   bun run src/cli.ts run <jobId>
 */

function usage(): void {
  console.log(`
HELLDESK Local CLI

  head    [--path P]                review committed HEAD
  commit  [--path P] [--ref R]      review an arbitrary commit
  range   [--path P] [--base B] [--head H]   review base..head
  dirty   [--path P]                review working-tree (staged+unstaged+untracked)
  mixed   [--path P]                review committed HEAD + dirty state
  folder  [--path P] [--sub S]      review a plain folder (no git required)
  run     <jobId>                   run one queued job and exit
  config  get [--path P]            print effective config + per-field apply meta
  config  set <json> [--path P]     apply+persist a partial config update (live
                                    when the daemon is reachable)
`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return 0;
  }
  const opt = (key: string): string | undefined => {
    const i = args.indexOf(key);
    return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
  };
  const configPath = opt('--config');

  // ── Runtime config control (no DB/engine needed) ──────────────────────
  //   config get [--path P]            print the effective config + apply meta
  //   config set <json> [--path P]     validate+persist a partial config update.
  // When the daemon is reachable (env GT_DAEMON_URL/GT_DAEMON_TOKEN or
  // HELLDESK_CONTROL_URL/TOKEN), `set` PATCHES the live daemon /v1/config so the
  // change applies immediately; otherwise it writes the config file directly
  // (applies on next start).
  if (cmd === 'config') {
    return await runConfigCommand(args[1], configPath);
  }

  const config = loadConfig(configPath ?? process.env.GT_CONFIG);
  const dataDir = config.daemon.dataDir ?? defaultDataDir();
  const dbPath = config.daemon.dbPath ?? defaultDbPath(dataDir);
  mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
  mkdirSync(join(dataDir, 'reports'), { recursive: true });
  const d = openDb(dbPath);
  d.runMigration();
  const telemetry = createTelemetry({ logDir: config.daemon.logDir });
  const runner = cmd === 'run' ? makeRunner(config, telemetry) : makeRunner(config, telemetry);
  const resolvedModels = new Map<string, { providerID: string; modelID: string }>();
  if (config.policy.reviewerModel) resolvedModels.set('inherited', config.policy.reviewerModel);
  const engine = new Engine({
    d,
    config,
    snapshotStore: join(dataDir, 'snapshots'),
    reportDir: join(dataDir, 'reports'),
    runner,
    resolvedModels,
  });
  engine.onStartup();
  engine.reload();

  if (cmd === 'run') {
    const jobId = args[1];
    if (!jobId) {
      console.error('run requires a jobId');
      return 2;
    }
    await engine.runJob(jobId);
    d.close();
    return 0;
  }

  const path = opt('--path');
  if (!path) {
    console.error(`${cmd} requires --path`);
    return 2;
  }
  const workspacePath = resolve(normalize(path));

  let out: { jobId: string; dedupeExisting: boolean };
  switch (cmd) {
    case 'head':
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'git-head', source: 'cli' });
      break;
    case 'commit': {
      const ref = opt('--ref') ?? 'HEAD';
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'git-commit', head: ref, source: 'cli' });
      break;
    }
    case 'range': {
      const base = opt('--base');
      const head = opt('--head');
      if (!base || !head) {
        console.error('range requires --base and --head');
        return 2;
      }
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'git-range', base, head, source: 'cli' });
      break;
    }
    case 'dirty':
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'git-dirty', includeDirty: true, includeUntracked: true, source: 'cli' });
      break;
    case 'mixed':
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'git-mixed', includeDirty: true, includeUntracked: true, source: 'cli' });
      break;
    case 'folder': {
      const sub = opt('--sub');
      out = await engine.createAndEnqueue({ workspacePath, subjectKind: 'fs-folder', fsPath: sub ?? workspacePath, source: 'cli' });
      break;
    }
    default:
      usage();
      d.close();
      return 2;
  }

  console.log(`[cli] enqueued review job ${out.jobId}${out.dedupeExisting ? ' (already exists)' : ''}`);
  // Run it now (one-shot).
  await engine.runJob(out.jobId);
  const row = d.db
    .query<{ state: string; result: string | null }, [string]>(
      `SELECT state, result FROM review_jobs WHERE job_id=?`
    )
    .get(out.jobId);
  console.log(`[cli] job ${out.jobId} → ${row?.state} result=${row?.result}`);
  console.log(`[cli] report at ${join(dataDir, 'reports', out.jobId + '.json')}`);
  d.close();
  return 0;
}

async function runConfigCommand(sub: string | undefined, configPath?: string): Promise<number> {
  const store = newRuntimeConfigStore({ configPath: configPath ?? process.env.GT_CONFIG });
  if (sub === 'get' || sub === undefined) {
    const view = store.view();
    console.log(JSON.stringify({ config: view.config, meta: view.meta, path: view.path }, null, 2));
    return 0;
  }
  if (sub === 'set') {
    const raw = argsAfterSub(process.argv.slice(2), 'set');
    if (!raw) {
      console.error('config set requires a JSON object argument');
      return 2;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      console.error('config set: invalid JSON');
      return 2;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      console.error('config set: argument must be a JSON object {daemon?,policy?,autonomy?,workspaces?}');
      return 2;
    }
    // Prefer patching a live daemon (applies immediately) when reachable.
    const daemonBase = process.env.GT_DAEMON_URL ?? process.env.HELLDESK_CONTROL_URL;
    const daemonToken = process.env.GT_DAEMON_TOKEN ?? process.env.HELLDESK_CONTROL_TOKEN;
    if (daemonBase && daemonToken) {
      try {
        const resp = await fetch(`${daemonBase}/v1/config`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemonToken}` },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        let parsed: unknown = {};
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        console.log(JSON.stringify({ daemon_patched: true, status: resp.status, result: parsed }, null, 2));
        return resp.ok ? 0 : 1;
      } catch (e) {
        console.error(`[cli] daemon unreachable (${String((e as Error)?.message ?? e)}); falling back to direct file write (applies on next start).`);
      }
    }
    const result = await store.patch(body);
    if (result.rejected.length) {
      console.error(JSON.stringify({ ok: false, rejected: result.rejected }, null, 2));
      return 2;
    }
    console.log(JSON.stringify({ ok: true, applied_live: result.appliedLive, applies_on_restart: result.appliesOnRestart, config_path: result.path }, null, 2));
    return 0;
  }
  console.error(`unknown config subcommand: ${sub ?? '(none)'} (expected get|set)`);
  return 2;
}

function argsAfterSub(argv: string[], sub: string): string | undefined {
  const i = argv.indexOf(sub);
  if (i === -1) return undefined;
  return argv.slice(i + 1).find((a) => !a.startsWith('--'));
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    });
}