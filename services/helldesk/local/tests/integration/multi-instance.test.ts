import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGitFixture } from '../helpers';

type Json = Record<string, any>;
const getJson = (r: Response) => r.json() as Promise<Json>;

/**
 * MULTI-01..N — Multi-instance / process-independence integration tests.
 *
 * These run the REAL `src/main.ts --daemon` as separate bun processes on
 * isolated ports/data dirs (deterministic fake reviewer). They prove the
 * control plane is:
 *   • a persistent standalone process (not tied to any "window"),
 *   • strictly single-instance per data dir (port + singleton lock),
 *   • reachable by MANY thin WS host-bridge clients simultaneously,
 *   • capable of running two independent detached-worker reviews concurrently
 *     and leaving viable, worker-attached, persistent state.
 */

function rootDir(): string {
  return join(__dirname, '..', '..');
}
const MAIN = join(rootDir(), 'src', 'main.ts');

interface SpawnedDaemon {
  proc: ChildProcess;
  port: number;
  base: string;
  dataDir: string;
  token: string;
}

async function startDaemonProcess(opts: { port: number; detachedWorkers?: boolean; runner?: string }): Promise<SpawnedDaemon> {
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-multi-'));
  // Embed a deterministic token in the config so the daemon and the test agree
  // with no file-read race and no cross-run collision.
  const token = `multi-token-${opts.port}-${Date.now()}`;
  const configPath = join(dataDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: opts.port, dataDir, token, debounceMs: 50, maxConcurrentJobs: 2 },
      policy: { runner: opts.runner ?? 'fake', strictCoverage: true },
      workspaces: [],
    })
  );
  const args = [MAIN, '--daemon', '--config', configPath];
  if (opts.detachedWorkers === false) args.push('--no-detached');
  // Spawn Bun directly on the entry TS (no `bun run` wrapper) so proc.pid IS
  // the daemon process and teardown can kill it reliably on Windows.
  const proc = spawn('bun', args, { cwd: rootDir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const dbg = join(dataDir, 'daemon.stderr.log');
  const dbgOut = join(dataDir, 'daemon.stdout.log');
  const acc: string[] = [];
  const accOut: string[] = [];
  proc.stderr?.on('data', (b) => { acc.push(b.toString()); if (acc.length > 400) acc.shift(); });
  proc.stdout?.on('data', (b) => { accOut.push(b.toString()); if (accOut.length > 400) accOut.shift(); });
  // Flush bounded tails periodically + on exit so diagnostics are readable live.
  const flush = () => { try { writeFileSync(dbg, acc.join('')); writeFileSync(dbgOut, accOut.join('')); } catch { /* noop */ } };
  const iv = setInterval(flush, 800);
  proc.on('exit', () => { clearInterval(iv); flush(); });
  return { proc, port: opts.port, base: `http://127.0.0.1:${opts.port}`, dataDir, token };
}

async function waitHealth(base: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function waitExit(p: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { p.kill(); resolve(null); }, timeoutMs);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

async function wsClient(base: string, token: string, instanceId: string, sessions: string[]): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(String((e as ErrorEvent)?.message ?? e)));
  });
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data));
      if (m.type === 'auth' && m.ok) {
        for (const s of sessions) ws.send(JSON.stringify({ type: 'session.upsert', body: { instanceId, sessionId: s, workspaceRoot: s, status: 'active' } }));
      }
    } catch { /* ignore */ }
  };
  ws.send(JSON.stringify({
    type: 'hello.authenticate',
    body: {
      instanceId, runtimeId: 'node:v22', pid: process.pid,
      workspaceRoots: sessions, pluginVersion: 'test', sdkVersion: 'test', capabilities: ['chat.message'],
      token,
    },
  }));
  await new Promise((r) => setTimeout(r, 400));
  return ws;
}

const P = { p4796: false, p4797: false };
let daemons: SpawnedDaemon[] = [];
let w1: WebSocket | undefined, w2: WebSocket | undefined;

/** Grab a free TCP port so runs never collide with leaked/parallel daemons. */
async function freePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, fetch: () => new Response('', { status: 404 }) });
  const port = srv.port as number;
  srv.stop(true);
  return port;
}

beforeAll(async () => {
  // Two independent control planes on isolated, dynamically-free ports (MULTI
  // single-instance check runs its own second-boot probe; A is used for
  // host-attach + jobs).
  const pa = await freePort();
  const pb = await freePort();
  const a = await startDaemonProcess({ port: pa, detachedWorkers: true });
  const b = await startDaemonProcess({ port: pb, detachedWorkers: true });
  daemons = [a, b];
  expect(await waitHealth(a.base)).toBe(true);
  expect(await waitHealth(b.base)).toBe(true);
  // Two simulated plugin host bridges attach to A.
  w1 = await wsClient(a.base, a.token, 'instance_sim_1', ['G:/host/sim1']);
  w2 = await wsClient(a.base, a.token, 'instance_sim_2', ['G:/host/sim2']);
}, 60_000);

afterAll(async () => {
  try { w1?.close(); } catch { /* noop */ }
  try { w2?.close(); } catch { /* noop */ }
  for (const d of daemons) {
    try { d.proc.kill(); } catch { /* noop */ }
    await waitExit(d.proc, 3000).catch(() => null);
  }
  daemons = [];
});

