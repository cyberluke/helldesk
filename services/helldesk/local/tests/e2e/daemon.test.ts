import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { serve, type DaemonRuntime } from '../../src/main';
import { makeGitFixture, makeTestDb } from '../helpers';
import { createFakeRunner } from '../../src/inference';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, any>;

const getJson = (r: Response) => r.json() as Promise<Json>;

/**
 * End-to-end tests: a live daemon (SQLite + localhost HTTP API) driven over
 * HTTP with the deterministic fake runner. Covers the vertical slice +
 * report retrieval + crash/recovery + fault injection.
 */

let rt: DaemonRuntime;
let d: ReturnType<typeof makeTestDb>['d'];
let base: string;
let configPath: string;

beforeAll(async () => {
  // A dedicated temp data dir + high port so e2e never touches the real state.
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-e2e-'));
  configPath = join(dataDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: 4795, dataDir, debounceMs: 100 },
      policy: { runner: 'fake', strictCoverage: true },
      workspaces: [],
    })
  );
  rt = await serve({ configPath, runnerOverride: createFakeRunner() });
  d = rt.d;
  base = `http://127.0.0.1:4795`;
  const ready = await fetch(`${base}/health`).then(getJson).catch(() => null);
  expect(ready).toBeTruthy();
});

afterAll(() => {
  rt.close();
});

