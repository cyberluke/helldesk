import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import {
  addTicket,
  createMission,
  createRevision,
  getMission,
  getRevision,
  resumeMissionState,
  scheduleBlockedRetry,
  updateMissionState,
  updateRevision,
} from '../../src/mission-repository';
import { advanceMission, type ControllerDeps } from '../../src/mission-controller';

/**
 * Long-horizon governors:
 *  - transient blocks get a BOUNDED auto-retry (5/10/20 min, max 3),
 *  - pathological (replan-exhausted) and budget blocks never auto-retry,
 *  - resume unblocks and reconciles a stuck revision to a dispatchable state.
 */
describe('mission governors + blocked recovery', () => {
  it('schedules a bounded retry only for transient blockers', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const mission = createMission(d, { workspace_id: 'ws_governor', objective: 'governor' });
      scheduleBlockedRetry(d, mission.mission_id, 'external blocker');
      let row = getMission(d, mission.mission_id)!;
      expect(row.next_retry_at).toBeTruthy();
      expect(row.auto_retry_count).toBe(1);

      // A budget/pathological block must clear the schedule: only a human resumes it.
      scheduleBlockedRetry(d, mission.mission_id, 'budget:wall-clock 400min > 360min');
      row = getMission(d, mission.mission_id)!;
      expect(row.next_retry_at).toBeNull();
    } finally {
      d.close();
    }
  });

  it('does NOT enforce a wall-clock budget unless the operator explicitly configured one', async () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const mission = createMission(d, { workspace_id: 'ws_governor', objective: 'long horizon' });
      // Seven hours old: past the old hidden 6h default.
      d.db
        .query(`UPDATE autonomy_missions SET created_at=? WHERE mission_id=?`)
        .run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), mission.mission_id);

      await advanceMission(mission.mission_id, { d } as ControllerDeps);

      const row = getMission(d, mission.mission_id)!;
      expect(row.blocked_reason ?? '').not.toContain('budget:');
      const budgetEvents = d.db
        .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM events_outbox WHERE event_type='mission.budget_blocked'`)
        .get();
      expect(budgetEvents?.c ?? 0).toBe(0);
    } finally {
      d.close();
    }
  });

  it('enforces a wall-clock budget when one is explicitly configured', async () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const mission = createMission(d, { workspace_id: 'ws_governor', objective: 'budgeted' });
      d.db
        .query(`UPDATE autonomy_missions SET created_at=? WHERE mission_id=?`)
        .run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), mission.mission_id);

      const result = await advanceMission(mission.mission_id, {
        d,
        maxMissionWallClockMs: 60_000,
      } as ControllerDeps);

      expect(result.action).toBe('budget-blocked');
      expect(getMission(d, mission.mission_id)?.blocked_reason).toContain('budget:wall-clock');
    } finally {
      d.close();
    }
  });

  it('resumeMissionState unblocks and reconciles a stuck revision to PLANNED', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const mission = createMission(d, { workspace_id: 'ws_governor', objective: 'governor' });
      const ticket = addTicket(d, mission.mission_id, { title: 'T', objective: 'governor' });
      const revision = createRevision(d, { ticket_id: ticket.ticket_id, workspace_fingerprint_before: 'fp' });
      updateRevision(d, revision.revision_id, { state: 'MUTATING' });
      updateMissionState(d, mission.mission_id, 'BLOCKED_EXTERNAL', { blocked_reason: 'external blocker' });

      expect(resumeMissionState(d, mission.mission_id)).toBe(true);
      const resumed = getMission(d, mission.mission_id)!;
      expect(resumed.state).toBe('ACTIVE');
      expect(resumed.blocked_reason).toBeNull();
      expect(resumed.next_retry_at).toBeNull();
      expect(getRevision(d, revision.revision_id)?.state).toBe('PLANNED');
    } finally {
      d.close();
    }
  });
});
