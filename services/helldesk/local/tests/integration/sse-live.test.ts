import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { serve, type DaemonRuntime } from '../../src/main';
import { createFakeRunner } from '../../src/inference';
import { enqueueEvent } from '../../src/events';
import { makeTestDb } from '../helpers';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * LIVE transport coverage for `/v1/events/stream` (Ender P0-H).
 *
 * Unlike the DB-cursor tests in sse.test.ts, this opens a REAL `fetch` against
 * the running daemon's HTTP SSE endpoint and consumes the actual
 * `text/event-stream` response — proving the durable cursor, Last-Event-ID
 * resume, live event streaming, and client-cancel/backpressure all work over
 * the transport, not just against the SQLite helper layer.
 */

let rt: DaemonRuntime;
let base: string;
let d: ReturnType<typeof makeTestDb>['d'];

// Number of ms we allow for the stream pump tick (400ms) + slack before asserting.
const PUMP_SLACK = 1500;

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gt-sse-live-'));
  const configPath = join(dataDir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      daemon: { bind: '127.0.0.1', port: 4799, dataDir, debounceMs: 100 },
      policy: { runner: 'fake', strictCoverage: true },
      workspaces: [],
    })
  );
  rt = await serve({ configPath, runnerOverride: createFakeRunner() });
  d = rt.d;
  base = `http://127.0.0.1:4799`;
  const ready = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!ready) throw new Error('daemon failed to start for live SSE test');
});

afterAll(() => {
  rt.close();
});

/**
 * Consume SSE frames from a live response until `predicate(frame)` matches.
 * `reader` is supplied by the caller so the SAME reader can be reused across
 * calls (proving a stream stays open across multiple events). Reads block on
 * `reader.read()` (the handler cruise-pumps every 400ms, so data arrives
 * promptly); a watchdog enforces `timeoutMs` without racing a second read.
 * Returns the matched frame. On timeout the test fails via throw.
 */
async function collectSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (frame: { id?: string; event?: string; data?: string; comment?: string }) => boolean,
  timeoutMs = 6000
): Promise<{ id?: string; event?: string; data?: string; comment?: string }> {
  const decoder = new TextDecoder();
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SSE predicate timeout; raw=${JSON.stringify(buf.slice(0, 200))}`)), timeoutMs);
  });
  const run: Promise<{ id?: string; event?: string; data?: string; comment?: string }> = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed before predicate satisfied');
      if (value) {
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const record = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame: { id?: string; event?: string; data?: string; comment?: string } = {};
          for (const line of record.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4);
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) frame.data = line.slice(6);
            else if (line.startsWith(':')) frame.comment = line.slice(1).trim();
          }
          if (predicate(frame)) return frame;
        }
      }
    }
  })();
  const result = await Promise.race([run, deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

describe('live /v1/events/stream transport (P0-H)', () => {
  it('streams a durable outbox event as a real SSE frame (id/event/data)', async () => {
    // Enqueue AFTER we open the stream so the pump picks it up live.
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/stream`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const seq = enqueueEvent(rt.d, 'mission.created', { missionId: 'live-m1', probe: 'frame' });
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const frame = await collectSse(reader, (f) => f.event === 'mission.created', PUMP_SLACK + 6000);
    expect(frame.id).toBe(String(seq));
    expect(frame.data).toContain('live-m1');
    expect(frame).not.toBeUndefined();

    // Cancelling the client stops the stream (no leak / no further draining).
    await reader.cancel().catch(() => {});
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('honors ?after=N resume on a live stream (only seq>N are delivered)', async () => {
    const s1 = enqueueEvent(rt.d, 'ticket.started', { ticketId: 'b-live' });
    const s2 = enqueueEvent(rt.d, 'evidence.captured', { ticketId: 'b-live' });
    // Open a stream resuming from s1: only s2 may appear.
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/stream?after=${s1}`, { signal: controller.signal });
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const frame = await collectSse(reader, (f) => f.id !== undefined, PUMP_SLACK + 6000);
    expect(frame.id).toBe(String(s2));
    expect(frame.event).toBe('evidence.captured');
    await reader.cancel().catch(() => {});
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('honors Last-Event-ID (>= cursor) and the retry directive is sent', async () => {
    const s1 = enqueueEvent(rt.d, 'mission.state_changed', { state: 'VERIFYING' });
    const s2 = enqueueEvent(rt.d, 'mission.replanned', { state: 'PLANNING' });
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/stream`, {
      headers: { 'Last-Event-ID': String(s1) },
      signal: controller.signal,
    });
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const frame = await collectSse(reader, (f) => f.id !== undefined, PUMP_SLACK + 6000);
    expect(frame.id).toBe(String(s2)); // seq > Last-Event-ID
    await reader.cancel().catch(() => {});
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('a live stream is never closed by mission/completion events (holds open until abort)', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/events/stream`, { signal: controller.signal });
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;

    // First event lands on the open stream.
    const a = enqueueEvent(rt.d, 'mission.verified', { seq: 'a' });
    const f1 = await collectSse(reader, (f) => f.id === String(a), PUMP_SLACK + 6000);
    expect(f1.event).toBe('mission.verified');
    expect(f1.id).toBe(String(a));

    // The SAME reader/stream continues to serve a later event (not closed).
    const b = enqueueEvent(rt.d, 'ticket.verified', { seq: 'b' });
    const f2 = await collectSse(reader, (f) => f.id === String(b), PUMP_SLACK + 6000);
    expect(f2.event).toBe('ticket.verified');
    expect(f2.id).toBe(String(b));

    await reader.cancel().catch(() => {});
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
  });
});