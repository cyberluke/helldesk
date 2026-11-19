import type { Context } from 'hono';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

export async function handleListEscalations(c: Context<HelldeskAppEnv>, params: { departmentId: string }) {
  const acknowledged = c.req.query('acknowledged');
  const filter = acknowledged !== undefined ? { acknowledged: acknowledged === 'true' } : undefined;

  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const escalations = await departmentDO.listEscalations(filter);
  return c.json(resSuccess(escalations));
}

export async function handleAcknowledgeEscalation(
  c: Context<HelldeskAppEnv>,
  params: { departmentId: string; escalationId: string }
) {
  const departmentDO = getDepartmentDOStub(c.env, params.departmentId);
  const escalation = await departmentDO.acknowledgeEscalation(params.escalationId);
  if (!escalation) return c.json(resError('Escalation not found'), 404);
  return c.json(resSuccess(escalation));
}
