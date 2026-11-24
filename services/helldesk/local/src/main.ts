import { openDb, type Db } from './db';
import { loadConfig, defaultDataDir, defaultDbPath, type Config } from './config';
import { newRuntimeConfigStore, type RuntimeConfigStore } from './config-runtime';
import { Engine, makeRunner } from './engine';
import { handleRequest, type ApiContext } from './api';
import { createTelemetry } from './telemetry';
import { writeFileSync, mkdirSync, readFileSync, openSync, closeSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  registerHost, heartbeatHostByInstance, recoverExpiredHostLeases, pruneStaleHosts, upsertSession,
  getHost, disconnectHost, ingestSessionEvent, getSession,
} from './host-registry';
import { acceptWorkerResult } from './worker-supervisor';
import { ensureHiddenChildSpawns } from './windows-spawn';
import { TaskReconciler } from './task-reconciler';
import { advanceMission } from './mission-controller';
import { makeControllerDeps, resolveEffectiveModelRoute } from './engine-review-hook';
import { resolveAndApplyKiloBinary } from './kilo-binary';
import { propagateEngineRoute } from './config-propagation';
import { resumeMissionState } from './mission-repository';
import { sweepStaleReviewJobs } from './mission-controller';
import { reviewRetryDue, REVIEW_MAX_ATTEMPTS } from './review-retry';
import { z } from 'zod';
import { commitEvent, getHostState, upsertHostState, eventsForSession } from './event-journal';

/**
 * HELLDESK Local CONTROL PLANE (standalone, persistent).
 *
 * A single per-user process that OWNS the SQLite DB, port 4789, the global
 * scheduler, the host/session registry, and detached review workers. It is
 * fully independent of VS Code — it keeps running when every window closes.
 *
 * The Kilo plugin is a THIN WS BRIDGE CLIENT: it registers this host and its
 * sessions and emits events. It never binds the port, never opens the DB,
 * never runs the scheduler, and never shuts this process down on dispose.
 *
 *   bun run src/main.ts                 # run the control plane (blocking)
 *   bun run src/main.ts --one-shot J    # run one queued job then exit (test/ops)
 */

export interface DaemonRuntime {
  d: Db;
  engine: Engine;
  token: string;
  dataDir: string;
  reportDir: string;
  port: number;
  /** Runtime config store — single mutable source of truth; the Engine and all
   *  daemon loops read its live Config so PATCH /v1/config applies immediately. */
  configStore: RuntimeConfigStore;
  /** True when this process is the single owning control-plane instance. */
  ready?: boolean;
  /** Whether the pump runs each review stage in independent detached processes. */
  detachedWorkers?: boolean;
  close(): void;
}

export function ensureToken(dataDir: string): string {
  const tokenFile = join(dataDir, 'token');
  try {
    return readFileSync(tokenFile, 'utf-8').trim();
  } catch {
    const t = randomBytes(24).toString('hex');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tokenFile, t, { mode: 0o600 });
    return t;
  }
}

/** Unix-style pidfile + singleton lock. The lock records {pid, timestamp}. A
 *  stale lock (owner dead, or its PID recycled to an unrelated process) is
 *  taken over. liveness is verified against OUR daemon identity, not just any
 *  live PID, so Windows PID reuse (PID now owned by msedge/etc.) can never
 *  block a legitimate restart. */
export function acquireSingletonLock(dataDir: string): { owned: boolean; lockPath: string } {
  const lockPath = join(dataDir, 'controlplane.lock');
  mkdirSync(dataDir, { recursive: true });
  // Try exclusive create; if the file exists, check whether the PID inside is a live daemon.
  try {
    const fd = openSync(lockPath, 'wx');
    const buf = `${process.pid}\n${new Date().toISOString()}\n`;
    writeFileSync(lockPath, buf, { flag: 'r+' });
    closeSync(fd);
    return { owned: true, lockPath };
  } catch (err) {
    // File exists — someone may hold it. Determine if it's a live daemon.
    if (existsSync(lockPath)) {
      try {
        const content = readFileSync(lockPath, 'utf-8').trim().split('\n')[0] ?? '';
        const pid = Number(content);
        if (pid && pid !== process.pid && isOurDaemonAlive(pid)) {
          return { owned: false, lockPath };
        }
      } catch { /* treat as stale */ }
      // stale lock — take it over
      try {
        writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'w' });
        return { owned: true, lockPath };
      } catch {
        return { owned: false, lockPath };
      }
    }
    return { owned: false, lockPath };
  }
}

/** True only when `pid` is a LIVE daemon of ours: a bun process actually
 *  running `src/main.ts --daemon`. This avoids the Windows PID-reuse trap where
 *  a dead daemon's PID number is later handed to an unrelated process (Edge,
 *  Explorer...) — that must be treated as a stale lock, never as a live owner.
 *  Uses PowerShell's Get-CimInstance (present on current Windows; wmic is
 *  deprecated/removed) to read the process command line. */
function isOurDaemonAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  try {
    // Inspect the command line: only a live daemon of this project counts.
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ], { encoding: 'utf8', timeout: 8000 });
    const cl = (out || '');
    return cl.toLowerCase().includes('main.ts') && cl.toLowerCase().includes('--daemon');
  } catch {
    // Inspection tooling unavailable: fall back to plain PID existence (best effort).
    return true;
  }
}

function releaseSingletonLock(lockPath: string): void {
  try {
    const pid = Number((readFileSync(lockPath, 'utf-8').split('\n')[0] ?? '').trim());
    if (pid === process.pid) writeFileSync(lockPath, '', { flag: 'w' }); // clear for next owner
  } catch { /* noop */ }
}

/**
 * Resolve the Kilo CLI (no pinned extension version) and validate the effective
 * model BEFORE the Engine/controller reads the config. Fail closed with a
 * precise message when a Kilo-backed stage has no binary or no model.
 */
function applyRuntimeBinariesAndValidateModel(config: Config): void {
  const binaries = resolveAndApplyKiloBinary(config);
  for (const [stage, found] of Object.entries(binaries)) {
    if (found && found.source !== 'configured') {
      console.log(
        `[helldesk] kilo ${stage} binary resolved (${found.source}${found.version ? ` ${found.version}` : ''}) -> ${found.path}`,
      );
    }
  }

  const reviewerRoute = config.policy.reviewerModel ?? resolveEffectiveModelRoute({});
  if (config.policy.runner === 'kilo' && (!reviewerRoute.providerID || !reviewerRoute.modelID)) {
    throw new Error(
      'No default Kilo model configured. Set "model": "provider/model" in ~/.config/kilo/kilo.jsonc ' +
        '(or policy.reviewerModel). No LiteLLM/local fallback is assumed.',
    );
  }

  if (config.autonomy.enabled !== false && config.autonomy.mutationRunner === 'kilo') {
    const mutationRoute = resolveEffectiveModelRoute({
      providerID: config.autonomy.providerID,
      modelID: config.autonomy.modelID,
    });
    if (!mutationRoute.providerID || !mutationRoute.modelID) {
      throw new Error(
        'No default Kilo model configured for the mutation runner. Set "model": "provider/model" ' +
          'in ~/.config/kilo/kilo.jsonc (or autonomy.providerID/modelID).',
      );
    }
  }
}

