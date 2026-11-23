import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db';
import { listEventsSince, listEventsTail } from '../../src/events';
import {
  buildObservabilitySnapshot,
  enrichOutboxEvents,
  invalidateObservabilitySnapshot,
} from '../../src/observability';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function insertEvent(
  d: ReturnType<typeof openDb>,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt: string,
  jobId?: string,
): void {
  d.db
    .query(
      `INSERT INTO events_outbox (event_type, job_id, payload, created_at, delivery_attempts)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(eventType, jobId ?? null, JSON.stringify(payload), createdAt);
}

function seed(d: ReturnType<typeof openDb>): void {
  d.runMigration();
  const createdAt = iso(120 * MIN);

  d.db
    .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?, ?, 1, ?)`)
    .run('ws_test', 'C:\\src\\observability-repo', createdAt);
  d.db
    .query(
      `INSERT INTO autonomy_missions
         (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at, verified_at)
       VALUES (?, ?, ?, 'VERIFIED_10_10', 'ender-1', ?, ?, ?)`,
    )
    .run('mis_test', 'ws_test', 'ship observability', createdAt, createdAt, iso(60 * MIN));
  d.db
    .query(
      `INSERT INTO mission_tickets
         (ticket_id, mission_id, title, objective, execution_state, verification_state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CLOSED', 'VERIFIED_10_10', ?, ?)`,
    )
    .run('tkt_test', 'mis_test', 'observability ticket', 'build it', createdAt, createdAt);
  d.db
    .query(
      `INSERT INTO ticket_revisions
         (revision_id, ticket_id, revision_no, state, review_job_id, created_at)
       VALUES (?, ?, 1, 'VERIFIED_10_10', ?, ?)`,
    )
    .run('rev_test', 'tkt_test', 'job_test', createdAt);
  d.db
    .query(
      `INSERT INTO snapshots
         (snapshot_id, subject_kind, workspace_id, manifest_hash, diff_blob_path,
          manifest_blob_path, content_hash, created_at)
       VALUES (?, 'git-head', ?, 'm', 'd', 'm2', 'c', ?)`,
    )
    .run('snap_test', 'ws_test', createdAt);
  d.db
    .query(
      `INSERT INTO review_jobs
         (job_id, workspace_id, snapshot_id, target_fingerprint, state, policy_version,
          requested_at, updated_at, completed_at, attempt_count)
       VALUES (?, ?, ?, 'fp-1', 'COMPLETED_FINDINGS', 'v1', ?, ?, ?, 2)`,
    )
    .run('job_test', 'ws_test', 'snap_test', iso(50 * MIN), iso(30 * MIN), iso(30 * MIN));
  d.db
    .query(
      `INSERT INTO workers
         (worker_id, job_id, role, status, provider_id, model_id, pid, started_at, finished_at)
       VALUES (?, ?, 'reviewer-a', 'succeeded', 'provider-x', 'model-y', 123, ?, ?)`,
    )
    .run('wrk_done', 'job_test', iso(40 * MIN), iso(35 * MIN));
  d.db
    .query(
      `INSERT INTO workers
         (worker_id, job_id, role, status, provider_id, model_id, pid, started_at)
       VALUES (?, ?, 'adjudicator', 'running', 'provider-x', 'model-y', 456, ?)`,
    )
    .run('wrk_live', 'job_test', iso(10 * MIN));
  d.db
    .query(
      `INSERT INTO agent_runs
         (run_id, job_id, role, status, started_at, finished_at, duration_ms, tokens_in, tokens_out, cost)
       VALUES (?, ?, 'reviewer-a', 'succeeded', ?, ?, 1234, 100, 50, 0)`,
    )
    .run('run_test', 'job_test', iso(40 * MIN), iso(35 * MIN));
  d.db
    .query(
      `INSERT INTO findings
         (finding_id, job_id, severity, confidence, title, file, reviewer_ids, adjudicated)
       VALUES (?, ?, 'BLOCKER', 'VERIFIED', 'missing wiring', 'src/x.ts', '["A"]', 1)`,
    )
    .run('fnd_test', 'job_test');
  d.db
    .query(
      `INSERT INTO quality_gate_results
         (revision_id, gate_key, status, checked_at)
       VALUES (?, 'functional_correctness', 'PASS', ?)`,
    )
    .run('rev_test', iso(45 * MIN));
  d.db
    .query(
      `INSERT INTO quality_gate_results
         (revision_id, gate_key, status, checked_at)
       VALUES (?, 'regression_safety', 'FAIL', ?)`,
    )
    .run('rev_test', iso(45 * MIN));

  insertEvent(d, 'mission.created', { mission_id: 'mis_test' }, iso(120 * MIN));
  insertEvent(d, 'job.enqueued', { jobId: 'job_test', state: 'QUEUED' }, iso(5 * MIN), 'job_test');
  insertEvent(d, 'job.requeued', { jobId: 'job_test', reason: 'stale' }, iso(60 * MIN), 'job_test');
  insertEvent(d, 'mission.state_changed', { mission_id: 'mis_test', state: 'ACTIVE' }, iso(0.2 * MIN));
}

describe('event journal tail', () => {
  test('returns the NEWEST events in chronological order, not the journal head', () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const tail = listEventsTail(d, 2);
      expect(tail.map(e => e.eventType)).toEqual(['job.requeued', 'mission.state_changed']);
      // The oldest event (journal head) must not be present.
      expect(tail.map(e => e.eventType)).not.toContain('mission.created');

      const since = listEventsSince(d, iso(10 * MIN));
      expect(since.map(e => e.eventType)).toEqual(['job.enqueued', 'mission.state_changed']);
    } finally {
      d.close();
    }
  });

  test('enriches events with the workspace their durable foreign keys imply', () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const enriched = enrichOutboxEvents(d, listEventsTail(d, 10));
      expect(enriched.every(e => e.workspaceId === 'ws_test')).toBe(true);
      expect(enriched.every(e => e.workspaceName === 'observability-repo')).toBe(true);
      const jobEvent = enriched.find(e => e.eventType === 'job.enqueued');
      expect(jobEvent?.ticketId).toBe('tkt_test');
      expect(jobEvent?.missionId).toBe('mis_test');
    } finally {
      d.close();
    }
  });
});

