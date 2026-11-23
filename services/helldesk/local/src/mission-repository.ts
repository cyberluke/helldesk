import type { Db } from './db';
import { generateId, now } from './ids';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeReviewControls, parseReviewControls, type ReviewControls } from './review-controls';

/**
 * Mission / Ticket / Revision durable repository (Ender long-horizon loop).
 *
 * Sits ABOVE the existing `review_jobs` level: a `review_job` is ONE immutable
 * review of ONE immutable revision, whereas a mission owns many tickets, each
 * ticket owns many revisions, each revision owns at most one review job.
 *
 * This is the TypeScript/agent layer — NOT Rust. Rust NAI-Lattice may be the
 * durable substrate for a separate deployment; this repository is the
 * authoritative mission state for the local `nai-helldesk` control plane and is
 * stored in the same SQLite DB as the reconciler (additive tables, never
 * altering PR #1's tables).
 *
 * Every mutation that crosses an irreversible boundary is persisted BEFORE the
 * next asynchronous operation is dispatched, so daemon death never loses the
 * mission.
 */

export type MissionState =
  | 'ACTIVE' | 'PLANNING' | 'MUTATING' | 'CAPTURING_EVIDENCE'
  | 'VERIFYING' | 'REPLANNING' | 'BLOCKED_EXTERNAL' | 'VERIFIED_10_10' | 'CANCELLED';

export type ExecutionState = 'OPEN' | 'READY' | 'RUNNING' | 'AWAITING_ACCEPTANCE' | 'FAILED' | 'CLOSED' | 'BLOCKED';
export type VerificationState = 'UNVERIFIED' | 'VERIFYING' | 'PENDING_VERIFY' | 'REJECTED' | 'SUPERSEDED' | 'VERIFIED_10_10';
export type RevisionState =
  | 'PLANNED' | 'MUTATING' | 'EVIDENCE_CAPTURED' | 'VERIFYING' | 'PENDING_VERIFY'
  | 'VERIFIED_10_10' | 'REJECTED' | 'SUPERSEDED' | 'BLOCKED';
export type GateStatus = 'UNVERIFIED' | 'PASS' | 'FAIL' | 'BLOCKED';

export interface MissionRow {
  mission_id: string;
  workspace_id: string;
  objective: string;
  state: MissionState;
  current_ticket_id: string | null;
  current_revision_id: string | null;
  policy_version: string;
  task_gates_json?: string;
  engine_matrix_json?: string;
  /** Per-task review policy (migration 0017): reviewerA/reviewerB/excellenceGovernor/agent gates. */
  controls_json?: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  blocked_reason: string | null;
  blocked_details: string | null;
  cancelled_at: string | null;
  /** Consecutive no-delta / scratch-only replan count (see migration 0010). */
  replan_streak?: number;
  /** Operator-chosen board column (migration 0014); display intent, never engine state. */
  operator_status?: string | null;
  operator_status_at?: string | null;
  /** Bounded auto-retry bookkeeping (migration 0015). */
  auto_retry_count?: number;
  next_retry_at?: string | null;
  /** Human acceptance gate (migration 0018): machine verification is not acceptance. */
  human_acceptance?: HumanAcceptanceDecision | null;
  human_acceptance_note?: string | null;
  human_accepted_at?: string | null;
  human_accepted_by?: string | null;
}

export type HumanAcceptanceDecision = 'accepted' | 'changes_requested';

export interface MissionAcceptanceEvent {
  event_id: string;
  mission_id: string;
  decision: HumanAcceptanceDecision;
  note: string | null;
  actor: string | null;
  created_at: string;
}

/**
 * Schedule a BOUNDED auto-retry for a transient BLOCKED_EXTERNAL mission.
 * Pathological loop exhaustion and budget breaches are deliberately NOT retried
 * (they need an operator decision); everything else gets 5/10/20-minute backoff,
 * capped at 3 attempts.
 */
export function scheduleBlockedRetry(d: Db, missionId: string, reason: string): void {
  const m = getMission(d, missionId);
  if (!m) return;
  const retryable = !/replan-exhausted|budget:|no-workspace|dependency|cycle/i.test(reason);
  const count = m.auto_retry_count ?? 0;
  if (!retryable || count >= 3) {
    d.db.query(`UPDATE autonomy_missions SET next_retry_at=NULL WHERE mission_id=?`).run(missionId);
    return;
  }
  const delayMs = Math.min(5 * 60_000 * 2 ** count, 60 * 60_000);
  d.db
    .query(`UPDATE autonomy_missions SET auto_retry_count=?, next_retry_at=? WHERE mission_id=?`)
    .run(count + 1, new Date(Date.now() + delayMs).toISOString(), missionId);
}

/**
 * Resume a blocked/stuck mission: ACTIVE + reconcile non-terminal revisions to
 * PLANNED. Shared by the operator's /resume and the bounded auto-retry sweep.
 */
export function resumeMissionState(d: Db, missionId: string): boolean {
  const m = getMission(d, missionId);
  if (!m) return false;
  const now = new Date().toISOString();
  d.tx(() => {
    d.db
      .query(
        `UPDATE autonomy_missions
            SET state='ACTIVE', blocked_reason=NULL, blocked_details=NULL,
                current_revision_id=NULL, next_retry_at=NULL, updated_at=?
          WHERE mission_id=?`
      )
      .run(now, missionId);
    for (const ticket of listTickets(d, missionId)) {
      if (!ticket.active_revision_id) continue;
      const rev = getRevision(d, ticket.active_revision_id);
      if (rev && ['MUTATING', 'EVIDENCE_CAPTURED', 'VERIFYING', 'BLOCKED'].includes(rev.state)) {
        updateRevision(d, rev.revision_id, { state: 'PLANNED' });
      }
    }
  });
  return true;
}

/** Record (or clear) the operator's chosen board column. Engine state is untouched. */
export function setMissionOperatorStatus(d: Db, missionId: string, status: string | null): void {
  d.db
    .query(`UPDATE autonomy_missions SET operator_status=?, operator_status_at=? WHERE mission_id=?`)
    .run(status, new Date().toISOString(), missionId);
}

