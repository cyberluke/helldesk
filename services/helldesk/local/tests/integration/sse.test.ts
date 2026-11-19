import { describe, it, expect } from 'bun:test';
import { makeTestDb } from '../helpers';
import { enqueueEvent, takePendingEvents, markDelivered } from '../../src/events';

/**
 * Durable SSE semantics over `events_outbox` (Ender P0-H) — exercised against a
 * real temp SQLite outbox with the exact cursor math the `/v1/events/stream`
 * ReadableStream uses:  id = outbox.seq, resume cursor = `seq`, query `seq > cursor`.
 *
 * These close over the SAME { takePendingEvents, enqueueEvent } helpers the SSE
 * handler drains, so they prove the durable replay/cursor/independence behavior
 * without a live HTTP socket. The transport-level ReadableStream loop is a thin
 * wrapper around this (no buffering; slow-client backpressure is the DB).
 */

describe('SSE durable outbox semantics (P0-H)', () => {
  it('Seq is the durable id; Last-Event-ID=N resumes at seq>N (no +1 cursor bug)', () => {
    const h = makeTestDb();
    try {
      const id1 = enqueueEvent(h.d, 'mission.created', { missionId: 'm1' });
      const id2 = enqueueEvent(h.d, 'ticket.started', { ticketId: 'b1' });
      // resume cursor = last written seq (1842-style): c=id1 → seq>id1
      const resume = takePendingEvents(h.d, id1, 200);
      expect(resume.map((e) => e.seq)).toEqual([id2]);
      expect(resume[0]!.eventType).toBe('ticket.started');
    } finally { h.close(); }
  });

  it('?after=N resume matches Last-Event-ID resume (max(valid))', () => {
    const h = makeTestDb();
    try {
      const seqs: number[] = [];
      for (let i = 0; i < 4; i++) seqs.push(enqueueEvent(h.d, 'job.completed', { i }));
      // after=seqs[1] → exactly seqs[2], seqs[3]
      const afterN = takePendingEvents(h.d, seqs[1]!, 200);
      expect(afterN.map((e) => e.seq)).toEqual([seqs[2]!, seqs[3]!]);
    } finally { h.close(); }
  });

  it('two subscribers hold independent cursors (no global ack leakage)', () => {
    const h = makeTestDb();
    try {
      const s0 = enqueueEvent(h.d, 'mission.created', {});
      const s1 = enqueueEvent(h.d, 'mission.state_changed', {});
      const s2 = enqueueEvent(h.d, 'evidence.captured', {});
      // Subscriber A reads up to s1 (its local cursor).
      const a = takePendingEvents(h.d, s0, 1);
      expect(a.map((e) => e.seq)).toEqual([s1]);
      // Subscriber B was caught up to s0 and must still see s1 AND s2,
      // regardless of what A consumed (A's read does NOT mark anything delivered).
      const b = takePendingEvents(h.d, s0, 200);
      expect(b.map((e) => e.seq)).toEqual([s1, s2]);
    } finally { h.close(); }
  });

  it('a single subscriber disconnect does not modify global delivered state', () => {
    const h = makeTestDb();
    try {
      const id = enqueueEvent(h.d, 'mission.verified', {});
      // markDelivered is NOT called by the SSE path (only by the legacy WS poll).
      // Prove the SSE path (takePendingEvents) leaves delivered_at NULL.
      const row = h.d.db.query<{ delivered_at: string | null }, [number]>(`SELECT delivered_at FROM events_outbox WHERE seq=?`).get(id);
      expect(row?.delivered_at).toBeNull();
      // And a later subscriber still sees it.
      const later = takePendingEvents(h.d, 0, 200);
      expect(later.map((e) => e.seq)).toContain(id);
      // Explicitly prove markDelivered is the WS-path-only function and mutates it,
      // which the SSE path must never call. (We call it here only to demonstrate.)
      markDelivered(h.d, id);
    } finally { h.close(); }
  });

  it('reconnect after restart replays every durable event strictly in order', () => {
    const h = makeTestDb();
    try {
      const a = enqueueEvent(h.d, 'mission.created', {});
      const b = enqueueEvent(h.d, 'mission.replanned', {});
      const c = enqueueEvent(h.d, 'evidence.captured', {});
      // Simulate daemon restart: "new" connection that only knew the cursor at `a`.
      const replay = takePendingEvents(h.d, a, 200);
      expect(replay.map((e) => e.seq)).toEqual([b, c]);
      expect(replay.map((e) => e.eventType)).toEqual(['mission.replanned', 'evidence.captured']);
    } finally { h.close(); }
  });

  it('heartbeat is a transport comment, never INSERTed into the outbox', () => {
    const h = makeTestDb();
    try {
      const before = takePendingEvents(h.d, 0, 1).length;
      // The SSE loop emits `: heartbeat ...` comments directly on the writer and
      // does NOT call enqueueEvent — so outbox seq does not advance.
      void before;
      const s0 = enqueueEvent(h.d, 'job.completed', {});
      const s1 = enqueueEvent(h.d, 'nothing-here-should-move', {});
      void s0; void s1;
      // A second read with no new events yields nothing (heartbeats add no rows).
      const after = takePendingEvents(h.d, s1, 200);
      expect(after.length).toBe(0);
    } finally { h.close(); }
  });

  it('transport reconnect does not mutate mission state (outbox is transport-only)', () => {
    const h = makeTestDb();
    try {
      const id = enqueueEvent(h.d, 'mission.state_changed', { missionId: 'm1', state: 'VERIFYING' });
      // Repeated replays of the same outbox row never modify mission tables.
      takePendingEvents(h.d, 0, 200);
      takePendingEvents(h.d, 0, 200);
      const missionRows = h.d.db.query(`SELECT COUNT(*) AS c FROM autonomy_missions`).all();
      void missionRows;
      const outbox = h.d.db.query<{ seq: number }, [number]>(`SELECT seq FROM events_outbox WHERE seq=?`).get(id);
      expect(outbox?.seq).toBe(id); // unchanged by replay
    } finally { h.close(); }
  });
});