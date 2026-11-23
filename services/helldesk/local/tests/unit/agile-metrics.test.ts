import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db';
import { buildAgileMetrics } from '../../src/agile-metrics';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;
const MIN = 60_000;

function seed(d: ReturnType<typeof openDb>): void {
  d.runMigration();
  d.db
    .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?, ?, 1, ?)`)
    .run('ws_a', 'C:\\src\\alpha', iso(100 * HOUR));
  d.db
    .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES (?, ?, 1, ?)`)
    .run('ws_b', 'C:\\src\\beta', iso(100 * HOUR));
  d.db
    .query(
      `INSERT INTO snapshots
         (snapshot_id, subject_kind, workspace_id, manifest_hash, diff_blob_path, manifest_blob_path, content_hash, created_at)
       VALUES ('snap_a','git-head','ws_a','m','d','m','c',?)`
    )
    .run(iso(60 * HOUR));

  const insertMission = (
    id: string,
    workspaceId: string,
    objective: string,
    state: string,
    createdAt: string,
    verifiedAt: string | null,
    humanAcceptance: string | null
  ) =>
    d.db
      .query(
        `INSERT INTO autonomy_missions
           (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at, verified_at, human_acceptance)
         VALUES (?,?,?,?,'ender-1',?,?,?,?)`
      )
      .run(id, workspaceId, objective, state, createdAt, createdAt, verifiedAt, humanAcceptance);

  insertMission('mis_a', 'ws_a', 'Mission A — two tickets', 'VERIFIED_10_10', iso(26 * HOUR), iso(2 * HOUR), null);
  insertMission('mis_b', 'ws_b', 'Mission B — accepted', 'VERIFIED_10_10', iso(50 * HOUR), iso(10 * HOUR), 'accepted');
  insertMission('mis_c', 'ws_a', 'Mission C — active', 'ACTIVE', iso(5 * HOUR), null, null);

  const insertTicket = (
    id: string,
    missionId: string,
    title: string,
    createdAt: string,
    state: string,
    verification: string
  ) =>
    d.db
      .query(
        `INSERT INTO mission_tickets
           (ticket_id, mission_id, title, objective, execution_state, verification_state, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(id, missionId, title, title, state, verification, createdAt, createdAt);

  insertTicket('tkt_a1', 'mis_a', 'A ticket 1', iso(26 * HOUR), 'CLOSED', 'VERIFIED_10_10');
  insertTicket('tkt_a2', 'mis_a', 'A ticket 2', iso(25 * HOUR), 'AWAITING_ACCEPTANCE', 'VERIFIED_10_10');
  insertTicket('tkt_b1', 'mis_b', 'B ticket 1', iso(50 * HOUR), 'CLOSED', 'VERIFIED_10_10');
  insertTicket('tkt_c1', 'mis_c', 'C ticket 1', iso(5 * HOUR), 'RUNNING', 'UNVERIFIED');
  d.db.query(`UPDATE mission_tickets SET story_points=?, tshirt_size=?, sizing_state='sized' WHERE ticket_id=?`).run(3, 'M', 'tkt_a1');
  d.db.query(`UPDATE mission_tickets SET story_points=?, tshirt_size=?, sizing_state='sized' WHERE ticket_id=?`).run(5, 'L', 'tkt_a2');
  d.db.query(`UPDATE mission_tickets SET story_points=?, tshirt_size=?, sizing_state='sized' WHERE ticket_id=?`).run(2, 'S', 'tkt_b1');

  const insertRevision = (id: string, ticketId: string, state: string, createdAt: string, completedAt: string | null) =>
    d.db
      .query(
        `INSERT INTO ticket_revisions (revision_id, ticket_id, revision_no, state, created_at, completed_at)
         VALUES (?,?,1,?,?,?)`
      )
      .run(id, ticketId, state, createdAt, completedAt);

  insertRevision('rev_a1', 'tkt_a1', 'VERIFIED_10_10', iso(26 * HOUR), iso(20 * HOUR));
  insertRevision('rev_a2', 'tkt_a2', 'VERIFIED_10_10', iso(25 * HOUR), iso(2 * HOUR));
  insertRevision('rev_b1', 'tkt_b1', 'VERIFIED_10_10', iso(50 * HOUR), iso(11 * HOUR));
  insertRevision('rev_c1', 'tkt_c1', 'MUTATING', iso(5 * HOUR), null);

  const insertReview = (id: string, state: string, requestedAt: string, completedAt: string, fingerprint: string) =>
    d.db
      .query(
        `INSERT INTO review_jobs
           (job_id, workspace_id, snapshot_id, target_fingerprint, state, policy_version, requested_at, updated_at, completed_at, attempt_count)
         VALUES (?, 'ws_a', 'snap_a', ?, ?, 'v1', ?, ?, ?, 1)`
      )
      .run(id, fingerprint, state, requestedAt, completedAt, completedAt);

  insertReview('job_pass', 'COMPLETED_PASS', iso(6 * HOUR), iso(5 * HOUR), 'fp-pass');
  insertReview('job_find', 'COMPLETED_FINDINGS', iso(4 * HOUR), iso(3 * HOUR), 'fp-find');
  insertReview('job_inc', 'INCONCLUSIVE', iso(2 * HOUR), iso(1 * HOUR), 'fp-inc');
}

describe('agile metrics', () => {
  test('derives mission burndown, throughput, cycle time, workstation velocity and review latency', () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const agile = buildAgileMetrics(d, new Date(NOW));

      expect(agile.missions).toHaveLength(3);
      expect(agile.windowDays).toBe(30);
      expect(agile.throughputDaily).toHaveLength(30);
      expect(agile.throughputHourly).toHaveLength(168);
      expect(agile.throughputDaily.reduce((sum, bucket) => sum + bucket.ticketsVerified, 0)).toBe(3);
      expect(agile.throughputDaily.reduce((sum, bucket) => sum + bucket.missionsVerified, 0)).toBe(2);
      expect(agile.throughputDaily.reduce((sum, bucket) => sum + bucket.storyPointsVerified, 0)).toBe(10);
      expect(agile.throughputDaily.reduce((sum, bucket) => sum + bucket.storyPointsCreated, 0)).toBe(10);

      const missionA = agile.missions.find(mission => mission.missionId === 'mis_a')!;
      expect(missionA.tickets).toBe(2);
      expect(missionA.verifiedTickets).toBe(2);
      expect(missionA.remainingTickets).toBe(0);
      expect(missionA.burndown.length).toBeGreaterThan(1);
      expect(missionA.storyPoints).toBe(8);
      expect(missionA.verifiedStoryPoints).toBe(8);
      expect(missionA.remainingStoryPoints).toBe(0);
      expect(missionA.sizedTickets).toBe(2);
      expect(missionA.sizingCoverage).toBe(1);
      expect(missionA.burndown.at(-1)?.remaining).toBe(0);
      expect(missionA.burndown.at(-1)?.ideal).toBe(0);
      expect(missionA.burndown.at(-1)?.remainingPoints).toBe(0);
      expect(missionA.burndown.at(-1)?.idealPoints).toBe(0);
      expect(missionA.cycleTimeMs).toBeGreaterThan(0);

      const missionC = agile.missions.find(mission => mission.missionId === 'mis_c')!;
      expect(missionC.storyPoints).toBe(0);
      expect(missionC.sizedTickets).toBe(0);
      expect(missionC.sizingCoverage).toBe(0);
      expect(agile.sizing).toMatchObject({ sizedTickets: 3, totalTickets: 4, coverage: 0.75 });

      expect(agile.cycleTime.missions.count).toBe(2);
      expect(agile.cycleTime.tickets.count).toBe(3);
      expect(agile.cycleTime.missions.p50Ms).not.toBeNull();
      expect(agile.cycleTime.tickets.p85Ms).not.toBeNull();

      expect(agile.workstations.length).toBeGreaterThanOrEqual(2);
      const alpha = agile.workstations.find(row => row.workspaceId === 'ws_a')!;
      expect(alpha.workspaceName).toBe('alpha');
      expect(alpha.verifiedTickets).toBe(2);
      expect(alpha.verifiedStoryPoints).toBe(8);
      expect(alpha.activeMissions).toBe(1);
      expect(agile.workstations.find(row => row.workspaceId === 'ws_b')?.verifiedStoryPoints).toBe(2);

      expect(agile.reviewLatencyDaily.reduce((sum, bucket) => sum + bucket.completed, 0)).toBe(3);
      expect(agile.reviewLatencyHourly.reduce((sum, bucket) => sum + bucket.completed, 0)).toBe(3);

      expect(agile.wip.awaitingAcceptance).toBe(1);
      expect(agile.wip.inReview).toBe(2);
      expect(agile.wip.done).toBe(1);
      expect(agile.wip.inProgress).toBe(1);
    } finally {
      d.close();
    }
  });

  test('does not fabricate a trend for an empty database', () => {
    const d = openDb(':memory:');
    try {
      d.runMigration();
      const agile = buildAgileMetrics(d, new Date(NOW));
      expect(agile.missions).toEqual([]);
      expect(agile.throughputDaily.every(bucket => bucket.ticketsCreated === 0 && bucket.ticketsVerified === 0)).toBe(true);
      expect(agile.cycleTime.missions.count).toBe(0);
      expect(agile.cycleTime.missions.p50Ms).toBeNull();
      expect(agile.wip.awaitingAcceptance).toBe(0);
    } finally {
      d.close();
    }
  });
});