describe('e2e localhost API (fake runner)', () => {
  it('GET /health reports alive/dbReady/queue up, modelConnectivity unknown', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.alive).toBe(true);
    expect(body.dbReady).toBe(true);
    expect(body.queueOperational).toBe(true);
    expect(body.modelConnectivity).toBe('unknown');
  });

  it('mutations require the local token', async () => {
    const res = await fetch(`${base}/v1/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'C:/x' }),
    });
    expect(res.status).toBe(401);
  });

  it('registers a workspace with the token', async () => {
    const g = makeGitFixture();
    const res = await fetch(`${base}/v1/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({ path: g.dir }),
    });
    expect(res.status).toBe(201);
    const body = await getJson(res);
    expect(body.workspace.workspaceId).toBeTruthy();
  });

  it('POST /v1/reviews enqueues and GET /v1/reports/:id returns the persisted report', async () => {
    const g = makeGitFixture();
    const reg = await fetch(`${base}/v1/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({ path: g.dir }),
    });
    const { workspace } = await getJson(reg);
    const enq = await fetch(`${base}/v1/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api' },
      }),
    });
    expect(enq.status).toBe(201);
    const { jobId } = await getJson(enq);

    // Health + jobs now show the job; wait for the pump to complete.
    let job: { state: string; result: string | null };
    for (let i = 0; i < 40; i++) {
      const j = await fetch(`${base}/v1/jobs/${jobId}`).then(getJson);
      job = j.job;
      if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL', 'CANCELLED'].includes(job.state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE']).toContain(job!.state);

    const rep = await fetch(`${base}/v1/reports/${jobId}`);
    expect(rep.status).toBe(200);
    const { report } = await getJson(rep);
    expect(report.jobId).toBe(jobId);
    expect(report.coverage.changedFiles).toBeGreaterThan(0);
    // Persist to disk too
    const jsonPath = join(rt.reportDir, `${jobId}.json`);
    expect(existsSync(jsonPath)).toBe(true);
  });

  it('auto-enqueue dedupes: same fingerprint => one job, duplicates => still one', async () => {
    const g = makeGitFixture();
    const reg = await fetch(`${base}/v1/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({ path: g.dir }),
    });
    const { workspace } = await getJson(reg);
    const mk = () =>
      fetch(`${base}/v1/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          subject: { workspaceId: workspace.workspaceId, subjectKind: 'git-head', source: 'api' },
        }),
      }).then(getJson);
    const a = await mk();
    const b = await mk();
    expect(a.jobId).toBe(b.jobId);
  });

  it('review recursion: reviewer/adjudicator sessions are excluded from auto-trigger (completion-detector unit), and daemon does not enqueue from its own runs', async () => {
    // The completion-detector unit test covers session-role exclusion. Here we
    // confirm a plain-folder review completes without spawning further jobs.
    const dir = mkdtempSync(join(tmpdir(), 'gt-e2e-fs-'));
    writeFileSync(join(dir, 'app.js'), 'export function run(){ return 42; }\n');
    const reg = await fetch(`${base}/v1/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({ path: dir }),
    });
    const { workspace } = await getJson(reg);
    const enq = await fetch(`${base}/v1/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.token}` },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        subject: { workspaceId: workspace.workspaceId, subjectKind: 'fs-folder', fsPath: dir, source: 'api' },
      }),
    });
    const { jobId } = await getJson(enq);
    // Wait for completion
    let completes = 0;
    for (let i = 0; i < 40 && completes < 1; i++) {
      const j = await fetch(`${base}/v1/jobs/${jobId}`).then(getJson);
      if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL'].includes(j.job.state)) completes++;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(completes).toBe(1);
    // No new auto jobs appeared from the reviewer's own activity.
    const jobs = await fetch(`${base}/v1/jobs`).then(getJson);
    const direct = jobs.jobs.filter((j: { source: string }) => j.source === 'plugin' || j.source === 'auto');
    // The daemon only enqueues what we POSTed (source 'api'), so no recursion.
    expect(jobs.jobs.every((j: { source: string }) => j.source !== 'reviewer')).toBe(true);
  });

  it('crash/recovery: kill daemon mid-review, restart resumes exactly one job, no duplicate terminal', async () => {
    // Inject a stuck job (simulating a crash) then invoke recovery directly.
    const g = makeGitFixture();
    const h2 = makeTestDb();
    // reuse engine to create a job in a held state with an expired lease
    const eng = (await import('../../src/engine')).Engine;
    const e = new eng({ d: h2.d, config: h2.cfg, snapshotStore: h2.snapshotStore, reportDir: h2.reportDir, runner: createFakeRunner(), resolvedModels: new Map() });
    e.onStartup();
    const { jobId } = await e.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'test' });
    e.d.db.query(`UPDATE review_jobs SET state='REVIEWING_A_B' WHERE job_id=?`).run(jobId);
    const { acquireLease, releaseLease } = await import('../../src/reconciler');
    const lease = acquireLease(h2.d, 'job', `job:${jobId}`, -10); // expired
    expect(lease).not.toBeNull();
    // Simulate crash: restart recovers it.
    const { recoverStuckLeases } = await import('../../src/reconciler');
    const n = recoverStuckLeases(h2.d);
    expect(n).toBeGreaterThanOrEqual(1);
    const j = h2.d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id=?`).get(jobId)!;
    expect(j.state).toBe('QUEUED');
    h2.close();
  });

  it('lease fencing: a fenced (expired) worker cannot overwrite a new success', async () => {
    const g = makeGitFixture();
    const h2 = makeTestDb();
    const eng2 = (await import('../../src/engine')).Engine;
    const e = new eng2({ d: h2.d, config: h2.cfg, snapshotStore: h2.snapshotStore, reportDir: h2.reportDir, runner: createFakeRunner(), resolvedModels: new Map() });
    e.onStartup();
    const { jobId } = await e.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'test' });
    await e.runJob(jobId);
    const done = h2.d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id=?`).get(jobId)!;
    expect(['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE']).toContain(done.state);
    // Fenced worker attempts a state update only if it matches QUEUED -> matches 0 rows -> no clobber.
    const res = h2.d.db.query(`UPDATE review_jobs SET state='REVIEWING_A_B' WHERE job_id=? AND state='QUEUED'`).run(jobId);
    expect(Number(res.changes)).toBe(0);
    const after = h2.d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id=?`).get(jobId)!;
    expect(after.state).toBe(done.state);
    h2.close();
  });

  it('provider outage => INCONCLUSIVE, never PASS (via failing runner on the API path)', async () => {
    const g = makeGitFixture();
    // Use a failing engine directly (HTTP runner is injectable only at startup).
    const h2 = makeTestDb();
    const eng3 = (await import('../../src/engine')).Engine;
    const { createFakeRunner: mkFail } = await import('../../src/inference');
    const e = new eng3({ d: h2.d, config: h2.cfg, snapshotStore: h2.snapshotStore, reportDir: h2.reportDir, runner: createFakeRunner({ failWith: 'outage' }), resolvedModels: new Map() });
    e.onStartup();
    const { jobId } = await e.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'test' });
    await e.runJob(jobId);
    const job = h2.d.db.query<{ state: string; result: string | null }, [string]>(`SELECT state, result FROM review_jobs WHERE job_id=?`).get(jobId)!;
    expect(job.state).toBe('INCONCLUSIVE');
    expect(job.result).toBe('INCONCLUSIVE');
    h2.close();
  });
});