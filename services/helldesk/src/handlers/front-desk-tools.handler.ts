import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { getHelldeskUserStub } from '../dos/HelldeskUser.do';
import { getHelldeskOrgStub } from '../dos/HelldeskOrg.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import {
  TicketStatus,
  TicketType,
  TicketPriority,
  UiActionSchema,
  normalizeUiAction,
  uiActionWorkstationId,
} from '../types';
import type { HelldeskEnv } from '../helldesk.worker';

const HANDLER_LOG = '[front-desk-tools.handler]';

const FrontDeskSlingBody = z.object({
  workstation_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  labels: z.array(z.string()).optional(),
});

const FrontDeskSlingBatchBody = z
  .object({
    workstation_id: z.string().min(1),
    shift_title: z.string().min(1),
    tasks: z
      .array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          depends_on: z.array(z.number().int().min(0)).optional(),
        })
      )
      .min(1)
      .max(50),
    merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),
    /** Set to true only when ALL tasks are genuinely independent (no shared files, no shared state). */
    parallel: z.boolean().optional(),
    staged: z.boolean().optional(),
    /** Metadata stamped onto BOTH the shift ticket AND every task ticket. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((data, ctx) => {
    // Require dependency graph unless explicitly opted out with parallel: true.
    // Without depends_on, all polecats start simultaneously on the same codebase
    // and produce merge conflicts.
    if (data.parallel) return;
    if (data.tasks.length <= 1) return;
    const hasDeps = data.tasks.some(t => t.depends_on && t.depends_on.length > 0);
    if (!hasDeps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Shift has multiple tasks but none declare depends_on. ' +
          'Without dependencies, all polecats start at the same time on the same codebase and will produce merge conflicts. ' +
          'Add depends_on to express task ordering, or set parallel: true if ALL tasks are genuinely independent ' +
          '(they touch completely different files with no shared state).',
        path: ['tasks'],
      });
    }
  });

const FrontDeskMemoBody = z.object({
  workstation_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  from_agent_id: z.string().min(1),
});

const NonNegativeInt = z.coerce.number().int().nonnegative();

/**
 * Resolve the userId for the frontDesk's department.
 *
 * In production the JWT is always present (set by frontDeskAuthMiddleware).
 * In development the middleware is skipped, so we fall back to a
 * `userId` query parameter to keep the routes testable.
 */
function resolveUserId(c: Context<HelldeskEnv>): string | null {
  const jwt = c.get('agentJWT');
  if (jwt?.userId) return jwt.userId;
  // Dev-mode fallback: accept userId as a query param
  return c.req.query('userId') ?? null;
}

/**
 * Resolve the DO stub that owns workstations for a given department. For personal departments
 * this is HelldeskUserDO; for org departments it's HelldeskOrgDO.
 */
async function resolveWorkstationOwnerForDepartment(env: Env, departmentId: string, userId: string) {
  const departmentStub = getDepartmentDOStub(env, departmentId);
  try {
    const config = await departmentStub.getDepartmentConfig();
    if (config.owner_type === 'org' && config.organization_id) {
      return getHelldeskOrgStub(env, config.organization_id);
    }
  } catch {
    // Fall through to user DO
  }
  return getHelldeskUserStub(env, userId);
}

/**
 * Verify that `workstationId` belongs to `departmentId` by checking the workstation registry
 * (user DO for personal departments, org DO for org departments).
 */
async function verifyWorkstationBelongsToDepartment(
  c: Context<HelldeskEnv>,
  departmentId: string,
  workstationId: string
): Promise<boolean> {
  const userId = resolveUserId(c);
  if (!userId) return false;
  const ownerDO = await resolveWorkstationOwnerForDepartment(c.env, departmentId, userId);
  const workstation = await ownerDO.getWorkstationAsync(workstationId);
  return workstation !== null && workstation.department_id === departmentId;
}

/**
 * POST /api/frontDesk/:departmentId/tools/sling
 * Sling a task to a soul in a specific workstation. Creates a ticket, assigns
 * an agent, and arms the alarm for dispatch.
 */