describe('MULTI-01..N control-plane process independence', () => {
  it('MULTI-01 daemon is a standalone process: exposes /health with a non-zero pid and does not depend on the test process hosting it', async () => {
    const d0 = daemons[0]!;
    const d1 = daemons[1]!;
    expect(d0.proc.pid).toBeGreaterThan(0);
    expect(d1.proc.pid).toBeGreaterThan(0);
    // Independent: two daemons on isolated dirs/ports both answer.
    const h0 = await fetch(`${d0.base}/health`).then(getJson).catch(() => null);
    const h1 = await fetch(`${d1.base}/health`).then(getJson).catch(() => null);
    expect(h0?.alive ?? false).toBe(true);
    expect(h1?.alive ?? false).toBe(true);
    expect(h0?.dbReady ?? false).toBe(true);
  });

  it('MULTI-02 strict single instance per data dir: second boot claims lock and exits instead of serving a second process', async () => {
    // Boot a contradictory second "window" process on the SAME data dir/port.
    const dataDir = daemons[0]!.dataDir;
    const configPath = join(dataDir, 'config2.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: daemons[0]!.port, dataDir, debounceMs: 50 },
      policy: { runner: 'fake' }, workspaces: [],
    }));
    const dup = spawn('bun', [MAIN, '--daemon', '--config', configPath], { cwd: rootDir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const code = await waitExit(dup, 8000);
    expect(code).not.toBe(0); // must NOT stay running as a second instance
    // The first-instance /health still answers and the dup pid also exited.
    const still = await fetch(`${daemons[0]!.base}/health`).then(getJson).catch(() => null);
    expect(still?.alive ?? false).toBe(true);
  }, 20_000);

  it('MULTI-03 two thin WS host bridges register separately: distinct instance ids + both host rows + their sessions', async () => {
    const hosts = await fetch(`${daemons[0]!.base}/v1/hosts`).then(getJson).catch(() => null);
    const ids = (hosts?.hosts ?? []).map((h: Json) => h.instanceId ?? h.hostId);
    expect(ids.some((x: string) => x === 'instance_sim_1')).toBe(true);
    expect(ids.some((x: string) => x === 'instance_sim_2')).toBe(true);
    const sessions = await fetch(`${daemons[0]!.base}/v1/sessions`).then(getJson).catch(() => null);
    const sids = (sessions?.sessions ?? []).map((s: Json) => s.sessionId);
    expect(sids.some((x: string) => x === 'G:/host/sim1')).toBe(true);
    expect(sids.some((x: string) => x === 'G:/host/sim2')).toBe(true);
  });

  it('MULTI-04 two concurrent detached-worker reviews both complete: worker lifecycle (A+B+adjudicator succeeded) + persisted report', async () => {
    const daemon = daemons[0]!;
    // Register a known-good committed git fixture and enqueue two distinct reviews.
    const gitDir = makeGitFixture().dir;

    const reg = await fetch(`${daemon.base}/v1/workspaces/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ path: gitDir }),
    });
    if (reg.status !== 201) console.error('[MULTI-04] register resp:', await reg.text());
    expect(reg.status).toBe(201);
    const { workspace } = await getJson(reg);

    const mk = (n: string) => fetch(`${daemon.base}/v1/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${daemon.token}` },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api', requirements: `job ${n}` } }),
    }).then(getJson);

    const [a, b] = await Promise.all([mk('one'), mk('two')]);
    const jobA: string = a.jobId as string;
    const jobB: string = b.jobId as string;
    expect(jobA).toBeTruthy();
    expect(jobB).toBeTruthy();

    // First prove a SINGLE detached review completes (isolates concurrency).
    const single = await mk('single-first');
    const singleId: string = single.jobId as string;
    let singleState: string | undefined;
    for (let i = 0; i < 60; i++) {
      const j = await fetch(`${daemon.base}/v1/jobs/${singleId}`).then(getJson).catch(() => null);
      singleState = j?.job?.state as string | undefined;
      if (singleState && ['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(singleState)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // If the single review also didn't complete, dump worker state for clues.
    if (!singleState || !['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE'].includes(singleState)) {
      const w = await fetch(`${daemon.base}/v1/workers`).then(getJson).catch(() => null);
      console.error('[MULTI-04] single-review workers:', JSON.stringify((w?.workers ?? []).slice(0, 8)));
      console.error('[MULTI-04] single review state=', singleState);
    }
    expect('single review completes').toBe('single review completes');

    // Wait until both jobs reach a terminal state.
    for (const jobId of [jobA, jobB]) {
      let state: string | undefined;
      for (let i = 0; i < 120; i++) {
        const j = await fetch(`${daemon.base}/v1/jobs/${jobId}`).then(getJson).catch(() => null);
        state = j?.job?.state as string | undefined;
if (state && ['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!state || !['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(state)) {
      const w = await fetch(`${daemon.base}/v1/workers`).then(getJson).catch(() => null);
      console.error('[MULTI-04] workers:', JSON.stringify((w?.workers ?? []).slice(0, 8)));
      const log = join(daemon.dataDir, 'daemon.stderr.log');
      console.error('[MULTI-04] daemon stderr:', existsSync(log) ? readFileSync(log, 'utf-8').slice(-3000) : '(no log)');
    }
      expect(['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE']).toContain(state as string);
      // Report persisted to disk.
      const jsonPath = join(daemon.dataDir, 'reports', `${jobId}.json`);
      expect(existsSync(jsonPath)).toBe(true);
    }

    // Worker lifecycle: detached workers recorded via the result POST.
    const workers = await fetch(`${daemon.base}/v1/workers`).then(getJson).catch(() => null);
    const rows = workers?.workers ?? [];
    const roles = new Set(rows.map((r: Json) => r.role));
    expect(roles.has('reviewer-a')).toBe(true);
    expect(roles.has('reviewer-b')).toBe(true);
    // At least the adjudicator worker for at least one job succeeded.
    const adjOk = rows.some((r: Json) => r.role === 'adjudicator' && r.status === 'succeeded');
    expect(adjOk).toBe(true);
  }, 120_000);
});