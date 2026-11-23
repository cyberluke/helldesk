import type { Db } from './db';
import { now } from './ids';

/**
 * Durable, idempotent, resumable event outbox. WS subscribers poll/receive
 * committed events; deliveries are marked delivered after ack so restarts
 * do not double-emit terminal job outcomes more than necessary.
 */

export function enqueueEvent(d: Db, eventType: string, payload: unknown, jobId?: string): number {
  const res = d.db
    .query(
      `INSERT INTO events_outbox (event_type, job_id, payload, created_at, delivery_attempts)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(eventType, jobId ?? null, JSON.stringify(payload), now());
  return Number(res.lastInsertRowid);
}

export interface OutboxItem {
  seq: number;
  eventType: string;
  jobId: string | null;
  payload: unknown;
  createdAt: string;
}

export function takePendingEvents(d: Db, afterSeq = 0, limit = 200): OutboxItem[] {
  const rows = d.db
    .query<
      { seq: number; event_type: string; job_id: string | null; payload: string; created_at: string },
      [number, number]
    >(
      `SELECT seq, event_type, job_id, payload, created_at
       FROM events_outbox
       WHERE seq > ?
       ORDER BY seq ASC LIMIT ?`
    )
    .all(afterSeq, limit);
  return rows.map((r) => ({ seq: r.seq, eventType: r.event_type, jobId: r.job_id, payload: JSON.parse(r.payload), createdAt: r.created_at }));
}

/**
 * Read the NEWEST `limit` events (the observability tail), returned oldest-first
 * so every consumer can append them in journal order.
 *
 * This is deliberately separate from `takePendingEvents`: that function answers
 * "what has this subscriber not seen yet" (cursor semantics, oldest-first from
 * the cursor), while the observability UI needs "what just happened" (tail
 * semantics). Calling the cursor reader with `after=0` returns the OLDEST journal
 * rows and silently shows stale activity — that was the observability bug.
 */
export function listEventsTail(d: Db, limit = 200): OutboxItem[] {
  const clamped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 2000);
  const rows = d.db
    .query<
      { seq: number; event_type: string; job_id: string | null; payload: string; created_at: string },
      [number]
    >(
      `SELECT seq, event_type, job_id, payload, created_at
       FROM (
         SELECT seq, event_type, job_id, payload, created_at
         FROM events_outbox
         ORDER BY seq DESC
         LIMIT ?
       )
       ORDER BY seq ASC`
    )
    .all(clamped);
  return rows.map((r) => ({ seq: r.seq, eventType: r.event_type, jobId: r.job_id, payload: JSON.parse(r.payload), createdAt: r.created_at }));
}

/** Every event created at or after `sinceIso`, oldest-first. Used by aggregation. */
export function listEventsSince(d: Db, sinceIso: string, limit = 100_000): OutboxItem[] {
  const rows = d.db
    .query<
      { seq: number; event_type: string; job_id: string | null; payload: string; created_at: string },
      [string, number]
    >(
      `SELECT seq, event_type, job_id, payload, created_at
       FROM events_outbox
       WHERE created_at >= ?
       ORDER BY seq ASC
       LIMIT ?`
    )
    .all(sinceIso, limit);
  return rows.map((r) => ({ seq: r.seq, eventType: r.event_type, jobId: r.job_id, payload: JSON.parse(r.payload), createdAt: r.created_at }));
}

/** Total journal size (all time). */
export function countEvents(d: Db): number {
  const row = d.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events_outbox`).get();
  return row?.c ?? 0;
}

/** Count events created at or after `sinceIso`. */
export function countEventsSince(d: Db, sinceIso: string): number {
  const row = d.db
    .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM events_outbox WHERE created_at >= ?`)
    .get(sinceIso);
  return row?.c ?? 0;
}

export function markDelivered(d: Db, seq: number): void {
  d.db
    .query(`UPDATE events_outbox SET delivered_at=? WHERE seq=?`)
    .run(now(), seq);
}