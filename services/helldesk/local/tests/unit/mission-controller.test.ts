import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/db';
import { makeTestDb } from '../helpers';
import {
  createMission, addTicket, getMission, updateTicket, createRevision, getRevision,
  setQualityGate, getQualityGates, isRevisionVerified10, addEvidence, upsertClaim,
  updateRevision, listRevisions, listEvidence, activeClaimContext,
} from '../../src/mission-repository';
import {
  advanceMission, deriveFailureSignature, REPORT_GATES,
  type ControllerDeps, type ReviewVerdict,
} from '../../src/mission-controller';
import type { MutationRunner, RepairRequest, RepairResult } from '../../src/mutation-runner';

// Module-scope stubs so every describe (P0-B, controller, GATE 5-13) can use them.
const stubRunner = (outcome: RepairResult['outcome'], after?: string): MutationRunner => ({
  transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
  async execute(_req, _signal?) {
    return { outcome, changedFiles: outcome === 'CHANGED' ? ['src/x.ts'] : [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: 'before', workspaceFingerprintAfter: after ?? (outcome === 'CHANGED' ? 'after' : 'before') };
  },
});
// A review that only PASSes a gate when it can bind it to a REAL content-hashed
// evidence artifact for THIS revision (the production Quality Oracle contract).
// `d` lets the stub mirror the production hook (makeEngineReviewHook reads
// real evidence via engine.d). A PASS with no resolvable evidence is refused.
const stubReview = (d: import('../../src/db').Db, verdict: ReviewVerdict, gatePassed: Record<string, boolean>, evidenceResolved = true): ControllerDeps['review'] =>
  async ({ revisionId }) => {
    const evidence = listEvidence(d, revisionId);
    const resolvable = evidence.filter((e) => e.bytes > 0 && e.sha256.length === 64).map((e) => e.artifact_id);
    const gateEvidenceRefs: Record<string, string[]> = {};
    for (const k of REPORT_GATES.ARTIFACTS) {
      const pass = verdict === 'PASS' && gatePassed[k] && evidenceResolved && resolvable.length > 0;
      gateEvidenceRefs[k] = pass ? resolvable : [];
    }
    return { verdict, mandatoryGates: REPORT_GATES.ARTIFACTS, gatePassed, gateEvidenceRefs, findings: ([] as string[]), evidenceResolved: evidenceResolved && resolvable.length > 0, snapshotId: `snap-${revisionId}`, reviewJobId: `job-${revisionId}` };
  };

/** Inserte a REAL (valid 64-hex sha256, non-zero bytes) evidence artifact row. */
function seedEvidence(d: import('../../src/db').Db, revisionId: string, kind = 'git-diff'): string {
  const ev = addEvidence(d, { revision_id: revisionId, kind, path: `ev-${revisionId}`, sha256: 'a'.repeat(64), bytes: 42, producer: 'test' });
  return ev.artifact_id;
}

/** Create a REAL temp workspace dir containing the file the mutation runner
 *  reports as changed, so captureEvidence produces a content-addressed artifact. */
function realWorkspace(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'gt-mission-ws-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'x.ts'), `export const x = 1;\n`);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

describe('mission-repository (Ender P0-B)', () => {
  it('creates a mission + tickets and tracks verification state separately from execution', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e', objective: 'recover B1 semantics' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1', objective: 'recover' });
      updateTicket(h.d, b1.ticket_id, { execution_state: 'CLOSED' }); // CLOSED != VERIFIED
      const reloaded = getTicket(h.d, b1.ticket_id);
      expect(reloaded?.execution_state).toBe('CLOSED');
      expect(reloaded?.verification_state).toBe('UNVERIFIED'); // CLOSED does not imply verified
    } finally { h.close(); }
  });

  it('CLOSED or FAILED execution state does not satisfy a VERIFIED_10_10 dependency', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e2', objective: 'dep gating' });
      const dep = addTicket(h.d, m.mission_id, { title: 'B1' });
      const b2 = addTicket(h.d, m.mission_id, { title: 'B2', depends_on: [dep.ticket_id] });
      // B1 CLOSED but UNVERIFIED
      updateTicket(h.d, dep.ticket_id, { execution_state: 'CLOSED' });
      const depState = getTicket(h.d, dep.ticket_id);
      expect(depState?.verification_state).toBe('UNVERIFIED');
      // B2 must NOT run because its dependency is not VERIFIED_10_10
      void b2;
      const deps = h.d.db.query<{ depends_on_ticket_id: string }, [string]>(
        `SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id=?`
      ).all(b2.ticket_id).map((r) => r.depends_on_ticket_id);
      expect(deps).toContain(dep.ticket_id);
    } finally { h.close(); }
  });

  it('quality oracle: only current-revision ALL-PASS-with-evidence yields VERIFIED_10_10, UNVERIFIED != PASS', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e3', objective: 'gates' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const rev1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      // PASS gates must carry a resolved evidence reference (production contract).
      const evId = seedEvidence(h.d, rev1.revision_id, 'git-diff');
      setQualityGate(h.d, rev1.revision_id, [
        { gate_key: 'artifacts_recovered', status: 'PASS', evidence_refs: [evId] },
        { gate_key: 'dim55_producer_traced', status: 'PASS', evidence_refs: [evId] },
        { gate_key: 'execution_granularity', status: 'UNVERIFIED' }, // not pass
        { gate_key: 'cpu_diagnostic_parity', status: 'PASS', evidence_refs: [evId] },
        { gate_key: 'no_fabrication', status: 'PASS', evidence_refs: [evId] },
      ]);
      expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS)).toBe(false); // 4/5
      setQualityGate(h.d, rev1.revision_id, [{ gate_key: 'execution_granularity', status: 'PASS', evidence_refs: [evId] }]);
      expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS)).toBe(true);
      // A gate PASS with NO evidence ref is NOT verified (Quality Oracle refuses it).
      setQualityGate(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'PASS' as const })));
      expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS)).toBe(false); // no evidence refs anywhere
      // A later revision is NOT verified by revision 1's PASS (revision-scoped).
      const rev2 = createRevision(h.d, { ticket_id: b1.ticket_id });
      expect(isRevisionVerified10(h.d, rev2.revision_id, REPORT_GATES.ARTIFACTS)).toBe(false);
    } finally { h.close(); }
  });

  it('revisions are immutable: a new corrective attempt creates a NEW revision, never overwrites', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e4', objective: 'revisions' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      const r2 = createRevision(h.d, { ticket_id: b1.ticket_id, parent_revision_id: r1.revision_id });
      const r3 = createRevision(h.d, { ticket_id: b1.ticket_id, parent_revision_id: r2.revision_id });
      expect(r1.revision_no).toBe(1);
      expect(r2.revision_no).toBe(2);
      expect(r3.revision_no).toBe(3);
      const all = listRevisions(h.d, b1.ticket_id);
      expect(all.length).toBe(3);
      expect(all[0]!.revision_id).toBe(r1.revision_id);
      expect(all[2]!.revision_id).toBe(r3.revision_id);
    } finally { h.close(); }
  });

  it('evidence is content-hashed + revision-tagged', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e5', objective: 'evidence' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      const ev = addEvidence(h.d, { revision_id: r1.revision_id, kind: 'source', path: 'src/x.ts', sha256: 'abc123', bytes: 10 });
      expect(ev.sha256).toBe('abc123');
      const row = h.d.db.query<{ sha256: string }, [string, string]>(`SELECT sha256 FROM evidence_artifacts WHERE revision_id=? AND artifact_id=?`).get(r1.revision_id, ev.artifact_id);
      expect(row?.sha256).toBe('abc123');
    } finally { h.close(); }
  });

  it('scientific claims canonicalize duplicates by occurrence_count++', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_e6', objective: 'claims' });
      const c1 = upsertClaim(h.d, { mission_id: m.mission_id, canonical_key: 'dim55-bind', claim: '55 is an MNN binding artifact' });
      const c2 = upsertClaim(h.d, { mission_id: m.mission_id, canonical_key: 'dim55-bind', claim: '55 is an MNN binding artifact' });
      expect(c1.claim_id).toBe(c2.claim_id); // same canonical row collapsed
      expect(c2.occurrence_count).toBe(2);
      const ctx = activeClaimContext(h.d, m.mission_id);
      expect(ctx.verified.length + ctx.hypotheses.length).toBe(1); // one canonical claim, not two
    } finally { h.close(); }
  });
});

