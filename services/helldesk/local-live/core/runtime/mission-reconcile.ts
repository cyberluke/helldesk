/**
 * mission-reconcile.ts — no-split-brain ticket projection from the control plane.
 *
 * The GUI's ticket board must show the REAL autonomous work (control-plane
 * missions) and stay in sync with the engine — never a divergent local mirror.
 * This module projects control-plane missions (via the proxied /api/v1/missions
 * on the local-live runtime, which injects the control-plane token server-side)
 * into the local ticket shape the GUI already renders. Actions on these tickets
 * route write-through to the engine through their `metadata.local_mission`
 * binding (see mission-dispatch.ts), so there is ONE source of truth: the engine.
 *
 * No boot/reconciler writes here: this is a read-time projection layered into
 * listTickets, so it cannot corrupt or disturb the running mission.
 */
import { z } from 'zod';
import type { Ticket } from '../types';

/** The control-plane public mission + ticket shapes (via /api/v1/missions). */
const MissionsDTO = z.object({
  missions: z.array(z.object({
    missionId: z.string(),
    state: z.string().optional(),
    currentTicketId: z.string().nullable().optional(),
    objective: z.string().optional(),
    verifiedAt: z.string().nullable().optional(),
    blockedReason: z.string().nullable().optional(),
    operatorStatus: z.string().nullable().optional(),
    revisionState: z.string().nullable().optional(),
    revisionNo: z.number().nullable().optional(),
    reviewJobState: z.string().nullable().optional(),
    controls: z.record(z.string(), z.unknown()).optional(),
    humanAcceptance: z.string().nullable().optional(),
    humanAcceptedAt: z.string().nullable().optional(),
    humanAcceptanceNote: z.string().nullable().optional(),
    humanAcceptedBy: z.string().nullable().optional(),
    awaitingHumanAcceptance: z.boolean().optional(),
  })),
});
const TicketsDTO = z.object({ tickets: z.array(z.record(z.string(), z.unknown())) });

/** Map a control-plane execution/verification state onto the local board status. */
export function missionStateToStatus(state?: string): 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed' {
  if (!state) return 'open';
  const s = state.toUpperCase();
  // Every engine state must land in a column the board can actually render.
  // 'failed' was previously UNREACHABLE, so blocked/failed missions showed in Open.
  if (s === 'CANCELLED' || s === 'VERIFIED_10_10' || s === 'CLOSED') return 'closed';
  if (s === 'BLOCKED' || s === 'BLOCKED_EXTERNAL' || s === 'FAILED_TERMINAL' || s === 'INCONCLUSIVE' || s === 'FAILED') return 'failed';
  if (s === 'REJECTED' || s === 'FINDINGS') return 'in_review';
  if (
    s === 'ACTIVE' || s === 'PLANNING' || s === 'PLANNED' || s === 'MUTATING' ||
    s === 'CAPTURING_EVIDENCE' || s === 'EVIDENCE_CAPTURED' || s === 'VERIFYING' ||
    s === 'REPLANNING' || s === 'RUNNING' || s === 'READY'
  ) return 'in_progress';
  return 'open';
}

/** The local-live runtime's own base (server-side fetch needs an absolute URL).
 *  MUST follow HELLDESK_PORT: a second dashboard on :8792 projects ITS control
 *  plane, not the production one on :8790. */
const SELF = `http://${process.env.HELLDESK_HOST ?? '127.0.0.1'}:${process.env.HELLDESK_PORT ?? '8790'}`;

/**
 * Decide whether a projected mission row is a duplicate of a local task ticket
 * or of another projected mission row and must NOT be added to the board.
 *
 * A task submitted to the engine exists in BOTH places: the local DO store (the
 * real ticket, carrying break_room_controls / local_repo_snapshot and a
 * `metadata.local_mission.missionId` binding) AND the control-plane projection
 * (the mission root + every per-mission child ticket, all tagged with the same
 * `local_mission.missionId`). Rendering both duplicates one logical task into
 * multiple cards. Additionally, even with no local ticket (pure engine mission),
 * the mission ROOT card already represents the whole mission, so a projected
 * CHILD ticket (whose parent_ticket_id is the mission root) is a second card
 * for the same work and must be folded too.
 *
 * @param projected  a row produced by listMissionsProjected()
 * @param local      the real local DO tickets
 * @param projectedIds all ticket_ids produced by the same listMissionsProjected()
 *                     call (so a child can be folded when its parent mission root
 *                     is projected in the same pass)
 */
export function isProjectedDupe(projected: Ticket, local: Ticket[], projectedIds: ReadonlySet<string>): boolean {
  if (local.some(t => t.ticket_id === projected.ticket_id)) return true;
  const projectedMissionId = (projected.metadata as { local_mission?: { missionId?: string } } | undefined)?.local_mission?.missionId;
  if (projectedMissionId && local.some(t => {
    const m = (t.metadata as { local_mission?: { missionId?: string } } | undefined)?.local_mission?.missionId;
    return m === projectedMissionId;
  })) {
    return true;
  }
  // Pure-engine mission with no local ticket: a projected child ticket is a
  // second card for work the mission ROOT already represents.
  if (projected.parent_ticket_id && projectedIds.has(projected.parent_ticket_id)) return true;
  return false;
}