export async function handleFrontDeskSling(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const parsed = FrontDeskSlingBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, parsed.data.workstation_id);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskSling: departmentId=${params.departmentId} workstationId=${parsed.data.workstation_id} title="${parsed.data.title.slice(0, 80)}"`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.slingTicket({
    workstationId: parsed.data.workstation_id,
    ...parsed.data,
  });

  console.log(
    `${HANDLER_LOG} handleFrontDeskSling: completed, result=${JSON.stringify(result).slice(0, 300)}`
  );

  return c.json(resSuccess(result), 201);
}

/**
 * GET /api/frontDesk/:departmentId/tools/workstations
 * List all workstations in the department. Requires userId to route to the correct
 * HelldeskUserDO instance (from JWT in prod, query param in dev).
 */
export async function handleFrontDeskListWorkstations(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const userId = resolveUserId(c);
  if (!userId) {
    return c.json(resError('Missing userId in token (or userId query param in dev mode)'), 401);
  }

  console.log(`${HANDLER_LOG} handleFrontDeskListWorkstations: departmentId=${params.departmentId} userId=${userId}`);

  const ownerDO = await resolveWorkstationOwnerForDepartment(c.env, params.departmentId, userId);
  const workstations = await ownerDO.listWorkstations(params.departmentId);

  return c.json(resSuccess(workstations));
}

/**
 * GET /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets
 * List tickets in a specific workstation. Supports status and type filtering.
 */
export async function handleFrontDeskListTickets(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

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

  console.log(
    `${HANDLER_LOG} handleFrontDeskListTickets: departmentId=${params.departmentId} workstationId=${params.workstationId} status=${statusRaw ?? 'all'} type=${typeRaw ?? 'all'}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const tickets = await department.listTickets({
    workstation_id: params.workstationId,
    status: status?.data,
    type: type?.data,
    assignee_agent_ticket_id:
      c.req.query('assignee_agent_ticket_id') ?? c.req.query('assignee_agent_id'),
    limit: limit?.data,
    offset: offset?.data,
  });

  return c.json(resSuccess(tickets));
}

/**
 * GET /api/frontDesk/:departmentId/tools/workstations/:workstationId/agents
 * List agents in a specific workstation.
 */