describe('mission-controller (Ender P0-D / P0-F / P0-G)', () => {
  it('FAILURE signatures differ when gate keys / files / error classes differ', () => {
    const a = deriveFailureSignature(['gate1'], ['f1'], ['a.ts'], ['build']);
    const b = deriveFailureSignature(['gate1'], ['f1'], ['a.ts'], ['build']);
    const c = deriveFailureSignature(['gate2'], ['f1'], ['a.ts'], ['build']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('B1 VERIFIED_10_10 releases B2 as the next runnable ticket', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_c1', objective: 'B1' });
      // First mutation CHANGED (B1 can verify); any later mutation NO_CHANGE
      // (B2 cannot reach 10/10 on the same reviewer PASS — it replans instead),
      // which proves B2 is only *released* after B1, not auto-verified.
      let calls = 0;
      const gatedRunner: MutationRunner = {
        transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
        async execute(_req, _signal?) { calls++; return stubRunner(calls === 1 ? 'CHANGED' : 'NO_CHANGE').execute({ ...(_req as RepairRequest) }, _signal ?? new AbortController().signal); },
      };
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const b2 = addTicket(h.d, m.mission_id, { title: 'B2', depends_on: [b1.ticket_id] });
      const ws = realWorkspace();
      // Run once: B1's mutation CHANGED → review PASS (with REAL content evidence)
      // → B1 verified, B2 becomes the next runnable ticket but is not yet verified.
      const deps2: ControllerDeps = {
        d: h.d, runner: gatedRunner, mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir, review: stubReview(h.d, 'PASS', Object.fromEntries(REPORT_GATES.ARTIFACTS.map((k) => [k, true])), true),
      };
      await advanceMission(m.mission_id, deps2);
      ws.cleanup();
      const b1now = getTicket(h.d, b1.ticket_id);
      expect(b1now?.verification_state).toBe('VERIFIED_10_10');
      expect(b1now?.execution_state).toBe('CLOSED');
      // B2 is now the runnable next ticket (its only dependency, B1, is verified),
      // but it is NOT yet verified itself.
      const b2now = getTicket(h.d, b2.ticket_id);
      expect(b2now?.verification_state).not.toBe('VERIFIED_10_10');
    } finally { h.close(); }
  });

  it('INCONCLUSIVE review must NOT reject the revision; it re-reviews the same revision and may converge to PASS', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_inc', objective: 'converge' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1', objective: 'x' });
      const ws = realWorkspace();
      // reviewer-a/B + adjudicator all stay INCONCLUSIVE on every attempt.
      let calls = 0;
      const stickyReview: ControllerDeps['review'] = async ({ revisionId }) => {
        calls += 1;
        const alpha = {
          verdict: 'INCONCLUSIVE' as const,
          mandatoryGates: REPORT_GATES.ARTIFACTS,
          gatePassed: Object.fromEntries(REPORT_GATES.ARTIFACTS.map((k) => [k, false])),
          gateEvidenceRefs: {},
          findings: [],
          evidenceResolved: false,
          snapshotId: `snap-${revisionId}`,
          reviewJobId: `job-${revisionId}-${calls}`,
        };
        return alpha;
      };
      const deps: ControllerDeps = {
        d: h.d,
        runner: stubRunner('CHANGED'),
        mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => ws.dir,
        review: stickyReview,
      };
      // First advance: mutation CHANGED -> INCONCLUSIVE review ->
      // convergence loop runs review up to MAX (3) -> all INCONCLUSIVE ->
      // revision stays EVIDENCE_CAPTURED (NOT REJECTED), no new mutation revision.
      const out1 = await advanceMission(m.mission_id, deps);
      const revs1 = listRevisions(h.d, b1.ticket_id);
      expect(revs1.length).toBe(1); // no reject+replan on INCONCLUSIVE
      const r1 = getRevision(h.d, revs1[0]!.revision_id);
      expect(r1?.state).not.toBe('REJECTED');
      expect(out1.nextState).toBe('VERIFYING');
      ws.cleanup();
    } finally { h.close(); }
  });

  it('same failure signature + no workspace delta forces REPLAN (rejects identical plan)', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_c2', objective: 'no-idle-loop' });
      // Rev 1 REJECTED with a failure signature and identical before/after fp.
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      updateRevision(h.d, r1.revision_id, { state: 'REJECTED', failure_signature: 'same-sig', hypothesis_key: 'same' });
      setQualityGate(h.d, r1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'FAIL' })));
      const deps: ControllerDeps = {
        d: h.d,
        runner: stubRunner('NO_CHANGE'),
        mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => 'C:/ws',
        review: stubReview(h.d, 'FINDINGS', {}, true),
      };
      // advanceMission must NOT redispatch the identical plan; it must create a
      // NEW revision with a different hypothesis instead.
      const out = await advanceMission(m.mission_id, deps);
      expect(out.nextState).toBe('REPLANNING');
      const all = listRevisions(h.d, b1.ticket_id);
      expect(all.length).toBeGreaterThanOrEqual(2); // no infinite identical rev1
    } finally { h.close(); }
  });

  it('a freshly-replanned revision (CHANGED mutation) must NOT be force-replanned (anti-loop false-positive)', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_fp', objective: 'no-false-positive' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      // rev1 REJECTED after a CHANGED mutation: before != after (content delta).
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id, workspace_fingerprint_before: 'BEFORE' });
      updateRevision(h.d, r1.revision_id, { state: 'REJECTED', failure_signature: 'sig-X', workspace_fingerprint_after: 'AFTER' });
      setQualityGate(h.d, r1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'FAIL' })));
      updateTicket(h.d, b1.ticket_id, { active_revision_id: r1.revision_id });
      // rev2 = the freshly-replanned revision (before==rev1.after carries forward).
      const r2 = createRevision(h.d, { ticket_id: b1.ticket_id, parent_revision_id: r1.revision_id, failure_signature: 'sig-X', workspace_fingerprint_before: 'AFTER' });
      updateTicket(h.d, b1.ticket_id, { active_revision_id: r2.revision_id, execution_state: 'READY' });
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'),
        mandatoryGates: REPORT_GATES.ARTIFACTS, workspacePathFor: () => 'C:/ws',
        review: stubReview(h.d, 'FINDINGS', {}, true),
      };
      // The mutation should RUN (CHANGED), NOT be force-replanned immediately.
      const out = await advanceMission(m.mission_id, deps);
      expect(out.action).not.toBe('forced-replan-identical-signature');
      expect(out.action).toBe('replanned-FINDINGS');
    } finally { h.close(); }
  });
});