/** True while a machine-verified mission is still waiting for the human decision. */
export function isAwaitingHumanAcceptance(mission: Pick<MissionRow, 'state' | 'human_acceptance'>): boolean {
  return mission.state === 'VERIFIED_10_10' && mission.human_acceptance !== 'accepted';
}

/** A re-opened / re-verified mission must ask the human again. */
export function clearHumanAcceptance(d: Db, missionId: string): void {
  d.db
    .query(
      `UPDATE autonomy_missions
          SET human_acceptance=NULL, human_acceptance_note=NULL,
              human_accepted_at=NULL, human_accepted_by=NULL
        WHERE mission_id=?`
    )
    .run(missionId);
}

export function listMissionAcceptanceEvents(d: Db, missionId: string): MissionAcceptanceEvent[] {
  return d.db
    .query<MissionAcceptanceEvent, [string]>(
      `SELECT event_id, mission_id, decision, note, actor, created_at
         FROM mission_acceptance_events WHERE mission_id=? ORDER BY created_at ASC, rowid ASC`
    )
    .all(missionId);
}

/**
 * The explicit HITL acceptance gate. Machine VERIFIED_10_10 is NOT acceptance:
 *
 *   accepted          → record the human decision and close the verified tickets.
 *   changes_requested → record the decision, reopen the mission with a
 *                       first-class follow-up ticket carrying the operator note.
 *                       The previously verified revision stays immutable/audited.
 */
