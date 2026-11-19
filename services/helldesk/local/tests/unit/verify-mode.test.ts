import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from '../helpers';
import {
  createMission, addTicket, getTicket, getMission, getRevision,
} from '../../src/mission-repository';
import {
  advanceMission, verifyPendingVerify, REPORT_GATES,
  type ControllerDeps, type ReviewVerdict,
} from '../../src/mission-controller';
import type { MutationRunner, RepairResult } from '../../src/mutation-runner';

// ── Reusable stubs (mirror mission-controller.test.ts conventions) ───────────
const stubRunner = (outcome: RepairResult['outcome'], after?: string): MutationRunner => ({
  transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
  async execute() {
    return { outcome, changedFiles: outcome === 'CHANGED' ? ['src/x.ts'] : [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: 'before', workspaceFingerprintAfter: after ?? (outcome === 'CHANGED' ? 'after' : 'before') };
  },
});
const stubReview = (verdict: ReviewVerdict): ControllerDeps['review'] =>
  async ({ revisionId }) => ({
    verdict, mandatoryGates: REPORT_GATES.ARTIFACTS,
    gatePassed: Object.fromEntries(REPORT_GATES.ARTIFACTS.map((k) => [k, true])),
    gateEvidenceRefs: Object.fromEntries(REPORT_GATES.ARTIFACTS.map((k) => [k, []])),
    findings: [] as string[],
    evidenceResolved: false,
    snapshotId: `snap-${revisionId}`,
    reviewJobId: `job-${revisionId}`,
  });
function realWorkspace(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-vmode-ws-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'x.ts'), `export const x = 1;\n`);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

describe('verifyMode (WAR-mode deferred verification)', () => {
  it('deferred: a completed revision is parked PENDING_VERIFY, not reviewed; next ticket still advances', async () => {
    const h = makeTestDb();
    let reviews = 0;
    try {
      const m = createMission(h.d, { workspace_id: 'ws_v1', objective: 'deliver-many' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const b2 = addTicket(h.d, m.mission_id, { title: 'B2' });
      const ws = realWorkspace();
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir,
        review: async (req) => { reviews++; return stubReview('PASS')(req); },
        verifyMode: () => 'deferred',
      };
      await advanceMission(m.mission_id, deps);
      // B1's revision should be parked PENDING_VERIFY (NOT verified, NOT reviewed).
      const b1now = getTicket(h.d, b1.ticket_id);
      expect(b1now?.verification_state).toBe('PENDING_VERIFY');
      // The mission must NOT have run review yet (deferred)…
      expect(reviews).toBe(0);
      // …and must NOT be BLOCKED — B2 is still independently runnable.
      const mnow = getMission(h.d, m.mission_id);
      expect(mnow?.state).not.toBe('BLOCKED_EXTERNAL');
      ws.cleanup();
    } finally { h.close(); }
  });

  it('deferred all-pending: mission stays ACTIVE (not BLOCKED) once every ticket is parked', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_v2', objective: 'all-pending' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const ws = realWorkspace();
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir,
        review: stubReview('PASS'),
        verifyMode: () => 'deferred',
      };
      // First tick: B1 mutates -> parked PENDING_VERIFY.
      await advanceMission(m.mission_id, deps);
      // Second tick: B1 is now PENDING_VERIFY (not a dispatch target); the mission
      // has no other runnable ticket. It must NOT be falsely BLOCKED_EXTERNAL.
      const again = await advanceMission(m.mission_id, deps);
      expect(again.action).toBe('deferred-all-pending-verify');
      // The mission must NOT be falsely BLOCKED_EXTERNAL, and its ticket stays parked.
      expect(getMission(h.d, m.mission_id)?.state).not.toBe('BLOCKED_EXTERNAL');
      expect(getMission(h.d, m.mission_id)?.state).not.toBe('VERIFIED_10_10');
      expect(getTicket(h.d, b1.ticket_id)?.verification_state).toBe('PENDING_VERIFY');
      ws.cleanup();
    } finally { h.close(); }
  });

  it('verifyPendingVerify un-parks the batch for the ordinary review path', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_v3', objective: 'sweep' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const b2 = addTicket(h.d, m.mission_id, { title: 'B2' });
      const ws = realWorkspace();
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir, review: stubReview('PASS'),
        verifyMode: () => 'deferred',
      };
      // Park B1 and B2.
      await advanceMission(m.mission_id, deps);
      await advanceMission(m.mission_id, deps);
      expect(getTicket(h.d, b1.ticket_id)?.verification_state).toBe('PENDING_VERIFY');
      expect(getTicket(h.d, b2.ticket_id)?.verification_state).toBe('PENDING_VERIFY');
      // Sweep (operator "run tests now").
      const sweep = verifyPendingVerify(h.d, m.mission_id);
      expect(sweep.count).toBe(2);
      // Now with auto verifyMode the reviewers would run; just assert the park is
      // released (EVIDENCE_CAPTURED revisions exist again, tickets VERIFYING).
      const b1rev = getRevision(h.d, getTicket(h.d, b1.ticket_id)!.active_revision_id ?? '');
      const b2rev = getRevision(h.d, getTicket(h.d, b2.ticket_id)!.active_revision_id ?? '');
      expect(b1rev?.state).toBe('EVIDENCE_CAPTURED');
      expect(b2rev?.state).toBe('EVIDENCE_CAPTURED');
      expect(getTicket(h.d, b1.ticket_id)?.verification_state).toBe('VERIFYING');
      expect(getTicket(h.d, b2.ticket_id)?.verification_state).toBe('VERIFYING');
      ws.cleanup();
    } finally { h.close(); }
  });

  it('auto (default / absent verifyMode) preserves the always-review loop', async () => {
    const h = makeTestDb();
    let reviews = 0;
    try {
      const m = createMission(h.d, { workspace_id: 'ws_v4', objective: 'auto' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const ws = realWorkspace();
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir,
        // no verifyMode getter => defaults to auto
        review: async (req) => { reviews++; return stubReview('PASS')(req); },
      };
      await advanceMission(m.mission_id, deps);
      // In auto mode the review runs; the revision is NOT parked PENDING_VERIFY.
      const b1rev = getRevision(h.d, getTicket(h.d, b1.ticket_id)!.active_revision_id ?? '');
      expect(b1rev?.state).not.toBe('PENDING_VERIFY');
      ws.cleanup();
    } finally { h.close(); }
  });
});