import type { Context } from 'hono';
import { z } from 'zod';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { HelldeskEnv } from '../helldesk.worker';

export async function handleGetTicketCaseCurrentStep(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const step = await department.getTicketCaseCurrentStep(params.agentId);
  if (!step) return c.json(resError('No active TicketCase for this agent'), 404);
  return c.json(resSuccess(step));
}

const AdvanceTicketCaseBody = z.object({
  summary: z.string().min(1).max(5000),
});

export async function handleAdvanceTicketCaseStep(
  c: Context<HelldeskEnv>,
  params: { workstationId: string; agentId: string }
) {
  const body = await parseJsonBody(c);
  const parsed = AdvanceTicketCaseBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const result = await department.advanceTicketCaseStep(params.agentId, parsed.data.summary);
  return c.json(resSuccess(result));
}

const CreateTicketCaseBody = z.object({
  ticket_id: z.string().min(1),
  formula: z.object({
    steps: z
      .array(
        z.object({
          title: z.string().min(1),
          instructions: z.string().min(1),
        })
      )
      .min(1),
  }),
});

export async function handleCreateTicketCase(c: Context<HelldeskEnv>, _params: { workstationId: string }) {
  const body = await parseJsonBody(c);
  const parsed = CreateTicketCaseBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
  const mol = await department.createTicketCase(parsed.data.ticket_id, parsed.data.formula);
  return c.json(resSuccess(mol), 201);
}