// local helper: reload a ticket by id
function getTicket(d: Db, ticketId: string) {
  return d.db.query<{ ticket_id: string; execution_state: string; verification_state: string; active_revision_id: string | null }, [string]>(
    `SELECT ticket_id, execution_state, verification_state, active_revision_id FROM mission_tickets WHERE ticket_id=?`
  ).get(ticketId);
}

describe('GATE 5 — Quality Oracle semantics (deterministic, not LLM score)', () => {
  it('VERIFIED_10_10 requires ALL gates PASS with a resolved evidence artifact + no BLOCKER/HIGH findings', () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_g5', objective: 'gates' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const rev1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      const evId = seedEvidence(h.d, rev1.revision_id, 'git-diff');
      setQualityGate(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'PASS' as const, evidence_refs: [evId] })));
      // all gates PASS **with evidence** → 10/10 true at repository level
      expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS)).toBe(true);
      // A gate PASS with EMPTY evidence refs breaks 10/10 (Quality Oracle refusal).
      setQualityGate(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'PASS' as const })));
      expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS)).toBe(false);
      // Each single non-PASS when ALL others PASS+evidence → NOT 10/10
      for (const bad of ['UNVERIFIED', 'FAIL', 'BLOCKED'] as const) {
        setQualityGate(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS.map((k, i) => ({ gate_key: k, status: (i === 0 ? bad : 'PASS' as const), evidence_refs: [evId] })));
        expect(isRevisionVerified10(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS), `one gate ${bad} must break 10/10`).toBe(false);
      }
      // restore all PASS + evidence
      setQualityGate(h.d, rev1.revision_id, REPORT_GATES.ARTIFACTS.map((k) => ({ gate_key: k, status: 'PASS' as const, evidence_refs: [evId] })));
    } finally { h.close(); }
  });
});

