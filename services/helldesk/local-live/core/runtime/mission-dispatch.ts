import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveConfigPath, defaultDataDir } from '../../../local/src/config';
import type { SqlStorage } from './runtime-types';
import type { Ticket } from '../types';
import * as ticketOps from '../dos/department/tickets';
import { query } from '../util/query.util';
import { tickets } from '../db/tables/tickets.table';

const Config = z.object({ daemon: z.object({ port: z.number().int().default(4789), dataDir: z.string().default(defaultDataDir()), token: z.string().optional() }) });
const RecordValue = z.record(z.string(), z.unknown());
const Binding = z.object({ missionId: z.string().optional(), submission: z.enum(['submitting', 'accepted']), workspace: z.string(), objective: z.string(), idempotencyKey:z.string().optional(),title:z.string().optional(),taskGates:z.array(z.string()).optional() });
const Mission = z.object({ mission_id: z.string(), state: z.string(), blocked_reason: z.string().nullable().optional() });
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
  if (!response.ok) throw Error(`Mission daemon refused ${route} (${response.status})`);
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
  const result = z.object({ missionId: z.string() }).parse(await missionApi('/v1/missions', { workspaceId: registered.workspace.workspaceId, objective:binding.objective, idempotencyKey:binding.idempotencyKey, taskGates:binding.taskGates, engineMatrix, tickets: [{ title: binding.title, objective:binding.objective }] }));
  binding = { ...binding, missionId: result.missionId, submission: 'accepted' };
  persist(sql, ticketOps.getTicket(sql, ticket.ticket_id) || ticket, binding);
  return binding;
}

export async function readMission(binding: MissionBinding) {
  if (!binding.missionId) return null;
  return z.object({ mission: Mission }).parse(await missionApi('/v1/missions/' + encodeURIComponent(binding.missionId))).mission;
}

export async function cancelMission(binding: MissionBinding): Promise<void> {
  if (binding.missionId) RecordValue.parse(await missionApi('/v1/missions/' + encodeURIComponent(binding.missionId) + '/cancel', {}));
}

export async function steerLocalMission(sql: SqlStorage, ticketId: string, note: string, kind: 'message' | 'interrupt' | 'force-review' | 'disapprove' = 'message'): Promise<{ ok: true; delivery: string }> {
  const ticket = ticketOps.getTicket(sql, ticketId);
  if (!ticket) throw Error('Task not found');
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
