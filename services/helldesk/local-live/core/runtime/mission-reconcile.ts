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
  missions: z.array(z.object({ missionId: z.string(), state: z.string().optional(), currentTicketId: z.string().nullable().optional(), objective: z.string().optional(), verifiedAt: z.string().nullable().optional(), blockedReason: z.string().nullable().optional() })),
});
const TicketsDTO = z.object({ tickets: z.array(z.record(z.string(), z.unknown())) });

/** Map a control-plane execution/verification state onto the local board status. */
export function missionStateToStatus(state: string | undefined): 'open' | 'in_progress' | 'in_review' | 'closed' {
  if (!state) return 'open';
  const s = state.toUpperCase();
  if (s === 'CANCELLED' || s === 'VERIFIED_10_10' || s === 'CLOSED') return 'closed';
  if (s === 'MUTATING' || s === 'ACTIVE' || s === 'VERIFYING' || s === 'RUNNING' || s === 'READY' || s === 'EVIDENCE_CAPTURED') return 'in_progress';
  if (s === 'REJECTED' || s === 'BLOCKED' || s === 'FINDINGS') return 'in_review';
  return 'open';
}

/** The local-live runtime's own base (server-side fetch needs an absolute URL). */
const SELF = 'http://127.0.0.1:8790';

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
    const missionStatus = missionStateToStatus(m.state);
    // Bind the projection to the real engine mission so actions write through.
    projections.push({
      ticket_id: m.missionId,
      type: 'shift' as const,
      status: missionStatus,
      title: objective ? objective.replace(/\n/g, ' ').slice(0, 96) : m.missionId,
      body: objective || null,
      workstation_id: null,
      parent_ticket_id: null,
      assignee_agent_ticket_id: null,
      priority: 'high' as const,
      labels: [],
      metadata: { is_mission: true, local_mission: { missionId: m.missionId, submission: 'accepted' }, engine_verified_at: m.verifiedAt ?? null },
      created_by: 'engine',
      created_at: m.verifiedAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      closed_at: missionStatus === 'closed' ? new Date().toISOString() : null,
      dispatch_attempts: 0,
      last_dispatch_attempt_at: null,
    });
    // the mission's tickets (per-control-plane ticket records)
    try {
      const tr = await fetch(`${SELF}/api/v1/missions/${encodeURIComponent(m.missionId)}/tickets`, { signal: AbortSignal.timeout(8000) });
      if (!tr || !tr.ok) continue;
      const td = TicketsDTO.parse(await tr.json());
      for (const raw of td.tickets) {
        const ticketId = (raw.ticketId ?? raw.ticket_id) as string | undefined;
        const title = (raw.title ?? '') as string;
        const execState = (raw.executionState ?? raw.execution_state) as string | undefined;
        const verifState = (raw.verificationState ?? raw.verification_state) as string | undefined;
        const status = verifState === 'VERIFIED_10_10' || execState === 'CLOSED' ? 'closed' : (execState === 'RUNNING' || execState === 'READY' || execState === 'MUTATING' ? 'in_progress' : missionStatus);
        projections.push({
          ticket_id: ticketId ?? m.missionId,
          type: 'shift' as const,
          status,
          title: title ? title.replace(/\n/g, ' ').slice(0, 96) : (objective.replace(/\n/g, ' ').slice(0, 96) || m.missionId),
          body: objective || null,
          workstation_id: null,
          parent_ticket_id: m.missionId,
          assignee_agent_ticket_id: null,
          priority: 'medium' as const,
          labels: [],
          metadata: { is_mission: true, is_mission_ticket: true, local_mission: { missionId: m.missionId, submission: 'accepted' } },
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