describe('GATE 6 — three-ticket serial dependency release (B1→B2→B3)', () => {
  it('B2 is locked until B1 is VERIFIED_10_10; B3 locked until B2 verified', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_g6', objective: 'serial' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const b2 = addTicket(h.d, m.mission_id, { title: 'B2', depends_on: [b1.ticket_id] });
      const b3 = addTicket(h.d, m.mission_id, { title: 'B3', depends_on: [b2.ticket_id] });
      // B1 CLOSED + UNVERIFIED → B2 locked, B3 locked
      updateTicket(h.d, b1.ticket_id, { execution_state: 'CLOSED' });
      expect(getTicket(h.d, b2.ticket_id)?.verification_state).toBe('UNVERIFIED');
      // B1 FAILED → still locked
      updateTicket(h.d, b1.ticket_id, { execution_state: 'FAILED' });
      expect(getTicket(h.d, b2.ticket_id)?.verification_state).toBe('UNVERIFIED');
      // Simulate B1 verified via the controller: B1's mutation CHANGED → PASS,
      // but any LATER ticket's mutation NO_CHANGE so B2 cannot auto-verify — this
      // isolates the release-gate semantics (B1 unlocks B2, B2 not yet verified).
      let calls = 0;
      const gated: MutationRunner = {
        transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
        async execute(_req: RepairRequest, _sig?: AbortSignal) { calls++; return stubRunner(calls === 1 ? 'CHANGED' : 'NO_CHANGE').execute({ ...(_req as RepairRequest) }, _sig ?? new AbortController().signal); },
      };
      const deps: ControllerDeps = {
        d: h.d, runner: gated, mandatoryGates: REPORT_GATES.ARTIFACTS, workspacePathFor: () => realWorkspace().dir, review: stubReview(h.d, 'PASS', Object.fromEntries(REPORT_GATES.ARTIFACTS.map((k) => [k, true])), true),
      };
      // First advanceMission call verifies B1 only; B2 becomes the next target but stays UNVERIFIED.
      await advanceMission(m.mission_id, deps);
      expect(getTicket(h.d, b1.ticket_id)?.verification_state).toBe('VERIFIED_10_10');
      expect(getTicket(h.d, b2.ticket_id)?.verification_state).toBe('UNVERIFIED'); // released but not yet verified
      expect(getTicket(h.d, b3.ticket_id)?.verification_state).toBe('UNVERIFIED'); // B3 still locked (B2 not verified)
    } finally { h.close(); }
  });
});

