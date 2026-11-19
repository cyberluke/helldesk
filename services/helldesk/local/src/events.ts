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

export function markDelivered(d: Db, seq: number): void {
  d.db
    .query(`UPDATE events_outbox SET delivered_at=? WHERE seq=?`)
    .run(now(), seq);
}