export function recordMissionAcceptance(
  d: Db,
  input: { missionId: string; decision: HumanAcceptanceDecision; note?: string | null; actor?: string | null },
): { event: MissionAcceptanceEvent; mission: MissionRow } {
  const mission = getMission(d, input.missionId);
  if (!mission) throw new Error(`mission not found: ${input.missionId}`);
  if (input.decision === 'accepted' && mission.human_acceptance === 'accepted') {
    const previous = listMissionAcceptanceEvents(d, input.missionId).filter((e) => e.decision === 'accepted').at(-1);
    if (previous) return { event: previous, mission };
  }
  if (mission.state !== 'VERIFIED_10_10') {
    throw new Error(`mission is ${mission.state}, not awaiting human acceptance`);
  }
  const note = input.note?.trim() || null;
  if (input.decision === 'changes_requested' && !note) {
    throw new Error('a change request requires a note');
  }
  const event: MissionAcceptanceEvent = {
    event_id: generateId('acceptance'),
    mission_id: input.missionId,
    decision: input.decision,
    note,
    actor: input.actor?.trim() || null,
    created_at: now(),
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO mission_acceptance_events (event_id, mission_id, decision, note, actor, created_at)
       VALUES (?,?,?,?,?,?)`
    ).run(event.event_id, event.mission_id, event.decision, event.note, event.actor, event.created_at);
    if (input.decision === 'accepted') {
      t.query(
        `UPDATE autonomy_missions
            SET human_acceptance='accepted', human_acceptance_note=?, human_accepted_at=?, human_accepted_by=?, updated_at=?
          WHERE mission_id=?`
      ).run(note, event.created_at, event.actor, event.created_at, input.missionId);
      t.query(
        `UPDATE mission_tickets
            SET execution_state='CLOSED', updated_at=?
          WHERE mission_id=? AND verification_state='VERIFIED_10_10'`
      ).run(event.created_at, input.missionId);
    } else {
      t.query(
        `UPDATE autonomy_missions
            SET human_acceptance='changes_requested', human_acceptance_note=?, human_accepted_at=?, human_accepted_by=?,
                state='ACTIVE', verified_at=NULL, updated_at=?
          WHERE mission_id=?`
      ).run(note, event.created_at, event.actor, event.created_at, input.missionId);
    }
  });
  if (input.decision === 'accepted') {
    emitMissionEvent(d, 'mission.human_accepted', {
      mission_id: input.missionId,
      actor: event.actor,
      note,
      accepted_at: event.created_at,
    });
  } else {
    // A change request is real follow-up work, not a silent note: it becomes a
    // first-class ticket the mission controller will plan and implement.
    emitMissionEvent(d, 'mission.changes_requested', {
      mission_id: input.missionId,
      actor: event.actor,
      note,
      requested_at: event.created_at,
    });
    updateMissionState(d, input.missionId, 'ACTIVE');
    addTicket(d, input.missionId, {
      title: 'Operator change request',
      objective: note ?? 'Operator requested changes',
      priority: 100,
    });
  }
  return { event, mission: getMission(d, input.missionId)! };
}

/** Read a mission's persisted consecutive no-delta replan streak. */
export function getReplanStreak(d: Db, missionId: string): number {
  const row = (d.db.query<{ replan_streak?: number | null }, [string]>('SELECT replan_streak FROM autonomy_missions WHERE mission_id=?').get(missionId) ?? {}) as { replan_streak?: number | null };
  return row.replan_streak ?? 0;
}

/** Increment the no-delta replan streak (bounded/positive). */
export function bumpReplanStreak(d: Db, missionId: string): number {
  const next = getReplanStreak(d, missionId) + 1;
  d.db.query<unknown, [number, string]>('UPDATE autonomy_missions SET replan_streak=? WHERE mission_id=?').run(next, missionId);
  return next;
}

/** Reset the no-delta streak to 0 after a real delta / terminal verdict. */
export function resetReplanStreak(d: Db, missionId: string): void {
  d.db.query<unknown, [string]>('UPDATE autonomy_missions SET replan_streak=0 WHERE mission_id=?').run(missionId);
}

export interface TicketRow {
  ticket_id: string;
  mission_id: string;
  title: string;
  objective: string | null;
  execution_state: ExecutionState;
  verification_state: VerificationState;
  active_revision_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  /** Operator dispatch override: the chosen agent (e.g. Toast) responsible for
   *  this ticket. NULL = unassigned (mission engine matrix auto-dispatch). */
  assignee_agent_id?: string | null;
  assigned_at?: string | null;
  assigned_by?: string | null;
  /** LLM/operator T-shirt estimate (migration 0020). Null = unsized. */
  story_points?: number | null;
  tshirt_size?: string | null;
  size_confidence?: string | null;
  size_rationale?: string | null;
  size_model?: string | null;
  sized_at?: string | null;
  sizing_state?: string | null;
}

/** Record an operator dispatch override on a mission ticket. Returns the ticket. */
export function assignTicketToAgent(
  d: Db,
  ticketId: string,
  agentId: string,
  opts?: { by?: string },
): TicketRow | null {
  const ticket = getTicket(d, ticketId);
  if (!ticket) return null;
  const now = new Date().toISOString();
  d.db.query<unknown, [string | null, string, string | null, string, string]>(
    'UPDATE mission_tickets SET assignee_agent_id=?, assigned_at=COALESCE(assigned_at,?), assigned_by=?, updated_at=? WHERE ticket_id=?'
  ).run(agentId, now, opts?.by ?? 'operator', now, ticketId);
  // return the refreshed row so callers see the assignment without a re-fetch.
  return { ...ticket, assignee_agent_id: agentId, assigned_at: now, assigned_by: opts?.by ?? 'operator' };
}

/** Read a ticket's assignment (assignee + when/by). Empty when unassigned. */
export function getTicketAssignment(d: Db, ticketId: string): { assignee_agent_id?: string | null; assigned_at?: string | null; assigned_by?: string | null } {
  const row = getTicket(d, ticketId);
  return {
    assignee_agent_id: row?.assignee_agent_id ?? null,
    assigned_at: row?.assigned_at ?? null,
    assigned_by: row?.assigned_by ?? null,
  };
}

export interface RevisionRow {
  revision_id: string;
  ticket_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  plan_id: string | null;
  hypothesis_key: string | null;
  failure_signature: string | null;
  snapshot_id: string | null;
  review_job_id: string | null;
  workspace_fingerprint_before: string | null;
  workspace_fingerprint_after: string | null;
  state: RevisionState;
  created_at: string;
  completed_at: string | null;
}

export interface QualityGateRow {
  revision_id: string;
  gate_key: string;
  status: GateStatus;
  evidence_refs_json: string | null;
  evaluator: string | null;
  checked_at: string;
}

export interface EvidenceRow {
  artifact_id: string;
  revision_id: string;
  kind: string;
  path: string | null;
  sha256: string;
  bytes: number;
  producer: string | null;
  command: string | null;
  exit_code: number | null;
  created_at: string;
  metadata_json: string | null;
}

export interface ClaimRow {
  claim_id: string;
  mission_id: string;
  canonical_key: string;
  revision_id: string | null;
  status: 'HYPOTHESIS' | 'VERIFIED' | 'FALSIFIED' | 'SUPERSEDED';
  claim: string;
  evidence_refs_json: string | null;
  contradicts_json: string | null;
  supersedes_claim_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
}

/** Emit a durable outbox event (projected by the SSE endpoint + metrics). */
export function emitMissionEvent(
  d: Db,
  eventType: string,
  payload: Record<string, unknown>,
): number {
  return d.tx((t) => {
    const res = t
      .query<{ seq: number }, [string, string, string]>(
        `INSERT INTO events_outbox (event_type, payload, created_at) VALUES (?, ?, ?) RETURNING seq`
      )
      .get(eventType, JSON.stringify(payload), now());
    return res?.seq ?? 0;
  });
}

// ── Missions ─────────────────────────────────────────────────────────────────
/** Create a complete mission graph atomically, or replay its durable identity.
 * The original request hash remains immutable even when later steering changes
 * the mission objective. A retry never creates a second mutation mission. */
export function createMissionRequest(d: Db, input: {
  workspaceId: string; objective: string; taskGates: string[]; idempotencyKey?: string;
  tickets: Array<{
    title: string;
    objective: string;
    dependsOn: string[];
    storyPoints?: number | null;
    tshirtSize?: string | null;
    sizeConfidence?: string | null;
    sizeRationale?: string | null;
    sizeModel?: string | null;
    sizingState?: string | null;
  }>;
  /** Provider-agnostic per-stage engine selection (serialized to engine_matrix_json). */
  engineMatrix?: Record<string, unknown>;
  /** Per-task review policy (serialized to controls_json). Mutable live. */
  controls?: ReviewControls;
}): { conflict: true } | { conflict: false; missionId: string; ticketIds: string[]; reused: boolean } {
  const requestHash = createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId, objective: input.objective,
    taskGates: input.taskGates, tickets: input.tickets, engineMatrix: input.engineMatrix ?? {},
  })).digest('hex');
  return d.tx(db => {
    if (input.idempotencyKey) {
      const previous = db.query<{ mission_id: string; request_hash: string }, [string]>(
        'SELECT mission_id, request_hash FROM autonomy_missions WHERE idempotency_key=?'
      ).get(input.idempotencyKey);
      if (previous) {
        if (previous.request_hash !== requestHash) return { conflict: true };
        // Controls are live operator policy, not part of the immutable request
        // identity. Re-applying the same request updates them on the existing mission.
        if (input.controls) setMissionReviewControls(d, previous.mission_id, input.controls);
        return { conflict: false, missionId: previous.mission_id, ticketIds: listTickets(d, previous.mission_id).map(ticket => ticket.ticket_id), reused: true };
      }
    }
    const mission = createMission(d, {
      workspace_id: input.workspaceId, objective: input.objective, taskGates: input.taskGates,
      engineMatrix: input.engineMatrix, controls: input.controls,
    });
    if (input.idempotencyKey) db.query('UPDATE autonomy_missions SET idempotency_key=?, request_hash=? WHERE mission_id=?').run(input.idempotencyKey, requestHash, mission.mission_id);
    const ticketIds = input.tickets.map(ticket => addTicket(d, mission.mission_id, {
      title: ticket.title,
      objective: ticket.objective,
      depends_on: ticket.dependsOn,
      storyPoints: ticket.storyPoints,
      tshirtSize: ticket.tshirtSize,
      sizeConfidence: ticket.sizeConfidence,
      sizeRationale: ticket.sizeRationale,
      sizeModel: ticket.sizeModel,
      sizingState: ticket.sizingState,
    }).ticket_id);
    return { conflict: false, missionId: mission.mission_id, ticketIds, reused: false };
  });
}

export function createMission(
  d: Db,
  input: {
    workspace_id: string; objective: string; policy_version?: string; taskGates?: string[];
    engineMatrix?: Record<string, unknown>;
    controls?: ReviewControls;
  },
): MissionRow {
  const mission_id = generateId('mis');
  const ts = now();
  const mission: MissionRow = {
    mission_id,
    workspace_id: input.workspace_id,
    objective: input.objective,
    state: 'ACTIVE',
    current_ticket_id: null,
    current_revision_id: null,
    policy_version: input.policy_version ?? 'ender-1',
    task_gates_json: JSON.stringify(input.taskGates || []),
    engine_matrix_json: JSON.stringify(input.engineMatrix ?? {}),
    controls_json: JSON.stringify(normalizeReviewControls(input.controls)),
    created_at: ts,
    updated_at: ts,
    verified_at: null,
    blocked_reason: null,
    blocked_details: null,
    cancelled_at: null,
  };
  d.tx((t) => {
    t.query(
      /* sql */ `INSERT INTO autonomy_missions
       (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at, task_gates_json, engine_matrix_json, controls_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(mission.mission_id, mission.workspace_id, mission.objective, mission.state, mission.policy_version, mission.created_at, mission.updated_at, mission.task_gates_json || '[]', mission.engine_matrix_json || '{}', mission.controls_json || '{}');
  });
  emitMissionEvent(d, 'mission.created', { mission_id, objective: input.objective });
  return mission;
}

