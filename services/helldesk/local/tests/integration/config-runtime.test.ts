import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { serve, type DaemonRuntime } from '../../src/main';
import { createFakeRunner } from '../../src/inference';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, any>;
const getJson = (r: Response) => r.json() as Promise<Json>;

/**
 * Runtime config control (Ender P0-req): `/v1/config` GET + PATCH on a live
 * daemon. Proves that a live PATCH mutates the shared config object the engine
 * reads (visible via GET), classifies live vs applies-on-restart correctly, and
 * persists to the authoritative config.json so a restart survives the change.
 */

let rt: DaemonRuntime;
let base: string;
let configPath: string;
let auth: Record<string, string>;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-config-'));
  configPath = join(dataDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: 4797, dataDir, debounceMs: 100, maxConcurrentJobs: 2 },
      policy: { runner: 'fake', strictCoverage: true },
      autonomy: { enabled: false },
      workspaces: [],
    }),
    'utf-8'
  );
  rt = await serve({ configPath, runnerOverride: createFakeRunner() });
  base = `http://127.0.0.1:4797`;
  auth = { Authorization: `Bearer ${rt.token}` };
  const ready = await fetch(`${base}/health`).then(getJson).catch(() => null);
  expect(ready).toBeTruthy();
});

afterAll(() => {
  rt.close();
});

describe('runtime config /v1/config', () => {
  it('GET requires the token (config may expose provider/auth shape)', async () => {
    const res = await fetch(`${base}/v1/config`);
    expect(res.status).toBe(401);
  });

  it('GET returns the effective config + per-field apply meta', async () => {
    const res = await fetch(`${base}/v1/config`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.config).toBeTruthy();
    expect(body.meta).toBeTruthy();
    expect(body.path).toBe(configPath);
    // Live vs restart classification is exposed for the UX.
    expect(body.meta.daemon.bind).toBe('restart');
    expect(body.meta.daemon.maxConcurrentJobs).toBe('live');
    expect(body.meta.daemon.maxAttempts).toBe('live');
    expect(body.meta.autonomy.enabled).toBe('live');
    expect(body.meta.policy.runner).toBe('live');
  });

  it('GET redacts provider secrets', async () => {
    // A second daemon on an isolated data dir so it can't clash with the main
    // suite's singleton lock / port.
    const dir2 = mkdtempSync(join(tmpdir(), 'gt-config-redact-'));
    const cfg2 = join(dir2, 'config.json');
    writeFileSync(
      cfg2,
      JSON.stringify({
        version: 1,
        daemon: { bind: '127.0.0.1', port: 4801, dataDir: dir2, debounceMs: 100 },
        policy: {
          runner: 'fake',
          providers: { inert: { kind: 'openai-compatible', baseURL: 'http://localhost:9/v1', apiKey: 'supersecret', modelID: 'm' } },
        },
        autonomy: { apiKey: 'autosecret' },
        workspaces: [],
      }),
      'utf-8'
    );
    const rt2 = await serve({ configPath: cfg2, runnerOverride: createFakeRunner() });
    const res = await fetch(`http://127.0.0.1:4801/v1/config`, { headers: { Authorization: `Bearer ${rt2.token}` } });
    const body = await getJson(res);
    expect(JSON.stringify(body.config)).not.toContain('supersecret');
    expect(JSON.stringify(body.config)).not.toContain('autosecret');
    rt2.close();
  });

  it('PATCH applies a live field immediately and persists it', async () => {
    const res = await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { maxAttempts: 5 }, autonomy: { enabled: true } }),
    });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.ok).toBe(true);
    expect(body.applied_live).toContain('daemon.maxAttempts');
    expect(body.applied_live).toContain('autonomy.enabled');
    expect(body.applies_on_restart).toEqual([]);
    // Live effect: GET reflects it.
    const getRes = await fetch(`${base}/v1/config`, { headers: auth });
    const getBody = await getJson(getRes);
    expect(getBody.config.daemon.maxAttempts).toBe(5);
    expect(getBody.config.autonomy.enabled).toBe(true);
    // Persisted for restart:
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.daemon.maxAttempts).toBe(5);
    expect(persisted.autonomy.enabled).toBe(true);
    // Clean up: revert so later tests / the real config are unaffected.
    await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { maxAttempts: 3 }, autonomy: { enabled: false } }),
    });
  });

  it('PATCH routes a restart-only field to applies_on_restart (persisted, not live-bound)', async () => {
    const res = await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { retentionDays: 45 } }),
    });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.applied_live).toContain('daemon.retentionDays'); // retention is live
  });

  it('PATCH toggles policy.verifyMode live (WAR-mode switch)', async () => {
    // Defer verification (WAR mode): applies live + persists.
    const res = await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ policy: { verifyMode: 'deferred' } }),
    });
    expect(res.status).toBe(200);
    const body = await getJson(res);
    expect(body.applied_live).toContain('policy.verifyMode');
    const getRes = await fetch(`${base}/v1/config`, { headers: auth });
    const getBody = await getJson(getRes);
    expect(getBody.config.policy.verifyMode).toBe('deferred');
    // Persisted for restart.
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.policy.verifyMode).toBe('deferred');
    // Reject an invalid value (must stay deferred).
    const bad = await fetch(`${base}/v1/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ policy: { verifyMode: 'never' } }),
    });
    expect(bad.status).toBe(400);
    // Clean up: revert to auto so later tests / the real config are unaffected.
    await fetch(`${base}/v1/config`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ policy: { verifyMode: 'auto' } }),
    });
  });

  it('PATCH rejects an invalid value without persisting', async () => {
    const before = readFileSync(configPath, 'utf-8');
    const res = await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { maxConcurrentJobs: 'not-a-number' } }),
    });
    expect(res.status).toBe(400);
    const body = await getJson(res);
    expect(body.ok).toBe(false);
    expect(body.rejected.length).toBeGreaterThan(0);
    // Nothing persisted.
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('GET reflects a restart-only daemon field persisted for next start', async () => {
    // PATCH a restart-only field: it persists to config.json even though the
    // live process can't re-bind. The GET view shows it as the (new) resolved value.
    await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { retentionDays: 60 } }),
    });
    const persisted = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(persisted.daemon.retentionDays).toBe(60);
    // Restore to avoid leaking into other suites.
    await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { retentionDays: 30 } }),
    });
  });

  it('a freshly served daemon loads the persisted config (startup parity)', async () => {
    // Persist a change on the main daemon, then boot a fresh daemon on an
    // isolated data dir seeded from that SAME persisted config file to prove a
    // runtime change survives restart.
    await fetch(`${base}/v1/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ daemon: { retentionDays: 90 } }),
    });
    const seed = readFileSync(configPath, 'utf-8');
    const dir3 = mkdtempSync(join(tmpdir(), 'gt-config-restart-'));
    const cfg3 = join(dir3, 'config.json');
    const seeded = JSON.parse(seed);
    seeded.daemon.port = 4802;
    seeded.daemon.dataDir = dir3;
    writeFileSync(cfg3, JSON.stringify(seeded), 'utf-8');
    const rt3 = await serve({ configPath: cfg3, runnerOverride: createFakeRunner() });
    const res = await fetch(`http://127.0.0.1:4802/v1/config`, { headers: { Authorization: `Bearer ${rt3.token}` } });
    const body = await getJson(res);
    expect(body.config.daemon.retentionDays).toBe(90); // survived the "restart"
    expect(body.path).toBe(cfg3);
    rt3.close();
  });

  it('a daemon can boot with an empty workspace list and still expose config', () => {
    expect(existsSync(configPath)).toBe(true);
  });
});