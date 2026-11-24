import type { Db } from './db';
import {
  getMission, listTickets, getTicket, getDependencies,
  updateMissionState, updateTicket, createRevision, getRevision, updateRevision,
  listRevisions, setQualityGate, getQualityGates, isRevisionVerified10,
  addEvidence, hashFileContent, setRepairPlan,
  upsertClaim, activeClaimContext, emitMissionEvent,
  bumpReplanStreak, resetReplanStreak,
  type MissionState, type RevisionState, type GateStatus,
  scheduleBlockedRetry, clearHumanAcceptance,
  getMissionGateCommands, latestGateExecution,
} from './mission-repository';
import { runGateExecutions } from './gate-runner';
import type { MutationRunner, RepairResult } from './mutation-runner';
import { changedFilesSinceFull, fingerprintWorkspace } from './mutation-runner';
import { acquireLease, releaseLease, renewLease, reclaimStaleLease } from './reconciler';
import { terminateWorkersForJob } from './worker-supervisor';
import { getJob } from './jobs';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  /** Effective default mutation route (no hardcoded provider/model). */
  mutationRoute?: { providerID: string; modelID: string };
  /** Effective route for a mission's engine-matrix mutation override. */
  mutationRouteFor?: (missionId: string) => { providerID: string; modelID: string };
  /** Mandatory gate keys a ticket must PASS for VERIFIED_10_10. Per-ticket optional. */
  mandatoryGates?: string[];
  /** Task-specific acceptance gates for THIS mission/ticket (e.g. a divide-by-zero
   *  mission should verify `zero_division_contract`, `coercion_semantics`,
   *  `boundary_tests`, NOT the turbine-diagnostic default REPORT_GATES.ARTIFACTS).
   *  When present, supersedes both mandatoryGates and the turbine default. */
  taskGates?: string[];
  /** absolute path to the writable workspace for this mission. */
  workspacePathFor: (missionId: string) => string;
  /** Storage root for host-executed gate worktrees + transcripts. Defaults to
   *  <dirname(db path)>/gate-runs. Must be outside the mission workspace. */
  gateDataDir?: string;
  review: ReviewHook;
  /** WAR-mode verification policy. When a getter returns 'deferred' (or when this
   *  is absent, treated as 'auto'), the controller SKIPS the per-revision review
   *  on a completed revision and instead stamps it PENDING_VERIFY so the mission
   *  keeps advancing; a later `verifyPending` sweep drives the queued batch through
   *  the real gates. Absent => 'auto' preserves the historic always-review loop. */
  verifyMode?: () => 'auto' | 'deferred';
  /** Long-horizon governors (see AutonomyConfigSchema). */
  maxMissionWallClockMs?: number;
  maxMissionRevisions?: number;
  maxMissionReviewTokens?: number;
  mutationWatchdogMs?: number;
}

/**
 * A revision that is REJECTED/SUPERSEDED must not keep a review execution alive.
 * Cancel its non-terminal job, kill the stale workers, drop the job lease, and
 * journal it. Without this a rejected revision's reviewers keep running (and
 * look "active") while the mission has already moved to a newer revision.
 */
export function cancelReviewForRevision(d: Db, revisionId: string, reason: string): void {
  const rev = getRevision(d, revisionId);
  if (!rev?.review_job_id) return;
  const job = getJob(d, rev.review_job_id);
  if (!job) return;
  if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL', 'CANCELLED'].includes(job.state)) return;
  const nowIso = new Date().toISOString();
  d.db.query(`UPDATE review_jobs SET state='CANCELLED', updated_at=? WHERE job_id=?`).run(nowIso, job.jobId);
  terminateWorkersForJob(d, job.jobId, reason);
  d.db.query(`DELETE FROM leases WHERE owner=?`).run(`job:${job.jobId}`);
  emitMissionEvent(d, 'review.cancelled', { revision_id: revisionId, job_id: job.jobId, reason });
}

