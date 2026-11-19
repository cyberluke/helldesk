import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

const VALID_TRIAGE_ACTIONS = [
  'RESTART',
  'RESTART_WITH_BACKOFF',
  'CLOSE_TICKET',
  'ESCALATE',
  'ESCALATE_TO_FRONT_DESK',
  'NUDGE',
  'REASSIGN_TICKET',
  'DISCARD',
  'PROVIDE_GUIDANCE',
] as const;

const ResolveTriageBody = z.object({
  triage_request_ticket_id: z.string().min(1),
  action: z
    .string()
    .min(1)
    .transform(v => v.toUpperCase())
    .pipe(z.enum(VALID_TRIAGE_ACTIONS)),
  resolution_notes: z.string(),
});

export async function handleResolveTriage(c: Context<HelldeskAppEnv>, _params: { workstationId: string }) {
  // In production, agentId comes from the verified JWT. In development
  // (where authMiddleware is skipped), fall back to the identity header
  // the container client sends with every request. The fallback is gated
  // on ENVIRONMENT to prevent header spoofing in production.
  const agentId =
    getEnforcedAgentId(c) ||
    (c.env.ENVIRONMENT === 'development' ? c.req.header('X-helldesk-Agent-Id') : null);
  if (!agentId) {
    return c.json(resError('Agent authentication required'), 401);
  }

  const parsed = ResolveTriageBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);

  // Verify this agent is actually working on a triage batch. Without this
  // check, any workstation agent (soul, qualityAssurance) could call the endpoint and
  // trigger restart/close/escalate side effects on other agents.
  const hookedTicket = await department.getHookedTicket(agentId);
  if (
    !hookedTicket ||
    !hookedTicket.labels.includes('gt:triage') ||
    hookedTicket.created_by !== 'attendance'
  ) {
    return c.json(resError('Only triage agents can resolve triage requests'), 403);
  }

  const ticket = await department.resolveTriage({
    agent_id: agentId,
    ...parsed.data,
  });
  return c.json(resSuccess(ticket), 200);
}