export async function startDaemon(opts?: {
  configPath?: string;
  config?: Config;
  runnerOverride?: ReturnType<typeof makeRunner> | null;
}): Promise<DaemonRuntime> {
  const config = opts?.config ?? loadConfig(opts?.configPath);
  applyRuntimeBinariesAndValidateModel(config);
  // The runtime config store owns the SAME mutable Config object the Engine and
  // the daemon loops read, so a live PATCH /v1/config applies by reference.
  const configStore = newRuntimeConfigStore({
    configPath: opts?.configPath,
    config,
  });
  // CLI/env overrides win over config — MUST be applied to the ENGINE config
  // BEFORE Engine construction. `--daemon` / HELLDESK_DETACHED_WORKERS=1 drive the
  // review-execution selection (engine.executeQueuedJob) which reads
  // config.daemon.detachedWorkers; resolving it here (not in serve after the
  // engine exists) is the ONLY authority both the scheduler pump and the mission
  // review hook share.
  const envDetached = process.env.HELLDESK_DETACHED_WORKERS;
  if (envDetached === '1') config.daemon.detachedWorkers = true;
  else if (envDetached === '0') config.daemon.detachedWorkers = false;
  const dataDir = config.daemon.dataDir ?? defaultDataDir();
  const dbPath = config.daemon.dbPath ?? defaultDbPath(dataDir);
  const snapshotStore = join(dataDir, 'snapshots');
  const reportDir = join(dataDir, 'reports');
  const logDir = config.daemon.logDir ?? join(dataDir, 'logs');
  mkdirSync(snapshotStore, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const d = openDb(dbPath);
  d.runMigration();

  const resolvedModels = new Map<string, { providerID: string; modelID: string }>();
  // Reviewer/adjudicator roles follow the operator's effective Kilo default model
  // (`~/.config/kilo/kilo.json(c)` `.model`) unless a role is pinned explicitly.
  // This is the same inheritance the writable mutation session already uses, so a
  // global provider/model switch refreshes BOTH boundaries together.
  resolvedModels.set('inherited', config.policy.reviewerModel ?? resolveEffectiveModelRoute({}));

  const telemetry = createTelemetry({ logDir });
  const runner = opts?.runnerOverride ?? makeRunner(config, telemetry);
  const engine = new Engine({ d, config, snapshotStore, reportDir, runner, resolvedModels });
  const startup = engine.onStartup();
  if (startup.mutationLeases > 0) {
    console.log(`[helldesk] cleared ${startup.mutationLeases} stale mutation-writer lease(s) from the previous process`);
  }
  engine.reload();

  const token = config.daemon.token ?? ensureToken(dataDir);
  return { d, engine, token, dataDir, reportDir, port: config.daemon.port, configStore, close: () => d.close() };
}

function queueStat(engine: Engine): { queued: number; running: number; inFlight: number } {
  try {
    const s = engine.d.db
      .query<{ queued: number; running: number; inflight: number }, []>(
        `SELECT COALESCE(SUM(state='QUEUED'),0) AS queued,
                COALESCE(SUM(state IN ('REVIEWING_A_B','ADJUDICATING')),0) AS running,
                COALESCE(SUM(state IN ('REVIEWING_A_B','ADJUDICATING','QUEUED','DISCOVERED','SNAPSHOTTED')),0) AS inflight
         FROM review_jobs`
      )
      .get() ?? { queued: 0, running: 0, inflight: 0 };
    return { queued: s.queued, running: s.running, inFlight: s.inflight };
  } catch {
    return { queued: 0, running: 0, inFlight: 0 };
  }
}

/** Run the control plane (blocking, single-instance). Returns the runtime. */
export async function serve(opts?: {
  configPath?: string;
  config?: Config;
  runnerOverride?: ReturnType<typeof makeRunner>;
}): Promise<DaemonRuntime> {
  // Windows console hygiene: every child the daemon spawns (kilo serve, gate
  // command shells, preview servers) must stay windowless. Installed once.
  ensureHiddenChildSpawns();
  const rt = await startDaemon(opts);
  // SINGLE mutable config reference — the same live Config object Engine reads,
  // owned by rt.configStore. Runtime PATCH /v1/config mutates this same object.
  const cfg = rt.configStore.get();
  const port = cfg.daemon.port;
  const bind = cfg.daemon.bind;
  const leaseSeconds = cfg.daemon.leaseSeconds ?? 120;
  const lock = acquireSingletonLock(rt.dataDir);
  if (!lock.owned) {
    rt.close();
    throw new Error(`HELLDESK control plane already running (lock held). Connect as a client instead; not booting a second instance.`);
  }

  // Unix-style pidfile: records the exact owning daemon PID + bound port so
  // the stop script can signal ONLY this process (no process-name scans).
  const pidPath = join(rt.dataDir, 'controlplane.pid');
  mkdirSync(rt.dataDir, { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n${port}\n`, { flag: 'w' });

  const apiCtx: ApiContext = {
    d: rt.d,
    engine: rt.engine,
    config: cfg,
    configStore: rt.configStore,
    token: rt.token,
    queueDepth: () => queueStat(rt.engine),
  };

  // Service-owned task reconciler: the ONE owner of completion eligibility,
  // review dispatch, and dedup. Consumes durable journal events. The plugin
  // never runs a state machine. `quietMs` is deref'd live so a runtime
  // debounce change applies to the next quiet-eligibility evaluation.
  const reconciler = new TaskReconciler({
    debounceMs: cfg.daemon.debounceMs ?? 4000,
    quietMs: () => (rt.configStore.get().daemon.debounceMs ?? 4000) * 2,
    policyVersion: cfg.policy.reviewerModel ? 'v2' : 'v1',
    enqueue: async (meta) => {
      // Engine owns snapshot + workspace registration + dedup in ONE call.
      const res = await rt.engine.createAndEnqueue({
        workspacePath: meta.workspaceRoot,
        subjectKind: 'git-dirty',
        includeDirty: true,
        includeUntracked: true,
        base: meta.baselineHead,
        source: meta.source,
        triggerSessionId: meta.sessionId,
      });
      return { jobId: res.jobId };
    },
  });

  // Detached worker self-reporting: workers POST their result back to this
  // daemon. Set the env the Engine reads to construct the worker argv.
  process.env.HELLDESK_CONTROL_URL = `http://${bind}:${port}`;
  process.env.HELLDESK_CONTROL_TOKEN = rt.token;
  // THE authoritative detached-work policy was resolved (config + env override)
  // inside startDaemon before Engine construction. serve() only surfaces it for
  // observability; it does NOT re-decide here.
  const detachedWorkers: boolean = cfg.daemon.detachedWorkers ?? false;
  rt.detachedWorkers = detachedWorkers;

  // Global scheduler pump: pull QUEUED jobs within the concurrency ceiling.
  // (Separate reviewer/adjudicator drives happen per job inside Engine; here we
  //  allow multiple jobs concurrently per maxConcurrentJobs.) The ceiling is
  //  read LIVE each tick so a runtime maxConcurrentJobs change takes effect
  //  without restart.
  const running = new Set<Promise<void>>();
  const pump = async () => {
    const maxJobs = Math.max(1, rt.configStore.get().daemon.maxConcurrentJobs ?? 1);
    while (running.size < maxJobs) {
      const q = queueStat(rt.engine);
      if (q.queued === 0) break;
      // Pick the first QUEUED job whose retry backoff has elapsed. A failing
      // governor used to be requeued instantly: 118 attempts in ~90 minutes,
      // each looking like a model turn. Attempts now back off exponentially and
      // stop at a hard cap; the attempt rows remain visible in Observability.
      const next = rt.engine.d.db
        .query<{ job_id: string; attempt_count: number; updated_at: string | null }, []>(
          `SELECT job_id, attempt_count, updated_at FROM review_jobs WHERE state='QUEUED' ORDER BY requested_at ASC LIMIT 50`
        )
        .all()
        .find((job) => reviewRetryDue(job.attempt_count, job.updated_at));
      if (!next) break;
      if (next.attempt_count >= REVIEW_MAX_ATTEMPTS) {
        rt.engine.failRetryBudget(next.job_id);
        continue;
      }
      const p = rt.engine.executeQueuedJob(next.job_id).catch((err) => {
        console.error(`[helldesk] job ${next.job_id} failed:`, err?.message ?? err);
      });
      running.add(p);
      p.finally(() => {
        running.delete(p);
        void pump();
      });
    }
  };
  const timer = setInterval(() => void pump(), 1000);
  void pump();

  // Ender autonomy: advance active missions through REPLAN→mutation→evidence→ExcellenceGovernor.
  // Wired to the REAL engine review (GATE 4) via makeControllerDeps. Only runs when
  // `autonomy.enabled` is true (operator-gated) so it never fires mutations unless
  // explicitly enabled; mission state survives daemon restart. Both the enabled
  // gate and the mission deps are rebuilt LIVE from the runtime config each tick
  // so toggling autonomy / its model route via /v1/config applies immediately.
  const activeMissionRuns = new Set<string>();
  // CONFIG PROPAGATION: engine matrices are creation-time snapshots, so a
  // provider/model switch must be pushed to every queued/in-progress task or they
  // keep using a stale (or dead) endpoint. Startup + a 60s reconcile (and the
  // /v1/config patch path) keep them on the CURRENT effective route.
  let lastRouteKey = '';
  let lastRouteCheck = 0;
  const syncEngineRoute = () => {
    const cfgNow = rt.configStore.get();
    const route = resolveEffectiveModelRoute({ providerID: cfgNow.autonomy.providerID, modelID: cfgNow.autonomy.modelID });
    const key = `${route.providerID}/${route.modelID}`;
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    const res = propagateEngineRoute(rt.d, route);
    if (res.updated) console.log(`[helldesk] engine route propagated to ${res.updated}/${res.total} non-terminal missions: ${key}`);
  };
  syncEngineRoute();
  const missionTick = setInterval(async () => {
    const liveCfg = rt.configStore.get();
    if (!liveCfg.autonomy.enabled) return;
    if (Date.now() - lastRouteCheck > 60_000) {
      lastRouteCheck = Date.now();
      syncEngineRoute();
    }
    // STALE REVIEW SWEEP: a rejected/superseded revision must not keep reviewers
    // running (or look active) while the mission moved on.
    try {
      const cancelled = sweepStaleReviewJobs(rt.d);
      if (cancelled) console.log(`[helldesk] cancelled ${cancelled} stale review job(s)`);
    } catch (err) {
      console.error('[helldesk-autonomy] stale review sweep failed', err instanceof Error ? err.message : String(err));
    }
    // AUTO-RETRY: bounded resume for TRANSIENT BLOCKED_EXTERNAL missions.
    try {
      const dueRetries = rt.d.db
        .query<{ mission_id: string }, [string]>(
          `SELECT mission_id FROM autonomy_missions WHERE state='BLOCKED_EXTERNAL' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`
        )
        .all(new Date().toISOString());
      for (const row of dueRetries) {
        if (resumeMissionState(rt.d, row.mission_id)) console.log(`[helldesk] auto-retry resumed ${row.mission_id}`);
      }
    } catch (err) {
      console.error('[helldesk-autonomy] auto-retry sweep failed', err instanceof Error ? err.message : String(err));
    }
    try {
      const active = rt.d.db.query<{ mission_id: string; task_gates_json: string }, []>(
        `SELECT mission_id, task_gates_json FROM autonomy_missions WHERE state IN ('ACTIVE','PLANNING','MUTATING','CAPTURING_EVIDENCE','VERIFYING','REPLANNING')`
      ).all();
      for (const m of active) {
        if (activeMissionRuns.size >= liveCfg.daemon.maxConcurrentJobs) break;
        if (activeMissionRuns.has(m.mission_id)) continue;
        const gates = z.array(z.string()).parse(JSON.parse(m.task_gates_json || '[]'));
        const deps = makeControllerDeps(rt.engine, { ...liveCfg.autonomy, taskGates: gates.length ? gates : liveCfg.autonomy.taskGates, verifyMode: liveCfg.policy.verifyMode });
        activeMissionRuns.add(m.mission_id);
        void advanceMission(m.mission_id, deps)
          .catch(err => console.error('[helldesk-autonomy]', err instanceof Error ? (err.stack ?? err.message) : 'Mission failed'))
          .finally(() => activeMissionRuns.delete(m.mission_id));
      }
    } catch (err) {
      // A transient controller error must not kill the autonomy loop.
      console.error('[helldesk-autonomy]', err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }, 4000);

  // Durable completion-reconcile tick. This is intentionally independent of
  // the host lease cadence so a transient snapshot/enqueue failure resumes
  // promptly and also survives daemon restarts.
  const reconcileTick = setInterval(
    () => void reconciler.reconcilePending(rt.d),
    Math.max(1000, Math.min(cfg.daemon.debounceMs ?? 4000, 5000))
  );
  void reconciler.reconcilePending(rt.d);

  // Host lease recovery tick.
  const hostTick = setInterval(() => {
    recoverExpiredHostLeases(rt.d);
    pruneStaleHosts(rt.d);
  }, Math.max(5000, leaseSeconds * 1000));

  // Zombie-worker reconcile: mark 'launching'/'running' review workers whose job
  // is now terminal as 'terminated' so the operator Agents panel does not show
  // reviewers 'active' forever on a decided job. Without this, a worker that
  // survived its job's completion (or the daemon restart) stays visibly 'running'
  // for hours (seen: 600+ min on job_48ed2b2f3a). read+write is safe: a worker on
  // a genuinely live job is untouched.
  const reapZombieWorkers = () => {
    try {
      const t = new Date(Date.now() - 90_000).toISOString();
      rt.d.db.query(
        `UPDATE workers
            SET status='terminated', finished_at=COALESCE(finished_at, ?)
          WHERE status IN ('launching','running')
            AND job_id IS NOT NULL
            AND job_id IN (
              SELECT job_id FROM review_jobs
              WHERE state IN ('COMPLETED_PASS','COMPLETED_FINDINGS','INCONCLUSIVE','FAILED_TERMINAL','CANCELLED')
            )`
      ).run(t);
    } catch { /* best effort */ }
  };
  void reapZombieWorkers();
  const zombieTick = setInterval(() => void reapZombieWorkers(), Math.max(5000, leaseSeconds * 1000));

  const server = Bun.serve({
    hostname: bind,
    port,
    // Long mutation/review dispatches keep requests open; do not cut them at 10s.
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/ws') {
        if (server.upgrade(req)) return new Response(null, { status: 101 });
        return new Response('upgrade required', { status: 426 });
      }
      return handleRequest(apiCtx, req);
    },
    websocket: {
      open(ws) {
        // WS is used by host-bridge clients; auth handled on first message.
        ws.send(JSON.stringify({ type: 'hello', you: ws.data ?? null }));
      },
      message(ws, raw) {
        try { void handleBridgeMessage(rt, ws, String(raw), cfg, reconciler); }
        catch (err) { console.error(`[helldesk] ws message error: ${err instanceof Error ? err.message : String(err)}`); }
      },
      close() {
        // Host disconnect reconciliation happens via lease expiry (heartbeat) /
        // durable journal high-water marks (plugin-side resume on reconnect).
      },
    },
  });

  const shutdown = () => {
    server.stop(true);
    clearInterval(timer);
    clearInterval(reconcileTick);
    clearInterval(hostTick);
    clearInterval(missionTick);
    reconciler.dispose();
    releaseSingletonLock(lock.lockPath);
    try { rmSync(pidPath, { force: true }); } catch { /* noop */ }
    rt.close();
  };
  if (import.meta.main) {
    process.on('SIGINT', () => { shutdown(); process.exit(0); });
    process.on('SIGTERM', () => { shutdown(); process.exit(0); });
    // Graceful close on Windows console shutdown so sockets are released (not orphaned).
    process.on('SIGBREAK', () => { shutdown(); process.exit(0); });
  }
  return { ...rt, port, close: shutdown };
}

/** WS bridge protocol: host <-> control plane (thin client; plugin never owns). */
async function handleBridgeMessage(rt: DaemonRuntime, ws: Bun.ServerWebSocket<unknown>, raw: string, cfg: Config, reconciler?: TaskReconciler): Promise<void> {
  let msg: { type?: string; body?: unknown; protocolVersion?: number; eventType?: string; eventId?: string; localSeq?: number; hostId?: string; sessionId?: string; runtimeId?: string; payload?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'bad json' }));
    return;
  }
  // New versioned-envelope protocol (v1): framed with top-level fields.
  if (typeof msg.protocolVersion === 'number' && msg.protocolVersion >= 1 && msg.eventType && msg.hostId && msg.localSeq) {
    try {
      await handleVersionedEnvelope(rt, ws, {
        protocolVersion: msg.protocolVersion,
        eventType: msg.eventType,
        hostId: msg.hostId,
        runtimeId: msg.runtimeId,
        sessionId: msg.sessionId,
        turnId: (msg as { turnId?: string }).turnId,
        eventId: msg.eventId ?? '',
        localSeq: msg.localSeq,
        timestamp: (msg as { timestamp?: string }).timestamp,
        payload: msg.payload ?? {},
      }, cfg, reconciler);
    } catch (err) {
      console.error(`[helldesk] envelope ${msg.eventType} error: ${err instanceof Error ? err.message : String(err)}`);
      try { ws.send(JSON.stringify({ type: 'error', error: 'envelope-failed' })); } catch {}
    }
    return;
  }
  const body = (msg.body ?? {}) as Record<string, any>;
  try {
    switch (msg.type) {
      case 'hello.authenticate': {
        if (body.token !== rt.token) {
          ws.send(JSON.stringify({ type: 'auth', ok: false }));
          return;
        }
        // HOST-12: a reviewer / headless worker runtime must never consume a
        // developer host slot nor present itself as a live editor. Such
        // runtimes are launched with KILO_PURE or a reviewer marker; reject the
        // host subscription so a worker can't be mistaken for a real session.
        // Explicit editor/vscode instance ids are always allowed.
        const rawRuntime = String(body.runtimeId ?? '');
        const rawInstance = String(body.instanceId ?? '');
        const looksLikeEditor = /^(dev-|editor-|vscode-|ses_|host_)/i.test(rawInstance);
        const marksReviewer =
          /kilo-headless|reviewer/i.test(rawRuntime) ||
          /^reviewer_/i.test(rawInstance) ||
          (Array.isArray(body.capabilities) && body.capabilities.some((c: string) => /^role:reviewer$/i.test(c)));
        if (marksReviewer && !looksLikeEditor) {
          ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'reviewer-runtime-not-a-host' }));
          return;
        }
        ws.data = { authed: true, instanceId: body.instanceId };
        const host = registerHost(rt.d, {
          instanceId: body.instanceId,
          runtimeId: body.runtimeId,
          pid: Number(body.pid ?? -1),
          sdkServerUrl: body.sdkServerUrl,
          workspaceRoots: Array.isArray(body.workspaceRoots) ? body.workspaceRoots : [],
          pluginVersion: body.pluginVersion,
          sdkVersion: body.sdkVersion,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
        }, cfg.daemon.leaseSeconds ?? 120);
        ws.send(JSON.stringify({ type: 'auth', ok: true, hostId: host.hostId, leaseSeconds: cfg.daemon.leaseSeconds ?? 120 }));
        // Sync the host's currently-discoverable sessions.
        if (Array.isArray(body.sessions)) {
          for (const s of body.sessions as Array<Record<string, any>>) {
            upsertSession(rt.d, { hostId: host.hostId, sessionId: String(s.sessionId), workspaceRoot: s.workspaceRoot, worktreeRoot: s.worktreeRoot, agentId: s.agentId, selectedProviderId: s.selectedProviderId, selectedModelId: s.selectedModelId, status: 'active' });
          }
        }
        break;
      }
      case 'heartbeat': {
        if (!body.instanceId) break;
        heartbeatHostByInstance(rt.d, String(body.instanceId), cfg.daemon.leaseSeconds ?? 120);
        // Re-sync session live status if provided.
        if (Array.isArray(body.sessions)) {
          for (const s of body.sessions as Array<Record<string, any>>) {
            const h = getHostByInstanceCached(rt.d, String(body.instanceId));
            if (h) upsertSession(rt.d, { hostId: h.hostId, sessionId: String(s.sessionId), workspaceRoot: s.workspaceRoot, worktreeRoot: s.worktreeRoot, agentId: s.agentId, selectedProviderId: s.selectedProviderId, selectedModelId: s.selectedModelId, status: s.status });
          }
        }
        ws.send(JSON.stringify({ type: 'heartbeat', ok: true }));
        break;
      }
      case 'session.upsert': {
        const h = getHostByInstanceCached(rt.d, String(body.instanceId));
        if (!h) break;
        upsertSession(rt.d, {
          hostId: h.hostId,
          sessionId: String(body.sessionId),
          workspaceRoot: body.workspaceRoot,
          worktreeRoot: body.worktreeRoot,
          agentId: body.agentId,
          selectedProviderId: body.selectedProviderId,
          selectedModelId: body.selectedModelId,
          status: body.status,
        });
        ws.send(JSON.stringify({ type: 'ack', ok: true, for: 'session.upsert' }));
        break;
      }
      case 'session.event': {
        const h = getHostByInstanceCached(rt.d, String(body.instanceId));
        if (!h) break;
        const session = getSession(rt.d, h.hostId, String(body.sessionId));
        const epoch = session?.taskEpoch ?? 0;
        ingestSessionEvent(rt.d, h.hostId, String(body.sessionId), String(body.eventType), body.payload ?? {}, epoch);
        ws.send(JSON.stringify({ type: 'ack', ok: true, for: 'session.event', sessionId: body.sessionId }));
        break;
      }
      case 'session.disconnect': {
        const h = getHostByInstanceCached(rt.d, String(body.instanceId));
        if (h) disconnectHost(rt.d, h.hostId);
        ws.send(JSON.stringify({ type: 'ack', ok: true, for: 'session.disconnect' }));
        break;
      }
      default:
        ws.send(JSON.stringify({ type: 'error', message: `unknown type ${msg.type}` }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
  }
}

