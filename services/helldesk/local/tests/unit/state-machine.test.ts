import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { transitionJob, InvalidTransitionError, forceJobState } from '../../src/state-machine';
import { makeTestDb } from '../helpers';
import { createJob } from '../../src/jobs';

describe('state machine', () => {
  let h: ReturnType<typeof makeTestDb>;
  beforeAll(() => { h = makeTestDb(); });
  afterAll(() => h.close());

  const mkJob = () => {
    // Seed the FK-referenced rows (workspace + snapshot) before the job.
    const ts = new Date().toISOString();
    h.d.db
      .query(
        `INSERT OR IGNORE INTO workspaces (workspace_id, path, enabled, created_at) VALUES ('ws_x','C:/x',1,?)`
      )
      .run(ts);
    h.d.db
      .query(
        `INSERT OR IGNORE INTO snapshots (snapshot_id, subject_kind, workspace_id, base_hash, head_hash, dirty_hash,
           untracked_hash, manifest_hash, diff_blob_path, manifest_blob_path, content_hash, created_at)
         VALUES ('snap_x','git-head','ws_x',NULL,NULL,NULL,NULL,'m', 'd','m','c', ?)`
      )
      .run(ts);
    return createJob(h.d, {
      workspaceId: 'ws_x',
      snapshotId: 'snap_x',
      targetFingerprint: 'fp_x' + Math.random(),
      subjectKind: 'git-head',
      policyVersion: '1',
      source: 'test',
    });
  };

  it('allows legal transitions', () => {
    const job = mkJob();
    transitionJob(h.d, job.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(h.d, job.jobId, 'SNAPSHOTTED', 'QUEUED');
    transitionJob(h.d, job.jobId, 'QUEUED', 'REVIEWING_A_B');
    transitionJob(h.d, job.jobId, 'REVIEWING_A_B', 'ADJUDICATING');
    transitionJob(h.d, job.jobId, 'ADJUDICATING', 'COMPLETED_PASS');
  });

  it('rejects invalid transitions atomically', () => {
    const job = mkJob();
    expect(() => transitionJob(h.d, job.jobId, 'QUEUED', 'DISCOVERED')).toThrow(InvalidTransitionError);
  });

  it('refuses a transition from a terminal state', () => {
    const a = mkJob();
    transitionJob(h.d, a.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(h.d, a.jobId, 'SNAPSHOTTED', 'QUEUED');
    transitionJob(h.d, a.jobId, 'QUEUED', 'REVIEWING_A_B');
    transitionJob(h.d, a.jobId, 'REVIEWING_A_B', 'ADJUDICATING');
    transitionJob(h.d, a.jobId, 'ADJUDICATING', 'COMPLETED_FINDINGS');
    expect(() => transitionJob(h.d, a.jobId, 'COMPLETED_FINDINGS', 'QUEUED')).toThrow(InvalidTransitionError);
  });

  it('sets completed_at only on terminal transitions', () => {
    const job = mkJob();
    transitionJob(h.d, job.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(h.d, job.jobId, 'SNAPSHOTTED', 'QUEUED');
    transitionJob(h.d, job.jobId, 'QUEUED', 'REVIEWING_A_B');
    const mid = h.d.db.query<{ completed_at: string | null }, [string]>(`SELECT completed_at FROM review_jobs WHERE job_id=?`).get(job.jobId)!;
    expect(mid.completed_at).toBeNull();
    transitionJob(h.d, job.jobId, 'REVIEWING_A_B', 'ADJUDICATING');
    transitionJob(h.d, job.jobId, 'ADJUDICATING', 'INCONCLUSIVE');
    const term = h.d.db.query<{ completed_at: string | null }, [string]>(`SELECT completed_at FROM review_jobs WHERE job_id=?`).get(job.jobId)!;
    expect(term.completed_at).not.toBeNull();
  });

  it('forceJobState bypasses graph (reconciler recovery)', () => {
    const job = mkJob();
    forceJobState(h.d, job.jobId, 'QUEUED');
    const row = h.d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id=?`).get(job.jobId)!;
    expect(row.state).toBe('QUEUED');
  });
});