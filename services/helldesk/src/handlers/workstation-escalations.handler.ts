import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { TicketPriority } from '../types';
import type { HelldeskEnv } from '../helldesk.worker';

const CreateEscalationBody = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  priority: TicketPriority.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function handleCreateEscalation(c: Context<HelldeskEnv>, params: { workstationId: string }) {
  const parsed = CreateEscalationBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const escalation = await department.routeEscalation({
    departmentId,
    source_workstation_id: params.workstationId,
    severity: parsed.data.priority ?? 'medium',
    message: parsed.data.title,
    category: undefined,
    source_agent_id: undefined,
  });
  return c.json(resSuccess(escalation), 201);
}
