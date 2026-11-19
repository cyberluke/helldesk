import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from '../helpers';
import { createMission, addTicket, getTicket, getMission } from '../../src/mission-repository';
import { advanceMission, REPORT_GATES, type ControllerDeps, type ReviewVerdict } from '../../src/mission-controller';
import type { MutationRunner, RepairResult } from '../../src/mutation-runner';

// Replan-cap regression guard.
// A mutator that persistently returns NO_CHANGE (e.g. a broken/hung child that
// commits nothing the controller recognizes) MUST NOT loop forever. Past the
// MAX_PLAN_REVISIONS cap the ticket/mission surfaces as BLOCKED ("replan-exhausted")
// instead of burning an unbounded new revision. This is the durable fix for the
// observed 4614-revision runaway in mis_49b6f04c.

const noChangeRunner = (): MutationRunner => ({
  transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
  async execute() {
    return { outcome: 'NO_CHANGE', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: 'same', workspaceFingerprintAfter: 'same' };
  },
});
const anyReview = (): ControllerDeps['review'] => async ({ revisionId }) => {
  const gateKeys: string[] = REPORT_GATES.ARTIFACTS
  return {
    verdict: 'PASS' as ReviewVerdict, mandatoryGates: gateKeys,
    gatePassed: Object.fromEntries(gateKeys.map((k) => [k, true])) as Record<string, boolean>,
    gateEvidenceRefs: Object.fromEntries(gateKeys.map((k) => [k, [] as string[]])) as Record<string, string[]>,
    findings: [] as string[], evidenceResolved: false, snapshotId: `snap-${revisionId}`, reviewJobId: `job-${revisionId}`,
  }
}
function ws(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-replan-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('mission-controller replan cap (NO_CHANGE runaway guard)', () => {
  it('multiple NO_CHANGE replans are NOT prematurely blocked (the 3000 cap is a safety valve, not a throttle on real autonomous work)',
  // Each advanceMission does a real filesystem fingerprint + mutation dispatch. The
  // cap is MAX_PLAN_REVISIONS=3000 deliberately — legitimate long-horizon convergence
  // (Inquisitor / review loop) is thousands of revisions by design. A handful of
  // NO_CHANGE replans MUST keep REPLANNING, never falsely BLOCK at 30.
  async () => {
    const h = makeTestDb();
    const w = ws();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_replan', objective: 'no-change-loop' });
      addTicket(h.d, m.mission_id, { title: 'B1' });
      const deps: ControllerDeps = {
        d: h.d, runner: noChangeRunner(), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => w.dir,
        review: anyReview(),
        verifyMode: () => 'auto',
      };
      // Push 8 NO_CHANGE replans — FAR under the 3000 ceiling. The mission must keep
      // converging (REPLANNING), not trip the safety valve.
      for (let i = 0; i < 8; i++) {
        const r = await advanceMission(m.mission_id, deps)
        if (r.action === 'replan-exhausted-blocked') break
        if (r.action.includes('verified') || r.action.includes('no-runnable')) break
      }
      expect(getMission(h.d, m.mission_id)?.state).toBe('REPLANNING')
      expect(getMission(h.d, m.mission_id)?.state).not.toBe('BLOCKED_EXTERNAL')
    } finally { w.cleanup(); h.close(); }
  })

  it('a healthy CHANGED mutation is NOT blocked by the replan cap (no false positive)', async () => {
    const h = makeTestDb()
    const w = ws()
    try {
      const m = createMission(h.d, { workspace_id: 'ws_ok', objective: 'healthy' })
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' })
      const changed: MutationRunner = {
        transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
        async execute() { return { outcome: 'CHANGED', changedFiles: ['src/x.ts'], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: 'a', workspaceFingerprintAfter: 'b' } },
      }
      const deps: ControllerDeps = {
        d: h.d, runner: changed, mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => w.dir, review: anyReview(), verifyMode: () => 'auto',
      }
      const r = await advanceMission(m.mission_id, deps)
      // CHANGED does not trip the replan-exhausted guard.
      expect(r.action).not.toBe('replan-exhausted-blocked')
      expect(getTicket(h.d, b1.ticket_id)?.execution_state).not.toBe('BLOCKED')
    } finally { w.cleanup(); h.close() }
  })
})