/** The mission's persisted review policy (defaults = all stages enabled). */
export function getMissionReviewControls(d: Db, missionId: string): ReviewControls {
  const row = d.db
    .query<{ controls_json: string | null }, [string]>('SELECT controls_json FROM autonomy_missions WHERE mission_id=?')
    .get(missionId);
  return parseReviewControls(row?.controls_json);
}

/**
 * Persist a new review policy and push it onto any not-yet-decided review job for
 * the mission's active revisions. A running A/B attempt is not interrupted (the
 * policy applies to the next review boundary); a QUEUED / retryable job picks it
 * up before its stages start.
 */
export function setMissionReviewControls(d: Db, missionId: string, controls: ReviewControls): ReviewControls {
  const merged = normalizeReviewControls(controls);
  d.db
    .query('UPDATE autonomy_missions SET controls_json=?, updated_at=? WHERE mission_id=?')
    .run(JSON.stringify(merged), now(), missionId);
  syncControlsToOpenReviewJobs(d, missionId, merged);
  emitMissionEvent(d, 'mission.controls_updated', { mission_id: missionId, controls: merged });
  return merged;
}

/** Propagate live controls to open review jobs linked to this mission's revisions. */
function syncControlsToOpenReviewJobs(d: Db, missionId: string, controls: ReviewControls): void {
  try {
    const rows = d.db
      .query<{ job_id: string; meta: string | null }, [string]>(
        `SELECT DISTINCT j.job_id, j.meta
           FROM review_jobs j
           JOIN ticket_revisions r ON r.review_job_id = j.job_id
           JOIN mission_tickets t ON t.active_revision_id = r.revision_id
          WHERE t.mission_id = ?
            AND j.state IN ('QUEUED','REVIEWING_A_B','ADJUDICATING','INCONCLUSIVE')`
      )
      .all(missionId);
    for (const row of rows) {
      let meta: Record<string, unknown> = {};
      try { meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
      meta.controls = controls;
      d.db.query('UPDATE review_jobs SET meta=?, updated_at=? WHERE job_id=?').run(JSON.stringify(meta), now(), row.job_id);
    }
  } catch {
    /* policy propagation is best effort; the hook re-reads the mission at review time */
  }
}

/**
 * Map a revision's failure_signature to a DISTINCT, operator-visible diagnosis.
 * Failure signatures are `failedGates|findings|changedFiles|errorClasses` (the
 * output of deriveFailureSignature). We previously surfaced only opaque raw
 * signatures (e.g. `[]|[]|[no-change]|[]`) — this turns each into a named issue
 * so the operator-console can tell "agent edited an EMPTY workspace" from "the
 * kilo server never booted" from "genuine no-op despite real content".
 */
export type FailureDiagnosis =
  | { kind: 'ok'; label: string }
  | { kind: 'empty-workspace-no-change'; label: string }
  | { kind: 'server-boot-timeout'; label: string }
  | { kind: 'agent-binary-missing'; label: string }
  | { kind: 'no-change'; label: string }
  | { kind: 'review-reject'; label: string }
  | { kind: 'quality-gate-fail'; label: string }
  | { kind: 'transient'; label: string }
  | { kind: 'blocked'; label: string }
  | { kind: 'unknown'; label: string };

/**
 * Human-readable failure diagnosis for a rejected revision.
 * `emptyWorkspace` must be TRUE only when the workspace actually has NO tracked
 * files (empty/missing checkout) — NOT merely when before===after. A populated
 * workspace whose agent produced no delta is `no-change`, which is a different,
 * real problem (the extraction/isolation loop), not an empty-workspace signal.
 * `workspaceTrackedCount` carries the real tracked-file count so the operator
 * room can see whether the workspace is genuinely empty or merely unchanged.
 */
export function diagnoseFailure(failureSignature: string | null | undefined, emptyWorkspace: boolean, workspaceTrackedCount = 0): FailureDiagnosis {
  const sig = failureSignature ?? '';
  if (!sig || sig === '[]|[]|[]|[]') return { kind: 'ok', label: 'in progress / no rejection recorded' };
  const parts = sig.split('|').map((s) => (s ?? '').slice(2, -2)); // strip [] and quotes
  const gates = parts[0] ?? '';
  const findings = parts[1] ?? '';
  const changed = parts[2] ?? '';
  const errors = parts[3] ?? '';
  // `no-change` declared in the changed slot takes precedence over incidental
  // keyword matches in the error text (the new write-chase surfaces agent replies
  // in `error`, which can legitimately mention "timeout"/"transient"/"plan").
  if (/no-change/i.test(changed)) {
    // The controller puts the mutation result.error (agent write-chase replies)
    // in the FINDINGS slot for a no-change; the errors slot is unused. Surface it.
    const brief = (findings && findings.length > 2 ? ` ${findings.slice(0, 260)}` : (errors ? ` ${errors.slice(0, 260)}` : ''));
    return emptyWorkspace
      ? { kind: 'empty-workspace-no-change', label: `agent edited an EMPTY workspace (${workspaceTrackedCount} tracked files) — output checkout missing baseline${brief}` }
      : { kind: 'no-change', label: `mutation ran but produced NO delta against a populated workspace (${workspaceTrackedCount} tracked files)${brief}` };
  }
  if (/timeout|server.*start/i.test(errors + findings)) return { kind: 'server-boot-timeout', label: `runtime server failed to start in time — ${(errors + ' ' + findings).trim()}` };
  if (/ENOENT|spawn.*failed|not found/i.test(errors + findings)) return { kind: 'agent-binary-missing', label: `agent binary missing/unrunnable — ${(errors + ' ' + findings).trim()}` };
  if (/blocked/i.test(errors)) return { kind: 'blocked', label: `blocked by external condition — ${errors.slice(0, 200)}` };
  if (/transient|socket|ECONN|provider_unreachable|temporarily unavailable/i.test(errors + findings)) return { kind: 'transient', label: `transient/network — ${(errors + ' ' + findings).trim()}` };
  if (findings && findings.length > 2) return { kind: 'review-reject', label: `review rejected: ${findings.slice(0, 200)}` };
  if (gates && gates.length > 2) return { kind: 'quality-gate-fail', label: `quality gate failed: ${gates.slice(0, 200)}` };
  return { kind: 'unknown', label: sig };
}

export function getMission(d: Db, mission_id: string): MissionRow | undefined {
  return d.db.query<MissionRow, [string]>(`SELECT * FROM autonomy_missions WHERE mission_id=?`).get(mission_id) as MissionRow | undefined;
}

export function listMissions(d: Db, state?: MissionState): MissionRow[] {
  if (state) {
    return d.db
      .query<MissionRow, [string]>(`SELECT * FROM autonomy_missions WHERE state=? ORDER BY created_at DESC`)
      .all(state) as MissionRow[];
  }
  return d.db.query(`SELECT * FROM autonomy_missions ORDER BY created_at DESC`).all() as MissionRow[];
}

export function updateMissionState(
  d: Db,
  mission_id: string,
  state: MissionState,
  extra?: Partial<Pick<MissionRow, 'blocked_reason' | 'blocked_details' | 'verified_at' | 'cancelled_at' | 'current_ticket_id' | 'current_revision_id'>>,
): MissionRow | undefined {
  const m = getMission(d, mission_id);
  if (!m) return undefined;
  m.state = state;
  m.updated_at = now();
  if (extra?.blocked_reason !== undefined) m.blocked_reason = extra.blocked_reason;
  if (extra?.blocked_details !== undefined) m.blocked_details = extra.blocked_details;
  if (extra?.verified_at !== undefined) m.verified_at = extra.verified_at;
  if (extra?.cancelled_at !== undefined) m.cancelled_at = extra.cancelled_at;
  if (extra?.current_ticket_id !== undefined) m.current_ticket_id = extra.current_ticket_id;
  if (extra?.current_revision_id !== undefined) m.current_revision_id = extra.current_revision_id;
  d.tx((t) => {
    t.query(
      `UPDATE autonomy_missions
       SET state=?, updated_at=?, current_ticket_id=?, current_revision_id=?, verified_at=?, blocked_reason=?, blocked_details=?, cancelled_at=?
       WHERE mission_id=?`
    ).run(m.state, m.updated_at, m.current_ticket_id, m.current_revision_id, m.verified_at, m.blocked_reason, m.blocked_details, m.cancelled_at, mission_id);
  });
  emitMissionEvent(d, 'mission.state_changed', { mission_id, state, updated_at: m.updated_at });
  return m;
}

// ── Tickets ────────────────────────────────────────────────────────────────────
export function addTicket(
  d: Db,
  mission_id: string,
  input: {
    title: string;
    objective?: string;
    priority?: number;
    depends_on?: string[];
    storyPoints?: number | null;
    tshirtSize?: string | null;
    sizeConfidence?: string | null;
    sizeRationale?: string | null;
    sizeModel?: string | null;
    sizingState?: string | null;
  },
): TicketRow {
  const ticket_id = generateId('ticket');
  const ts = now();
  const ticket: TicketRow = {
    ticket_id,
    mission_id,
    title: input.title,
    objective: input.objective ?? null,
    execution_state: 'OPEN',
    verification_state: 'UNVERIFIED',
    active_revision_id: null,
    priority: input.priority ?? 0,
    created_at: ts,
    updated_at: ts,
    story_points: input.storyPoints ?? null,
    tshirt_size: input.tshirtSize ?? null,
    size_confidence: input.sizeConfidence ?? null,
    size_rationale: input.sizeRationale ?? null,
    size_model: input.sizeModel ?? null,
    sized_at: input.storyPoints != null ? ts : null,
    sizing_state: input.sizingState ?? (input.storyPoints != null ? 'sized' : 'unsized'),
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO mission_tickets
       (ticket_id, mission_id, title, objective, execution_state, verification_state, priority, created_at, updated_at,
        story_points, tshirt_size, size_confidence, size_rationale, size_model, sized_at, sizing_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      ticket.ticket_id, ticket.mission_id, ticket.title, ticket.objective, ticket.execution_state, ticket.verification_state,
      ticket.priority, ticket.created_at, ticket.updated_at,
      ticket.story_points ?? null, ticket.tshirt_size ?? null, ticket.size_confidence ?? null,
      ticket.size_rationale ?? null, ticket.size_model ?? null, ticket.sized_at ?? null, ticket.sizing_state ?? 'unsized',
    );
    for (const dep of input.depends_on ?? []) {
      t.query(
        `INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_ticket_id, dependency_type) VALUES (?,?,?)`
      ).run(ticket.ticket_id, dep, 'mandatory');
    }
  });
  emitMissionEvent(d, 'ticket.ready', { mission_id, ticket_id, title: ticket.title });
  return ticket;
}

