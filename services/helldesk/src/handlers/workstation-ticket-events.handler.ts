import type { Context } from 'hono';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess } from '../util/res.util';
import type { HelldeskEnv } from '../helldesk.worker';

export async function handleListTicketEvents(c: Context<HelldeskEnv>, _params: { workstationId: string }) {
  const since = c.req.query('since') ?? undefined;
  const ticketId = c.req.query('ticket_id') ?? undefined;
  const limitStr = c.req.query('limit');
  const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;
  const limit =
    parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
      ? parsedLimit
      : undefined;

  const departmentId = c.get('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
  const events = await department.listTicketEvents({ ticketId, since, limit });
  return c.json(resSuccess(events));
}
