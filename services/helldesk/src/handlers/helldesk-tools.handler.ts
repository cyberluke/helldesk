import type { Context } from 'hono';
import { z } from 'zod';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import { getDepartmentDOStub } from '../dos/Department.do';
import type { HelldeskEnv } from '../helldesk.worker';
import { pickWorkstationIdForHelldeskTicket } from './helldesk-ticket.helpers';
import type { HelldeskConnectionRecord } from '../dos/department/helldesk';

const HANDLER_LOG = '[helldesk-tools.handler]';

const HelldeskClaimBody = z.object({
  item_id: z.string().min(1),
});

const HelldeskPostBody = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
});

const HelldeskDoneBody = z.object({
  item_id: z.string().min(1),
  // Evidence MUST be a single URL (PR / commit / artifact). The helldesk
  // review UI renders this as a clickable link, so passing a sentence with
  // a URL embedded in it (e.g. "PR submitted: https://…") breaks the link
  // affordance for admins. Mirrors the strict `z.string().url()` validation
  // on the tRPC `markWantedItemDone` procedure used by the web UI; the
  // frontDesk path was previously the only entry that allowed free-form text.
  evidence: z.string().url(),
});

const HelldeskWantedStatus = z.enum([
  'open',
  'claimed',
  'in_review',
  'completed',
  'validated',
  'withdrawn',
]);

/** Resolve the userId of the caller from the frontDesk auth middleware. */
function resolveUserId(c: Context<HelldeskEnv>): string | null {
  const agentJWT = c.get('agentJWT');
  return agentJWT?.userId ?? null;
}

/**
 * Resolve the helldesk ID for this department. Returns null if the department is
 * not connected to any helldesk.
 */
async function resolveHelldeskId(c: Context<HelldeskEnv>, departmentId: string): Promise<string | null> {
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const connection = await department.getHelldeskConnection();
  return connection?.helldesk_id ?? null;
}

/**
 * Resolve the full helldesk connection for this department. Returns null when
 * the department is not connected. Used by code paths that need both the
 * `helldesk_id` and the upstream `workstation_handle` (e.g. to attach a ticket to a
 * matching local workstation).
 */
async function resolveHelldeskConnection(
  c: Context<HelldeskEnv>,
  departmentId: string
): Promise<HelldeskConnectionRecord | null> {
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  return department.getHelldeskConnection();
}

/** Map a helldesk RPC failure into a Hono response. */
function helldeskFailureToResponse(
  c: Context<HelldeskEnv>,
  failure: { code: string; message: string }
) {
  const status =
    failure.code === 'PRECONDITION_FAILED' ? 412 : failure.code === 'NOT_FOUND' ? 404 : 502;
  return c.json(resError(failure.message), status as 400);
}

/**
 * GET /api/frontDesk/:departmentId/tools/helldesk/browse
 * Browse the wanted board. Supports optional `status` and `limit` query params.
 */
export async function handleHelldeskBrowse(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const helldeskId = await resolveHelldeskId(c, params.departmentId);
  if (!helldeskId) {
    return c.json(resError('This department is not connected to any helldesk'), 404);
  }

  const statusRaw = c.req.query('status');
  const limitRaw = c.req.query('limit');
  let status: z.infer<typeof HelldeskWantedStatus> | undefined;

  if (statusRaw) {
    const parsed = HelldeskWantedStatus.safeParse(statusRaw);
    if (!parsed.success) {
      return c.json(
        resError(
          `Invalid status filter. Must be one of: ${HelldeskWantedStatus.options.join(', ')}`
        ),
        400
      );
    }
    status = parsed.data;
  }

  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return c.json(resError('limit must be an integer between 1 and 100'), 400);
  }

  console.log(
    `${HANDLER_LOG} handleHelldeskBrowse: departmentId=${params.departmentId} helldeskId=${helldeskId} status=${statusRaw ?? 'all'} limit=${limitRaw ?? 'default'}`
  );

  const result = await c.env.HELLDESK_SERVICE.browseWantedBoard({
    helldeskId,
    userId,
    status,
    limit,
    includeForkBranches: true,
  });

  if (!result.success) {
    return helldeskFailureToResponse(c, result);
  }

  return c.json(resSuccess(result.data));
}

/**
 * POST /api/frontDesk/:departmentId/tools/helldesk/claim
 *
 * Claims the upstream wanted item and returns a rich planning context to
 * the frontDesk: the item title/body/priority/type, the upstream PR URL (if
 * any), a suggested local `workstation_id`, and the canonical `helldesk` origin
 * tag the frontDesk MUST attach to whatever tickets it creates next (single
 * ticket via gt_sling, or shift via gt_sling_batch). The frontDesk decides the
 * shape of the work; helldesk does NOT create any tickets here.
 */
