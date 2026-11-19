import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getEnforcedAgentId } from '../middleware/auth.middleware';
import type { HelldeskEnv } from '../helldesk.worker';

const SendMemoBody = z.object({
  from_agent_id: z.string().min(1),
  to_agent_id: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export async function handleSendMemo(c: Context<HelldeskEnv>, _params: { workstationId: string }) {
  const parsed = SendMemoBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const enforced = getEnforcedAgentId(c);
  if (enforced && enforced !== parsed.data.from_agent_id) {
    return c.json(resError('from_agent_id does not match authenticated agent'), 403);
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  await department.sendMemo(parsed.data);
  return c.json(resSuccess({ sent: true }), 201);
}
