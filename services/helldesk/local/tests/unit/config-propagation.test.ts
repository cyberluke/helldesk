import { describe, expect, it } from 'bun:test';
import { openDb } from '../../src/db';
import { createMission, getMission, updateMissionState } from '../../src/mission-repository';
import { propagateEngineRoute } from '../../src/config-propagation';

/**
 * A provider/model switch must reach every queued or in-progress task. Mission
 * engine matrices are creation-time snapshots; propagation keeps the chosen
 * ENGINE KIND and drops stale provider/model pins so dispatch follows the
 * current effective route. Terminal tasks are never rewritten.
 */
describe('config propagation to non-terminal tasks', () => {
  it('drops stale route pins, preserves engine kinds, leaves terminal tasks alone', () => {
    const d = openDb(':memory:');
    d.runMigration();
    try {
      const active = createMission(d, {
        workspace_id: 'ws1',
        objective: 'active task',
        engineMatrix: {
          mutation: { engine: 'kilo', providerID: 'dead', modelID: 'old', baseURL: 'http://dead' },
          review: { engine: 'codex', providerID: 'dead', modelID: 'old' },
          adjudicate: { engine: 'kilo', baseURL: 'http://dead' },
        },
      });
      const done = createMission(d, {
        workspace_id: 'ws1',
        objective: 'done task',
        engineMatrix: { mutation: { engine: 'kilo', providerID: 'keep', modelID: 'keep' } },
      });
      updateMissionState(d, done.mission_id, 'VERIFIED_10_10');

      const first = propagateEngineRoute(d, { providerID: 'cyberluke', modelID: 'deepseek' });
      expect(first.updated).toBe(1);

      const activeRow = getMission(d, active.mission_id)!;
      expect(JSON.parse(activeRow.engine_matrix_json!)).toEqual({
        mutation: { engine: 'kilo' },
        review: { engine: 'codex' },
        adjudicate: { engine: 'kilo' },
      });

      const doneRow = getMission(d, done.mission_id)!;
      expect(JSON.parse(doneRow.engine_matrix_json!)).toEqual({
        mutation: { engine: 'kilo', providerID: 'keep', modelID: 'keep' },
      });

      // Idempotent: the second sync updates nothing.
      expect(propagateEngineRoute(d, { providerID: 'cyberluke', modelID: 'deepseek' }).updated).toBe(0);
    } finally {
      d.close();
    }
  });
});
