import type { Context } from 'hono';
import { z } from 'zod';
import type { HelldeskEnv } from '../helldesk.worker';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { UiActionSchema, normalizeUiAction, uiActionWorkstationId } from '../types';

const FRONT_DESK_HANDLER_LOG = '[frontDesk.handler]';

const SendFrontDeskMessageBody = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
  uiContext: z.string().max(10_000).optional(),
});

const FrontDeskCompletedBody = z.object({
  status: z.enum(['completed', 'failed']),
  reason: z.string().optional(),
  agentId: z.string().optional(),
});

/**
 * POST /api/departments/:departmentId/frontDesk/configure
 * Configure the FrontDeskDO for a department. Called when a workstation is created.
 */
export async function handleConfigureFrontDesk(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  // No-op: the frontDesk auto-configures on first message via DepartmentDO.
  console.log(`${FRONT_DESK_HANDLER_LOG} handleConfigureFrontDesk: no-op for departmentId=${params.departmentId}`);
  return c.json(resSuccess({ configured: true }), 200);
}

/**
 * POST /api/departments/:departmentId/frontDesk/message
 * Send a user message to the frontDesk. Creates session on first call,
 * sends follow-up on subsequent calls. No tickets are created.
 */
export async function handleSendFrontDeskMessage(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = SendFrontDeskMessageBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${FRONT_DESK_HANDLER_LOG} handleSendFrontDeskMessage: departmentId=${params.departmentId} message="${parsed.data.message.slice(0, 80)}"`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.sendFrontDeskMessage(
    parsed.data.message,
    parsed.data.model,
    parsed.data.uiContext
  );
  return c.json(resSuccess(result), 200);
}

/**
 * GET /api/departments/:departmentId/frontDesk/status
 * Get the frontDesk's session status.
 */
export async function handleGetFrontDeskStatus(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const department = getDepartmentDOStub(c.env, params.departmentId);
  const status = await department.getFrontDeskStatus();
  return c.json(resSuccess(status), 200);
}

/**
 * POST /api/departments/:departmentId/frontDesk/ensure
 * Eagerly ensure the frontDesk agent + container are running.
 * Called on page load so the terminal is available immediately.
 */
export async function handleEnsureFrontDesk(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  console.log(`${FRONT_DESK_HANDLER_LOG} handleEnsureFrontDesk: departmentId=${params.departmentId}`);
  const department = getDepartmentDOStub(c.env, params.departmentId);
  const result = await department.ensureFrontDesk();
  return c.json(resSuccess(result), 200);
}

/**
 * POST /api/departments/:departmentId/frontDesk/completed
 * Completion callback from the container. Clears the session immediately
 * so the UI reflects idle status without waiting for the alarm.
 */
export async function handleFrontDeskCompleted(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = FrontDeskCompletedBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${FRONT_DESK_HANDLER_LOG} handleFrontDeskCompleted: departmentId=${params.departmentId} status=${parsed.data.status}`
  );

  const department = getDepartmentDOStub(c.env, params.departmentId);
  await department.agentCompleted(parsed.data.agentId ?? '', {
    status: parsed.data.status,
    reason: parsed.data.reason,
  });
  return c.json(resSuccess({ acknowledged: true }), 200);
}

/**
 * POST /api/departments/:departmentId/frontDesk/destroy
 * Tear down the frontDesk agent and its container session. Does NOT destroy
 * the department — only removes the frontDesk agent so it can be re-created.
 */
export async function handleDestroyFrontDesk(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  console.log(
    `${FRONT_DESK_HANDLER_LOG} handleDestroyFrontDesk: destroying frontDesk for departmentId=${params.departmentId}`
  );
  const department = getDepartmentDOStub(c.env, params.departmentId);
  const status = await department.getFrontDeskStatus();
  if (status.session) {
    await department.deleteAgent(status.session.agentId);
  }
  return c.json(resSuccess({ destroyed: true }), 200);
}

const SetDashboardContextBody = z.object({
  context: z.string().max(10_000),
});

const BroadcastUiActionBody = z.object({
  action: UiActionSchema,
});

/**
 * POST /api/departments/:departmentId/frontDesk/dashboard-context
 * Store the current dashboard context (XML string) in the DepartmentDO.
 * Used as a fallback when sendFrontDeskMessage is called without explicit uiContext.
 */
export async function handleSetDashboardContext(
  c: Context<HelldeskEnv>,
  params: { departmentId: string }
) {
  const body = await parseJsonBody(c);
  const parsed = SetDashboardContextBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const department = getDepartmentDOStub(c.env, params.departmentId);
  await department.setDashboardContext(parsed.data.context);
  return c.json(resSuccess({ stored: true }), 200);
}

/**
 * POST /api/departments/:departmentId/frontDesk/ui-action
 * Broadcast a UI action to all connected dashboard WebSocket clients.
 * Called by the frontDesk agent to trigger navigation/drawer actions in the dashboard.
 * Protected by kiloAuthMiddleware (same as other /api/departments/:departmentId/frontDesk/* routes).
 */
export async function handleBroadcastUiAction(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const body = await parseJsonBody(c);
  const parsed = BroadcastUiActionBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${FRONT_DESK_HANDLER_LOG} handleBroadcastUiAction: departmentId=${params.departmentId} type=${parsed.data.action.type}`
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
