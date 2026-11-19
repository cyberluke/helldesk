import type { Db } from './db';
import {
  getMission, listTickets, getTicket, getDependencies,
  updateMissionState, updateTicket, createRevision, getRevision, updateRevision,
  listRevisions, setQualityGate, getQualityGates, isRevisionVerified10,
  addEvidence, hashFileContent, setRepairPlan,
  upsertClaim, activeClaimContext, emitMissionEvent,
  type MissionState, type RevisionState, type GateStatus,
} from './mission-repository';
import type { MutationRunner, RepairResult } from './mutation-runner';
import { changedFilesSinceFull, fingerprintWorkspace } from './mutation-runner';
import { acquireLease, releaseLease, renewLease, reclaimStaleLease } from './reconciler';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendTranscript } from './job-transcript';

/**
 * Mission Controller — the durable `advanceMission` driver (Ender loop P0-B/P0-D).
 *
 * Implements the Phase-8 pseudo-flow as a durable, idempotent operation:
 *
 *   mission terminal ? return
 *   ticket = first whose mandatory deps are VERIFIED_10_10 and itself is not
 *   if none: mission VERIFIED_10_10 or BLOCKED_EXTERNAL; return
 *   if ticket has no active revision: plan + create revision
 *   maybe recover a stuck revision (crash) — never leave it stranded
 *   dispatch mutation
 *     FAILED_TRANSIENT      -> revision back to PLANNED (bounded retry), NOT stranded
 *     FAILED_PLAN/NO_CHANGE -> mark hypothesis failed, REPLAN + real repair_plan, new revision
 *     BLOCKED_EXTERNAL      -> persist blocker, mission BLOCKED_EXTERNAL
 *     CHANGED               -> capture content evidence + immutable snapshot, create review, run
 *                              ExcellenceGovernor, require per-gate resolved evidence, update gates
 *   if VERIFIED_10_10 (all gates PASS **with evidence**) -> release next ticket
 *   else                    -> revision REJECTED, failure_signature, real REPLAN +
 *                              structured repair_plan (feeds prior findings/gates forward)
 *
 * Every irreversible boundary is persisted BEFORE the next async dispatch, so
 * daemon death at any point is resumable (Phase 18).
 *
 * IMPORTANT: the controller NEVER lets a mutation worker self-verify. The
 * ExcellenceGovernor/Quality Oracle are the ONLY authority for VERIFIED_10_10, and a gate
 * only PASSes with a resolved content-addressed evidence reference (Phase 14).
 */

export type ReviewVerdict = 'PASS' | 'FINDINGS' | 'INCONCLUSIVE';

export interface ReviewHook {
  /** Run the AC independent ExcellenceGovernor over one immutable revision; return the
   *  persisted review result (job + snapshot + findings, per-gate resolved
   *  evidence). Production wiring supplies this via the real Engine pipeline
   *  (`makeEngineReviewHook`). Must refer to the EXACT revision + its snapshot +
   *  review job, and resolve every evidence reference to content. */
  (info: { missionId: string; ticketId: string; revisionId: string; workspacePath: string }): Promise<{
    verdict: ReviewVerdict;
    mandatoryGates: string[];
    gatePassed: Record<string, boolean>;
    /** Per-gate evidence artifact IDs the review actually resolved (content). */
    gateEvidenceRefs: Record<string, string[]>;
    findings: string[];
    evidenceResolved: boolean;
    snapshotId: string | null;
    reviewJobId: string | null;
  }>;
}

export interface ControllerDeps {
  d: Db;
  runner: MutationRunner;
  /** Provider-agnostic per-mission engine resolver: given a mission id, return
   *  the MutationRunner whose engine comes from the mission's engine_matrix_json
   *  (falling back to `runner` when the mission has no matrix override). Lets a
   *  task pin e.g. codex for MUTATION while another task uses kilo. */
  runnerFor?: (missionId: string) => MutationRunner;
  /** Mandatory gate keys a ticket must PASS for VERIFIED_10_10. Per-ticket optional. */
  mandatoryGates?: string[];
  /** Task-specific acceptance gates for THIS mission/ticket (e.g. a divide-by-zero
   *  mission should verify `zero_division_contract`, `coercion_semantics`,
   *  `boundary_tests`, NOT the turbine-diagnostic default REPORT_GATES.ARTIFACTS).
   *  When present, supersedes both mandatoryGates and the turbine default. */
  taskGates?: string[];
  /** absolute path to the writable workspace for this mission. */
  workspacePathFor: (missionId: string) => string;
  review: ReviewHook;
  /** WAR-mode verification policy. When a getter returns 'deferred' (or when this
   *  is absent, treated as 'auto'), the controller SKIPS the per-revision review
   *  on a completed revision and instead stamps it PENDING_VERIFY so the mission
   *  keeps advancing; a later `verifyPending` sweep drives the queued batch through
   *  the real gates. Absent => 'auto' preserves the historic always-review loop. */
  verifyMode?: () => 'auto' | 'deferred';
}

/** Normalize a failure signature so conservative scientific REPLAN is forced
 *  when both the signature and the workspace fingerprint are unchanged. */
export function deriveFailureSignature(
  failedGateKeys: string[],
  findingKeys: string[],
  changedFiles: string[],
  errorClasses: string[],
): string {
  const parts: string[] = [
    JSON.stringify([...failedGateKeys].sort()),
    JSON.stringify([...findingKeys].sort()),
    JSON.stringify([...changedFiles].sort()),
    JSON.stringify([...errorClasses].sort()),
  ];
  return parts.join('|');
}

/** Copy a mission's ABORT/recovery policy: how many transient mutation attempts
 *  before a revision is rejected (not stranded). Default 3. */
const MAX_TRANSIENT_ATTEMPTS = 3;
/** How many INCONCLUSIVE re-reviews of the SAME revision before we reject + replan
 *  instead of deadlocking on a mutation the reviewer persistently cannot validate. */
const MAX_INCONCLUSIVE_REVISIONS = 3;
/** Mission-level review convergence: how many times to re-review the SAME
 *  immutable revision/snapshot when the verdict is INCONCLUSIVE. A valid PASS or
 *  FINDINGS is accepted immediately; only epistemically-invalid (INCONCLUSIVE)
 *  verdicts trigger a bounded re-review. Default 3. */
const MAX_CONVERGENT_REVIEW_ATTEMPTS = 3;