export function getTicket(d: Db, ticket_id: string): TicketRow | undefined {
  return d.db.query<TicketRow, [string]>(`SELECT * FROM mission_tickets WHERE ticket_id=?`).get(ticket_id) as TicketRow | undefined;
}

export function listTickets(d: Db, mission_id: string, orderByPriority = true): TicketRow[] {
  const rows = d.db
    .query<TicketRow, [string]>(`SELECT * FROM mission_tickets WHERE mission_id=? ORDER BY priority DESC, created_at ASC`)
    .all(mission_id) as TicketRow[];
  return orderByPriority ? rows : rows.reverse();
}

/** Operator/LLM size update. Missing fields keep the existing value. */
export function updateTicketSize(
  d: Db,
  ticketId: string,
  size: {
    tshirt?: string | null;
    storyPoints?: number | null;
    confidence?: string | null;
    rationale?: string | null;
    model?: string | null;
    state?: string | null;
  },
): TicketRow | null {
  const ticket = getTicket(d, ticketId);
  if (!ticket) return null;
  const ts = now();
  const storyPoints = size.storyPoints !== undefined ? size.storyPoints : ticket.story_points ?? null;
  const tshirt = size.tshirt !== undefined ? size.tshirt : ticket.tshirt_size ?? null;
  const sizingState = size.state ?? (storyPoints != null ? 'manual' : 'unsized');
  d.db
    .query(
      `UPDATE mission_tickets
          SET story_points=?, tshirt_size=?, size_confidence=?, size_rationale=?, size_model=?,
              sized_at=?, sizing_state=?, updated_at=?
        WHERE ticket_id=?`
    )
    .run(
      storyPoints,
      tshirt,
      size.confidence !== undefined ? size.confidence : ticket.size_confidence ?? null,
      size.rationale !== undefined ? size.rationale : ticket.size_rationale ?? null,
      size.model !== undefined ? size.model : ticket.size_model ?? null,
      storyPoints != null ? ts : null,
      sizingState,
      ts,
      ticketId,
    );
  emitMissionEvent(d, 'ticket.sized', {
    mission_id: ticket.mission_id,
    ticket_id: ticketId,
    story_points: storyPoints,
    tshirt_size: tshirt,
    sizing_state: sizingState,
  });
  return getTicket(d, ticketId) ?? null;
}

