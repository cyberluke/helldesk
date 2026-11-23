import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import { TicketType, TicketPriority, TicketStatus } from '../types';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';
import { routeMissionTicketMove, sizeTaskForSpec } from '../runtime/mission-dispatch';
import { TSHIRT_POINTS, TSHIRT_SIZES, type TShirtSize } from '../../../local/src/task-sizer';

const HANDLER_LOG = '[workstation-tickets.handler]';

const CreateTicketBody = z.object({
  type: TicketType,
  title: z.string().min(1),
  body: z.string().optional(),
  priority: TicketPriority.optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  assignee_agent_id: z.string().optional(),
  depends_on: z.array(z.string().min(1)).max(100).optional(),
  // Enforcer picker — which NAI process enforces this task. Stored into
  // metadata.break_room_controls so the engine already gates dispatch/ExcellenceGovernor/rev.
  break_room_controls: z
    .object({
      agents: z.boolean().optional(),
      reviewer: z.boolean().optional(),
      reviewerA: z.boolean().optional(),
      reviewerB: z.boolean().optional(),
      excellenceGovernor: z.boolean().optional(),
      review_mode: z.enum(['ReviewThenLand', 'ReviewAndMerge']).optional(),
    })
    .optional(),
  // Provider-agnostic per-task engine override (mutation/review/adjudicate).
  // Folded into metadata.engine_matrix so dispatch carries it to the mission.
  engine_matrix: z.record(z.string(), z.unknown()).optional(),
  // Manual estimate at creation (optional; otherwise the sizing pass runs).
  story_points: z.number().int().min(1).max(100).optional(),
  tshirt_size: z.enum(TSHIRT_SIZES).optional(),
  size_confidence: z.enum(['high', 'medium', 'low']).optional(),
  size_rationale: z.string().max(600).optional(),
});

const UpdateTicketStatusBody = z.object({
  status: TicketStatus,
  agent_id: z.string().min(1),
});

const CloseTicketBody = z.object({
  agent_id: z.string().min(1),
});

const NonNegativeInt = z.coerce.number().int().nonnegative();