/** The single durable controller operation. May be called on every scheduler tick.
 *  Returns a human-readable action for observability. Idempotency is enforced by
 *  (a) only a PLANNED/REJECTED revision is ever dispatched, (b) a stuck revision
 *  is reconciled (recovered) BEFORE a fresh mutation is allowed, and (c) a
 *  transient failure returns the revision to PLANNED (bounded retries) instead of
 *  stranding it in MUTATING. */
export async function advanceMission(missionId: string, deps: ControllerDeps): Promise<{ action: string; nextState: MissionState }> {
  const { d, runner, review, runnerFor } = deps;
  const mission = getMission(d, missionId);
  if (!mission) return { action: 'no-mission', nextState: 'CANCELLED' };
  const terminal: MissionState[] = ['VERIFIED_10_10', 'BLOCKED_EXTERNAL', 'CANCELLED'];
  if (terminal.includes(mission.state)) return { action: 'terminal', nextState: mission.state };

  // Task-specific acceptance gates take precedence; fall back to per-ticket
  // mandatoryGates, then the turbine-diagnostic default. A divide-by-zero mission
  // must NEVER be judged by turbine gates (apple vs. turbine diagnostics).
  const mandatory = deps.taskGates?.length ? deps.taskGates : deps.mandatoryGates ?? REPORT_GATES.ARTIFACTS;

  // ── 1. select next ticket whose mandatory deps are VERIFIED_10_10 and itself is not
  const tickets = listTickets(d, missionId);
  // A PENDING_VERIFY ticket has a completed revision awaiting the verify sweep — it
  // is NOT a dispatch target (we must not re-mutate it), but it still gates its
  // dependents until swept. Independent neighboring tickets keep flowing.
  const target = tickets.find((b) => {
    if (b.verification_state === 'VERIFIED_10_10' || b.verification_state === 'PENDING_VERIFY') return false;
    const depTickets = getDependencies(d, b.ticket_id)
      .map((id) => getTicket(d, id))
      .filter((x): x is NonNullable<typeof x> => Boolean(x));
    return depTickets.every((x) => x.verification_state === 'VERIFIED_10_10');
  });
  if (!target) {
    if (tickets.length && tickets.every((b) => b.verification_state === 'VERIFIED_10_10')) {
      updateMissionState(d, missionId, 'VERIFIED_10_10', { verified_at: new Date().toISOString() });
      emitMissionEvent(d, 'mission.verified', { mission_id: missionId });
      return { action: 'mission-verified-10-10', nextState: 'VERIFIED_10_10' };
    }
    // WAR-mode: if every remaining non-verified ticket is PENDING_VERIFY, the mission
    // is NOT externally blocked and NOT deadlocked — it is waiting on the verify
    // sweep. Stay ACTIVE (idempotent) so the operator's `verify-pending` can drive
    // the batch; do not falsely mark BLOCKED_EXTERNAL.
    if (tickets.length && tickets.every((b) => b.verification_state === 'VERIFIED_10_10' || b.verification_state === 'PENDING_VERIFY')) {
      return { action: 'deferred-all-pending-verify', nextState: mission.state };
    }
    // A real DAG deadlock (missing mandatory dep, cyclic) is NOT an external
    // blocker. Surface it honestly as BLOCKED with a precise reason so it is
    // never mistaken for "waiting on an external system".
    updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: 'no runnable ticket: dependency graph unsatisfiable (cycles or missing mandatory dependency)' });
    return { action: 'no-runnable-ticket', nextState: 'BLOCKED_EXTERNAL' };
  }
  mission.current_ticket_id = target.ticket_id;
  updateMissionState(d, missionId, 'ACTIVE', { current_ticket_id: target.ticket_id });

  // ── 2. ensure an active revision exists
  const revisions = listRevisions(d, target.ticket_id);
  const active = getRevision(d, target.active_revision_id ?? '') ?? revisions[revisions.length - 1];
  let current: NonNullable<ReturnType<typeof getRevision>>;
  if (!active) {
    // create initial plan + revision
    updateMissionState(d, missionId, 'PLANNING');
    const created = createRevision(d, { ticket_id: target.ticket_id, workspace_fingerprint_before: await fingerprintOrEmpty(deps.workspacePathFor(missionId)) });
    updateTicket(d, target.ticket_id, { execution_state: 'READY', active_revision_id: created.revision_id });
    current = created;
  } else {
    current = active;
  }

  // ── 3. recover a STUCK revision (daemon died mid-mutation / mid-review).
  //    Never strand a crash window forever (P0 liveness). At-most-once is kept:
  //    a revision whose workspace was NOT changed is reset to PLANNED (clean
  //    redispatch is safe — nothing applied); a revision whose workspace WAS
  //    partially/totally changed proceeds directly to evidence capture + review
  //    WITHOUT re-running the mutation.
  if (current.state === 'MUTATING' || current.state === 'EVIDENCE_CAPTURED' || current.state === 'VERIFYING') {
    const ws = deps.workspacePathFor(missionId);
    const after = current.workspace_fingerprint_after || await fingerprintOrEmpty(ws);
    if (current.state === 'MUTATING' && current.workspace_fingerprint_after == null) {
      // Daemon died during the mutation with a null after-fingerprint. The mutation
      // child may have (a) never touched the workspace (clean -> safe to redispatch
      // the PLAN from scratch), or (b) made PARTIAL/UNCOMPLETED edits then died
      // (dirty workspace with real file deltas -> that is a changed revision and must
      // NOT be stranded in MUTATING, nor throw away the partial work). Recover both:
      //   clean -> PLANNED (redispatch later)
      //   dirty -> EVIDENCE_CAPTURED with content evidence (re-drive review on a
      //            LATER tick — never re-execute this revision's mutation).
      const fpNow = await fingerprintOrEmpty(ws);
      if (fpNow === (current.workspace_fingerprint_before || '')) {
        updateRevision(d, current.revision_id, { state: 'PLANNED', workspace_fingerprint_after: undefined });
        emitMissionEvent(d, 'revision.recovered', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, to: 'PLANNED' });
        current = getRevision(d, current.revision_id)!;
      } else if (ws) {
        // Partial/unfinished mutation left real deltas in the workspace. Do not lose
        // them and do not strand MUTATING: promote to EVIDENCE_CAPTURED so a later
        // step-4a re-review pass drives a verdict on the actual delta. The changed-
        // file set is the current git working-tree delta (committed + dirty) vs HEAD,
        // since no clean pre-mutation ref is persisted when after was never stamped.
        // AT-MOST-ONE (GATE 9): this revision's mutation already ran (crash window);
        // we MUST return here and let a subsequent advanceMission re-review it, so the
        // mutation runner is never invoked again for this revision.
        const changed = changedFilesSinceFull(ws, 'HEAD');
        for (const f of changed) captureEvidence(d, current.revision_id, 'source', f, ws);
        updateRevision(d, current.revision_id, { state: 'EVIDENCE_CAPTURED' });
        updateMissionState(d, missionId, 'VERIFYING');
        emitMissionEvent(d, 'revision.recovered', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, to: 'EVIDENCE_CAPTURED', changed: changed.length });
        current = getRevision(d, current.revision_id)!;
        return { action: 'revision-recovered-to-review', nextState: 'VERIFYING' };
      }
    } else if (current.state === 'MUTATING' && current.workspace_fingerprint_after != null) {
      // The mutation COMPLETED and produced a real delta (workspace_fingerprint_after
      // is already persisted), but the daemon died BEFORE the transition to
      // evidence capture + review. Per the recovery doctrine above, a revision
      // whose workspace WAS changed must proceed to evidence capture + review —
      // never strand it in MUTATING forever. Promote it to EVIDENCE_CAPTURED and
      // hand off to a later step-4a re-review pass (AT-MOST-ONE: never re-run the
      // mutation for this revision).
      const changed = ws ? changedFilesSinceFull(ws, 'HEAD^') : [];
      for (const f of changed) captureEvidence(d, current.revision_id, 'source', f, ws);
      updateRevision(d, current.revision_id, { state: 'EVIDENCE_CAPTURED' });
      updateMissionState(d, missionId, 'VERIFYING');
      emitMissionEvent(d, 'revision.recovered', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, to: 'EVIDENCE_CAPTURED', changed: changed.length });
      current = getRevision(d, current.revision_id)!;
      return { action: 'revision-recovered-to-review', nextState: 'VERIFYING' };
    }
    void after;
  }

  // ── 4a. RE-REVIEW a stuck EVIDENCE_CAPTURED/VERIFYING revision whose previous
  //  review ended INCONCLUSIVE/terminal-nonpass. The dispatch guard below would
  //  otherwise bail forever (`revision-EVIDENCE_CAPTURED-in-flight`) because the
  //  review is only triggered inside the CHANGED handler once. Re-drive the review
  //  across ticks; after MAX_INCONCLUSIVE_REVISIONS inconclusive re-reviews of the
  //  SAME revision, REJECT + replan so a fresh mutation is the monotonic repair
  //  step (CTO: findings/indecision feed the next mutation, never a permanent stall).
  if (current.state === 'EVIDENCE_CAPTURED' || current.state === 'VERIFYING') {
    // WAR-mode deferred verification: a completed revision is evidence-captured but
    // NOT yet reviewed. Instead of spending a review + executable-gate pass on this
    // revision right now, stamp it PENDING_VERIFY (durable, recoverable) and let the
    // mission advance to the NEXT ticket. The `verifyPending` sweep later drives the
    // whole batch through the real gates in one pass. This is the deliver-many,
    // verify-as-checkpoint workflow; it never risks the revision's durability.
    if (deps.verifyMode?.() === 'deferred' && current.state !== 'VERIFYING') {
      if (current.state === 'EVIDENCE_CAPTURED') {
        updateRevision(d, current.revision_id, { state: 'PENDING_VERIFY' });
        updateTicket(d, target.ticket_id, { verification_state: 'PENDING_VERIFY' });
        emitMissionEvent(d, 'revision.deferred_verify', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
      }
      return { action: 'deferred-verify-pending', nextState: mission.state };
    }
    const ws = deps.workspacePathFor(missionId);
    if (ws) {
      const reviewVerdict = await review({ missionId, ticketId: target.ticket_id, revisionId: current.revision_id, workspacePath: ws });
      if (getMission(d, missionId)?.state === 'CANCELLED') return { action: 'operator-cancelled', nextState: 'CANCELLED' };
      if (getTicket(d, target.ticket_id)?.objective !== target.objective) {
        updateRevision(d, current.revision_id, { state: 'SUPERSEDED' });
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: 'operator-steering' });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id, verification_state: 'UNVERIFIED' });
        updateMissionState(d, missionId, 'REPLANNING');
        return { action: 'operator-steering-replan', nextState: 'REPLANNING' };
      }
      updateRevision(d, current.revision_id, { snapshot_id: reviewVerdict.snapshotId ?? undefined, review_job_id: reviewVerdict.reviewJobId ?? undefined });
      if (reviewVerdict.verdict === 'INCONCLUSIVE') {
        if (inconclusiveCount(d, current.revision_id) >= MAX_INCONCLUSIVE_REVISIONS) {
          emitMissionEvent(d, 'revision.review_inconclusive_exhausted', { revision_id: current.revision_id });
          updateMissionState(d, missionId, 'REPLANNING');
          const sig = deriveFailureSignature([], [], [], ['inconclusive-exhausted']);
          updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
          const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: current.workspace_fingerprint_after || await fingerprintOrEmpty(ws) });
          updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
          persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: 'review-inconclusive-exhausted', findings: reviewVerdict.findings, failedGates: [], evidenceIds: [] });
          emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: 'review-inconclusive-exhausted' });
          current = getRevision(d, current.revision_id)!;
        } else {
          incrementInconclusive(d, current.revision_id);
          return { action: `review-inconclusive-reexamine-${inconclusiveCount(d, current.revision_id)}`, nextState: 'VERIFYING' };
        }
      } else if (reviewVerdict.verdict === 'PASS' || reviewVerdict.verdict === 'FINDINGS') {
        // A decisive verdict on re-review: apply it like the CHANGED path does
        // (evidence-resolved gates + verified / FAIL-to-replan). Re-use the same
        // gate/verify logic by NOT bailing here — but keep it simple: if PASS and
        // verified, crown it; else reject+replan below via the shared verdict block.
        const updatedGates: Array<{ gate_key: string; status: GateStatus; evidence_refs?: string[] }> = reviewVerdict.mandatoryGates.map((k) => {
          const resolvedRefs = (reviewVerdict.gateEvidenceRefs?.[k] ?? []).filter((id) => evidenceRefResolves(d, current.revision_id, id));
          const pass = reviewVerdict.gatePassed[k] && reviewVerdict.evidenceResolved && resolvedRefs.length > 0;
          return { gate_key: k, status: pass ? 'PASS' : (reviewVerdict.findings.some((f) => f.toLowerCase().includes(k.toLowerCase())) ? 'FAIL' : 'UNVERIFIED'), evidence_refs: pass ? resolvedRefs : [] };
        });
        setQualityGate(d, current.revision_id, updatedGates);
        const verified = isRevisionVerified10(d, current.revision_id, reviewVerdict.mandatoryGates.length ? reviewVerdict.mandatoryGates : mandatory);
        if (reviewVerdict.verdict === 'PASS' && verified) {
          updateRevision(d, current.revision_id, { state: 'VERIFIED_10_10', completed_at: new Date().toISOString() });
          updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10' });
          updateMissionState(d, missionId, 'VERIFIED_10_10');
          emitMissionEvent(d, 'mission.verified_10_10', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
          return { action: 'verified-10-10-on-rereview', nextState: 'VERIFIED_10_10' };
        }
        // Decisive FINDINGS (or PASS but not evidence-verified): reject + replan.
        updateMissionState(d, missionId, 'REPLANNING');
        const failedKeys = updatedGates.filter((g) => g.status === 'FAIL').map((g) => g.gate_key);
        const sig = deriveFailureSignature(failedKeys, reviewVerdict.findings, [], []);
        updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: current.workspace_fingerprint_after || await fingerprintOrEmpty(ws) });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
        persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: `review-${reviewVerdict.verdict}`, findings: reviewVerdict.findings, failedGates: failedKeys, evidenceIds: [] });
        emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: `review-${reviewVerdict.verdict}` });
        current = getRevision(d, current.revision_id)!;
      }
    }
  }

  // ── 4. if already verified terminal, release next and continue
  if (current.state === 'VERIFIED_10_10') {
    updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10', execution_state: 'CLOSED' });
    return { action: `ticket-verified-${target.title}`, nextState: mission.state };
  }

  // ── 5. dispatch mutation (only if the revision is in a clean dispatchable state)
  const dispatchable: RevisionState[] = ['PLANNED', 'REJECTED'];
  if (!dispatchable.includes(current.state)) {
    return { action: `revision-${current.state}-in-flight`, nextState: mission.state };
  }

  const workspace = deps.workspacePathFor(missionId);
  // Fail fast on a misconfigured mission (no resolvable workspace path) instead
  // of spinning on a per-workspace lease or a transient retry that can never run.
  if (!workspace) {
    updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: `mission has no resolvable workspace path (workspace_id=${mission.workspace_id})` });
    return { action: 'no-workspace-path', nextState: 'BLOCKED_EXTERNAL' };
  }
  const facts = activeClaimContext(d, missionId);
  // Carry the PRIOR revision's findings/gates forward so a replan is NOT blind.
  const priorRevision = revisions.filter((r) => r.revision_no < current.revision_no).reverse()[0];

  // Guard: never repeat the same plan when the failure signature is unchanged AND