type ReviewResult = Awaited<ReturnType<ReviewHook>>;

/**
 * Run the mission's executable gates BEFORE the review, in an isolated
 * candidate tree. Execution is a controller responsibility so a custom review
 * hook cannot silently skip it. Execution failures are persisted as gate rows /
 * evidence by the runner; a catastrophic runner error is journaled and the
 * Quality Oracle fails closed (missing execution => no VERIFIED_10_10).
 */
async function executeMissionGates(
  d: Db,
  deps: ControllerDeps,
  missionId: string,
  revisionId: string,
  workspacePath: string,
): Promise<void> {
  const commands = getMissionGateCommands(d, missionId);
  if (!Object.keys(commands).length) return;
  const dataDir = deps.gateDataDir ?? join(dirname(d.path), 'gate-runs');
  try {
    await runGateExecutions({ d, missionId, revisionId, workspacePath, dataDir, commands });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    emitMissionEvent(d, 'gate.execution_failed', {
      mission_id: missionId,
      revision_id: revisionId,
      error,
    });
  }
}

/**
 * Quality-gate rows for one review. Execution gates are authoritative in the
 * FAIL direction: a failed host execution forces FAIL even if the review hook
 * returned PASS for that gate. The reviewer can only make a passing execution
 * stricter (a real BLOCKER/HIGH finding), never rescue a failed one.
 */
function buildGateRows(
  d: Db,
  revisionId: string,
  verdict: ReviewResult,
  gates: string[],
): Array<{ gate_key: string; status: GateStatus; evidence_refs?: string[] }> {
  return gates.map((gateKey) => {
    const exec = latestGateExecution(d, revisionId, gateKey);
    const execPass = !exec || exec.status === 'PASS';
    const execRefs = exec ? [exec.evidence_artifact_id] : [];
    const refs = [...new Set([...execRefs, ...(verdict.gateEvidenceRefs?.[gateKey] ?? [])])]
      .filter((id) => evidenceRefResolves(d, revisionId, id));
    const pass = execPass
      && Boolean(verdict.gatePassed[gateKey])
      && (verdict.evidenceResolved || Boolean(exec))
      && refs.length > 0;
    const status: GateStatus = !execPass
      ? 'FAIL'
      : pass
        ? 'PASS'
        : (verdict.findings.some((f) => f.toLowerCase().includes(gateKey.toLowerCase())) ? 'FAIL' : 'UNVERIFIED');
    return {
      gate_key: gateKey,
      status,
      evidence_refs: pass
        ? refs
        : (exec && !execPass ? execRefs.filter((id) => evidenceRefResolves(d, revisionId, id)) : []),
    };
  });
}

