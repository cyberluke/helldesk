import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveConfigPath, defaultDataDir } from '../../../local/src/config';
import { normalizeReviewControls, type ReviewControls } from '../../../local/src/review-controls';
import type { SqlStorage } from './runtime-types';
import type { Ticket } from '../types';
import * as ticketOps from '../dos/department/tickets';
import { query } from '../util/query.util';
import { tickets } from '../db/tables/tickets.table';

const Config = z.object({ daemon: z.object({ port: z.number().int().default(4789), dataDir: z.string().default(defaultDataDir()), token: z.string().optional() }) });
const RecordValue = z.record(z.string(), z.unknown());
const Binding = z.object({ missionId: z.string().optional(), submission: z.enum(['submitting', 'accepted']), workspace: z.string(), objective: z.string(), idempotencyKey:z.string().optional(),title:z.string().optional(),taskGates:z.array(z.string()).optional() });
const Mission = z.object({
  mission_id: z.string(),
  state: z.string(),
  blocked_reason: z.string().nullable().optional(),
  verified_at: z.string().nullable().optional(),
  human_acceptance: z.string().nullable().optional(),
  human_accepted_at: z.string().nullable().optional(),
  human_acceptance_note: z.string().nullable().optional(),
  human_accepted_by: z.string().nullable().optional(),
});
export type MissionBinding = z.infer<typeof Binding>;

/** The existing daemon owns mutation, immutable review and rework. Local Department
 * only submits and projects its durable state; a git commit is never dispatch. */