export async function handleFrontDeskListAgents(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskListAgents: departmentId=${params.departmentId} workstationId=${params.workstationId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const agents = await department.listAgents({ workstation_id: params.workstationId });

  return c.json(resSuccess(agents));
}

/**
 * POST /api/frontDesk/:departmentId/tools/memo
 * Send memo to an agent in any workstation. The frontDesk can communicate cross-workstation.
 */
export async function handleFrontDeskSendMemo(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const parsed = FrontDeskMemoBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, parsed.data.workstation_id);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskSendMemo: departmentId=${params.departmentId} workstationId=${parsed.data.workstation_id} to=${parsed.data.to_agent_id} subject="${parsed.data.subject.slice(0, 80)}"`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  await department.sendMemo({
    from_agent_id: parsed.data.from_agent_id,
    to_agent_id: parsed.data.to_agent_id,
    subject: parsed.data.subject,
    body: parsed.data.body,
  });

  return c.json(resSuccess({ sent: true }));
}

/**
 * POST /api/frontDesk/:departmentId/tools/sling-batch
 * Sling multiple tickets as a tracked shift. Creates N tickets + 1 shift,
 * assigns polecats, and dispatches all in one call.
 */
export async function handleFrontDeskSlingBatch(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const parsed = FrontDeskSlingBatchBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, parsed.data.workstation_id);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskSlingBatch: departmentId=${params.departmentId} workstationId=${parsed.data.workstation_id} shift="${parsed.data.shift_title.slice(0, 80)}" tasks=${parsed.data.tasks.length}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.slingShift({
    workstationId: parsed.data.workstation_id,
    shiftTitle: parsed.data.shift_title,
    tasks: parsed.data.tasks,
    merge_mode: parsed.data.merge_mode,
    staged: parsed.data.staged,
    metadata: parsed.data.metadata,
  });

  console.log(
    `${HANDLER_LOG} handleFrontDeskSlingBatch: completed, shift=${result.shift.id} tickets=${result.tickets.length}`
  );

  return c.json(resSuccess(result), 201);
}

/**
 * GET /api/frontDesk/:departmentId/tools/shifts
 * List active shifts with progress counts.
 */
export async function handleFrontDeskListShifts(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  console.log(`${HANDLER_LOG} handleFrontDeskListShifts: departmentId=${params.departmentId}`);

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const shifts = await department.listShifts();

  return c.json(resSuccess(shifts));
}

/**
 * GET /api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/pending-nudges
 * Returns undelivered, non-expired nudges for the given agent.
 * Allows the frontDesk to inspect an agent's nudge queue and decide whether to intervene.
 */
export async function handleFrontDeskGetPendingNudges(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string; agentId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskGetPendingNudges: departmentId=${params.departmentId} workstationId=${params.workstationId} agentId=${params.agentId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const nudges = await department.getPendingNudges(params.agentId);

  return c.json(resSuccess(nudges));
}

/**
 * GET /api/frontDesk/:departmentId/tools/shifts/:shiftId
 * Detailed shift status with per-ticket breakdown.
 */
export async function handleFrontDeskShiftStatus(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftStatus: departmentId=${params.departmentId} shiftId=${params.shiftId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const status = await department.getShiftStatus(params.shiftId);

  if (!status) return c.json(resError('Shift not found'), 404);
  return c.json(resSuccess(status));
}

const TicketUpdateBody = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    priority: TicketPriority.optional(),
    labels: z.array(z.string()).optional(),
    status: TicketStatus.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    workstation_id: z.string().min(1).nullable().optional(),
    parent_ticket_id: z.string().min(1).nullable().optional(),
    depends_on: z.array(z.string().uuid()).optional(),
  })
  .refine(
    data =>
      data.title !== undefined ||
      data.body !== undefined ||
      data.priority !== undefined ||
      data.labels !== undefined ||
      data.status !== undefined ||
      data.metadata !== undefined ||
      data.workstation_id !== undefined ||
      data.parent_ticket_id !== undefined ||
      data.depends_on !== undefined,
    { message: 'At least one field must be provided' }
  );

const TicketReassignBody = z.object({
  agent_id: z.string().min(1),
});

const ShiftUpdateBody = z
  .object({
    merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),
    feature_branch: z.string().min(1).optional(),
  })
  .refine(data => data.merge_mode !== undefined || data.feature_branch !== undefined, {
    message: 'At least one field must be provided',
  });

/**
 * PATCH /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId
 * Partially update a ticket's editable fields (title, body, priority, labels, status, metadata).
 */
export async function handleFrontDeskTicketUpdate(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string; ticketId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  const parsed = TicketUpdateBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskTicketUpdate: departmentId=${params.departmentId} workstationId=${params.workstationId} ticketId=${params.ticketId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);

  // Verify the ticket belongs to this workstation (same check as handleFrontDeskTicketDelete)
  const existing = await department.getTicketAsync(params.ticketId);
  if (!existing) {
    return c.json(resError('Ticket not found'), 404);
  }
  if (existing.workstation_id !== params.workstationId) {
    return c.json(resError('Ticket does not belong to this workstation'), 403);
  }

  const ticket = await department.updateTicket(params.ticketId, parsed.data, 'frontDesk');

  return c.json(resSuccess(ticket));
}

/**
 * POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId/reassign
 * Reassign a ticket to a different agent. Unhooks the current agent (if any)
 * and hooks the specified agent.
 */
export async function handleFrontDeskTicketReassign(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string; ticketId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  const parsed = TicketReassignBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskTicketReassign: departmentId=${params.departmentId} workstationId=${params.workstationId} ticketId=${params.ticketId} targetAgent=${parsed.data.agent_id}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);

  const ticket = await department.getTicketAsync(params.ticketId);
  if (!ticket) {
    return c.json(resError('Ticket not found'), 404);
  }
  if (ticket.workstation_id !== params.workstationId) {
    return c.json(resError('Ticket does not belong to this workstation'), 403);
  }

  const targetAgent = await department.getAgentAsync(parsed.data.agent_id);
  if (!targetAgent) {
    return c.json(resError('Target agent not found'), 404);
  }
  if (targetAgent.workstation_id !== params.workstationId) {
    return c.json(resError('Target agent does not belong to this workstation'), 403);
  }

  // Hook the new agent first — if this fails, the old assignment is untouched
  await department.hookTicket(parsed.data.agent_id, params.ticketId);

  // Only unhook the old agent if it is still hooked to this specific ticket
  if (ticket.assignee_agent_ticket_id && ticket.assignee_agent_ticket_id !== parsed.data.agent_id) {
    const oldAgent = await department.getAgentAsync(ticket.assignee_agent_ticket_id);
    if (oldAgent && oldAgent.current_hook_ticket_id === params.ticketId) {
      await department.unhookTicket(ticket.assignee_agent_ticket_id);
    }
  }

  const updated = await department.getTicketAsync(params.ticketId);
  return c.json(resSuccess(updated));
}

/**
 * POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/reset
 * Force-reset an agent to idle, unhooking from any current ticket.
 */
export async function handleFrontDeskAgentReset(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string; agentId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskAgentReset: departmentId=${params.departmentId} workstationId=${params.workstationId} agentId=${params.agentId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);

  const agent = await department.getAgentAsync(params.agentId);
  if (!agent) {
    return c.json(resError('Agent not found'), 404);
  }
  if (agent.workstation_id !== params.workstationId) {
    return c.json(resError('Agent does not belong to this workstation'), 403);
  }

  await department.resetAgent(params.agentId);

  return c.json(resSuccess({ reset: true }));
}

/**
 * POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/close
 * Force-close a shift and all its tracked open tickets.
 */
export async function handleFrontDeskShiftClose(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftClose: departmentId=${params.departmentId} shiftId=${params.shiftId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const shift = await department.closeShift(params.shiftId);

  if (!shift) return c.json(resError('Shift not found'), 404);
  return c.json(resSuccess(shift));
}

/**
 * PATCH /api/frontDesk/:departmentId/tools/shifts/:shiftId
 * Edit shift metadata (merge_mode or feature_branch).
 */
export async function handleFrontDeskShiftUpdate(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  const parsed = ShiftUpdateBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftUpdate: departmentId=${params.departmentId} shiftId=${params.shiftId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const shift = await department.updateShift(params.shiftId, parsed.data);

  if (!shift) return c.json(resError('Shift not found'), 404);
  return c.json(resSuccess(shift));
}

/**
 * DELETE /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId
 * Delete a ticket that belongs to the specified workstation.
 */
export async function handleFrontDeskTicketDelete(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string; ticketId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskTicketDelete: departmentId=${params.departmentId} workstationId=${params.workstationId} ticketId=${params.ticketId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);

  const ticket = await department.getTicketAsync(params.ticketId);
  if (!ticket) {
    return c.json(resError('Ticket not found'), 404);
  }
  if (ticket.workstation_id !== params.workstationId) {
    return c.json(resError('Ticket does not belong to this workstation'), 403);
  }

  // Pass workstationId as a defense-in-depth workstation check in the DO delete path.
  await department.deleteTicket(params.ticketId, params.workstationId);

  return c.json(resSuccess({ deleted: true }));
}

const FrontDeskBulkDeleteTicketsBody = z.object({
  ticket_ids: z.array(z.string().uuid()).min(1).max(5000),
});

export async function handleFrontDeskBulkDeleteTickets(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  const parsed = FrontDeskBulkDeleteTicketsBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError(`Invalid request body: ${parsed.error.message}`), 400);
  }

  const { ticket_ids } = parsed.data;

  console.log(
    `${HANDLER_LOG} handleFrontDeskBulkDeleteTickets: departmentId=${params.departmentId} workstationId=${params.workstationId} count=${ticket_ids.length}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  // Pass workstationId so the DO filters to tickets actually belonging to this workstation —
  // prevents a frontDesk tool from deleting tickets from a sibling workstation by
  // passing their IDs alongside an authorized workstation.
  const count = await department.deleteTickets(ticket_ids, params.workstationId);

  return c.json(resSuccess({ deleted: count }));
}