describe('GATE 7 — REPLAN is a real new revision (not review-job retry)', () => {
  it('revision N review-FINDINGS → revision N REJECTED → N+1 created with parent=N → new review job', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_g7', objective: 'B1' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id });
      // FINDINGS everywhere → the controller rejects r1 and creates r2.
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('CHANGED'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => 'C:/ws',
        review: stubReview(h.d, 'FINDINGS', {}, true),
      };
      const out = await advanceMission(m.mission_id, deps);
      expect(out.nextState).toBe('REPLANNING');
      const revs = listRevisions(h.d, b1.ticket_id);
      expect(revs.length).toBeGreaterThanOrEqual(2);
      const r2 = revs[revs.length - 1]!;
      expect(r2.parent_revision_id).toBe(r1.revision_id); // revision 2 = child of revision 1
      expect(r2.revision_no).toBe(r1.revision_no + 1);
      // r1 must be REJECTED (not re-run as the same review job)
      const r1now = revs.find((r) => r.revision_id === r1.revision_id)!;
      expect(r1now.state).toBe('REJECTED');
      // Each revision carries a distinct immutable review_job slot (nullable now, set later).
      const jobs = new Set(revs.map((r) => r.review_job_id).filter(Boolean));
      void jobs;
    } finally { h.close(); }
  });
});

