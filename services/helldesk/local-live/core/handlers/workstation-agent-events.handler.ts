import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

const AppendEventBody = z.object({
  agent_id: z.string().min(1),
  event_type: z.string().min(1),
  data: z.unknown().default({}),
});

const GetEventsQuery = z.object({
  after_id: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

/**
 * Append an event to the agent's persistent event log.
 * Called by the container (via completion-reporter or a streaming relay)
 * to persist events so late-joining dashboard clients can catch up.
 */
export async function handleAppendAgentEvent(c: Context<HelldeskAppEnv>, _params: { workstationId: string }) {
  const parsed = AppendEventBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(resError('Invalid request body'), 400);
  }

  // Verify the caller's agent identity matches the agent_id in the body
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.agent_id) {
    return c.json(resError('agent_id does not match authenticated agent'), 403);
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.appendAgentEvent(parsed.data.agent_id, parsed.data.event_type, parsed.data.data);
  return c.json(resSuccess({ appended: true }), 201);
}

/**
 * Get agent events from the persistent log, optionally after a given event id.
 * Used by the frontend to catch up on events that happened before the
 * WebSocket connection was established.
 */
export async function handleGetAgentEvents(
  c: Context<HelldeskAppEnv>,
  params: { workstationId: string; agentId: string }
) {
  const queryParsed = GetEventsQuery.safeParse({
    after_id: c.req.query('after_id'),
    limit: c.req.query('limit'),
  });
  if (!queryParsed.success) {
    return c.json(resError('Invalid query parameters'), 400);
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
  const events = await department.getAgentEvents(
    params.agentId,
    queryParsed.data.after_id,
    queryParsed.data.limit
  );

  return c.json(resSuccess(events));
}