/**
 * Versioned-envelope protocol (v1) — bank-grade, service-owned.
 * Envelopes carry top-level protocolVersion/hostId/eventId/localSeq/eventType.
 *  - `auth`: registers the host, returns hostId + lease, and the server's
 *    durable last-acked-seq so the plugin can `resume`.
 *  - `session.upsert` / `session.event`: journal-committed in one transaction,
 *    then ack(localSeq) is sent. Repeated eventIds are no-op ACKs.
 *  - `resume(lastSeq)`: server returns events above the plugin's last ack.
 *  - `heartbeat`: renews the host lease.
 */
async function handleVersionedEnvelope(
  rt: DaemonRuntime, ws: Bun.ServerWebSocket<unknown>,
  frame: { protocolVersion: number; eventType: string; hostId?: string; runtimeId?: string; sessionId?: string; turnId?: string; eventId: string; localSeq: number; timestamp?: string; payload?: Record<string, unknown> },
  cfg: Config, reconciler?: TaskReconciler
): Promise<void> {
  const eventType = frame.eventType;
  const hostId = String(frame.hostId ?? '');
  const seq = Number(frame.localSeq ?? 0);

  if (eventType === 'auth') {
    const authPayload = (frame.payload ?? {}) as Record<string, any>;
    if (authPayload.token !== rt.token) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'unauthorized' }));
      return;
    }
    const instanceId = hostId || String(authPayload.instanceId ?? '');
    if (!instanceId) { ws.send(JSON.stringify({ type: 'error', error: 'missing hostId' })); return; }
    const rawRuntime = String(authPayload.runtimeId ?? frame.runtimeId ?? '');
    const looksLikeEditor = /^(dev-|editor-|vscode-|ses_|host_)/i.test(instanceId);
    const marksReviewer = /kilo-headless|reviewer/i.test(rawRuntime) || /^reviewer_/i.test(instanceId);
    if (marksReviewer && !looksLikeEditor) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, error: 'reviewer-runtime-not-a-host' }));
      return;
    }
    const lease = cfg.daemon.leaseSeconds ?? 120;
    const host = registerHost(rt.d, {
      instanceId,
      runtimeId: rawRuntime,
      pid: Number(authPayload.pid ?? -1),
      sdkServerUrl: undefined,
      workspaceRoots: Array.isArray(authPayload.workspaceRoots) ? authPayload.workspaceRoots : [],
      pluginVersion: String(authPayload.pluginVersion ?? ''),
      sdkVersion: String(authPayload.sdkVersion ?? ''),
      capabilities: Array.isArray(authPayload.capabilities) ? authPayload.capabilities : [],
    }, lease);
    upsertHostState(rt.d, host.hostId, frame.protocolVersion, lease);
    const state = getHostState(rt.d, host.hostId);
    ws.data = { authed: true, instanceId };
    ws.send(JSON.stringify({ type: 'auth', ok: true, hostId: host.hostId, leaseSeconds: lease, resumeSeq: state.lastAckedSeq, protocolVersion: frame.protocolVersion }));
    ws.send(JSON.stringify({ type: 'ack', ok: true, ack: seq }));
    return;
  }

  // Everything after auth requires the host to be registered.
  const host = instanceId2host(rt.d, hostId) ?? (hostId ? getHostByInstanceCached(rt.d, hostId) : null);
  if (!host) { ws.send(JSON.stringify({ type: 'error', error: 'not-authenticated' })); return; }

  if (eventType === 'session.upsert') {
    const p = (frame.payload ?? {}) as Record<string, any>;
    upsertSession(rt.d, { hostId: host.hostId, sessionId: String(p.sessionId ?? frame.sessionId ?? ''), workspaceRoot: p.workspaceRoot, worktreeRoot: p.worktreeRoot, agentId: p.agentId, selectedProviderId: p.selectedProviderId, selectedModelId: p.selectedModelId, status: p.status ?? 'active' });
    ws.send(JSON.stringify({ type: 'ack', ack: seq }));
    return;
  }

  if (eventType === 'session.event' || ['chat.message','turn.started','file.edited','session.status','session.idle','session.diff','tool.execute.before','tool.execute.after','tool.started','tool.completed'].includes(eventType)) {
    const p = (frame.payload ?? {}) as Record<string, any>;
    const sessionId = String(p.sessionId ?? frame.sessionId ?? '');
    const innerEventType = String(p.eventType ?? eventType);
    // Durable journal commit (idempotent) then ack.
    const committed = commitEvent(rt.d, {
      hostId: host.hostId,
      runtimeId: frame.runtimeId ?? host.runtimeId,
      sessionId,
      turnId: frame.turnId,
      eventId: frame.eventId || `ev-${seq}`,
      localSeq: seq,
      eventType: innerEventType,
      protocolVersion: frame.protocolVersion,
      payload: p.payload ?? p,
    });
    ws.send(JSON.stringify({ type: 'ack', ok: true, ack: seq, inserted: committed.inserted }));
    if (committed.inserted) {
      // Upsert the session so the reconciler has a workspace root.
      upsertSession(rt.d, { hostId: host.hostId, sessionId, workspaceRoot: p.workspaceRoot || undefined, status: 'active' });
      await reconciler?.ingest(rt.d, { hostId: host.hostId, sessionId, eventId: frame.eventId, eventType: innerEventType, payload: (p.payload ?? p) as Record<string, unknown> });
    }
    return;
  }

  if (eventType === 'heartbeat') {
    heartbeatHostByInstance(rt.d, host.instanceId ?? host.hostId, cfg.daemon.leaseSeconds ?? 120);
    ws.send(JSON.stringify({ type: 'heartbeat', ok: true }));
    return;
  }

  if (eventType === 'host.disconnect') {
    disconnectHost(rt.d, host.hostId);
    ws.send(JSON.stringify({ type: 'ack', ack: seq }));
    return;
  }

  ws.send(JSON.stringify({ type: 'error', error: `unknown envelope ${eventType}` }));
}