/** Backfill input: tickets that still have no point estimate. */
export function listUnsizedTickets(d: Db, limit = 20): TicketRow[] {
  return d.db
    .query<TicketRow, [number]>(
      `SELECT * FROM mission_tickets
        WHERE story_points IS NULL OR sizing_state IN ('unsized','pending')
        ORDER BY created_at ASC LIMIT ?`
    )
    .all(limit) as TicketRow[];
}

export function getDependencies(d: Db, ticket_id: string): string[] {
  const rows = d.db
    .query<{ depends_on_ticket_id: string }, [string]>(`SELECT depends_on_ticket_id FROM ticket_dependencies WHERE ticket_id=? AND dependency_type='mandatory'`)
    .all(ticket_id);
  return rows.map((r) => r.depends_on_ticket_id);
}

export function updateTicket(
  d: Db,
  ticket_id: string,
  update: Partial<Pick<TicketRow, 'execution_state' | 'verification_state' | 'active_revision_id' | 'title' | 'objective'>>,
): TicketRow | undefined {
  const b = getTicket(d, ticket_id);
  if (!b) return undefined;
  const prevVerif = b.verification_state;
  if (update.execution_state !== undefined) b.execution_state = update.execution_state;
  if (update.verification_state !== undefined) b.verification_state = update.verification_state;
  if (update.active_revision_id !== undefined) b.active_revision_id = update.active_revision_id;
  if (update.title !== undefined) b.title = update.title;
  if (update.objective !== undefined) b.objective = update.objective;
  b.updated_at = now();
  d.tx((t) => {
    t.query(
      `UPDATE mission_tickets SET execution_state=?, verification_state=?, active_revision_id=?, title=?, objective=?, updated_at=? WHERE ticket_id=?`
    ).run(b.execution_state, b.verification_state, b.active_revision_id, b.title, b.objective, b.updated_at, ticket_id);
  });
  emitMissionEvent(d, 'ticket.verification_changed', { mission_id: b.mission_id, ticket_id, execution_state: b.execution_state, verification_state: b.verification_state, active_revision_id: b.active_revision_id });
  if (prevVerif !== b.verification_state) {
    emitMissionEvent(d, b.verification_state === 'VERIFIED_10_10' ? 'ticket.verified' : 'ticket.verification_changed', { mission_id: b.mission_id, ticket_id, verification_state: b.verification_state });
  }
  return b;
}

// ── Revisions (immutable) ────────────────────────────────────────────────────
export function createRevision(
  d: Db,
  input: {
    ticket_id: string;
    parent_revision_id?: string | null;
    hypothesis_key?: string | null;
    failure_signature?: string | null;
    workspace_fingerprint_before?: string | null;
  },
): RevisionRow {
  const ticket = getTicket(d, input.ticket_id);
  if (!ticket) throw new Error(`ticket not found: ${input.ticket_id}`);
  const max = d.db
    .query<{ n: number }, [string]>(`SELECT COALESCE(MAX(revision_no),0) AS n FROM ticket_revisions WHERE ticket_id=?`)
    .get(input.ticket_id)?.n ?? 0;
  const revision: RevisionRow = {
    revision_id: generateId('rev'),
    ticket_id: input.ticket_id,
    revision_no: max + 1,
    parent_revision_id: input.parent_revision_id ?? null,
    plan_id: null,
    hypothesis_key: input.hypothesis_key ?? null,
    failure_signature: input.failure_signature ?? null,
    snapshot_id: null,
    review_job_id: null,
    workspace_fingerprint_before: input.workspace_fingerprint_before ?? null,
    workspace_fingerprint_after: null,
    state: 'PLANNED',
    created_at: now(),
    completed_at: null,
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO ticket_revisions
       (revision_id, ticket_id, revision_no, parent_revision_id, hypothesis_key, failure_signature, snapshot_id, review_job_id, workspace_fingerprint_before, state, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(revision.revision_id, revision.ticket_id, revision.revision_no, revision.parent_revision_id, revision.hypothesis_key, revision.failure_signature, revision.snapshot_id, revision.review_job_id, revision.workspace_fingerprint_before, revision.state, revision.created_at);
    // Advise the ticket of its new active revision immediately (before dispatch).
    t.query(`UPDATE mission_tickets SET active_revision_id=?, updated_at=? WHERE ticket_id=?`).run(revision.revision_id, revision.created_at, input.ticket_id);
  });
  emitMissionEvent(d, 'revision.created', { mission_id: ticket.mission_id, ticket_id: input.ticket_id, revision_id: revision.revision_id, revision_no: revision.revision_no });
  return revision;
}

