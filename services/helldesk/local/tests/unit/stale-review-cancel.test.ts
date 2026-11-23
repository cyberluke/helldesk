import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import { addTicket, createMission, createRevision } from '../../src/mission-repository';
import { registerWorkspace } from '../../src/workspace-registry';
import { cancelReviewForRevision, sweepStaleReviewJobs } from '../../src/mission-controller';

function seedWorkspace(d: ReturnType<typeof openDb>, path: string): string {
  const ws = registerWorkspace(d, { path, enabled: true });
  const nowIso = new Date().toISOString();
  d.db.query(`INSERT INTO snapshots (snapshot_id, subject_kind, workspace_id, manifest_hash, diff_blob_path, manifest_blob_path, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?)`).run(`snap_${path.split('/').pop()}`, 'fs-folder', ws.workspaceId, 'mh', 'd.bin', 'm.bin', 'ch', nowIso);
  return ws.workspaceId;
}

/**
 * A rejected/superseded revision must not keep a review execution alive: the job
 * is cancelled, the stale workers are terminated, and the job lease is dropped.
 * Otherwise reviewers keep running (and look "active") for work the mission has
 * already rejected.
 */
describe('stale review cancellation', () => {
  it('cancels a non-terminal review on a rejected revision and terminates its workers', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const wsId = seedWorkspace(d, 'C:/tmp/stale-1');
      const mission = createMission(d, { workspace_id: wsId, objective: 'stale' });
      const ticket = addTicket(d, mission.mission_id, { title: 'T', objective: 'stale' });
      const revision = createRevision(d, { ticket_id: ticket.ticket_id, workspace_fingerprint_before: 'fp' });
      const nowIso = new Date().toISOString();
      d.db
        .query(
          `INSERT INTO review_jobs
             (job_id, workspace_id, snapshot_id, target_fingerprint, state, policy_version, source, requested_at, updated_at, attempt_count, retry_count)
           VALUES ('job_stale',?,?,'fp','REVIEWING_A_B','v1','mission',?,?,1,0)`
        )
        .run(wsId, 'snap_stale-1', nowIso, nowIso);
      d.db
        .query(`UPDATE ticket_revisions SET state='REJECTED', review_job_id='job_stale' WHERE revision_id=?`)
        .run(revision.revision_id);
      d.db
        .query(
          `INSERT INTO workers (worker_id, job_id, attempt_id, role, status, provider_id, model_id, started_at, last_heartbeat_at)
           VALUES ('wk_stale','job_stale','att_stale-a','reviewer-a','running','p','m',?,?)`
        )
        .run(nowIso, nowIso);

      expect(sweepStaleReviewJobs(d)).toBe(1);

      const job = d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id='job_stale'`).get('job_stale');
      expect(job?.state).toBe('CANCELLED');
      const worker = d.db.query<{ status: string }, [string]>(`SELECT status FROM workers WHERE worker_id='wk_stale'`).get('wk_stale');
      expect(worker?.status).toBe('terminated');
    } finally {
      d.close();
    }
  });

  it('is a no-op for an already-terminal job', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const wsId2 = seedWorkspace(d, 'C:/tmp/stale-2');
      const mission = createMission(d, { workspace_id: wsId2, objective: 'stale' });
      const ticket = addTicket(d, mission.mission_id, { title: 'T', objective: 'stale' });
      const revision = createRevision(d, { ticket_id: ticket.ticket_id, workspace_fingerprint_before: 'fp' });
      const nowIso = new Date().toISOString();
      d.db
        .query(
          `INSERT INTO review_jobs
             (job_id, workspace_id, snapshot_id, target_fingerprint, state, policy_version, source, requested_at, updated_at, attempt_count, retry_count)
           VALUES ('job_done',?,'snap_stale-2','fp','COMPLETED_FINDINGS','v1','mission',?,?,1,0)`
        )
        .run(wsId2, nowIso, nowIso);
      d.db
        .query(`UPDATE ticket_revisions SET state='REJECTED', review_job_id='job_done' WHERE revision_id=?`)
        .run(revision.revision_id);
      cancelReviewForRevision(d, revision.revision_id, 'revision rejected');
      const job = d.db.query<{ state: string }, [string]>(`SELECT state FROM review_jobs WHERE job_id='job_done'`).get('job_done');
      expect(job?.state).toBe('COMPLETED_FINDINGS');
    } finally {
      d.close();
    }
  });
});

