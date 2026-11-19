/**
 * job-transcript.ts — durable per-mission AGENT TRANSCRIPT journal.
 *
 * Full-QA observability: append what each agent actually did (assistant messages,
 * tool calls, file diffs, review findings, mission events) as durable rows the
 * operator console reads back. This turns "steer blind" into "see exactly what
 * the mutator/reviewers did, then steer with evidence."
 *
 * Writes are fire-and-forget (never a mission gate — a failed journal write must
 * not roll back real work). Reads are fast indexed by mission/revision/job.
 * Lives in the SAME daemon DB as the mission loop, so a journal entry for a
 * revision is durable with the work itself (crash-survivable).
 */
import type { Db } from './db';

export type TranscriptKind = 'message' | 'tool_call' | 'diff' | 'finding' | 'event' | 'error';

export interface TranscriptEntry {
  transcript_id: number;
  mission_id: string;
  ticket_id: string | null;
  revision_id: string | null;
  job_id: string | null;
  worker_id: string | null;
  role: string | null;
  kind: TranscriptKind;
  title: string | null;
  content: string;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface AppendTranscriptInput {
  missionId: string;
  ticketId?: string | null;
  revisionId?: string | null;
  jobId?: string | null;
  workerId?: string | null;
  role?: string;
  kind: TranscriptKind;
  title?: string;
  content: string;
  meta?: Record<string, unknown>;
}

/** Append one durable transcript row. Never throws; a best-effort observability write. */
export function appendTranscript(d: Db, e: AppendTranscriptInput): void {
  try {
    d.db.query(
      `INSERT INTO job_transcript (mission_id, ticket_id, revision_id, job_id, worker_id, role, kind, title, content, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      e.missionId,
      e.ticketId ?? null,
      e.revisionId ?? null,
      e.jobId ?? null,
      e.workerId ?? null,
      e.role ?? 'engine',
      e.kind,
      e.title ?? null,
      e.content,
      e.meta ? JSON.stringify(e.meta) : null,
      new Date().toISOString(),
    );
  } catch { /* best effort */ }
}

/** List the transcript for a mission (or a single revision/job), newest-last. */
export function listTranscript(d: Db, opts: { missionId?: string; revisionId?: string; jobId?: string; limit?: number } = {}): TranscriptEntry[] {
  const where: string[] = [];
  const params: Array<string | null> = [];
  if (opts.missionId) { where.push('mission_id=?'); params.push(opts.missionId); }
  if (opts.revisionId) { where.push('revision_id=?'); params.push(opts.revisionId); }
  if (opts.jobId) { where.push('job_id=?'); params.push(opts.jobId); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const rows = d.db.query<Row, Array<string | null>>(
    `SELECT transcript_id, mission_id, ticket_id, revision_id, job_id, worker_id, role, kind, title, content, meta, created_at
     FROM job_transcript ${w} ORDER BY transcript_id DESC LIMIT ${limit}`
  ).all(...params);
  // newest-last is more natural for a feed (oldest first read top-down)
  return rows.reverse().map((r) => ({
    transcript_id: r.transcript_id,
    mission_id: r.mission_id,
    ticket_id: r.ticket_id,
    revision_id: r.revision_id,
    job_id: r.job_id,
    worker_id: r.worker_id,
    role: r.role,
    kind: r.kind as TranscriptKind,
    title: r.title,
    content: r.content,
    meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {},
    created_at: r.created_at,
  }));
}

interface Row {
  transcript_id: number;
  mission_id: string;
  ticket_id: string | null;
  revision_id: string | null;
  job_id: string | null;
  worker_id: string | null;
  role: string | null;
  kind: string;
  title: string | null;
  content: string;
  meta: string | null;
  created_at: string;
}