function instanceId2host(d: Db, hostId: string) {
  return hostId.startsWith('host_') ? getHost(d, hostId) : getHostByInstanceCached(d, hostId);
}

async function registerWorkspaceForDispatch(rt: DaemonRuntime, workspaceRoot: string): Promise<string> {
  // Unused placeholder removed.
  return workspaceRoot;
}

function getHostByInstanceCached(d: Db, instanceId: string) {
  return (getHost(d, instanceId.startsWith('host_') ? instanceId : `host_${instanceId}`)) ??
    (() => {
      const r = d.db.query<{ host_id: string }, [string]>(`SELECT host_id FROM hosts WHERE instance_id=?`).get(instanceId);
      return r ? getHost(d, r.host_id) : null;
    })();
}

export { acceptWorkerResult };

const isMain = import.meta.main;
if (isMain) {
  const args = process.argv.slice(2);
  const oneShotIndex = args.indexOf('--one-shot');
  let configPath: string | undefined;
  if (args.includes('--config')) configPath = args[args.indexOf('--config') + 1];

  if (oneShotIndex !== -1) {
    const jobId = args[oneShotIndex + 1];
    if (!jobId) { console.error('[helldesk] --one-shot requires a jobId'); process.exit(2); }
    const rt = await startDaemon({ configPath });
    await rt.engine.runJob(jobId);
    rt.close();
    process.exit(0);
  }

  // --daemon runs the persistent control plane with detached-worker reviews
  // (independent processes). Production mode FAILS CLOSED: it can never run
  // synthetic/fake inference. --no-detached keeps the legacy in-process path
  // (used by the existing e2e tests, where fake is an explicit test override).
  const daemonMode = args.includes('--daemon');
  if (daemonMode) process.env.HELLDESK_DETACHED_WORKERS = '1';
  if (args.includes('--no-detached')) process.env.HELLDESK_DETACHED_WORKERS = '0';

  if (daemonMode) {
    const dcfg = loadConfig(configPath);
    // Production fail-closed: @ daemon.production=true, synthetic/fake inference
    // is forbidden and runner=kilo requires the headless Kilo server binary.
    const production = dcfg.daemon.production === true;
    if (production && dcfg.policy.runner === 'fake') {
      console.error('[helldesk] FAIL_CLOSED: production daemon cannot run runner=fake (synthetic inference). Set daemon.production=false for test daemons, or policy.runner=kilo/openai.');
      process.exit(42);
    }
  }

  // startDaemon resolves the Kilo CLI (explicit → KILO_BIN → PATH → newest
  // installed extension) and validates the effective model. Fail closed with a
  // single precise message instead of an unhandled stack.
  let rt: Awaited<ReturnType<typeof serve>>;
  try {
    rt = await serve({ configPath });
  } catch (error) {
    console.error(`[helldesk] FAIL_CLOSED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(42);
  }
  rt.ready = true;
  if (process.env.HELLDESK_DETACHED_WORKERS === '1' || args.includes('--daemon')) {
    // Advertise readiness for the parent launcher / scheduled task.
    const cfg = loadConfig(configPath);
    console.log(`[helldesk] control plane up on ${cfg.daemon.bind}:${cfg.daemon.port} pid=${process.pid} detachedWorkers=${rt.detachedWorkers}`);
  }
}
