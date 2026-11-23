import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import { createMission, getMission, setMissionOperatorStatus } from '../../src/mission-repository';

/**
 * The kanban must not snap a mission card back: the operator's chosen column is
 * recorded in the engine as a DISPLAY overlay. The mission STATE stays
 * engine-owned and is never rewritten by a drag.
 */
describe('mission operator-status overlay', () => {
  it('records the chosen board column without touching the engine state', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const mission = createMission(d, { workspace_id: 'ws_overlay', objective: 'overlay' });
      const engineStateBefore = getMission(d, mission.mission_id)?.state;

      setMissionOperatorStatus(d, mission.mission_id, 'in_progress');
      const withOverlay = getMission(d, mission.mission_id);
      expect(withOverlay?.operator_status).toBe('in_progress');
      expect(withOverlay?.operator_status_at).toBeTruthy();
      expect(withOverlay?.state).toBe(engineStateBefore);

      setMissionOperatorStatus(d, mission.mission_id, null);
      expect(getMission(d, mission.mission_id)?.operator_status).toBeNull();
    } finally {
      d.close();
    }
  });
});
