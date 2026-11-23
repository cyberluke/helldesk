import type { Db } from './db';
import { generateId } from './ids';

/**
 * Mission chat transcript repository.
 *
 * Rows are written from TWO sources, both real:
 *   - the mission's actual headless Kilo session (captured by the mutation
 *     runner from `client.session.messages`), and
 *   - operator messages / steering notes.
 *
 * One row per Kilo part (`part_id`), so the live poller can re-read the same
 * session repeatedly without duplicating rows. `seq` is per-mission monotonic
 * and drives incremental polling (`?since=`).
 */
export type ChatRole = 'user' | 'assistant' | 'system' | 'operator';
export type ChatKind = 'text' | 'reasoning' | 'tool_call' | 'tool_result';

export interface MissionChatMessageRow {
  message_id: string;
  mission_id: string;
  ticket_id: string | null;
  revision_id: string | null;
  session_id: string | null;
  part_id: string | null;
  /** soul | reviewer-a | reviewer-b | adjudicator | system */
  speaker: string | null;
  role: ChatRole;
  kind: ChatKind;
  text: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_result: string | null;
  seq: number;
  created_at: string;
}

export interface MissionChatInput {
  missionId: string;
  ticketId?: string;
  revisionId?: string;
  sessionId?: string;
  /** Stable per-part identity; enables idempotent live capture. */
  partId?: string;
  /** Identity of the speaker when it is not the soul (review roles). */
  speaker?: string;
  role: ChatRole;
  kind: ChatKind;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

/** Insert one transcript row. Returns null when the part was already captured. */
export function addMissionChatMessage(d: Db, input: MissionChatInput): MissionChatMessageRow | null {
  return d.tx((db) => {
    if (input.partId) {
      const existing = db
        .query<{ message_id: string }, [string, string]>(
          `SELECT message_id FROM mission_chat_messages WHERE mission_id=? AND part_id=?`
        )
        .get(input.missionId, input.partId);
      if (existing) return null;
    }
    const next = db
      .query<{ next: number }, [string]>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM mission_chat_messages WHERE mission_id=?`
      )
      .get(input.missionId);
    const seq = next?.next ?? 1;
    const row: MissionChatMessageRow = {
      message_id: generateId('msg'),
      mission_id: input.missionId,
      ticket_id: input.ticketId ?? null,
      revision_id: input.revisionId ?? null,
      session_id: input.sessionId ?? null,
      part_id: input.partId ?? null,
      speaker: input.speaker ?? null,
      role: input.role,
      kind: input.kind,
      text: input.text ?? null,
      tool_name: input.toolName ?? null,
      tool_input: input.toolInput ?? null,
      tool_result: input.toolResult ?? null,
      seq,
      created_at: new Date().toISOString(),
    };
    db.query(
      `INSERT INTO mission_chat_messages
         (message_id, mission_id, ticket_id, revision_id, session_id, part_id, speaker, role, kind, text, tool_name, tool_input, tool_result, seq, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      row.message_id,
      row.mission_id,
      row.ticket_id,
      row.revision_id,
      row.session_id,
      row.part_id,
      row.speaker,
      row.role,
      row.kind,
      row.text,
      row.tool_name,
      row.tool_input,
      row.tool_result,
      row.seq,
      row.created_at
    );
    return row;
  });
}

/** List transcript rows in order. `sinceSeq` enables incremental polling. */
export function listMissionChatMessages(
  d: Db,
  missionId: string,
  opts?: { sinceSeq?: number; limit?: number; tail?: number }
): MissionChatMessageRow[] {
  const limit = Math.min(1000, Math.max(1, Math.floor(opts?.limit ?? 500)));
  // TAIL mode: the console must open on the NEWEST messages, not the first page.
  // A long mission has thousands of rows; `limit` alone returns the oldest page.
  const tail = opts?.tail ? Math.min(1000, Math.max(1, Math.floor(opts.tail))) : 0;
  if (tail > 0) {
    return d.db
      .query<MissionChatMessageRow, [string, number]>(
        `SELECT * FROM (
           SELECT * FROM mission_chat_messages WHERE mission_id=? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`
      )
      .all(missionId, tail);
  }
  const since = Math.max(0, Math.floor(opts?.sinceSeq ?? 0));
  return d.db
    .query<MissionChatMessageRow, [string, number, number]>(
      `SELECT * FROM mission_chat_messages WHERE mission_id=? AND seq > ? ORDER BY seq ASC LIMIT ?`
    )
    .all(missionId, since, limit);
}

/**
 * Batch insert in ONE transaction with ONE seq scan. The live capture polls a
 * session several hundred parts deep; per-row transactions + per-row MAX(seq)
 * blocked the daemon's event loop long enough to time out the console chat.
 */
export function addMissionChatMessages(d: Db, inputs: MissionChatInput[]): number {
  if (!inputs.length) return 0;
  const missionId = inputs[0]!.missionId;
  return d.tx((db) => {
    const next = db
      .query<{ next: number }, [string]>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM mission_chat_messages WHERE mission_id=?`
      )
      .get(missionId);
    let seq = (next?.next ?? 1) - 1;
    let inserted = 0;
    for (const input of inputs) {
      if (input.missionId !== missionId) continue;
      if (input.partId) {
        const exists = db
          .query<{ message_id: string }, [string, string]>(
            `SELECT message_id FROM mission_chat_messages WHERE mission_id=? AND part_id=?`
          )
          .get(missionId, input.partId);
        if (exists) continue;
      }
      seq += 1;
      db.query(
        `INSERT INTO mission_chat_messages
           (message_id, mission_id, ticket_id, revision_id, session_id, part_id, speaker, role, kind, text, tool_name, tool_input, tool_result, seq, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        generateId('msg'),
        missionId,
        input.ticketId ?? null,
        input.revisionId ?? null,
        input.sessionId ?? null,
        input.partId ?? null,
        input.speaker ?? null,
        input.role,
        input.kind,
        input.text ?? null,
        input.toolName ?? null,
        input.toolInput ?? null,
        input.toolResult ?? null,
        seq,
        new Date().toISOString()
      );
      inserted += 1;
    }
    return inserted;
  });
}
