import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { AgentRole, AgentStatus } from '../types';
import type { HelldeskEnv } from '../helldesk.worker';
import { getEnforcedAgentId } from '../middleware/auth.middleware';

const AGENT_LOG = '[workstation-agents.handler]';

const RegisterAgentBody = z.object({
  role: AgentRole,
  name: z.string().min(1),
  identity: z.string().min(1),
});

const HookTicketBody = z.object({
  ticket_id: z.string().min(1),
});

const AgentDoneBody = z.object({
  branch: z.string().min(1),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});

const AgentCompletedBody = z.object({
  status: z.enum(['completed', 'failed']),
  reason: z.string().optional(),
});

const WriteCheckpointBody = z.object({
  data: z.unknown(),
});

const UpdateAgentStatusMessageBody = z.object({
  message: z.string().trim().min(1).max(280),
});

export async function handleRegisterAgent(c: Context<HelldeskEnv>, params: { workstationId: string }) {
  const parsed = RegisterAgentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const agent = await department.registerAgent({ ...parsed.data, workstation_id: params.workstationId });
  return c.json(resSuccess(agent), 201);
}

export async function handleListAgents(c: Context<HelldeskEnv>, params: { workstationId: string }) {
  const roleRaw = c.req.query('role');
  const statusRaw = c.req.query('status');
  const role = roleRaw !== undefined ? AgentRole.safeParse(roleRaw) : undefined;
  const status = statusRaw !== undefined ? AgentStatus.safeParse(statusRaw) : undefined;
  if ((role && !role.success) || (status && !status.success)) {
    return c.json(resError('Invalid role or status filter'), 400);
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const agents = await department.listAgents({
    role: role?.data,
    status: status?.data,
    workstation_id: params.workstationId,
  });
  return c.json(resSuccess(agents));
}

export async function handleGetAgent(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const agent = await department.getAgentAsync(params.agentId);
  if (!agent || agent.workstation_id !== params.workstationId) return c.json(resError('Agent not found'), 404);
  return c.json(resSuccess(agent));
}

export async function handleHookTicket(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = HookTicketBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${AGENT_LOG} handleHookTicket: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${AGENT_LOG} handleHookTicket: workstationId=${params.workstationId} agentId=${params.agentId} ticketId=${parsed.data.ticket_id}`
  );
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.hookTicket(params.agentId, parsed.data.ticket_id);
  console.log(`${AGENT_LOG} handleHookTicket: hooked successfully`);
  return c.json(resSuccess({ hooked: true }));
}

export async function handleUnhookTicket(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.unhookTicket(params.agentId);
  return c.json(resSuccess({ unhooked: true }));
}

export async function handlePrime(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const context = await department.prime(params.agentId);
  return c.json(resSuccess(context));
}

export async function handleAgentDone(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = AgentDoneBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.agentDone(params.agentId, parsed.data);
  return c.json(resSuccess({ done: true }));
}

/**
 * Called by the container when an agent session completes or fails.
 * Transitions the hooked ticket to closed/failed and unhooks the agent.
 */
export async function handleAgentCompleted(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = AgentCompletedBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.agentCompleted(params.agentId, parsed.data);
  return c.json(resSuccess({ completed: true }));
}

/**
 * Called by the container when the frontDesk's session goes idle (turn done,
 * waiting for user input). Transitions the frontDesk from "working" to
 * "waiting" so the alarm drops to the idle cadence and health-check
 * pings stop resetting the container's sleepAfter timer.
 */
export async function handleAgentWaiting(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const body = (await parseJsonBody(c)) as Record<string, unknown>;
  const firedAt = typeof body?.firedAt === 'number' ? body.firedAt : undefined;
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.frontDeskWaiting(params.agentId, firedAt);
  return c.json(resSuccess({ acknowledged: true }));
}

export async function handleWriteCheckpoint(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = WriteCheckpointBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.writeCheckpoint(params.agentId, parsed.data.data);
  return c.json(resSuccess({ written: true }));
}

const EvictionContextBody = z.object({
  branch: z.string(),
  agent_name: z.string(),
  saved_at: z.string(),
});

export async function handleWriteEvictionContext(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = EvictionContextBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.writeTicketEvictionContext(params.agentId, parsed.data);
  return c.json(resSuccess({ written: true }));
}

export async function handleCheckMemo(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const messages = await department.checkMemo(params.agentId);
  return c.json(resSuccess(messages));
}

const HeartbeatWatermark = z
  .object({
    lastEventType: z.string().nullable().optional(),
    lastEventAt: z.string().nullable().optional(),
    activeTools: z.array(z.string()).optional(),
    containerInstanceId: z.string().optional(),
  })
  .passthrough();

/**
 * Heartbeat endpoint called by the container's heartbeat reporter.
 * Updates the agent's last_activity_at timestamp and SDK activity
 * watermark in the Department DO's agent_metadata.
 */
export async function handleHeartbeat(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);

  // Parse watermark from body (best-effort — old containers send no body)
  let watermark: z.infer<typeof HeartbeatWatermark> | undefined;
  try {
    const body: unknown = await c.req.json();
    const parsed = HeartbeatWatermark.safeParse(body);
    if (parsed.success) {
      watermark = parsed.data;
    }
  } catch {
    // No body or invalid JSON — old container format, just touch
  }

  // touchAgentHeartbeat returns the drain nonce atomically — no
  // second RPC needed, which prevents a TOCTOU race where an
  // in-flight heartbeat from the old container could observe a nonce
  // generated between two separate DO calls.
  const { drainNonce } = await department.touchAgentHeartbeat(
    params.agentId,
    watermark
      ? {
          lastEventType: watermark.lastEventType ?? null,
          lastEventAt: watermark.lastEventAt ?? null,
          activeTools: watermark.activeTools,
          containerInstanceId: watermark.containerInstanceId,
        }
      : undefined
  );

  return c.json(resSuccess({ heartbeat: true, ...(drainNonce ? { drainNonce } : {}) }));
}

const GetOrCreateAgentBody = z.object({
  role: AgentRole,
});

/**
 * Atomically get an existing agent of the given role (idle preferred) or create one.
 * Prevents duplicate agent creation from concurrent calls.
 */
export async function handleGetOrCreateAgent(c: Context<HelldeskEnv>, params: { workstationId: string }) {
  const parsed = GetOrCreateAgentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${AGENT_LOG} handleGetOrCreateAgent: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${AGENT_LOG} handleGetOrCreateAgent: workstationId=${params.workstationId} role=${parsed.data.role}`
  );
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const agent = await department.getOrCreateAgent(parsed.data.role, params.workstationId);
  console.log(`${AGENT_LOG} handleGetOrCreateAgent: result=${JSON.stringify(agent).slice(0, 200)}`);
  return c.json(resSuccess(agent));
}