/** Tick sweep: cancel any non-terminal review attached to a dead revision. */
export function sweepStaleReviewJobs(d: Db): number {
  const rows = d.db
    .query<{ revision_id: string }, []>(
      `SELECT r.revision_id FROM review_jobs j
         JOIN ticket_revisions r ON r.review_job_id=j.job_id
        WHERE j.state IN ('QUEUED','RUNNING','REVIEWING_A_B','ADJUDICATING')
          AND r.state IN ('REJECTED','SUPERSEDED')`
    )
    .all();
  for (const row of rows) cancelReviewForRevision(d, row.revision_id, 'revision is rejected/superseded');
  return rows.length;
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
/** HARD ceiling on how many times a single ticket may be replanned (NO_CHANGE /
 *  FAILED_PLAN / SCRATCH_ONLY / identical-failure-no-delta) before the mission
 *  surfaces as BLOCKED. This is a SAFETY VALVE, deliberately set far above any
 *  realistic convergence so legitimate long-horizon autonomous work (the kind
 *  the ExcellenceGovernor / review loop exists to enable — "a weekend debugging one line"
 *  is thousands of genuine revisions, not a bug) is never throttled. It only
 *  trips on a true unbounded spin (e.g. a mutator that can never satisfy its own
 *  gates). The observed 4614-revision runaway would have kept being legitimate if
 *  each revision had landed a real delta toward the objective rather than
 *  probe-only output; it is caught by the SCRATCH_ONLY classifier + this ceiling. */
const MAX_PLAN_REVISIONS = 3000;
/**
 * Fail-fast ceiling for a NO-DELTA / SCRATCH_ONLY consecutive-replan spin. A
 * mutator that keeps producing no recognized content delta (probe-only commits,
 * identical no-change) parks the mission after this many consecutive replans,
 * instead of spinning toward MAX_PLAN_REVISIONS (3000). Real deltas reset the
 * streak, so legitimate long-horizon work is never throttled. */
const MAX_CONSECUTIVE_NO_DELTA_REPLANS = 24;

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

  // MISSION BUDGETS ARE OPT-IN — NEVER A HIDDEN DEFAULT.
  //
  // HELLDESK is a long-horizon coding platform: a mission may legitimately run
  // for days across many review/replan cycles. An unconfigured limit therefore
  // means UNBOUNDED, not "6 hours". A silent default once parked a productive
  // mission at 361 minutes against a 360-minute ceiling; that is not allowed to
  // happen again. Only an operator-supplied `maxMissionWallClockMs`,
  // `maxMissionRevisions` or `maxMissionReviewTokens` may park a mission, and a
  // budget park is still not auto-retried (a human owns that call).
  //
  // Pathological loops are still bounded by MAX_CONSECUTIVE_NO_DELTA_REPLANS and
  // MAX_PLAN_REVISIONS below — those are correctness guards, not spend clocks.
  {
    const blockers: string[] = [];

    if (typeof deps.maxMissionWallClockMs === 'number' && deps.maxMissionWallClockMs > 0) {
      const age = Date.now() - Date.parse(mission.created_at);
      if (Number.isFinite(age) && age > deps.maxMissionWallClockMs) {
        blockers.push(
          `budget:wall-clock ${Math.round(age / 60_000)}min > ${Math.round(deps.maxMissionWallClockMs / 60_000)}min`
        );
      }
    }

    if (typeof deps.maxMissionRevisions === 'number' && deps.maxMissionRevisions > 0) {
      const n = d.db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ticket_revisions WHERE ticket_id IN (SELECT ticket_id FROM mission_tickets WHERE mission_id=?)`)
        .get(missionId)?.n ?? 0;
      if (n >= deps.maxMissionRevisions) blockers.push(`budget:revisions ${n} >= ${deps.maxMissionRevisions}`);
    }

    if (typeof deps.maxMissionReviewTokens === 'number' && deps.maxMissionReviewTokens > 0) {
      const tokens = d.db
        .query<{ tokens: number }, [string]>(
          `SELECT COALESCE(SUM(a.tokens_in + a.tokens_out), 0) AS tokens
             FROM agent_runs a JOIN review_jobs j ON j.job_id=a.job_id
            WHERE j.source='mission' AND j.job_id IN (
              SELECT review_job_id FROM ticket_revisions
               WHERE ticket_id IN (SELECT ticket_id FROM mission_tickets WHERE mission_id=?))`
        )
        .get(missionId)?.tokens ?? 0;
      if (tokens > deps.maxMissionReviewTokens) {
        blockers.push(`budget:review-tokens ${tokens} > ${deps.maxMissionReviewTokens}`);
      }
    }

    if (blockers.length) {
      updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: blockers.join('; ') });
      emitMissionEvent(d, 'mission.budget_blocked', { mission_id: missionId, blockers });
      return { action: 'budget-blocked', nextState: 'BLOCKED_EXTERNAL' };
    }
  }

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
      // Machine verification is not human acceptance: the board waits for the
      // operator's explicit decision before the ticket is CLOSED.
      clearHumanAcceptance(d, missionId);
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
    scheduleBlockedRetry(d, missionId, 'no runnable ticket: dependency graph unsatisfiable (cycles or missing mandatory dependency)');
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
    if (current.state === 'EVIDENCE_CAPTURED' && deps.verifyMode?.() === 'deferred') {
      updateRevision(d, current.revision_id, { state: 'PENDING_VERIFY' });
      updateTicket(d, target.ticket_id, { verification_state: 'PENDING_VERIFY' });
      emitMissionEvent(d, 'revision.deferred_verify', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
      return { action: 'deferred-verify-pending', nextState: mission.state };
    }
    const ws = deps.workspacePathFor(missionId);
    if (ws) {
      await executeMissionGates(d, deps, missionId, current.revision_id, ws);
      const reviewVerdict = await review({ missionId, ticketId: target.ticket_id, revisionId: current.revision_id, workspacePath: ws });
      if (getMission(d, missionId)?.state === 'CANCELLED') return { action: 'operator-cancelled', nextState: 'CANCELLED' };
      if (getTicket(d, target.ticket_id)?.objective !== target.objective) {
        updateRevision(d, current.revision_id, { state: 'SUPERSEDED' });
    cancelReviewForRevision(d, current.revision_id, 'revision superseded');
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
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
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
        const updatedGates = buildGateRows(d, current.revision_id, reviewVerdict, reviewVerdict.mandatoryGates);
        setQualityGate(d, current.revision_id, updatedGates);
        const verified = isRevisionVerified10(d, current.revision_id, reviewVerdict.mandatoryGates.length ? reviewVerdict.mandatoryGates : mandatory);
        if (reviewVerdict.verdict === 'PASS' && verified) {
          updateRevision(d, current.revision_id, { state: 'VERIFIED_10_10', completed_at: new Date().toISOString() });
          updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10', execution_state: 'AWAITING_ACCEPTANCE' });
          clearHumanAcceptance(d, missionId);
          updateMissionState(d, missionId, 'VERIFIED_10_10', { verified_at: new Date().toISOString() });
          emitMissionEvent(d, 'mission.verified_10_10', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
          return { action: 'verified-10-10-on-rereview', nextState: 'VERIFIED_10_10' };
        }
        // Decisive FINDINGS (or PASS but not evidence-verified): reject + replan.
        updateMissionState(d, missionId, 'REPLANNING');
        const failedKeys = updatedGates.filter((g) => g.status === 'FAIL').map((g) => g.gate_key);
        const sig = deriveFailureSignature(failedKeys, reviewVerdict.findings, [], []);
        updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, workspace_fingerprint_before: current.workspace_fingerprint_after || await fingerprintOrEmpty(ws) });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
        persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: `review-${reviewVerdict.verdict}`, findings: reviewVerdict.findings, failedGates: failedKeys, evidenceIds: [] });
        emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: `review-${reviewVerdict.verdict}` });
        current = getRevision(d, current.revision_id)!;
      }
    }
  }

  // ── 4. if already verified terminal, release next and continue. The human
  //       acceptance gate owns the final CLOSED transition.
  if (current.state === 'VERIFIED_10_10') {
    updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10', execution_state: 'AWAITING_ACCEPTANCE' });
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
    scheduleBlockedRetry(d, missionId, 'no-workspace-path');
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
      // Replan cap for the identical-signature loop (same guard as NO_CHANGE):
      // never burn unbounded revisions on a mutation that cannot produce a delta.
      if (current.revision_no >= MAX_PLAN_REVISIONS) {
        updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: `replan-exhausted: identical-failure-no-delta after ${current.revision_no} revisions (mutator not producing a recognized content delta)` });
        scheduleBlockedRetry(d, missionId, 'replan-exhausted');
        updateRevision(d, current.revision_id, { state: 'BLOCKED' });
        emitMissionEvent(d, 'mission.blocked', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, blocked_reason: 'replan-exhausted', revisions: current.revision_no });
        return { action: 'replan-exhausted-blocked', nextState: 'BLOCKED_EXTERNAL' };
      }
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
  const WATCHDOG_MS = deps.mutationWatchdogMs ?? 25 * 60_000;
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
    const workerRoute = deps.mutationRouteFor?.(missionId) ?? deps.mutationRoute;
    let mutProv = workerRoute?.providerID ?? '';
    let mutModel = workerRoute?.modelID ?? '';
    try {
      const mx = mission.engine_matrix_json ? JSON.parse(mission.engine_matrix_json) : {};
      const mut = mx?.mutation ?? mx?.mutator ?? {};
      if (mut?.providerID) mutProv = String(mut.providerID);
      if (mut?.modelID) mutModel = String(mut.modelID);
    } catch { /* keep the effective route */ }
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
    cancelReviewForRevision(d, current.revision_id, 'revision superseded');
    const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: 'operator-steering' });
    updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id, verification_state: 'UNVERIFIED' });
    updateMissionState(d, missionId, 'REPLANNING');
    return { action: 'operator-steering-replan', nextState: 'REPLANNING' };
  }
  updateRevision(d, current.revision_id, { workspace_fingerprint_after: result.workspaceFingerprintAfter || undefined, state: 'MUTATING' });

  // CONVERGENCE RECOVERY (P0): the deliverable may already be COMMITTED by an
  // earlier revision — the repo worktree is then clean, so a later revision
  // legitimately produces NO new delta. Replanning from that state can never
  // converge (nothing left to change, yet zero evidence ⇒ gates can never PASS).
  // When the workspace content differs from where this ticket BEGAN, treat the
  // existing tree as this revision's deliverable and run the real evidence +
  // review path on it: the review snapshot diffs base→head and the review hook
  // binds content-addressed evidence to those files. `current.revision_no > 1`
  // plus the fingerprint check ensure an untouched workspace can never "verify".
  if ((result.outcome === 'NO_CHANGE' || result.outcome === 'FAILED_PLAN') && current.revision_no > 1) {
    try {
      const first = d.db
        .query<{ workspace_fingerprint_before: string | null }, [string]>(
          `SELECT workspace_fingerprint_before FROM ticket_revisions WHERE ticket_id=? ORDER BY revision_no ASC LIMIT 1`
        )
        .get(target.ticket_id);
      // Use the runner's ALREADY-COMPUTED workspace fingerprint (sha256 hex) when
      // it is genuine; never re-hash the tree on every replan tick (that made the
      // NO_CHANGE loop measurably slower) and never accept a fake value.
      const looksRealFingerprint = (v: string | undefined): v is string =>
        typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
      const nowFp = looksRealFingerprint(result.workspaceFingerprintAfter) ? result.workspaceFingerprintAfter : '';
      if (first?.workspace_fingerprint_before && nowFp && nowFp !== first.workspace_fingerprint_before) {
        emitMissionEvent(d, 'revision.existing-tree-verified', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, from: result.outcome });
        result = { ...result, outcome: 'CHANGED', error: undefined };
      }
    } catch { /* any probe failure keeps the original no-delta outcome */ }
  }

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
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
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
      const blockerReason = result.blocker?.description ?? 'external blocker';
      updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: blockerReason, blocked_details: result.blocker ? JSON.stringify(result.blocker) : undefined });
      scheduleBlockedRetry(d, missionId, blockerReason);
      updateRevision(d, current.revision_id, { state: 'BLOCKED' });
      emitMissionEvent(d, 'mission.blocked', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, blocker: result.blocker });
      return { action: 'blocked-external', nextState: 'BLOCKED_EXTERNAL' };
    }
    case 'NO_CHANGE':
    case 'FAILED_PLAN':
    case 'SCRATCH_ONLY': {
      // FAIL-FAST consecutive no-delta guard: bump the streak; a mutator that
      // keeps producing NO recognized content delta (scratch-only / no-change)
      // parks BLOCKED after MAX_CONSECUTIVE_NO_DELTA_REPLANS instead of spinning
      // toward MAX_PLAN_REVISIONS (3000). A real delta (CHANGED) resets it.
      const streak = bumpReplanStreak(d, missionId);
      if (streak >= MAX_CONSECUTIVE_NO_DELTA_REPLANS) {
        updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: `replan-exhausted: ${result.outcome} after ${streak} consecutive no-delta replans (mutator not producing a recognized content delta)` });
        updateRevision(d, current.revision_id, { state: 'BLOCKED' });
        emitMissionEvent(d, 'mission.blocked', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, blocked_reason: 'replan-exhausted-no-delta', revisions: current.revision_no, streak });
        return { action: 'replan-exhausted-no-delta-blocked', nextState: 'BLOCKED_EXTERNAL' };
      }
      // Replan cap: a ticket that cannot produce a recognized delta after
      // MAX_PLAN_REVISIONS is NOT made to loop forever — surface it as BLOCKED
      // with a precise reason so the operator intervenes. This is the durable
      // guard against the observed 4000+ revision runaway (a hung mutator that
      // commits nothing advanceMission recognizes as a change).
      if (current.revision_no >= MAX_PLAN_REVISIONS) {
        updateMissionState(d, missionId, 'BLOCKED_EXTERNAL', { blocked_reason: `replan-exhausted: ${result.outcome} after ${current.revision_no} revisions (mutator not producing a recognized delta)` });
        updateRevision(d, current.revision_id, { state: 'BLOCKED' });
        emitMissionEvent(d, 'mission.blocked', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id, blocked_reason: 'replan-exhausted', revisions: current.revision_no });
        return { action: 'replan-exhausted-blocked', nextState: 'BLOCKED_EXTERNAL' };
      }
      updateMissionState(d, missionId, 'REPLANNING');
      if (request.activeHypotheses[0]) {
        upsertClaim(d, { mission_id: missionId, canonical_key: `falsified:${hypKey(request)}`, claim: request.activeHypotheses[0], status: 'FALSIFIED', revision_id: current.revision_id });
      }
      const sig = deriveFailureSignature(priorFailedGates(d, priorRevision), result.error ? [result.error] : [], ['no-change'], []);
      updateRevision(d, current.revision_id, { state: 'REJECTED', failure_signature: sig });
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
      const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: `hyp-${current.revision_no + 1}`, workspace_fingerprint_before: await fingerprintOrEmpty(workspace) });
      updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id });
      persistPlan(d, next.revision_id, { objective: target.objective ?? target.title, hypothesis_key: `hyp-${current.revision_no + 1}`, failure_signature: sig, reason: result.outcome, findings: request.currentFindings, failedGates: request.failedQualityGateKeys });
      emitMissionEvent(d, 'mission.replanned', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: next.revision_id, reason: result.outcome });
      return { action: `replanned-${result.outcome}`, nextState: 'REPLANNING' };
    }
    case 'CHANGED': {
      // A real content delta resets the consecutive no-delta streak (it broke
      // the spin and is now producing deliverables).
      resetReplanStreak(d, missionId);
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
      // WAR-mode deferred verification: the mutation CHANGED and evidence is captured
      // (durable + content-addressed). With verifyMode=deferred we do NOT spend the
      // review + executable-gate pass on this revision right now — park it PENDING_VERIFY
      // and let the Ender loop advance to the next ticket. The `verifyPending` sweep later
      // drives the whole batch through the real gates. The snapshot/evidence is frozen so
      // nothing is lost; we only defer WHEN we spend verification.
      if (deps.verifyMode?.() === 'deferred') {
        updateRevision(d, current.revision_id, { state: 'PENDING_VERIFY' });
        updateTicket(d, target.ticket_id, { verification_state: 'PENDING_VERIFY' });
        emitMissionEvent(d, 'revision.deferred_verify', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
        return { action: 'deferred-verify-pending', nextState: mission.state };
      }
      // EPISTEMIC convergence at the mission level: re-review the SAME immutable
      // snapshot/revision only when the verdict is epistemically invalid
      // (INCONCLUSIVE = reviewer could not decide). A valid FINDINGS or PASS is
      // accepted immediately. Bound the re-review budget; never reject a revision
      // merely because the FIRST review was inconclusive.
      await executeMissionGates(d, deps, missionId, current.revision_id, workspace);
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
    cancelReviewForRevision(d, current.revision_id, 'revision superseded');
        const next = createRevision(d, { ticket_id: target.ticket_id, parent_revision_id: current.revision_id, hypothesis_key: 'operator-steering' });
        updateTicket(d, target.ticket_id, { active_revision_id: next.revision_id, verification_state: 'UNVERIFIED' });
        updateMissionState(d, missionId, 'REPLANNING');
        return { action: 'operator-steering-replan', nextState: 'REPLANNING' };
      }
      // `evidence_id` in a gate ref MUST resolve to a real content-hashed artifact
      // for THIS revision (never a bare overall PASS).
      const updatedGates = buildGateRows(d, current.revision_id, verdict, verdict.mandatoryGates);
      setQualityGate(d, current.revision_id, updatedGates);
      const verified = isRevisionVerified10(d, current.revision_id, verdict.mandatoryGates.length ? verdict.mandatoryGates : mandatory);
      const allTicketsVerified = tickets.every((b) => (b.ticket_id === target.ticket_id && verified) || b.verification_state === 'VERIFIED_10_10');
      if (verified && verdict.verdict === 'PASS' && verdict.evidenceResolved) {
        updateRevision(d, current.revision_id, { state: 'VERIFIED_10_10', completed_at: new Date().toISOString() });
        updateTicket(d, target.ticket_id, { verification_state: 'VERIFIED_10_10', execution_state: 'AWAITING_ACCEPTANCE', active_revision_id: current.revision_id });
        emitMissionEvent(d, 'ticket.verified', { mission_id: missionId, ticket_id: target.ticket_id, revision_id: current.revision_id });
        if (allTicketsVerified) {
          clearHumanAcceptance(d, missionId);
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
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
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
        cancelReviewForRevision(d, current.revision_id, 'revision rejected');
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
export function captureEvidence(d: Db, revisionId: string, kind: string, relPath: string, workspace: string): string {
  const full = join(workspace, relPath);
  if (existsSync(full)) {
    try {
      // A DIRECTORY is never an evidence artifact. Git porcelain reports an
      // untracked directory as `?? src/` unless `-uall` is passed; reading it
      // would EISDIR and abort the whole controller tick.
      if (!statSync(full).isDirectory()) {
        const { sha256, bytes } = hashFileContent(full);
        // IDEMPOTENT capture: recovery + re-review passes re-capture the same
        // workspace delta. Without this the evidence manifest grows without bound
        // (observed: package.json repeated 80x) and every review slows down.
        const existing = d.db
          .query<{ artifact_id: string }, [string, string, string, number]>(
            `SELECT artifact_id FROM evidence_artifacts WHERE revision_id=? AND path=? AND sha256=? AND bytes=? LIMIT 1`
          )
          .get(revisionId, relPath, sha256, bytes);
        if (existing) return existing.artifact_id;
        const ev = addEvidence(d, { revision_id: revisionId, kind, path: relPath, sha256, bytes, producer: 'kilo-mutation', metadata: { workspace } });
        return ev.artifact_id;
      }
    } catch {
      /* fall through to the zero-byte marker */
    }
  }
  // The mutation reported the file but it is missing on disk (or is a directory):
  // record a zero-byte marker so verification can never fabricate evidence for it.
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