/**
 * The board-level effect of mission state + human acceptance. Machine
 * VERIFIED_10_10 is NOT human acceptance: the card waits in review until the
 * operator accepts. Pure so it is unit-testable.
 */
export function missionBoardStatus(input: {
  state?: string | null;
  humanAcceptance?: string | null;
  operatorStatus?: string | null;
}): {
  status: 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed';
  closed: boolean;
  awaitingAcceptance: boolean;
  terminal: boolean;
} {
  const stateUpper = (input.state ?? '').toUpperCase();
  const accepted = input.humanAcceptance === 'accepted';
  const awaitingAcceptance = stateUpper === 'VERIFIED_10_10' && !accepted;
  const closed = stateUpper === 'CANCELLED' || stateUpper === 'CLOSED' || (stateUpper === 'VERIFIED_10_10' && accepted);
  const overlay = input.operatorStatus;
  const status = awaitingAcceptance
    ? 'in_review'
    : !closed && (overlay === 'open' || overlay === 'in_progress' || overlay === 'in_review' || overlay === 'closed' || overlay === 'failed')
      ? overlay
      : missionStateToStatus(input.state ?? undefined);
  return { status, closed, awaitingAcceptance, terminal: closed || awaitingAcceptance };
}

/**
 * Merge the read-time mission projection into a ticket list.
 *
 * Engine missions are DEPARTMENT-scoped: the control plane has no workstation
 * binding for them, so projected rows carry workstation_id=null. They belong on
 * the department board only. A seat board (workstation filter) shows only the
 * tickets routed to that workstation; merging the unfiltered projection there
 * made every workstation render the same kanban.
 */
export function projectMissionsIntoBoard(
  local: Ticket[],
  missions: Ticket[],
  filter: { workstation_id?: string },
): Ticket[] {
  if (filter.workstation_id) return local;
  if (missions.length === 0) return local;
  const projectedIds = new Set(missions.map(t => t.ticket_id));
  const extra = missions.filter(t => !isProjectedDupe(t, local, projectedIds));
  return [...extra, ...local];
}

/**
 * Overlay the LIVE engine state onto local tickets that are bound to a mission.
 *
 * Backfilled local tickets (metadata.local_mission.missionId) hold a snapshot of
 * the mission at creation time. The board must not trust that snapshot for
 * engine-owned state: after human acceptance the engine says CLOSED while the
 * local ticket can still say in_review — the card then looks like it "flips"
 * back. Merge the projected mission's board status + engine/acceptance metadata
 * onto the bound local ticket (local fields such as workspace/title/controls are
 * preserved), so the board follows one source of truth.
 */
export function mergeLocalMissionState(local: Ticket[], missions: Ticket[]): Ticket[] {
  if (missions.length === 0) return local;
  const byMission = new Map<string, Ticket>();
  for (const mission of missions) {
    const missionId = (mission.metadata as { local_mission?: { missionId?: unknown } } | undefined)
      ?.local_mission?.missionId;
    // ONLY the mission ROOT carries the mission's board status. Child tickets
    // share the same local_mission binding and can be closed while the root is
    // still in review; letting a child overwrite the map made accepted/verified
    // roots look closed (the "flipping" card).
    if (typeof missionId === 'string' && missionId && mission.ticket_id === missionId) {
      byMission.set(missionId, mission);
    }
  }
  if (byMission.size === 0) return local;
  const engineKeys = [
    'engine_state',
    'engine_verified_at',
    'human_acceptance',
    'human_accepted_at',
    'human_acceptance_note',
    'human_accepted_by',
    'awaiting_human_acceptance',
    'revision_state',
    'revision_no',
    'review_job_state',
  ] as const;
  return local.map(ticket => {
    const missionId = (ticket.metadata as { local_mission?: { missionId?: unknown } } | undefined)
      ?.local_mission?.missionId;
    const mission = typeof missionId === 'string' ? byMission.get(missionId) : undefined;
    if (!mission) return ticket;
    const localMeta = (ticket.metadata ?? {}) as Record<string, unknown>;
    const missionMeta = (mission.metadata ?? {}) as Record<string, unknown>;
    const metadata: Record<string, unknown> = { ...missionMeta, ...localMeta };
    for (const key of engineKeys) {
      if (key in missionMeta) metadata[key] = missionMeta[key];
    }
    return {
      ...ticket,
      status: mission.status,
      metadata,
    };
  });
}