export async function handleUpdateAgentStatusMessage(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = UpdateAgentStatusMessageBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.updateAgentStatusMessage(params.agentId, parsed.data.message);
  return c.json(resSuccess({ ok: true }));
}

export async function handleDeleteAgent(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const agent = await department.getAgentAsync(params.agentId);
  if (!agent || agent.workstation_id !== params.workstationId) return c.json(resError('Agent not found'), 404);
  await department.deleteAgent(params.agentId);
  return c.json(resSuccess({ deleted: true }));
}

/**
 * Returns undelivered, non-expired nudges for the agent.
 * Called by the container's process-manager when the agent goes idle.
 */
export async function handleGetPendingNudges(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const nudges = await department.getPendingNudges(params.agentId);
  return c.json(resSuccess(nudges));
}

const QueueNudgeBody = z.object({
  target_agent_id: z.string().min(1),
  message: z.string().min(1),
  mode: z.enum(['wait-idle', 'immediate', 'queue']).optional(),
});

const NudgeDeliveredBody = z.object({
  nudge_id: z.string().min(1),
});

/**
 * Agent-facing endpoint: queues a nudge from one agent to another.
 * The requesting agent's identity is taken from the auth token.
 */
export async function handleNudge(c: Context<HelldeskEnv>, params: { workstationId: string }) {
  const parsed = QueueNudgeBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const sourceAgentId = getEnforcedAgentId(c) ?? 'unknown';
  console.log(
    `${AGENT_LOG} handleNudge: workstationId=${params.workstationId} from=${sourceAgentId} target=${parsed.data.target_agent_id}`
  );
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const nudgeId = await department.queueNudge(parsed.data.target_agent_id, parsed.data.message, {
    mode: parsed.data.mode,
    source: 'agent',
  });
  return c.json(resSuccess({ nudge_id: nudgeId }));
}

/**
 * Marks a nudge as delivered after the container has injected it into the agent.
 */
export async function handleNudgeDelivered(
  c: Context<HelldeskEnv>,
  _params: { workstationId: string; agentId: string }
) {
  const parsed = NudgeDeliveredBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.markNudgeDelivered(parsed.data.nudge_id);
  return c.json(resSuccess({ marked: true }));
}

const RequestChangesBody = z.object({
  feedback: z.string().min(1, 'Feedback is required'),
  files: z.array(z.string()).optional(),
});

/**
 * QualityAssurance requests changes on an in-progress MR. Creates a rework ticket
 * that blocks the MR ticket. The reconciler assigns a soul to the rework
 * ticket; when it closes, the MR unblocks for re-review.
 */
export async function handleRequestChanges(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const parsed = RequestChangesBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const result = await department.requestChanges(params.agentId, parsed.data);
  return c.json(resSuccess(result), 201);
}