export function getRevision(d: Db, revision_id: string): RevisionRow | undefined {
  return d.db.query<RevisionRow, [string]>(`SELECT * FROM ticket_revisions WHERE revision_id=?`).get(revision_id) as RevisionRow | undefined;
}

export function listRevisions(d: Db, ticket_id: string): RevisionRow[] {
  return d.db
    .query<RevisionRow, [string]>(`SELECT * FROM ticket_revisions WHERE ticket_id=? ORDER BY revision_no ASC`)
    .all(ticket_id);
}

export function updateRevision(
  d: Db,
  revision_id: string,
  update: Partial<Pick<RevisionRow, 'state' | 'snapshot_id' | 'review_job_id' | 'plan_id' | 'workspace_fingerprint_after' | 'completed_at' | 'failure_signature' | 'hypothesis_key'>>,
): RevisionRow | undefined {
  const r = getRevision(d, revision_id);
  if (!r) return undefined;
  if (update.state !== undefined) r.state = update.state;
  if (update.snapshot_id !== undefined) r.snapshot_id = update.snapshot_id;
  if (update.review_job_id !== undefined) r.review_job_id = update.review_job_id;
  if (update.plan_id !== undefined) r.plan_id = update.plan_id;
  if (update.workspace_fingerprint_after !== undefined) r.workspace_fingerprint_after = update.workspace_fingerprint_after;
  if (update.completed_at !== undefined) r.completed_at = update.completed_at;
  if (update.failure_signature !== undefined) r.failure_signature = update.failure_signature;
  if (update.hypothesis_key !== undefined) r.hypothesis_key = update.hypothesis_key;
  d.tx((t) => {
    t.query(
      `UPDATE ticket_revisions SET state=?, snapshot_id=?, review_job_id=?, plan_id=?, workspace_fingerprint_after=?, completed_at=?, failure_signature=?, hypothesis_key=? WHERE revision_id=?`
    ).run(r.state, r.snapshot_id, r.review_job_id, r.plan_id, r.workspace_fingerprint_after, r.completed_at, r.failure_signature, r.hypothesis_key, revision_id);
  });
  const ticket = getTicket(d, r.ticket_id);
  const stateEvent = r.state === 'VERIFIED_10_10' ? 'revision.verified' : (r.state === 'REJECTED' ? 'revision.rejected' : 'revision.created');
  emitMissionEvent(d, stateEvent, { mission_id: ticket?.mission_id, ticket_id: r.ticket_id, revision_id, revision_no: r.revision_no, state: r.state, snapshot_id: r.snapshot_id, review_job_id: r.review_job_id });
  return r;
}

// ── Quality gates (revision-scoped) ──────────────────────────────────────────
export function setQualityGate(
  d: Db,
  revision_id: string,
  gates: Array<{ gate_key: string; status: GateStatus; evidence_refs?: string[]; evaluator?: string }>,
): void {
  d.tx((t) => {
    for (const g of gates) {
      t.query(
        `INSERT INTO quality_gate_results (revision_id, gate_key, status, evidence_refs_json, evaluator, checked_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(revision_id, gate_key)
         DO UPDATE SET status=excluded.status, evidence_refs_json=excluded.evidence_refs_json, evaluator=excluded.evaluator, checked_at=excluded.checked_at`
      ).run(revision_id, g.gate_key, g.status, JSON.stringify(g.evidence_refs ?? []), g.evaluator ?? 'quality-oracle', now());
    }
  });
  emitMissionEvent(d, 'quality.updated', { revision_id, gates });
}

export function getQualityGates(d: Db, revision_id: string): QualityGateRow[] {
  return d.db
    .query<QualityGateRow, [string]>(`SELECT * FROM quality_gate_results WHERE revision_id=?`)
    .all(revision_id);
}

/** Deterministic: 10/10 only when every mandatory gate PASS **and** that gate
 *  carries at least one resolved evidence reference. No LLM vibe score, and a
 *  bare reviewer PASS without evidence can never fabricate 10/10. */
