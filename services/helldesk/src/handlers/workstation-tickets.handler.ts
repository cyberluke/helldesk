import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import { TicketType, TicketPriority, TicketStatus } from '../types';
import type { HelldeskEnv } from '../helldesk.worker';

const HANDLER_LOG = '[workstation-tickets.handler]';

const CreateTicketBody = z.object({
  type: TicketType,
  title: z.string().min(1),
  body: z.string().optional(),
  priority: TicketPriority.optional(),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  assignee_agent_id: z.string().optional(),
});

const UpdateTicketStatusBody = z.object({
  status: TicketStatus,
  agent_id: z.string().min(1),
});

const CloseTicketBody = z.object({
  agent_id: z.string().min(1),
});

const NonNegativeInt = z.coerce.number().int().nonnegative();

export async function handleCreateTicket(c: Context<HelldeskEnv>, params: { workstationId: string }) {
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
  const ticket = await department.createTicket({ ...parsed.data, workstation_id: params.workstationId });
  console.log(
    `${HANDLER_LOG} handleCreateTicket: created ticket ${JSON.stringify(ticket).slice(0, 200)}`
  );
  return c.json(resSuccess(ticket), 201);
}

export async function handleListTickets(c: Context<HelldeskEnv>, params: { workstationId: string }) {
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
    limit: limit?.data,
    offset: offset?.data,
  });
  return c.json(resSuccess(tickets));
}

export async function handleGetTicket(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; ticketId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const ticket = await department.getTicketAsync(params.ticketId);
  if (!ticket || ticket.workstation_id !== params.workstationId) return c.json(resError('Ticket not found'), 404);
  return c.json(resSuccess(ticket));
}

export async function handleUpdateTicketStatus(
  c: Context<HelldeskEnv>,
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
  const ticket = await department.updateTicketStatus(params.ticketId, parsed.data.status, parsed.data.agent_id);
  return c.json(resSuccess(ticket));
}

export async function handleCloseTicket(
  c: Context<HelldeskEnv>,
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

export async function handleSlingTicket(c: Context<HelldeskEnv>, params: { workstationId: string }) {
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
  const result = await department.slingTicket({ ...parsed.data, workstationId: params.workstationId });
  console.log(
    `${HANDLER_LOG} handleSlingTicket: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );
  return c.json(resSuccess(result), 201);
}

export async function handleDeleteTicket(
  c: Context<HelldeskEnv>,
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