// the PREVIOUS mutation produced NO content delta (its before == its after). A
// freshly-replanned revision (after a CHANGED mutation) has prev.after !=
// prev.before, so this does NOT fire — the next mutation may genuinely try again
// with findings fed forward. It only fires to break a true no-progress cycle.
  if (current.failure_signature) {
    const prev = priorRevision;
    const prevWasEmpty = prev?.workspace_fingerprint_before && prev?.workspace_fingerprint_after && prev.workspace_fingerprint_before === prev.workspace_fingerprint_after;
    if (prev && prev.failure_signature === current.failure_signature && prevWasEmpty) {
      updateMissionState(d, missionId, 'REPLANNING');
      emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, reason: 'identical-failure-no-delta' });
      const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${(current.revision_no + 1)}`, workspace_fingerprint_before: await fingerprintOrEmpty(workspace) });
      updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
      persistPlan(d, current.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: current.failure_signature, reason: 'identical-failure-no-delta', findings: priorFindings(d, priorRevision), failedGates: priorFailedGates(d, priorRevision) });
      return { action: 'forced-replan-identical-signature', nextState: 'REPLANNING' };
    }
  }

  // P0 concurrency: per-workspace FENCED mutation lease. Only ONE writable
  // mutation agent may run against a workspace at a time, regardless of how many
  // missions/tickets point at it. If another mission currently holds the writer
  // lease, this tick yields (idempotent) — it does NOT start a second mutation.
  // LIVENESS: first reclaim a DEAD holder. A mutation that died (server-boot
  // timeout / crash) leaves its lease held until expiry; without this, every
  // subsequent mutation yields `mutation-workspace-busy` for up to 10 min. A
  // live mutation renews its lease every ~30s, so a 3-min-stale heartbeat is a
  // safe dead-holder signal.
  if (workspace) reclaimStaleLease(d, `ws:${workspace}`, 'mutation-writer', 3 * 60_000);
  const writerLease = workspace ? acquireLease(d, 'mutation-writer', `ws:${workspace}`, 10 * 60_000) : null;
  if (!writerLease) {
    updateTicket(d, target.ticket_id, { execution_state: 'RUNNING' });
    return { action: 'mutation-workspace-busy', nextState: mission.state };
  }
  let leaseHeld = true;
  // RENEW the writer lease while the mutation is alive so a legitimately long
  // mutation (write-chase, long extraction) never loses its fence mid-run and
  // lets a concurrent mutation onto the same workspace. Cleared in the finally.
  const leaseHeartbeat = setInterval(() => {
    try { renewLease(d, writerLease.leaseId, 10 * 60_000); } catch { /* best effort */ }
  }, 30 * 1000);
  try {
    updateMissionState(d, missionId, 'MUTATING');
    updateRevision(d, current.revision_id, { state: 'MUTATING' });

    const request = {
      missionId,
      ticketId: target.ticket_id,
      revisionId: current.revision_id,
      workspacePath: workspace,
      objective: target.objective ?? target.title,
      // REAL prior findings/gates, not a hardcoded empty array (P0 replan blindness).
      currentFindings: priorFindings(d, priorRevision),
      failedQualityGateKeys: priorFailedGates(d, priorRevision),
      // ACCEPTANCE CONSTRAINTS: the mutation agent must satisfy every gate the
      // way the CTO/contract demands — a monotonic repair process, not a blind
      // retry. The Codex/OpenAI actuator is told these MUST hold before doing.
      acceptanceGates: mandatory,
      verifiedScientificFacts: facts.verified.map((c) => c.claim),
      activeHypotheses: facts.hypotheses.map((c) => c.claim),
      falsifiedHypotheses: facts.falsified.map((c) => c.claim),
      previousFailureSignature: current.failure_signature ?? undefined,
      allowedCapabilities: ['code', 'git-commit-local'],
    };
  const controller = new AbortController();
  const cancellation = setInterval(() => {
    if (getMission(d, missionId)?.state === 'CANCELLED') controller.abort();
  }, 1000);
  // LIVENESS WATCHDOG: a mutation must never strand the mission in MUTATING.
  // createKilo's server-boot timeout is 5s (in @kilocode/sdk) and a hung agent
  // (network stall, server never returns) previously left the ticket MUTATING
  // forever. Abort after a generous bounded window so the FAILED_TRANSIENT path
  // below replans instead of deadlocking. Real extraction on a 900-file
  // workspace can take minutes, so 15 min guards only a TRUE hang.
  const WATCHDOG_MS = 15 * 60_000;
  const watchdog = setTimeout(() => controller.abort(), WATCHDOG_MS);
  let result: RepairResult;
  try {
    // Provider-agnostic per-mission engine: pick the runner whose engine comes
    // from this mission's engine_matrix_json, falling back to the default.
    const activeRunner = runnerFor ? runnerFor(missionId) : runner;
    // Register the SOUL-CHAMBER worker so the operator surfaces see the mutation
    // agent as a live worker (role=mutation), not just reviewers/adjudicators.
    // /v1/workers already lists review workers; this adds the mutator alongside.
    // Derive provider/model from the mission engine matrix (mutation slot) so it
    // matches what the mutator actually uses.
    let mutProv = 'litellm-edge', mutModel = 'differential_sseproxy';
    try {
      const mx = mission.engine_matrix_json ? JSON.parse(mission.engine_matrix_json) : {};
      const mut = mx?.mutation ?? mx?.mutator ?? {};
      if (mut?.providerID) mutProv = String(mut.providerID);
      if (mut?.modelID) mutModel = String(mut.modelID);
    } catch { /* default */ }
    const mutWorkerId = `wk_${randomBytes(8).toString('hex')}`;
    const mutNow = new Date().toISOString();
    try {
      d.db.query(
        `INSERT INTO workers (worker_id, job_id, attempt_id, role, status, provider_id, model_id, started_at, last_heartbeat_at)
         VALUES (?,?,?,?, 'running', ?,?,?,?)`
      ).run(mutWorkerId, current.revision_id, null, 'mutation', mutProv, mutModel, mutNow, mutNow);
    } catch { /* best effort: worker row is observability, never a mission gate */ }
    // best-effort heartbeat: a mutation can take minutes; keep the row 'live'.
    const mutHb = setInterval(() => { try { d.db.query(`UPDATE workers SET last_heartbeat_at=? WHERE worker_id=?`).run(new Date().toISOString(), mutWorkerId); } catch {} }, 30_000);
    const finishMut = (rr: RepairResult) => {
      clearInterval(mutHb);
      try { d.db.query(`UPDATE workers SET status=?, finished_at=?, error=?, job_id=? WHERE worker_id=?`).run(rr?.outcome === 'FAILED_TRANSIENT' ? 'failed' : 'succeeded', new Date().toISOString(), rr?.error ?? null, current.revision_id, mutWorkerId); } catch {}
    };
    try {
      const r = await activeRunner.execute(request, controller.signal);
      finishMut(r);
      result = r;
    } catch (e) { result = { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: current.workspace_fingerprint_before || await fingerprintOrEmpty(workspace), workspaceFingerprintAfter: '', error: String(e) }; }
  } catch (err) {
    result = { outcome: 'FAILED_TRANSIENT', changedFiles: [], commandsExecuted: [], artifactsProduced: [], workspaceFingerprintBefore: current.workspace_fingerprint_before || await fingerprintOrEmpty(workspace), workspaceFingerprintAfter: '', error: String(err) };
  } finally {
    clearInterval(cancellation);
    clearTimeout(watchdog);
  }
  if (getMission(d, missionId)?.state === 'CANCELLED') return { action: 'operator-cancelled', nextState: 'CANCELLED' };
  if (getTicket(d, target.ticket_id)?.objective !== target.objective) {
    updateRevision(d, current.revision_id, { state: 'SUPERSEDED' });
    const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: 'operator-steering' });
    updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id, verification_state: 'UNVERIFIED' });
    updateMissionState(d, missionId, 'REPLANNING');
    return { action: 'operator-steering-replan', nextState: 'REPLANNING' };
  }
  updateRevision(d, current.revision_id, { workspace_fingerprint_after: result.workspaceFingerprintAfter || undefined, state: 'MUTATING' });

  switch (result.outcome) {
    case 'FAILED_TRANSIENT': {
      emitMissionEvent(d, 'repair.failed', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, error: result.error });
      // P0 liveness: DO NOT strand in MUTATING. Count transient attempts on the
      // revision; below the cap, back to PLANNED for a bounded retry. At the cap,
      // reject + replan instead of looping forever.
      const attempts = countTransientAttempts(d, current.revision_id);
      if (attempts + 1 >= MAX_TRANSIENT_ATTEMPTS) {
        const sig = deriveFailureSignature([], result.error ? [result.error] : [], [], [`transient:x${attempts + 1}`]);
        updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
        updateMissionState(d, missionId, 'REPLANNING');
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: await fingerprintOrEmpty(workspace) });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
        emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: 'transient-exhausted' });
        return { action: 'replanned-transient-exhausted', nextState: 'REPLANNING' };
      }
      // Record the attempt in the failure signature so the next transient sees N+1.
      const nextSig = deriveFailureSignature([], result.error ? [result.error] : [], [], [`transient:x${attempts + 1}`]);
      updateRevision(d, current.revision_id, { state: 'PLANNED', failure_signature: nextSig });
      updateMissionState(d, missionId, 'ACTIVE');
      emitMissionEvent(d, 'revision.retry', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, attempt: attempts + 1 });
      return { action: 'infra-retry', nextState: 'ACTIVE' };
    }
    case 'BLOCKED_EXTERNAL': {
      updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: result.blocker?.description ?? 'external blocker', blocked_details: result.blocker ? JSON.stringify(result.blocker) : undefined });
      updateRevision(d, current.revision_id, { state: 'BLOCKED' });
      emitMissionEvent(d, 'mission.blocked', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, blocker: result.blocker });
      return { action: 'blocked-external', nextState: 'BLOCKED_EXTERNAL' };
    }
    case 'NO_CHANGE':
    case 'FAILED_PLAN': {
      updateMissionState(d, missionId, 'REPLANNING');
      if (request.activeHypotheses[0]) {
        upsertClaim(d, { mission_id: missionId, canonical_key: `falsified:${hypKey(request)}`, claim: request.activeHypotheses[0], status: 'FALSIFIED', revision_id: current.revision_id });
      }
      const sig = deriveFailureSignature(priorFailedGates(d, priorRevision), result.error ? [result.error] : [], ['no-change'], []);
      updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
      const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, workspace_fingerprint_before: await fingerprintOrEmpty(workspace) });
      updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
      persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: result.outcome, findings: request.currentFindings, failedGates: request.failedQualityGateKeys });
      emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: result.outcome });
      return { action: `replanned-${result.outcome}`, nextState: 'REPLANNING' };
    }
    case 'CHANGED': {
      // Full-QA observable transcript of what the mutator did, so the operator
      // can inspect the actual delta (commands + file diff) before it is reviewed.
      for (const cmd of result.commandsExecuted ?? []) {
        appendTranscript(d, { missionId, ticketId: target.ticket_id, revisionId: current.revision_id, role: 'mutation', kind: 'tool_call', title: cmd, content: cmd, meta: { worker: 'mutation', revision: current.revision_id } });
      }
      for (const f of result.changedFiles ?? []) {
        const diff = safelyGetDiff(workspace, f);
        appendTranscript(d, { missionId, ticketId: target.ticket_id, revisionId: current.revision_id, role: 'mutation', kind: 'diff', title: `changed ${f}`, content: diff || '(no text diff — new/untracked file)', meta: { file: f, revision: current.revision_id } });
      }
      // capture content-addressed evidence (real SHA-256 + byte count) + the
      // immutable snapshot BEFORE review (P0 evidence).
      updateMissionState(d, missionId, 'CAPTURING_EVIDENCE');
      const evidenceIds: string[] = [];
      for (const f of result.changedFiles) {
        evidenceIds.push(captureEvidence(d, current.revision_id, 'source', f, workspace));
      }
      for (const a of result.artifactsProduced) {
        evidenceIds.push(captureEvidence(d, current.revision_id, 'artifact', a, workspace));
      }
      // run the independent ExcellenceGovernor over the immutable revision
      updateMissionState(d, missionId, 'VERIFYING');
      updateRevision(d, current.revision_id, { state: 'EVIDENCE_CAPTURED' });
      // EPISTEMIC convergence at the mission level: re-review the SAME immutable
      // snapshot/revision only when the verdict is epistemically invalid
      // (INCONCLUSIVE = reviewer could not decide). A valid FINDINGS or PASS is
      // accepted immediately. Bound the re-review budget; never reject a revision
      // merely because the FIRST review was inconclusive.
      let verdict = await review({ missionId, ticketId: target.ticket_id, revisionId: current.revision_id, workspacePath: workspace });
      let reviewAttempts = 1;
      while (verdict.verdict === 'INCONCLUSIVE' && reviewAttempts < MAX_CONVERGENT_REVIEW_ATTEMPTS) {
        reviewAttempts += 1;
        verdict = await review({ missionId, ticketId: target.ticket_id, revisionId: current.revision_id, workspacePath: workspace });
      }
      emitMissionEvent(d, 'revision.reviewed', { revision_id: current.revision_id, verdict: verdict.verdict, attempts: reviewAttempts });
      // Full-QA observable transcript of the review outcome: each accepted
      // finding becomes a durable 'finding' journal row the operator reads.
      for (const f of verdict.findings ?? []) {
        appendTranscript(d, { missionId, ticketId: target.ticket_id, revisionId: current.revision_id, role: 'reviewer', kind: 'finding', title: f, content: f, meta: { verdict: verdict.verdict, revision: current.revision_id } });
      }
      appendTranscript(d, { missionId, ticketId: target.ticket_id, revisionId: current.revision_id, role: 'engine', kind: 'event', title: `review ${verdict.verdict}`, content: `Review verdict ${verdict.verdict} after ${reviewAttempts} attempt(s)`, meta: { verdict: verdict.verdict, attempts: reviewAttempts, revision: current.revision_id } });
      updateRevision(d, current.revision_id, { snapshot_id: verdict.snapshotId ?? undefined, review_job_id: verdict.reviewJobId ?? undefined });
      // P0 Quality Oracle: a gate PASSes ONLY with resolved evidence references.
      if (getMission(d, missionId)?.state === 'CANCELLED') return { action: 'operator-cancelled', nextState: 'CANCELLED' };
      if (getTicket(d, target.ticket_id)?.objective !== target.objective) {
        updateRevision(d, current.revision_id, { state: 'SUPERSEDED' });
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: 'operator-steering' });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id, verification_state: 'UNVERIFIED' });
        updateMissionState(d, missionId, 'REPLANNING');
        return { action: 'operator-steering-replan', nextState: 'REPLANNING' };
      }
      // `evidence_id` in a gate ref MUST resolve to a real content-hashed artifact
      // for THIS revision (never a bare overall PASS).
      const updatedGates: Array<{ gate_key: string; status: GateStatus; evidence_refs?: string[] }> = verdict.mandatoryGates.map((k) => {
        const refs = (verdict.gateEvidenceRefs?.[k] ?? []).filter((id) => evidenceIds.includes(id) || evidenceRefResolves(d, current.revision_id, id));
        const pass = verdict.gatePassed[k] && verdict.evidenceResolved && refs.length > 0;
        return { gate_key: k, status: pass ? 'PASS' : (verdict.findings.some((f) => f.toLowerCase().includes(k.toLowerCase())) ? 'FAIL' : 'UNVERIFIED'), evidence_refs: pass ? refs : [] };
      });
      setQualityGate(d, current.revision_id, updatedGates);
      const verified = isRevisionVerified10(d, current.revision_id, verdict.mandatoryGates.length ? verdict.mandatoryGates : mandatory);
      const allTicketsVerified = tickets.every((b) => (b.ticket_id === target.ticket_id && verified) || b.verification_state === 'VERIFIED_10_10');
      if (verified && verdict.verdict === 'PASS' && verdict.evidenceResolved) {
        updateRevision(d, current.revision_id, { state: 'VERIFIED_10_10', completed_at: new Date().toISOString() });
        updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10', execution_state: 'CLOSED', active_revision_id: current.revision_id });
        emitMissionEvent(d, 'ticket.verified', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
        if (allTicketsVerified) {
          updateMissionState(d, missionId, 'VERIFIED_10_10', { verified_at: new Date().toISOString() });
          emitMissionEvent(d, 'mission.verified', { mission_id: missionId });
          return { action: `mission-verified`, nextState: 'VERIFIED_10_10' };
        }
        return { action: `ticket-verified-${target.title}`, nextState: mission.state };
      }
      // If the review exhausted convergence without a decisive verdict
      // (INCONCLUSIVE after all attempts): do NOT immediately reject + force a
      // fresh mutation — first give a later tick a chance to re-review the SAME
      // immutable snapshot (transient provider recovery). BUT bound it: a reviewer
      // that is persistently INCONCLUSIVE on one revision (bounded cap) strongly
      // signals the mutation itself is inadequate (e.g. broken code the reviewer
      // cannot validate, or an evidence gap). Re-reviewing the same inadequate
      // snapshot forever is a deadlock; after the cap, REJECT + replan so a fresh
      // mutation attempt is the monotonic repair step. This is the Ender/CTO rule:
      // findings/indecision feed the next mutation, never a permanent stall.
      if (verdict.verdict === 'INCONCLUSIVE') {
        if (inconclusiveCount(d, current.revision_id) >= MAX_INCONCLUSIVE_REVISIONS) {
          emitMissionEvent(d, 'revision.review_inconclusive_exhausted', { revision_id: current.revision_id, attempts: reviewAttempts });
          updateMissionState(d, missionId, 'REPLANNING');
          const failedKeys = updatedGates.filter((g) => g.status === 'FAIL').map((g) => g.gate_key);
          const sig = deriveFailureSignature(failedKeys.length ? failedKeys : [], [], result.changedFiles, ['inconclusive-exhausted']);
          updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
          const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: result.workspaceFingerprintAfter || await fingerprintOrEmpty(workspace) });
          updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
          persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: 'review-inconclusive-exhausted', findings: verdict.findings, failedGates: failedKeys, evidenceIds });
          emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: 'review-inconclusive-exhausted' });
          return { action: `replanned-inconclusive-exhausted`, nextState: 'REPLANNING' };
        }
        // Persist the inconclusive re-review for this revision (bounded counter).
        incrementInconclusive(d, current.revision_id);
        updateRevision(d, current.revision_id, { state: 'EVIDENCE_CAPTURED' });
        emitMissionEvent(d, 'revision.review_inconclusive', { revision_id: current.revision_id, attempts: reviewAttempts });
        return { action: `review-inconclusive-${reviewAttempts}`, nextState: 'VERIFYING' };
      }
      // Decisive but not 10/10: derive failure signature, REJECT this revision, replan
      updateMissionState(d, missionId, 'REPLANNING');
      const failedKeys = updatedGates.filter((g) => g.status === 'FAIL').map((g) => g.gate_key);
      const sig = deriveFailureSignature(failedKeys, verdict.findings, result.changedFiles, []);
      updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
      const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: result.workspaceFingerprintAfter || await fingerprintOrEmpty(workspace) });
      updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
      persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: `review-${verdict.verdict}`, findings: verdict.findings, failedGates: failedKeys, evidenceIds });
      emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: `review-${verdict.verdict}` });
      return { action: `replanned-${verdict.verdict}`, nextState: 'REPLANNING' };
    }
    default: {
      // Unreachable in practice (all MutationOutcome values handled); fail closed.
      const unreachable: never = result.outcome;
      throw new Error(`unhandled mutation outcome ${String(unreachable)}`);
    }
  }
  } finally {
    // Release the per-workspace mutation writer fence on EVERY exit path.
    clearInterval(leaseHeartbeat);
    if (leaseHeld) { releaseLease(d, writerLease.leaseId); leaseHeld = false; }
  }
}

/** Determine the number of transient-failure attempts already recorded for a
 *  revision. We persist the failure signature width as our retry counter: the
 *  revision stays `PLANNED` and each transient bump pushes its signal. A more
 *  precise counter is the count of `revision.retry` events, but we keep this
 *  cheap and DB-only by counting the `transient:` markers in prior signatures. */
function countTransientAttempts(d: Db, revisionId: string): number {
  const r = getRevision(d, revisionId);
  const sig = r?.failure_signature ?? '';
  const m = /transient:x(\d+)/.exec(sig);
  return m ? Number(m[1]) : 0;
}

/** Number of INCONCLUSIVE re-reviews recorded for a revision (bounded). The
 *  counter is persisted on the revision's failure signature as `inconclusive:xN`
 *  so it survives daemon restarts and ticks. */
function inconclusiveCount(d: Db, revisionId: string): number {
  const r = getRevision(d, revisionId);
  const sig = r?.failure_signature ?? '';
  const m = /inconclusive:x(\d+)/.exec(sig);
  return m ? Number(m[1]) : 0;
}

/** Append one INCONCLUSIVE re-review marker to the revision's failure signature. */
function incrementInconclusive(d: Db, revisionId: string): void {
  const r = getRevision(d, revisionId);
  const cur = (r?.failure_signature ?? '').replace(/inconclusive:x\d+/, '');
  const n = inconclusiveCount(d, revisionId) + 1;
  updateRevision(d, revisionId, { failure_signature: `${cur}inconclusive:x${n}` });
}

/** Waterloo shutdown reason string for a transient-exhausted signature. */
// (unused placeholder removed — deriveFailureSignature builds it fully)

function priorFindings(d: Db, prev: ReturnType<typeof getRevision> | undefined): string[] {
  if (!prev) return [];
  // Findings are what a review emitted: pull any FAIL/UNVERIFIED gate + the
  // persisted failure signature as an objective signal. In a full system the
  // Findings table scoped to the revision is the source; here the reviewer's
  // returned findings were stored in the revision's failure signature.
  const gates = getQualityGates(d, prev.revision_id);
  const failed = gates.filter((g) => g.status === 'FAIL' || g.status === 'UNVERIFIED').map((g) => `${g.gate_key}=${g.status}`);
  return prev.failure_signature ? [`${prev.failure_signature}`, ...failed] : failed;
}

function priorFailedGates(d: Db, prev: ReturnType<typeof getRevision> | undefined): string[] {
  if (!prev) return [];
  return getQualityGates(d, prev.revision_id).filter((g) => g.status === 'FAIL').map((g) => g.gate_key);
}

/** Persist a REAL structured repair plan, linking it to the revision. */
function persistPlan(
  d: Db,
  revisionId: string,
  input: { objective: string; hypothesis_key: string; failure_signature?: string; reason: string; findings: string[]; failedGates?: string[]; evidenceIds?: string[] },
): void {
  setRepairPlan(d, {
    revision_id: revisionId,
    planner_model: 'controller',
    objective: input.objective,
    hypothesis_key: input.hypothesis_key,
    failure_signature: input.failure_signature,
    plan: {
      reason: input.reason,
      findings: input.findings,
      failedQualityGates: input.failedGates ?? [],
      evidenceIds: input.evidenceIds ?? [],
      acceptance: ['independent reviewer PASS', 'every mandatory gate PASS with a resolved evidence artifact'],
    },
  });
}

/** Capture one content-addressed evidence artifact. If the path exists on disk,
 *  hash the REAL bytes (P0 evidence — never a path+revision FNV). Otherwise,
 *  record a structural marker with zero bytes so the reviewer cannot claim it. */
function captureEvidence(d: Db, revisionId: string, kind: string, relPath: string, workspace: string): string {
  const full = join(workspace, relPath);
  if (existsSync(full)) {
    const { sha256, bytes } = hashFileContent(full);
    const ev = addEvidence(d, { revision_id: revisionId, kind, path: relPath, sha256, bytes, producer: 'kilo-mutation', metadata: { workspace } });
    return ev.artifact_id;
  }
  // The mutation reported the file but it is missing on disk: record a
  // zero-byte marker so verification can never fabricate evidence for it.
  const ev = addEvidence(d, { revision_id: revisionId, kind, path: relPath, sha256: '', bytes: 0, producer: 'kilo-mutation', metadata: { workspace, missing: true } });
  return ev.artifact_id;
}

/** True if an evidence ref resolves to a real content-hashed artifact row for
 *  this revision that is NOT a zero-byte/missing marker. */
function evidenceRefResolves(d: Db, revisionId: string, artifactId: string): boolean {
  const row = d.db
    .query<{ sha256: string; bytes: number }, [string, string]>(`SELECT sha256, bytes FROM evidence_artifacts WHERE artifact_id=? AND revision_id=?`)
    .get(artifactId, revisionId);
  return !!row && row.bytes > 0 && row.sha256.length === 64;
}

/** Fingerprint helper — reuses KiloMutationRunner's content fingerprint. ASYNC. */
function fingerprintOrEmpty(workspacePath: string): Promise<string> {
  if (!workspacePath) return Promise.resolve('');
  return fingerprintWorkspace(workspacePath);
}

function hypKey(req: { activeHypotheses: string[] }): string {
  return req.activeHypotheses[0]?.slice(0, 20) ?? 'unknown';
}

/** The plan's B1 mandatory gate example (Phase 12), typed concretely so
 *  `REPORT_GATES.ARTIFACTS` is `string[]` (never `| undefined`) even under
 *  `noUncheckedIndexedAccess`. */
export const REPORT_GATES: { ARTIFACTS: string[]; INFRA: string[] } = {
  ARTIFACTS: ['artifacts_recovered', 'dim55_producer_traced', 'execution_granularity', 'cpu_diagnostic_parity', 'no_fabrication'],
  INFRA: ['host_tests', 'ledger_durability', 'recall_exposed', 'security_auth'],
};

/** Best-effort git diff of one changed file for the observable transcript. */
function safelyGetDiff(workspace: string, file: string): string {
  if (!workspace || !file) return '';
  try {
    return execFileSync('git', ['--no-pager', 'diff', '--', file], { cwd: workspace, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 6000);
  } catch {
    return '';
  }
}

/** Recover pending mission work after daemon restart (Phase 18/19). */
export function recoverMissions(d: Db): string[] {
  const rows = d.db.query<{ mission_id: string; state: string }, []>(
    `SELECT mission_id, state FROM autonomy_missions WHERE state IN ('PLANNING','MUTATING','CAPTURING_EVIDENCE','VERIFYING','REPLANNING','ACTIVE')`
  ).all();
  // Any non-terminal, in-flight mission is resumable; the controller's state
  // machine re-derives the safe next step on the next advanceMission call.
  for (const r of rows) {
    emitMissionEvent(d, 'agent.recovered', { mission_id: r.mission_id, from_state: r.state });
  }
  return rows.map((r) => r.mission_id);
}

/**
 * WAR-mode verify checkpoint — the "run tests now" sweep.
 *
 * Drives every ticket whose revision is parked in `PENDING_VERIFY` back through
 * the REAL review + deterministic gate pipeline. It does NOT re-run the mutation
 * (at-most-once is preserved); it only un-parks the queued evidence by flipping
 * each parking revision `PENDING_VERIFY -> EVIDENCE_CAPTURED` (and its ticket to
 * `VERIFYING`), then returns the affected ticket ids. The next `advanceMission`
 * tick picks them up through the normal re-review path, so the executable gates
 * (tsc/lint/unit/PolyGraph) and the A/B reviewers + adjudicator all run against
 * the SAME frozen snapshot — but as a batch, not one-per-task.
 *
 * Needs only the Db — no MutationRunner/review hook — because un-parking just
 * re-enables the ordinary review path; the Ender loop does the actual verify.
 * Returns `{ unParked, count }`; `count` is 0 when there was nothing pending.
 */
export function verifyPendingVerify(d: Db, missionId: string): { unParked: string[]; count: number } {
  const unParked: string[] = [];
  const tickets = listTickets(d, missionId);
  for (const b of tickets) {
    if (b.verification_state !== 'PENDING_VERIFY') continue;
    const revs = listRevisions(d, b.ticket_id);
    const parked = revs.filter((r) => r.state === 'PENDING_VERIFY');
    // Flip the parked (evidence-captured, un-reviewed) revision back to
    // EVIDENCE_CAPTURED so the ordinary re-review path drives it. Its ticket moves
    // to VERIFYING. At-most-once holds: the mutation already ran and its snapshot
    // is frozen; we are only choosing to spend verification NOW, batch-wise.
    for (const r of parked) {
      updateRevision(d, r.revision_id, { state: 'EVIDENCE_CAPTURED' });
      emitMissionEvent(d, 'revision.verify_released', { mission_id: missionId, ticket_id: b.ticket_id, revision_id: r.revision_id });
    }
    updateTicket(d, b.ticket_id, { verification_state: parked.length ? 'VERIFYING' : b.verification_state });
    if (parked.length) unParked.push(b.ticket_id);
  }
  return { unParked, count: unParked.length };
}