describe('observability snapshot', () => {
  test('aggregates events, reviews, gates, workers and usage from real rows', () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      invalidateObservabilitySnapshot(d);
      const snapshot = buildObservabilitySnapshot(d, { queued: 1, running: 0, inFlight: 1 }, { maxAgeMs: -1 });

      expect(snapshot.engine.queue).toEqual({ queued: 1, running: 0, inFlight: 1 });
      expect(snapshot.events.total).toBe(4);
      expect(snapshot.events.last24h).toBe(4);
      expect(snapshot.events.lastHour).toBe(2);
      expect(snapshot.events.perHour24h).toHaveLength(24);
      expect(snapshot.events.perHour24h.reduce((sum, b) => sum + b.count, 0)).toBe(4);
      expect(snapshot.events.byType24h.find(row => row.eventType === 'mission.created')?.count).toBe(1);
      expect(snapshot.events.byWorkspace24h).toEqual([
        { workspaceId: 'ws_test', workspaceName: 'observability-repo', count: 4 },
      ]);
      expect(snapshot.events.latest).toHaveLength(4);

      expect(snapshot.missions).toMatchObject({
        total: 1,
        active: 0,
        blocked: 0,
        verified: 1,
        verified24h: 1,
      });
      expect(snapshot.missions.byState).toEqual([{ state: 'VERIFIED_10_10', count: 1 }]);

      expect(snapshot.reviews.total).toBe(1);
      expect(snapshot.reviews.open).toBe(0);
      expect(snapshot.reviews.completed24h).toBe(1);
      expect(snapshot.reviews.findings24h).toBe(1);
      expect(snapshot.reviews.pass24h).toBe(0);
      expect(snapshot.reviews.avgTimeToVerdictMs).toBe(20 * MIN);
      expect(snapshot.reviews.byState).toEqual([{ state: 'COMPLETED_FINDINGS', count: 1 }]);

      expect(snapshot.findings.total).toBe(1);
      expect(snapshot.findings.bySeverity).toEqual([{ severity: 'BLOCKER', count: 1 }]);

      expect(snapshot.gates.total).toBe(2);
      expect(snapshot.gates.byStatus).toEqual(
        expect.arrayContaining([
          { status: 'PASS', count: 1 },
          { status: 'FAIL', count: 1 },
        ]),
      );
      expect(snapshot.gates.byGate).toEqual(
        expect.arrayContaining([
          { gateKey: 'functional_correctness', pass: 1, fail: 0, unverified: 0, blocked: 0 },
          { gateKey: 'regression_safety', pass: 0, fail: 1, unverified: 0, blocked: 0 },
        ]),
      );

      expect(snapshot.workers.total).toBe(2);
      expect(snapshot.workers.running).toBe(1);
      expect(snapshot.workers.active).toHaveLength(1);
      expect(snapshot.workers.active[0]?.workerId).toBe('wrk_live');
      expect(snapshot.workers.byStatus).toEqual(
        expect.arrayContaining([
          { status: 'running', count: 1 },
          { status: 'succeeded', count: 1 },
        ]),
      );

      expect(snapshot.usage).toMatchObject({
        runs: 1,
        tokensIn: 100,
        tokensOut: 50,
        avgRunDurationMs: 1234,
      });

      expect(snapshot.recovery.requeued24h).toBe(1);
      expect(snapshot.recovery.replanned24h).toBe(0);

      expect(snapshot.recentJobs).toHaveLength(1);
      expect(snapshot.recentJobs[0]).toMatchObject({
        jobId: 'job_test',
        workspaceName: 'observability-repo',
        state: 'COMPLETED_FINDINGS',
        attemptCount: 2,
        durationMs: 20 * MIN,
      });
    } finally {
      d.close();
    }
  });

  test('counts a budget halt as a blocked mission in the recovery window', () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      insertEvent(d, 'mission.budget_blocked', { mission_id: 'mis_test' }, iso(1 * MIN));
      invalidateObservabilitySnapshot(d);
      const snapshot = buildObservabilitySnapshot(d, { queued: 0, running: 0, inFlight: 0 }, { maxAgeMs: -1 });
      expect(snapshot.recovery.blocked24h).toBe(1);
    } finally {
      d.close();
    }
  });

  test('reports null/empty metrics honestly on an empty engine', () => {
    const d = openDb(':memory:');
    try {
      d.runMigration();
      invalidateObservabilitySnapshot(d);
      const snapshot = buildObservabilitySnapshot(d, { queued: 0, running: 0, inFlight: 0 }, { maxAgeMs: -1 });

      expect(snapshot.events.total).toBe(0);
      expect(snapshot.events.perHour24h).toHaveLength(24);
      expect(snapshot.events.perHour24h.every(b => b.count === 0)).toBe(true);
      expect(snapshot.events.byType24h).toEqual([]);
      expect(snapshot.events.byWorkspace24h).toEqual([]);
      expect(snapshot.events.latest).toEqual([]);
      expect(snapshot.reviews.avgTimeToVerdictMs).toBeNull();
      expect(snapshot.reviews.oldestOpenAgeMs).toBeNull();
      expect(snapshot.usage.avgRunDurationMs).toBeNull();
      expect(snapshot.recentJobs).toEqual([]);
    } finally {
      d.close();
    }
  });
});
