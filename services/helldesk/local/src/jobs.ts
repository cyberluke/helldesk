import type { Db } from './db';
import { generateId, now } from './ids';
import type { SubjectKind } from './schemas';
import { parseReviewControls, type ReviewControls } from './review-controls';

/** Job repository + creation with immutable fingerprint dedupe. */

export interface CreateJobInput {
  workspaceId: string;
  snapshotId: string;
  targetFingerprint: string;
  subjectKind: SubjectKind;
  policyVersion: string;
  source: string;
  triggerSessionId?: string;
  requirements?: string;
  baseHash?: string | null;
  headHash?: string | null;
  dirtyHash?: string | null;
  untrackedHash?: string | null;
  /** Per-task review policy (which reviewer/governor stages may run). */
  controls?: ReviewControls;
}

export type JobRecord = {
  jobId: string;
  workspaceId: string;
  snapshotId: string;
  targetFingerprint: string;
  state: string;
  result: string | null;
  source: string;
  triggerSessionId: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
  attemptCount: number;
  retryCount: number;
};

export function createJob(d: Db, input: CreateJobInput): JobRecord {
  const jobId = `job_${generateId().slice(0, 24)}`;
  const t = now();
  d.db
    .query(
      `INSERT INTO review_jobs
         (job_id, workspace_id, snapshot_id, target_fingerprint, state, policy_version, source,
          trigger_session_id, requested_at, updated_at, meta)
       VALUES (?, ?, ?, ?, 'DISCOVERED', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      jobId,
      input.workspaceId,
      input.snapshotId,
      input.targetFingerprint,
      input.policyVersion,
      input.source,
      input.triggerSessionId ?? null,
      t,
      t,
      JSON.stringify({
        requirements: input.requirements ?? null,
        kind: input.subjectKind,
        baseHash: input.baseHash ?? null,
        headHash: input.headHash ?? null,
        dirtyHash: input.dirtyHash ?? null,
        untrackedHash: input.untrackedHash ?? null,
        controls: input.controls ?? {},
      })
    );
  return getJob(d, jobId)!;
}

/** The job's persisted review policy (defaults = all stages enabled). */
export function getJobReviewControls(d: Db, jobId: string): ReviewControls {
  const row = d.db.query<{ meta: string | null }, [string]>('SELECT meta FROM review_jobs WHERE job_id=?').get(jobId);
  if (!row?.meta) return {};
  try {
    const meta = JSON.parse(row.meta) as { controls?: unknown };
    return parseReviewControls(meta.controls);
  } catch {
    return {};
  }
}

export function getJob(d: Db, jobId: string): JobRecord | null {
  const row = d.db
    .query<{
      job_id: string;
      workspace_id: string;
      snapshot_id: string;
      target_fingerprint: string;
      state: string;
      result: string | null;
      source: string;
      trigger_session_id: string | null;
      requested_at: string;
      updated_at: string;
      completed_at: string | null;
      attempt_count: number;
      retry_count: number;
    }, [string]>(`SELECT * FROM review_jobs WHERE job_id=?`)
    .get(jobId);
  if (!row) return null;
  return {
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    snapshotId: row.snapshot_id,
    targetFingerprint: row.target_fingerprint,
    state: row.state,
    result: row.result,
    source: row.source,
    triggerSessionId: row.trigger_session_id,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    attemptCount: row.attempt_count,
    retryCount: row.retry_count,
  };
}

/** Find a job by immutable fingerprint (dedupe auto triggers). */
export function findJobByFingerprint(d: Db, fp: string): JobRecord | null {
  const row = d.db
    .query<{ job_id: string }, [string]>(`SELECT job_id FROM review_jobs WHERE target_fingerprint=?`)
    .get(fp);
  return row ? getJob(d, row.job_id) : null;
}

export function listJobs(d: Db, opts?: { state?: string; workspaceId?: string; limit?: number }): JobRecord[] {
  const limit = opts?.limit ?? 50;
  const cond: string[] = [];
  const params: string[] = [];
  if (opts?.state) { cond.push('state=?'); params.push(opts.state); }
  if (opts?.workspaceId) { cond.push('workspace_id=?'); params.push(opts.workspaceId); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return d.db
    .query<JobRecord, string[]>(
      `SELECT job_id, workspace_id, snapshot_id, target_fingerprint, state, result, source,
              trigger_session_id, requested_at, updated_at, completed_at,
              attempt_count, retry_count
       FROM review_jobs ${where} ORDER BY requested_at DESC LIMIT ?`
    )
    .all(...params, String(limit));
}

export function resolveSnapshotMeta(d: Db, snapshotId: string): {
  kind: string;
  baseHash: string | null;
  headHash: string | null;
  dirtyHash: string | null;
} | null {
  const row = d.db
    .query<{ subject_kind: string; base_hash: string | null; head_hash: string | null; dirty_hash: string | null }, [string]>(
      `SELECT subject_kind, base_hash, head_hash, dirty_hash FROM snapshots WHERE snapshot_id=?`
    )
    .get(snapshotId);
  if (!row) return null;
  return { kind: row.subject_kind, baseHash: row.base_hash, headHash: row.head_hash, dirtyHash: row.dirty_hash };
}