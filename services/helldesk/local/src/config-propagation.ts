import type { Db } from './db';
import { emitMissionEvent } from './mission-repository';

/**
 * PROPAGATE operator configuration changes to every non-terminal task.
 *
 * A mission's engine matrix is a snapshot taken at creation. When the operator
 * changes the provider/model (or anything the route depends on), a queued or
 * in-progress mission must FOLLOW the new configuration instead of staying
 * pinned to a stale or dead endpoint (this is exactly how missions ended up on
 * a dead local provider route). The propagation:
 *
 *   - keeps the per-stage ENGINE KIND the mission chose (kilo/codex/…),
 *   - drops providerID/modelID/baseURL/apiKey pins so dispatch resolves the
 *     CURRENT effective route (kilo.jsonc / policy),
 *   - journals `mission.engine_route_propagated` with the applied route,
 *   - never touches VERIFIED/CANCELLED tasks.
 *
 * Idempotent: a second call with the same effective state updates nothing.
 */
export interface EffectiveRoute {
  providerID: string;
  modelID: string;
}

const TERMINAL = new Set(['VERIFIED_10_10', 'CANCELLED', 'CLOSED']);
const STAGES = ['mutation', 'review', 'adjudicate'] as const;

export function propagateEngineRoute(d: Db, route: EffectiveRoute): { updated: number; total: number } {
  const rows = d.db
    .query<{ mission_id: string; state: string; engine_matrix_json: string | null }, []>(
      `SELECT mission_id, state, engine_matrix_json FROM autonomy_missions`
    )
    .all();
  let updated = 0;
  let total = 0;
  d.tx(() => {
    for (const row of rows) {
      if (TERMINAL.has(row.state)) continue;
      total++;
      let matrix: Record<string, unknown> = {};
      try {
        matrix = JSON.parse(row.engine_matrix_json || '{}') as Record<string, unknown>;
      } catch {
        matrix = {};
      }
      let changed = false;
      for (const stage of STAGES) {
        const current = (matrix[stage] ?? {}) as Record<string, unknown>;
        const engine = typeof current.engine === 'string' && current.engine ? current.engine : 'kilo';
        const next: Record<string, unknown> = { engine };
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          matrix[stage] = next;
          changed = true;
        }
      }
      if (!changed) continue;
      d.db
        .query(`UPDATE autonomy_missions SET engine_matrix_json=?, updated_at=? WHERE mission_id=?`)
        .run(JSON.stringify(matrix), new Date().toISOString(), row.mission_id);
      emitMissionEvent(d, 'mission.engine_route_propagated', {
        mission_id: row.mission_id,
        providerID: route.providerID,
        modelID: route.modelID,
        engine_matrix: matrix,
      });
      updated++;
    }
  });
  return { updated, total };
}