export function isRevisionVerified10(d: Db, revision_id: string, mandatory: string[]): boolean {
  if (!mandatory.length) return false;
  const rows = getQualityGates(d, revision_id);
  const lookup = new Map(rows.map((g) => [g.gate_key, g]));
  for (const k of mandatory) {
    const g = lookup.get(k);
    if (!g || g.status !== 'PASS') return false;
    const refs: unknown = g.evidence_refs_json ? safeParseJson(g.evidence_refs_json) : [];
    if (!Array.isArray(refs) || refs.length === 0) return false; // PASS requires evidence
  }
  return true;
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// ── Evidence (content-hashed, immutable) ─────────────────────────────────────
/** Real SHA-256 content hash + byte count of a file on disk. Throws if unreadable. */
export function hashFileContent(filePath: string): { sha256: string; bytes: number } {
  const buf = readFileSync(filePath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { sha256, bytes: buf.byteLength };
}

export function addEvidence(
  d: Db,
  input: {
    revision_id: string;
    kind: string;
    path?: string;
    sha256: string;
    bytes?: number;
    producer?: string;
    command?: string;
    exit_code?: number;
    metadata?: Record<string, unknown>;
  },
): EvidenceRow {
  const ev: EvidenceRow = {
    artifact_id: generateId('ev'),
    revision_id: input.revision_id,
    kind: input.kind,
    path: input.path ?? null,
    sha256: input.sha256,
    bytes: input.bytes ?? 0,
    producer: input.producer ?? null,
    command: input.command ?? null,
    exit_code: input.exit_code ?? null,
    created_at: now(),
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO evidence_artifacts (artifact_id, revision_id, kind, path, sha256, bytes, producer, command, exit_code, created_at, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(ev.artifact_id, ev.revision_id, ev.kind, ev.path, ev.sha256, ev.bytes, ev.producer, ev.command, ev.exit_code, ev.created_at, ev.metadata_json);
  });
  emitMissionEvent(d, 'evidence.captured', { revision_id: input.revision_id, artifact_id: ev.artifact_id, kind: ev.kind, sha256: ev.sha256 });
  return ev;
}

export function listEvidence(d: Db, revision_id: string): EvidenceRow[] {
  return d.db
    .query<EvidenceRow, [string]>(`SELECT * FROM evidence_artifacts WHERE revision_id=? ORDER BY created_at ASC`)
    .all(revision_id);
}

// ── Repair plans (structured, never hidden chain-of-thought) ─────────────────
export interface RepairPlanRow {
  plan_id: string;
  revision_id: string;
  planner_model: string | null;
  objective: string | null;
  plan_json: string | null;
  hypothesis_key: string | null;
  failure_signature: string | null;
  created_at: string;
}

export function setRepairPlan(
  d: Db,
  input: {
    revision_id: string;
    planner_model?: string;
    objective?: string;
    plan?: Record<string, unknown>;
    hypothesis_key?: string;
    failure_signature?: string;
  },
): RepairPlanRow {
  const plan_id = generateId('plan');
  const ts = now();
  const row: RepairPlanRow = {
    plan_id,
    revision_id: input.revision_id,
    planner_model: input.planner_model ?? null,
    objective: input.objective ?? null,
    plan_json: input.plan ? JSON.stringify(input.plan) : null,
    hypothesis_key: input.hypothesis_key ?? null,
    failure_signature: input.failure_signature ?? null,
    created_at: ts,
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO repair_plans (plan_id, revision_id, planner_model, objective, plan_json, hypothesis_key, failure_signature, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(row.plan_id, row.revision_id, row.planner_model, row.objective, row.plan_json, row.hypothesis_key, row.failure_signature, row.created_at);
  });
  // Advise the revision of its structured plan identity.
  updateRevision(d, input.revision_id, { plan_id });
  emitMissionEvent(d, 'repair.plan', { revision_id: input.revision_id, plan_id, hypothesis_key: input.hypothesis_key });
  return row;
}

export function getRepairPlan(d: Db, revision_id: string): RepairPlanRow | undefined {
  return d.db
    .query<RepairPlanRow, [string]>(`SELECT * FROM repair_plans WHERE revision_id=? ORDER BY created_at ASC LIMIT 1`)
    .get(revision_id) as RepairPlanRow | undefined;
}

// ── Scientific claims (canonicalized typed graph) ────────────────────────────
export function upsertClaim(
  d: Db,
  input: {
    mission_id: string;
    canonical_key: string;
    claim: string;
    status?: ClaimRow['status'];
    revision_id?: string;
    evidence_refs?: string[];
    contradicts?: string[];
    confidence?: number;
    supersedes_claim_id?: string;
  },
): ClaimRow {
  const existing = d.db
    .query<ClaimRow, [string, string]>(`SELECT * FROM scientific_claims WHERE mission_id=? AND canonical_key=? ORDER BY updated_at DESC LIMIT 1`)
    .get(input.mission_id, input.canonical_key) as ClaimRow | undefined;
  const ts = now();
  if (existing) {
    // Canonicalize: collapse duplicates by occurrence_count++, never duplicate.
    const updated: ClaimRow = {
      ...existing,
      status: input.status ?? existing.status,
      claim: input.claim ?? existing.claim,
      evidence_refs_json: input.evidence_refs ? JSON.stringify(input.evidence_refs) : existing.evidence_refs_json,
      contradicts_json: input.contradicts ? JSON.stringify(input.contradicts) : existing.contradicts_json,
      supersedes_claim_id: input.supersedes_claim_id ?? existing.supersedes_claim_id,
      confidence: input.confidence ?? existing.confidence,
      revision_id: input.revision_id ?? existing.revision_id,
      updated_at: ts,
      occurrence_count: existing.occurrence_count + 1,
    };
    d.tx((t) => {
      t.query(
        `UPDATE scientific_claims SET status=?, claim=?, evidence_refs_json=?, contradicts_json=?, supersedes_claim_id=?, confidence=?, revision_id=?, updated_at=?, occurrence_count=? WHERE claim_id=?`
      ).run(updated.status, updated.claim, updated.evidence_refs_json, updated.contradicts_json, updated.supersedes_claim_id, updated.confidence, updated.revision_id, updated.updated_at, updated.occurrence_count, existing.claim_id);
    });
    return updated;
  }
  const claim: ClaimRow = {
    claim_id: generateId('clm'),
    mission_id: input.mission_id,
    canonical_key: input.canonical_key,
    revision_id: input.revision_id ?? null,
    status: input.status ?? 'HYPOTHESIS',
    claim: input.claim,
    evidence_refs_json: input.evidence_refs ? JSON.stringify(input.evidence_refs) : null,
    contradicts_json: input.contradicts ? JSON.stringify(input.contradicts) : null,
    supersedes_claim_id: input.supersedes_claim_id ?? null,
    confidence: input.confidence ?? 0,
    created_at: ts,
    updated_at: ts,
    occurrence_count: 1,
  };
  d.tx((t) => {
    t.query(
      `INSERT INTO scientific_claims (claim_id, mission_id, canonical_key, revision_id, status, claim, evidence_refs_json, contradicts_json, supersedes_claim_id, confidence, created_at, updated_at, occurrence_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(claim.claim_id, claim.mission_id, claim.canonical_key, claim.revision_id, claim.status, claim.claim, claim.evidence_refs_json, claim.contradicts_json, claim.supersedes_claim_id, claim.confidence, claim.created_at, claim.updated_at, claim.occurrence_count);
  });
  return claim;
}

export function activeClaimContext(d: Db, mission_id: string): {
  verified: ClaimRow[]; hypotheses: ClaimRow[]; falsified: ClaimRow[];
} {
  const all = d.db
    .query<ClaimRow, [string]>(`SELECT * FROM scientific_claims WHERE mission_id=?`)
    .all(mission_id) as ClaimRow[];
  return {
    verified: all.filter((c) => c.status === 'VERIFIED'),
    hypotheses: all.filter((c) => c.status === 'HYPOTHESIS'),
    falsified: all.filter((c) => c.status === 'FALSIFIED'),
  };
}