/** Fetch the control-plane missions (server-proxied; never needs a browser token). */
export async function listMissionsProjected(): Promise<Ticket[]> {
  let res: Response;
  try {
    res = await fetch(`${SELF}/api/v1/missions`, { signal: AbortSignal.timeout(8000) });
  } catch { return []; }
  if (!res || !res.ok) return [];
  let parsed;
  try { parsed = MissionsDTO.parse(await res.json()); } catch { return []; }

  const projections: Ticket[] = [];
  for (const m of parsed.missions) {
    // real mission objective (the framework task text)
    const objective = m.objective ?? '';
    // Operator overlay: the kanban drag records the chosen column in the ENGINE
    // (never faked locally). Show it until the mission is terminal; the real
    // engine state stays in metadata.engine_state for honest display.
    // Machine VERIFIED_10_10 is NOT human acceptance. Until the operator accepts,
    // the card waits in review; only an accepted/closed/cancelled mission closes.
    const accepted = m.humanAcceptance === 'accepted';
    const board = missionBoardStatus({
      state: m.state,
      humanAcceptance: m.humanAcceptance,
      operatorStatus: m.operatorStatus,
    });
    const awaitingAcceptance = board.awaitingAcceptance;
    const closedState = board.closed;
    const terminal = board.terminal;
    const missionStatus = board.status;
    const humanMeta = {
      human_acceptance: m.humanAcceptance ?? null,
      human_accepted_at: m.humanAcceptedAt ?? null,
      human_acceptance_note: m.humanAcceptanceNote ?? null,
      human_accepted_by: m.humanAcceptedBy ?? null,
      awaiting_human_acceptance: awaitingAcceptance,
    };
    // Bind the projection to the real engine mission so actions write through.
    const rootProjection: Ticket = {
      ticket_id: m.missionId,
      type: 'shift' as const,
      status: missionStatus,
      title: objective ? objective.replace(/\n/g, ' ').slice(0, 96) : m.missionId,
      body: objective || null,
      workstation_id: null,
      parent_ticket_id: null,
      // Durable ownership: the executor of every non-terminal mission is the
      // STABLE soul role, not a transient worker id. An explicit assignment
      // (current ticket's assigneeAgentId) overrides it below.
      assignee_agent_ticket_id: terminal ? null : 'role:soul',
      priority: 'high' as const,
      labels: [],
      metadata: { is_mission: true, local_mission: { missionId: m.missionId, submission: 'accepted' }, break_room_controls: m.controls ?? {}, engine_state: m.state ?? null, engine_verified_at: m.verifiedAt ?? null, revision_state: m.revisionState ?? null, revision_no: m.revisionNo ?? null, review_job_state: m.reviewJobState ?? null, ...humanMeta },
      created_by: 'engine',
      created_at: m.verifiedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: closedState ? new Date().toISOString() : null,
      dispatch_attempts: 0,
      last_dispatch_attempt_at: null,
    };
    projections.push(rootProjection);
    // the mission's tickets (per-control-plane ticket records)
    try {
      const tr = await fetch(`${SELF}/api/v1/missions/${encodeURIComponent(m.missionId)}/tickets`, { signal: AbortSignal.timeout(8000) });
      if (!tr || !tr.ok) continue;
      const td = TicketsDTO.parse(await tr.json());
      // The card is owned by the CURRENT ticket's assignee; the projection must
      // carry it or the drawer shows "Unassigned" while the engine has an owner.
      const currentRaw = td.tickets.find((t) => (t.ticketId ?? t.ticket_id) === m.currentTicketId) ?? td.tickets[0];
      const rootAssignee = (currentRaw?.assigneeAgentId ?? currentRaw?.assignee_agent_id) as string | null | undefined;
      if (rootAssignee) rootProjection.assignee_agent_ticket_id = rootAssignee;
      for (const raw of td.tickets) {
        const ticketId = (raw.ticketId ?? raw.ticket_id) as string | undefined;
        const title = (raw.title ?? '') as string;
        const execState = (raw.executionState ?? raw.execution_state) as string | undefined;
        const verifState = (raw.verificationState ?? raw.verification_state) as string | undefined;
        const childAwaiting = verifState === 'VERIFIED_10_10' && !accepted;
        const status =
          execState === 'CLOSED' || (verifState === 'VERIFIED_10_10' && accepted)
            ? 'closed'
            : childAwaiting || execState === 'AWAITING_ACCEPTANCE'
              ? 'in_review'
              : execState === 'RUNNING' || execState === 'READY' || execState === 'MUTATING'
                ? 'in_progress'
                : missionStatus;
        const assignee = (raw.assigneeAgentId ?? raw.assignee_agent_id) as string | null | undefined;
        projections.push({
          ticket_id: ticketId ?? m.missionId,
          type: 'shift' as const,
          status,
          title: title ? title.replace(/\n/g, ' ').slice(0, 96) : (objective.replace(/\n/g, ' ').slice(0, 96) || m.missionId),
          body: objective || null,
          workstation_id: null,
          parent_ticket_id: m.missionId,
          assignee_agent_ticket_id: assignee ?? (terminal ? null : 'role:soul'),
          priority: 'medium' as const,
          labels: [],
          metadata: { is_mission: true, is_mission_ticket: true, local_mission: { missionId: m.missionId, submission: 'accepted' }, break_room_controls: m.controls ?? {}, ...humanMeta },
          created_by: 'engine',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          closed_at: status === 'closed' ? new Date().toISOString() : null,
          dispatch_attempts: 0,
          last_dispatch_attempt_at: null,
        });
      }
    } catch { /* no tickets / transient — still surface the mission projection */ }
  }
  return projections;
}