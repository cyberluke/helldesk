import type { Context } from 'hono';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess } from '../util/res.util';
import type { HelldeskEnv } from '../helldesk.worker';

/**
 * List ticket events for a department. Since all data lives in the Department DO now,
 * this is a single call rather than a fan-out across Workstation DOs.
 * GET /api/users/:userId/departments/:departmentId/events?since=<iso>&limit=<n>
 */
export async function handleListDepartmentEvents(
  c: Context<HelldeskEnv>,
  params: { userId: string; departmentId: string }
) {
  const since = c.req.query('since') ?? undefined;
  const limitStr = c.req.query('limit');
  const parsedLimit = limitStr !== undefined ? Number(limitStr) : undefined;
  const limit =
    parsedLimit !== undefined && Number.isInteger(parsedLimit) && parsedLimit >= 0
      ? parsedLimit
      : 100;

  const department = getDepartmentDOStub(c.env, params.departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
  const events = await department.listTicketEvents({ since, limit });

  return c.json(resSuccess(events));
}