export async function handleHelldeskClaim(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const connection = await resolveHelldeskConnection(c, params.departmentId);
  if (!connection) {
    return c.json(resError('This department is not connected to any helldesk'), 404);
  }

  const parsed = HelldeskClaimBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleHelldeskClaim: departmentId=${params.departmentId} helldeskId=${connection.helldesk_id} itemId=${parsed.data.item_id}`
  );

  const result = await c.env.HELLDESK_SERVICE.claimWantedItem({
    helldeskId: connection.helldesk_id,
    userId,
    itemId: parsed.data.item_id,
  });

  if (!result.success) {
    return helldeskFailureToResponse(c, result);
  }

  const item = await fetchClaimedItem(c, connection.helldesk_id, userId, parsed.data.item_id);
  const suggestedWorkstationId = await suggestLocalWorkstationId(c, params.departmentId, connection.workstation_handle);

  return c.json(
    resSuccess({
      claim: result.data,
      item,
      planning: {
        helldesk_origin: {
          kind: 'wanted-item-claim',
          helldesk_id: connection.helldesk_id,
          item_id: parsed.data.item_id,
          pull_id: null,
          source_url: result.data.pr_url,
        },
        suggested_workstation_id: suggestedWorkstationId,
      },
    })
  );
}

/**
 * Look up the just-claimed item on the wanted board so we can return its
 * title, description, priority, and type to the frontDesk for planning. Best
 * effort: returns null if the item can't be found.
 */
async function fetchClaimedItem(
  c: Context<HelldeskEnv>,
  helldeskId: string,
  userId: string,
  itemId: string
): Promise<Record<string, unknown> | null> {
  try {
    const browse = await c.env.HELLDESK_SERVICE.browseWantedBoard({
      helldeskId,
      userId,
    });
    if (!browse.success) return null;
    return browse.data.find(it => it.id === itemId) ?? null;
  } catch (err) {
    console.warn(
      `${HANDLER_LOG} fetchClaimedItem: browse failed for helldeskId=${helldeskId} itemId=${itemId}:`,
      err
    );
    return null;
  }
}

/**
 * Suggest a local workstation id for the frontDesk to scope helldesk-originated work to.
 * Uses the same rule the helldesk-ticket helpers use: match by `workstation_handle`,
 * else pick the only workstation if exactly one exists, else null.
 */
async function suggestLocalWorkstationId(
  c: Context<HelldeskEnv>,
  departmentId: string,
  workstationHandle: string
): Promise<string | null> {
  try {
    const department = getDepartmentDOStub(c.env, departmentId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
    const workstationList = await department.listWorkstations();
    return pickWorkstationIdForHelldeskTicket(
      workstationList.map(r => ({ id: r.id, name: r.name })),
      workstationHandle
    );
  } catch (err) {
    console.warn(`${HANDLER_LOG} suggestLocalWorkstationId: listWorkstations failed for departmentId=${departmentId}:`, err);
    return null;
  }
}

/**
 * POST /api/frontDesk/:departmentId/tools/helldesk/post
 */
export async function handleHelldeskPost(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const helldeskId = await resolveHelldeskId(c, params.departmentId);
  if (!helldeskId) {
    return c.json(resError('This department is not connected to any helldesk'), 404);
  }

  const parsed = HelldeskPostBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleHelldeskPost: departmentId=${params.departmentId} helldeskId=${helldeskId} title="${parsed.data.title.slice(0, 80)}"`
  );

  const result = await c.env.HELLDESK_SERVICE.postWantedItem({
    helldeskId,
    userId,
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    type: parsed.data.type,
    publish: true,
  });

  if (!result.success) {
    return helldeskFailureToResponse(c, result);
  }

  return c.json(resSuccess(result.data), 201);
}

/**
 * POST /api/frontDesk/:departmentId/tools/helldesk/done
 */
export async function handleHelldeskDone(c: Context<HelldeskEnv>, params: { departmentId: string }) {
  const userId = resolveUserId(c);
  if (!userId) return c.json(resError('Authentication required'), 401);

  const helldeskId = await resolveHelldeskId(c, params.departmentId);
  if (!helldeskId) {
    return c.json(resError('This department is not connected to any helldesk'), 404);
  }

  const parsed = HelldeskDoneBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  console.log(
    `${HANDLER_LOG} handleHelldeskDone: departmentId=${params.departmentId} helldeskId=${helldeskId} itemId=${parsed.data.item_id}`
  );

  const result = await c.env.HELLDESK_SERVICE.markWantedItemDone({
    helldeskId,
    userId,
    itemId: parsed.data.item_id,
    evidence: parsed.data.evidence,
  });

  if (!result.success) {
    return helldeskFailureToResponse(c, result);
  }

  // Stamp the canonical ticket so the auto-done reconciler doesn't re-fire
  // for an item the frontDesk already reported manually. Best-effort: a stamp
  // failure is logged but does NOT fail the response — the upstream call
  // already succeeded.
  try {
    const department = getDepartmentDOStub(c.env, params.departmentId);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
    await department.stampHelldeskReported({
      helldeskId,
      itemId: parsed.data.item_id,
      evidence: parsed.data.evidence,
    });
  } catch (err) {
    console.warn(
      `${HANDLER_LOG} handleHelldeskDone: stampHelldeskReported failed for item=${parsed.data.item_id}:`,
      err
    );
  }

  return c.json(resSuccess(result.data));
}