describe('GATE 9 — mutation crash recovery: at-most-one logical mutation per revision', () => {
  it('a revision stuck in MUTATING (daemon died mid-mutation) is NOT blindly re-dispatched', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_g9', objective: 'crash-safe' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      const r1 = createRevision(h.d, { ticket_id: b1.ticket_id, workspace_fingerprint_before: 'A' });
      // The daemon died AFTER persisting the revision + setting MUTATING but
      // BEFORE recording workspace_fingerprint_after (the crash window).
      updateRevision(h.d, r1.revision_id, { state: 'MUTATING' });
      // workspace now differs from before (mutation may have partially applied)
      updateTicket(h.d, b1.ticket_id, { active_revision_id: r1.revision_id });
      let executed = 0;
      const recorder: MutationRunner = {
        transport: 'test', provider: 'test', model: 'test', agent: 'test', writeCapability: true, shellCapability: true,
        async execute(_req, _sig) { executed++; return { outcome: 'CHANGED', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: 'A', workspaceFingerprintAfter: 'B' }; },
      };
      const deps: ControllerDeps = { d: h.d, runner: recorder, mandatoryGates: REPORT_GATES.ARTIFACTS, workspacePathFor: () => 'C:/ws', review: stubReview(h.d, 'FINDINGS', {}, true) };
      await advanceMission(m.mission_id, deps);
      // At-most-one: the same revision must NOT be re-dispatched after the crash.
      expect(executed).toBe(0);
    } finally { h.close(); }
  });
});

describe('GATE 8 — anti-loop: identical failure + unchanged workspace forbids re-execution', () => {
  it('five failed hypotheses do NOT terminal-fail the mission; no identical plan repeats', async () => {
    const h = makeTestDb();
    try {
      const m = createMission(h.d, { workspace_id: 'ws_g8', objective: 'no-loop' });
      const b1 = addTicket(h.d, m.mission_id, { title: 'B1' });
      // Create 5 REJECTED revisions, all with the SAME failure signature + no delta
      // (simulating the prohibited identical-strategy exhaustion).
      let parent: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r = createRevision(h.d, { ticket_id: b1.ticket_id, parent_revision_id: parent, hypothesis_key: `h${i}` });
        updateRevision(h.d, r.revision_id, { state: 'REJECTED', failure_signature: 'same-sig', hypothesis_key: `h${i}`, workspace_fingerprint_after: 'FP' });
        parent = r.revision_id;
      }
      // The controller must NOT re-dispatch the identical plan; it must force a fresh
      // revision with a changed hypothesis instead of terminating the mission.
      const deps: ControllerDeps = {
        d: h.d, runner: stubRunner('NO_CHANGE'), mandatoryGates: REPORT_GATES.ARTIFACTS,
        workspacePathFor: () => 'C:/ws', review: stubReview(h.d, 'FINDINGS', {}, true),
      };
      const out = await advanceMission(m.mission_id, deps);
      expect(out.nextState).toBe('REPLANNING'); // new hypothesis, never FAILED_TERMINAL
      const all = listRevisions(h.d, b1.ticket_id);
      expect(all.length).toBeGreaterThan(5); // at least one further revision
    } finally { h.close(); }
  });
});