const FrontDeskDeleteTicketsByStatusBody = z.object({
  status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
  type: z
    .enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent'])
    .optional(),
});

export async function handleFrontDeskDeleteTicketsByStatus(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; workstationId: string }
) {
  const workstationOwned = await verifyWorkstationBelongsToDepartment(c, params.departmentId, params.workstationId);
  if (!workstationOwned) {
    return c.json(resError('Workstation not found in this department'), 403);
  }

  const parsed = FrontDeskDeleteTicketsByStatusBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError(`Invalid request body: ${parsed.error.message}`), 400);
  }

  const { status, type } = parsed.data;

  console.log(
    `${HANDLER_LOG} handleFrontDeskDeleteTicketsByStatus: departmentId=${params.departmentId} workstationId=${params.workstationId} status=${status}${type ? ` type=${type}` : ''}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const count = await department.deleteTicketsByStatus(status, type, params.workstationId);

  return c.json(resSuccess({ deleted: count }));
}

/**
 * POST /api/frontDesk/:departmentId/tools/escalations/:escalationId/acknowledge
 * Acknowledge an escalation, marking it as reviewed.
 */
export async function handleFrontDeskEscalationAcknowledge(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; escalationId: string }
) {
  console.log(
    `${HANDLER_LOG} handleFrontDeskEscalationAcknowledge: departmentId=${params.departmentId} escalationId=${params.escalationId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const escalation = await department.acknowledgeEscalation(params.escalationId);

  if (!escalation) return c.json(resError('Escalation not found'), 404);
  return c.json(resSuccess(escalation));
}

/**
 * POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/start
 * Transition a staged shift to active: hook agents and begin dispatch.
 */
export async function handleFrontDeskShiftStart(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftStart: departmentId=${params.departmentId} shiftId=${params.shiftId}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  let result: { shift: { id: string }; tickets: unknown[] };
  try {
    result = await department.startShift(params.shiftId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('not found') || message.includes('not staged')) {
      return c.json(resError('Shift not found or not staged'), 404);
    }
    throw err;
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftStart: completed, shift=${result.shift.id} tickets=${result.tickets.length}`
  );

  return c.json(resSuccess(result));
}

const ShiftAddTicketBody = z.object({
  ticket_id: z.string().uuid(),
  depends_on: z.array(z.string().uuid()).optional(),
});

/**
 * POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/add-ticket
 * Add an existing ticket to a shift's tracking.
 */
export async function handleFrontDeskShiftAddTicket(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  const parsed = ShiftAddTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftAddTicket: departmentId=${params.departmentId} shiftId=${params.shiftId} ticketId=${parsed.data.ticket_id}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.shiftAddTicket(
    params.shiftId,
    parsed.data.ticket_id,
    parsed.data.depends_on
  );
  return c.json(resSuccess(result));
}

const ShiftRemoveTicketBody = z.object({
  ticket_id: z.string().uuid(),
});

/**
 * POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/remove-ticket
 * Remove a ticket from a shift's tracking.
 */
export async function handleFrontDeskShiftRemoveTicket(
  c: Context<HelldeskEnv>,
  params: { departmentId: string; shiftId: string }
) {
  const parsed = ShiftRemoveTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskShiftRemoveTicket: departmentId=${params.departmentId} shiftId=${params.shiftId} ticketId=${parsed.data.ticket_id}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.shiftRemoveTicket(params.shiftId, parsed.data.ticket_id);
  return c.json(resSuccess(result));
}

const FrontDeskUiActionBody = z.object({
  action: UiActionSchema,
});

/**
 * POST /api/frontDesk/:departmentId/tools/ui-action
 * FrontDesk tool: broadcast a UI action to all connected dashboard WebSocket clients.
 * Allows the frontDesk to trigger navigation/drawer actions in the user's dashboard.
 */
export async function handleFrontDeskUiAction(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = FrontDeskUiActionBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleFrontDeskUiAction: departmentId=${params.departmentId} type=${parsed.data.action.type}`
  );

  const action = normalizeUiAction(parsed.data.action, params.departmentId);

  const department = getDepartmentDOStub(c.env, params.departmentId);

  const workstationId = uiActionWorkstationId(action);
  if (workstationId) {
    const workstation = await department.getWorkstationAsync(workstationId);
    if (!workstation) {
      return c.json({ success: false, error: `Workstation ${workstationId} does not belong to this department` }, 400);
    }
  }

  await department.broadcastUiAction(action);
  return c.json(resSuccess({ broadcast: true }), 200);
}
