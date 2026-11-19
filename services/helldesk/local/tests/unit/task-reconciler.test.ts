import { describe, expect, it } from 'bun:test';
import { makeTestDb } from '../helpers';
import { TaskReconciler } from '../../src/task-reconciler';

function seedEligibleQuietEpoch(d: ReturnType<typeof makeTestDb>['d'], id: string): void {
  const t = new Date(Date.now() - 60_000).toISOString();
  d.db.query(
    `INSERT INTO task_epochs
      (epoch_id, host_id, session_id, epoch_no, state, work_observed, last_activity_at,
       assistant_delivered, tools_running, quiet_deadline_at, eligibility_state,
       eligibility_at, workspace_root)
     VALUES (?, 'host-test', 'session-test', 1, 'quiet', 1, ?, 1, 0, ?, 'pending', ?, '')`
  ).run(id, t, t, t);
}

describe('TaskReconciler durable completion enqueue', () => {
  it('marks an epoch complete only after enqueue succeeds', async () => {
    const h = makeTestDb();
    try {
      let calls = 0;
      const reconciler = new TaskReconciler({
        debounceMs: 1,
        quietMs: 1,
        policyVersion: 'test',
        enqueue: async () => {
          calls++;
          return { jobId: 'job-test' };
        },
      });
      seedEligibleQuietEpoch(h.d, 'epoch-success');

      await reconciler.reconcilePending(h.d);

      const row = h.d.db
        .query<{ state: string; eligibility_state: string | null }, [string]>(
          `SELECT state, eligibility_state FROM task_epochs WHERE epoch_id=?`
        )
        .get('epoch-success');
      expect(calls).toBe(1);
      expect(row?.state).toBe('complete');
      expect(row?.eligibility_state).toBe('eligible');
      reconciler.dispose();
    } finally {
      h.close();
    }
  });

  it('keeps a failed enqueue retryable and completes on a later sweep', async () => {
    const h = makeTestDb();
    try {
      let calls = 0;
      const reconciler = new TaskReconciler({
        debounceMs: 1,
        quietMs: 1,
        policyVersion: 'test',
        enqueue: async () => {
          calls++;
          if (calls === 1) throw new Error('transient snapshot failure');
          return { jobId: 'job-recovered' };
        },
      });
      seedEligibleQuietEpoch(h.d, 'epoch-retry');

      await reconciler.reconcilePending(h.d);

      let row = h.d.db
        .query<{ state: string; eligibility_state: string | null }, [string]>(
          `SELECT state, eligibility_state FROM task_epochs WHERE epoch_id=?`
        )
        .get('epoch-retry');
      expect(row?.state).toBe('quiet');
      expect(row?.eligibility_state).toBe('attribution_uncertain');

      h.d.db.query(
        `UPDATE task_epochs SET quiet_deadline_at=? WHERE epoch_id=?`
      ).run(new Date(Date.now() - 1_000).toISOString(), 'epoch-retry');

      await reconciler.reconcilePending(h.d);

      row = h.d.db
        .query<{ state: string; eligibility_state: string | null }, [string]>(
          `SELECT state, eligibility_state FROM task_epochs WHERE epoch_id=?`
        )
        .get('epoch-retry');
      expect(calls).toBe(2);
      expect(row?.state).toBe('complete');
      expect(row?.eligibility_state).toBe('eligible');
      reconciler.dispose();
    } finally {
      h.close();
    }
  });

  it('recovers a stale enqueuing claim after a daemon crash', async () => {
    const h = makeTestDb();
    try {
      let calls = 0;
      const reconciler = new TaskReconciler({
        debounceMs: 1,
        quietMs: 1,
        policyVersion: 'test',
        enqueue: async () => {
          calls++;
          return { jobId: 'job-after-crash' };
        },
      });
      seedEligibleQuietEpoch(h.d, 'epoch-crash');
      h.d.db.query(
        `UPDATE task_epochs
         SET eligibility_state='enqueuing', eligibility_at=?, quiet_deadline_at=?
         WHERE epoch_id=?`
      ).run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 120_000).toISOString(),
        'epoch-crash'
      );

      await reconciler.reconcilePending(h.d);

      const row = h.d.db
        .query<{ state: string; eligibility_state: string | null }, [string]>(
          `SELECT state, eligibility_state FROM task_epochs WHERE epoch_id=?`
        )
        .get('epoch-crash');
      expect(calls).toBe(1);
      expect(row?.state).toBe('complete');
      expect(row?.eligibility_state).toBe('eligible');
      reconciler.dispose();
    } finally {
      h.close();
    }
  });
});