export async function missionApi(route: string, body?: unknown): Promise<unknown> {
  const config = Config.parse(JSON.parse(readFileSync(resolveConfigPath(), 'utf8')));
  const token = config.daemon.token || readFileSync(join(config.daemon.dataDir, 'token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${config.daemon.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const detail = result as { message?: unknown; error?: unknown } | null;
    const why = typeof detail?.message === 'string'
      ? detail.message
      : typeof detail?.error === 'string'
        ? detail.error
        : '';
    throw Error(`Mission daemon refused ${route} (${response.status})${why ? `: ${why}` : ''}`);
  }
  return result;
}

export function missionBinding(ticket: Ticket): MissionBinding | null {
  const result = Binding.safeParse(ticket.metadata?.local_mission);
  return result.success ? result.data : null;
}

function persist(sql: SqlStorage, ticket: Ticket, binding: MissionBinding): void {
  ticketOps.updateTicketFields(sql, ticket.ticket_id, { metadata: { ...ticket.metadata, local_mission: binding } }, 'mission-dispatch');
}

export async function submitMission(sql: SqlStorage, ticket: Ticket, workspace: string, context: string, defaultEngineMatrix?: Record<string, unknown>): Promise<MissionBinding> {
  const config = z.object({ config: z.object({ autonomy: z.object({ enabled: z.boolean() }) }) }).parse(await missionApi('/v1/config'));
  if (!config.config.autonomy.enabled) throw Error('Autonomous mission controller is disabled; enable autonomy in Runtime settings. No coding agent was launched.');
  let binding = missionBinding(ticket);
  if (binding?.missionId) return binding;
  if (binding && !binding.idempotencyKey) {
    // Reconcile an uncertain POST outcome after client/daemon restart. Never
    // blindly resubmit side-effecting work under a second mission identity.
    const list = z.object({ missions: z.array(z.object({ missionId: z.string(), objective: z.string() })) }).parse(await missionApi('/v1/missions'));
    const existing = list.missions.find(m => m.objective === binding?.objective);
    if (!existing) throw Error('Mission submission outcome is pending reconciliation; no duplicate execution was started.');
    binding = { ...binding, missionId: existing.missionId, submission: 'accepted' };
    persist(sql, ticket, binding);
    return binding;
  }
  const objective = `[HELLDESK ticket ${ticket.ticket_id}]\n${ticket.title}\n\n${ticket.body || ''}\n\n${context}\n\nThe CTO steers asynchronously. Preserve the entire task scope; do not wait for human review. Implement, independently review, and rework. Explicit stop instructions still stop work. Machine review is not CTO production acceptance.`;
  const gates = z.array(z.string().min(1)).min(1).safeParse(ticket.metadata?.acceptance_gates);
  if(!binding){
    binding = { submission: 'submitting', workspace, objective, idempotencyKey:'helldesk:'+ticket.ticket_id,title:ticket.title,taskGates:gates.success ? gates.data : ['full_task_scope', 'functional_behavior', 'regression_checks', 'artifact_provenance'] };
    persist(sql, ticket, binding);
  }
  const registered = z.object({ workspace: z.object({ workspaceId: z.string() }) }).parse(await missionApi('/v1/workspaces/register', { path: binding.workspace }));
  // Provider-agnostic per-task engine matrix: department-default (settings) merged with
  // the per-ticket override (metadata.engine_matrix). Carried into the mission so
  // the control plane resolves per-mission engines.
  const departmentDefault = (defaultEngineMatrix ?? {}) as Record<string, unknown>;
  const ticketOverride = (ticket.metadata?.engine_matrix ?? {}) as Record<string, unknown>;
  const engineMatrix = { ...departmentDefault, ...ticketOverride };
  // The enforcer picker / Kanban toggles live on the ticket's
  // metadata.break_room_controls. Carry them into the mission so the review
  // pipeline can honor Reviewer A / Reviewer B / ExcellenceGovernor per task.
  const controls = normalizeReviewControls(ticket.metadata?.break_room_controls);
  const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
  const size = {
    storyPoints: typeof meta.story_points === 'number' ? meta.story_points : undefined,
    tshirtSize: typeof meta.tshirt_size === 'string' ? meta.tshirt_size : undefined,
    sizeConfidence: typeof meta.size_confidence === 'string' ? meta.size_confidence : undefined,
    sizeRationale: typeof meta.size_rationale === 'string' ? meta.size_rationale : undefined,
    sizeModel: typeof meta.size_model === 'string' ? meta.size_model : undefined,
    sizingState: typeof meta.sizing_state === 'string' ? meta.sizing_state : undefined,
  };
  const result = z.object({ missionId: z.string() }).parse(await missionApi('/v1/missions', { workspaceId: registered.workspace.workspaceId, objective:binding.objective, idempotencyKey:binding.idempotencyKey, taskGates:binding.taskGates, engineMatrix, controls, tickets: [{ title: binding.title, objective:binding.objective, ...size }] }));
  binding = { ...binding, missionId: result.missionId, submission: 'accepted' };
  persist(sql, ticketOps.getTicket(sql, ticket.ticket_id) || ticket, binding);
  return binding;
}

const TaskSizeResponse = z.object({
  ok: z.boolean(),
  state: z.enum(['sized', 'unsized']),
  tshirt: z.string().nullable(),
  points: z.number().nullable(),
  confidence: z.string().nullable(),
  rationale: z.string().nullable(),
  model: z.string().nullable(),
  cached: z.boolean(),
  error: z.string().optional(),
});
export type TaskSizeResponse = z.output<typeof TaskSizeResponse>;

/** One bounded structured-JSON sizing call; null on any transport/daemon error. */
export async function sizeTaskForSpec(spec: {
  title: string;
  objective?: string | null;
  body?: string | null;
  requirements?: string | string[] | null;
  workspace?: string | null;
  kind?: string | null;
}): Promise<TaskSizeResponse | null> {
  try {
    return TaskSizeResponse.parse(await missionApi('/v1/size-task', spec));
  } catch {
    return null;
  }
}

export async function readMission(binding: MissionBinding) {
  if (!binding.missionId) return null;
  return z.object({ mission: Mission }).parse(await missionApi('/v1/missions/' + encodeURIComponent(binding.missionId))).mission;
}

/**
 * Set a mission's LIVE per-task review policy (Governor / Reviewer A / Reviewer
 * B / Agents). Returns the merged controls the engine persisted.
 */
export async function setMissionReviewControls(
  missionId: string,
  controls: ReviewControls,
): Promise<ReviewControls> {
  const response = z.object({ ok: z.literal(true), controls: RecordValue }).parse(
    await missionApi('/v1/missions/' + encodeURIComponent(missionId) + '/controls', controls),
  );
  return normalizeReviewControls(response.controls);
}

export async function cancelMission(binding: MissionBinding): Promise<void> {
  if (binding.missionId) RecordValue.parse(await missionApi('/v1/missions/' + encodeURIComponent(binding.missionId) + '/cancel', {}));
}

export async function steerLocalMission(sql: SqlStorage, ticketId: string, note: string, kind: 'message' | 'interrupt' | 'force-review' | 'disapprove' = 'message'): Promise<{ ok: true; delivery: string }> {
  // (body unchanged; the mission-id fallback is above)
  const ticket = ticketOps.getTicket(sql, ticketId);
  if (!ticket) {
    // Mission-owned ticket (e.g. mis_*/bead_* present in the control-plane autonomy
    // store but NOT in the local department ticket table). The operator still
    // needs to steer the underlying mission. Resolve which mission owns this
    // ticket by scanning the control plane, then forward the steer. This is the
    // fix for the 503 'Could not persist mission steering' the operator hit when
    // trying to steer a mission task that was never a local workstation ticket.
    const resolved = await resolveMissionForTicket(ticketId);
    if (!resolved) throw Error('Task not found');
    const response = z.object({ ok: z.literal(true), delivery: z.string() }).parse(await missionApi('/v1/missions/' + encodeURIComponent(resolved) + '/steer', { note: note || `CTO requested ${kind}`, kind }));
    return response;
  }
  const binding = missionBinding(ticket);
  if (!binding?.missionId) {
    ticketOps.updateTicketFields(sql, ticketId, { body: (ticket.body || '') + `\n\n[Async CTO ${kind}]\n${note}` }, 'operator');
    return { ok: true, delivery: 'persisted_before_dispatch' };
  }
  const response = z.object({ ok: z.literal(true), delivery: z.string() }).parse(await missionApi('/v1/missions/' + encodeURIComponent(binding.missionId) + '/steer', { note: note || `CTO requested ${kind}`, kind }));
  if (ticket.status === 'closed') {
    // Terminal automation callbacks stay immutable; this is an explicit new
    // operator instruction and creates a new review obligation on the daemon.
    query(sql, /* sql */ `UPDATE ${tickets} SET ${tickets.columns.status}='in_progress', ${tickets.columns.closed_at}=NULL, ${tickets.columns.updated_at}=? WHERE ${tickets.ticket_id}=?`, [new Date().toISOString(), ticketId]);
    ticketOps.logTicketEvent(sql, { ticketId, agentId: 'operator', eventType: 'status_changed', newValue: 'in_progress', metadata: { reason: 'async_operator_follow_up', missionId: binding.missionId } });
  }
  return response;
}

/**
 * Resolve which control-plane mission owns a given ticket id (mission ticket ids
 * like ticket_* / bead_* that are NOT local workstation tickets). Also accepts a
 * MISSION id directly (mis_*) and returns it, so a caller that (mis)uses the
 * mission id where a ticket id belongs still steers the right mission. Scans the
 * daemon's missions + per-mission tickets. Returns the mission_id or null.
 */
export async function resolveMissionForTicket(ticketId: string): Promise<string | null> {
  try {
    const list = z.object({ missions: z.array(z.object({ missionId: z.string() })) }).parse(await missionApi('/v1/missions'));
    // Direct mission-id: the caller passed mis_* where a ticket id belongs.
    const direct = list.missions.find((m) => m.missionId === ticketId);
    if (direct) return direct.missionId;
    for (const m of list.missions) {
      const tickets = await missionApi('/v1/missions/' + encodeURIComponent(m.missionId) + '/tickets').catch(() => null);
      if (!tickets) continue;
      const found = z.array(z.object({ ticketId: z.string() }).passthrough()).safeParse((tickets as { tickets?: unknown }).tickets);
      if (found.success && found.data.some(t => t.ticketId === ticketId || t.ticketId === `ticket_${ticketId}` || t.ticketId === `bead_${ticketId}`)) {
        return m.missionId;
      }
    }
  } catch {
    /* unable to resolve; caller surfaces the error */
  }
  return null;
}

export type MissionMoveResult = {
  ok: true;
  missionId: string;
  ticketId: string;
  delivery: string;
  assignment?: string;
};
export type MissionMoveError = { ok: false; error: string };

/**
 * Route an operator's kanban move (status + optional assignee) on a MISSION-OWNED
 * ticket to the mission controller instead of the department DO (which 500s
 * 'Ticket <mis_*> not found' because mission tickets are not department tickets).
 *
 * Accepts either a real ticket id (ticket_ wildcard / bead_) or a MISSION id
 * (mis_ prefix) in the `ticketId` slot — the id-resolution bug the operator
 * hit. It:
 *   1. resolves the owning mission,
 *   2. if an agentId was given, records the operator dispatch override via
 *      POST /v1/missions/:id/tickets/:ticketId/assign,
 *   3. feeds the operator's status intent as a steering note so the mission, at
 *      its next boundary, sees the desired target state + responsible agent.
 * Never 404s/500s on a valid mission — returns a visible ack instead.
 */
export async function routeMissionTicketMove(
  ticketId: string,
  opts: { status?: string; agentId?: string; by?: string },
): Promise<MissionMoveResult | MissionMoveError> {
  let missionId: string | null;
  let resolvedTicket = ticketId;
  try { missionId = await resolveMissionForTicket(ticketId); } catch { missionId = null; }
  if (!missionId) return { ok: false, error: 'TICKET_RESOLUTION_FAILED' };

  // The assign endpoint needs a REAL ticket id (the mission's current ticket).
  // Resolve it from the resolved mission's tickets if the caller passed a mission id.
  if (ticketId.startsWith('mis_')) {
    const tickets = await missionApi('/v1/missions/' + encodeURIComponent(missionId) + '/tickets').catch(() => null);
    const t = z.array(z.object({ ticketId: z.string() }).passthrough()).safeParse((tickets as { tickets?: unknown } | null)?.tickets);
    if (t.success && t.data.length > 0) resolvedTicket = t.data[0].ticketId;
  }

  // TERMINAL CHECK FIRST. A closed mission must refuse the move BEFORE any
  // assignment is written (the old order assigned first and swallowed the
  // engine's 409, so dragging a cancelled card silently mutated its ticket).
  if (opts.status) {
    try {
      await missionApi(`/v1/missions/${encodeURIComponent(missionId)}/status`, { status: opts.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\(409\)/.test(message)) return { ok: false, error: 'MISSION_TERMINAL' };
      // Non-terminal engine hiccup: keep going, the steer still records intent.
    }
  }

  try {
    if (opts.agentId) {
      await missionApi(`/v1/missions/${encodeURIComponent(missionId)}/tickets/${encodeURIComponent(resolvedTicket)}/assign`, { agentId: opts.agentId });
    }
  } catch { /* assignment best-effort; the steer still records intent */ }

  // Feed the operator's move as an async steering note so the mission sees it.
  const note = `[operator via kanban] move ticket ${resolvedTicket.slice(0, 12)} to ${opts.status ?? 'next'}${opts.agentId ? '; responsible agent ' + opts.agentId.slice(0, 8) : ''}`;
  const steerRes = await missionApi(`/v1/missions/${encodeURIComponent(missionId)}/steer`, { note, kind: 'message' }).catch(() => ({ ok: false }));
  return {
    ok: true,
    missionId,
    ticketId: resolvedTicket,
    delivery: (steerRes as { delivery?: string } | null)?.delivery ?? 'queued_for_next_boundary',
    assignment: opts.agentId,
  };
}