export async function handleCreateTicket(c: Context<HelldeskAppEnv>, params: { workstationId: string }) {
  const parsed = CreateTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${HANDLER_LOG} handleCreateTicket: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${HANDLER_LOG} handleCreateTicket: workstationId=${params.workstationId} type=${parsed.data.type} title="${parsed.data.title?.slice(0, 80)}" assignee=${parsed.data.assignee_agent_id ?? 'none'}`
  );
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  for (const id of parsed.data.depends_on || []) {
    if (!(await department.getTicketAsync(id))) return c.json(resError(`Dependency does not exist in this department: ${id}`), 400);
  }
  const metadata: Record<string, unknown> = {
    ...(parsed.data.metadata ?? {}),
    ...(parsed.data.engine_matrix ? { engine_matrix: parsed.data.engine_matrix } : {}),
  };
  const manualPoints =
    parsed.data.story_points ??
    (parsed.data.tshirt_size ? TSHIRT_POINTS[parsed.data.tshirt_size as TShirtSize] : undefined);
  if (manualPoints != null) {
    metadata.story_points = manualPoints;
    metadata.tshirt_size = parsed.data.tshirt_size ?? null;
    metadata.size_confidence = parsed.data.size_confidence ?? 'high';
    metadata.size_rationale = parsed.data.size_rationale ?? 'operator supplied at creation';
    metadata.size_model = 'manual';
    metadata.sized_at = new Date().toISOString();
    metadata.sizing_state = 'manual';
  } else {
    // One small structured-JSON estimate at creation; failure is non-blocking.
    const size = await sizeTaskForSpec({
      title: parsed.data.title,
      body: parsed.data.body,
      workspace: params.workstationId,
      kind: parsed.data.type,
    });
    if (size?.state === 'sized') {
      metadata.story_points = size.points;
      metadata.tshirt_size = size.tshirt;
      metadata.size_confidence = size.confidence;
      metadata.size_rationale = size.rationale;
      metadata.size_model = size.model;
      metadata.sized_at = new Date().toISOString();
      metadata.sizing_state = 'sized';
    } else {
      metadata.sizing_state = 'unsized';
      metadata.size_error = size?.error ?? 'sizing unavailable';
    }
  }
  const ticket = await department.createTicket({
    ...parsed.data,
    assignee_agent_ticket_id: parsed.data.assignee_agent_id,
    workstation_id: params.workstationId,
    metadata,
  });
  console.log(
    `${HANDLER_LOG} handleCreateTicket: created ticket ${JSON.stringify(ticket).slice(0, 200)}`
  );
  return c.json(resSuccess(ticket), 201);
}

export interface TicketSizeDeps {
  getTicket?: (ticketId: string) => Promise<{ metadata?: Record<string, unknown> } | null>;
  updateTicketMetadata?: (ticketId: string, metadata: Record<string, unknown>) => Promise<void>;
}

/** Local-ticket manual size override. Mission tickets use /v1/tickets/:id/size. */
export async function handleSetTicketSize(
  c: Context<HelldeskAppEnv>,
  params: { ticketId: string },
  deps?: TicketSizeDeps,
) {
  const parsed = z
    .object({
      tshirt: z.enum(TSHIRT_SIZES),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
      rationale: z.string().trim().max(600).optional(),
    })
    .safeParse(await parseJsonBody(c));
  if (!parsed.success) return c.json(resError('Invalid size body'), 400);
  const ticket = await deps?.getTicket?.(params.ticketId);
  if (!ticket) return c.json(resError('Ticket not found'), 404);
  const points = TSHIRT_POINTS[parsed.data.tshirt as TShirtSize];
  const metadata: Record<string, unknown> = {
    ...(ticket.metadata ?? {}),
    story_points: points,
    tshirt_size: parsed.data.tshirt,
    size_confidence: parsed.data.confidence ?? 'high',
    size_rationale: parsed.data.rationale ?? 'operator override',
    size_model: 'manual',
    sized_at: new Date().toISOString(),
    sizing_state: 'manual',
  };
  await deps?.updateTicketMetadata?.(params.ticketId, metadata);
  return c.json(resSuccess({ ...ticket, metadata }));
}

export async function handleListTickets(c: Context<HelldeskAppEnv>, params: { workstationId?: string }) {
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const limit = limitRaw !== undefined ? NonNegativeInt.safeParse(limitRaw) : undefined;
  const offset = offsetRaw !== undefined ? NonNegativeInt.safeParse(offsetRaw) : undefined;
  if ((limit && !limit.success) || (offset && !offset.success)) {
    return c.json(resError('limit and offset must be non-negative integers'), 400);
  }

  const statusRaw = c.req.query('status');
  const typeRaw = c.req.query('type');
  const status = statusRaw !== undefined ? TicketStatus.safeParse(statusRaw) : undefined;
  const type = typeRaw !== undefined ? TicketType.safeParse(typeRaw) : undefined;
  if ((status && !status.success) || (type && !type.success)) {
    return c.json(resError('Invalid status or type filter'), 400);
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const tickets = await department.listTickets({
    status: status?.data,
    type: type?.data,
    assignee_agent_ticket_id:
      c.req.query('assignee_agent_ticket_id') ?? c.req.query('assignee_agent_id'),
    workstation_id: params.workstationId,
    include_archived: c.req.query('include_archived') === '1' || c.req.query('include_archived') === 'true',
    limit: limit?.data,
    offset: offset?.data,
  });
  return c.json(resSuccess(tickets));
}

export async function handleGetTicket(
  c: Context<HelldeskAppEnv>,
  params: { workstationId: string; ticketId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const ticket = await department.getTicketAsync(params.ticketId);
  if (!ticket || ticket.workstation_id !== params.workstationId) return c.json(resError('Ticket not found'), 404);
  return c.json(resSuccess(ticket));
}

export async function handleUpdateTicketStatus(
  c: Context<HelldeskAppEnv>,
  params: { workstationId: string; ticketId: string }
) {
  const parsed = UpdateTicketStatusBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.agent_id) {
    return c.json(resError('agent_id does not match authenticated agent'), 403);
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // Mission-owned ticket (mis_*/mission id)? The department DO does NOT store
  // mission tickets and throws 'Ticket <id> not found' (the exact operator error).
  // Route the operator's move to the mission controller instead — record the
  // assignment + feed the target state as an async steering note. NEVER 500.
  const missionMove = await routeMissionTicketMove(params.ticketId, { status: parsed.data.status, agentId: parsed.data.agent_id }).catch(err => ({ ok: false as const, error: (err as Error)?.message ?? 'mission_resolution_failed' }));
  if (missionMove.ok) {
    return c.json(resSuccess({ ticketId: missionMove.ticketId, status: parsed.data.status, missionId: missionMove.missionId, delivery: missionMove.delivery, assignment: missionMove.assignment ?? undefined }));
  }
  if (missionMove.error === 'MISSION_TERMINAL') {
    return c.json(resError('Mission is closed (verified or cancelled) and cannot be moved'), 409);
  }
  // Not a mission ticket -> normal department ticket path.
  const ticket = await department.updateTicketStatus(params.ticketId, parsed.data.status, parsed.data.agent_id);
  return c.json(resSuccess(ticket));
}

export async function handleCloseTicket(
  c: Context<HelldeskAppEnv>,
  params: { workstationId: string; ticketId: string }
) {
  const parsed = CloseTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.agent_id) {
    return c.json(resError('agent_id does not match authenticated agent'), 403);
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const ticket = await department.closeTicket(params.ticketId, parsed.data.agent_id);
  return c.json(resSuccess(ticket));
}

const SlingTicketBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function handleSlingTicket(c: Context<HelldeskAppEnv>, params: { workstationId: string }) {
  const parsed = SlingTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${HANDLER_LOG} handleSlingTicket: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${HANDLER_LOG} handleSlingTicket: workstationId=${params.workstationId} title="${parsed.data.title?.slice(0, 80)}" metadata=${JSON.stringify(parsed.data.metadata)}`
  );
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const result = await department.slings({ ...parsed.data, workstationId: params.workstationId });
  console.log(
    `${HANDLER_LOG} handleSlingTicket: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );
  return c.json(resSuccess(result), 201);
}

export async function handleDeleteTicket(
  c: Context<HelldeskAppEnv>,
  params: { workstationId: string; ticketId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const ticket = await department.getTicketAsync(params.ticketId);
  if (!ticket || ticket.workstation_id !== params.workstationId) return c.json(resError('Ticket not found'), 404);
  // Pass workstationId as a defense-in-depth workstation check in the DO delete path.
  await department.deleteTicket(params.ticketId, params.workstationId);
  return c.json(resSuccess({ deleted: true }));
}
