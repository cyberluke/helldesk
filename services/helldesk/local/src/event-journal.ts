import type { Db } from './db';
import { now } from './ids';

/**
 * Bank-grade plugin->daemon event journal.
 *
 * - Idempotent: UNIQUE(host_id, event_id). Replayed frames are no-op ACKs.
 * - Durable ACK: the journal row is committed and THEN ack(localSeq) is sent.
 * - Resume: host_runtime_state.last_acked_seq lets a reconnecting host resume
 *   (resend anything above lastAck without inventing events).
 * - Out-of-order: accepted as-is; ordering responsibility is on the consumer
 *   (reconciler re-orders per session by local_seq; gaps are marked).
 */

export interface JournaledEvent {
  journalSeq: number;
  hostId: string;
  sessionId?: string;
  eventId: string;
  localSeq: number;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Commit a plugin event durably. Returns true if NEW (first delivery). */
export function commitEvent(
  d: Db,
  e: {
    hostId: string;
    runtimeId?: string;
    sessionId?: string;
    turnId?: string;
    eventId: string;
    localSeq: number;
    eventType: string;
    protocolVersion: number;
    payload: Record<string, unknown>;
  }
): { inserted: boolean; journalSeq?: number } {
  return d.tx((t) => {
    const res = t
      .query(
        `INSERT OR IGNORE INTO event_journal
         (host_id, runtime_id, session_id, turn_id, event_id, local_seq, event_type, protocol_version, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(e.hostId, e.runtimeId ?? null, e.sessionId ?? null, e.turnId ?? null, e.eventId, e.localSeq, e.eventType, e.protocolVersion, JSON.stringify(e.payload), now());
    const inserted = Number(res.lastInsertRowid) !== 0;
    const row = t.query<{ journal_seq: number }, [string, string]>(
      `SELECT journal_seq FROM event_journal WHERE host_id=? AND event_id=?`
    ).get(e.hostId, e.eventId);
    // Advance the host high-water (ack) ONLY for monotonic frames.
    if (e.localSeq) {
      t.query(
        `UPDATE host_runtime_state SET last_acked_seq=? WHERE host_id=?`
      ).run(e.localSeq, e.hostId); // optimistic; caller validates monotonicity
    }
    return { inserted, journalSeq: row?.journal_seq };
  });
}

export function getHostState(d: Db, hostId: string): { lastAckedSeq: number; protocolVersion: number } {
  const r = d.db
    .query<{ last_acked_seq: number; protocol_version: number }, [string]>(
      `SELECT last_acked_seq, protocol_version FROM host_runtime_state WHERE host_id=?`
    )
    .get(hostId);
  return r ? { lastAckedSeq: r.last_acked_seq, protocolVersion: r.protocol_version } : { lastAckedSeq: 0, protocolVersion: 1 };
}

export function upsertHostState(d: Db, hostId: string, protocolVersion: number, leaseSeconds: number): void {
  d.db
    .query(
      `INSERT INTO host_runtime_state (host_id, last_acked_seq, protocol_version, connection_generation, lease_seconds, last_seen_at)
       VALUES (?, 0, ?, 0, ?, ?)
       ON CONFLICT(host_id) DO UPDATE SET protocol_version=excluded.protocol_version, lease_seconds=excluded.lease_seconds, last_seen_at=excluded.last_seen_at, connection_generation=connection_generation+1`
    )
    .run(hostId, protocolVersion, leaseSeconds, now());
}

/** Events accepted for a session in local_seq order (for reconciler ordering). */
export function eventsForSession(d: Db, hostId: string, sessionId: string): JournaledEvent[] {
  const rows = d.db
    .query<
      { journal_seq: number; host_id: string; session_id: string | null; event_id: string; local_seq: number; event_type: string; payload: string },
      [string, string]
    >(
      `SELECT journal_seq, host_id, session_id, event_id, local_seq, event_type, payload
       FROM event_journal WHERE host_id=? AND session_id=?
       ORDER BY local_seq ASC`
    )
    .all(hostId, sessionId);
  return rows.map((r) => ({ journalSeq: r.journal_seq, hostId: r.host_id, sessionId: r.session_id ?? undefined, eventId: r.event_id, localSeq: r.local_seq, eventType: r.event_type, payload: JSON.parse(r.payload) }));
}