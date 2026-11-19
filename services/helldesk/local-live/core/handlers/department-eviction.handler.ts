import type { Context } from 'hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';
import { getDepartmentDOStub } from '../dos/Department.do';
import { verifyContainerJWT } from '../util/jwt.util';
import { resolveSecret } from '../util/secret.util';
import { resSuccess, resError } from '../util/res.util';

/**
 * POST /api/departments/:departmentId/container-eviction
 *
 * Called by the container's process-manager when the container receives
 * SIGTERM. Inserts a `container_eviction` event and sets the draining
 * flag so the reconciler stops dispatching new work.
 *
 * Returns a `drainNonce` that must be presented via `/container-ready`
 * to clear the drain flag. This prevents stale heartbeats from the
 * dying container from prematurely re-enabling dispatch.
 *
 * Authenticated with the container-scoped JWT (same token used for all
 * container→worker calls).
 */
export async function handleContainerEviction(
  c: Context<HelldeskAppEnv>,
  params: { departmentId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    console.error('[department-eviction] failed to resolve HELLDESK_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.departmentId !== params.departmentId) {
    return c.json(resError('Cross-department access denied'), 403);
  }

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const drainNonce = await department.recordContainerEviction();

  console.log(`[department-eviction] container eviction recorded for department=${params.departmentId}`);
  return c.json(resSuccess({ acknowledged: true, drainNonce }), 200);
}

/**
 * GET /api/departments/:departmentId/drain-status
 *
 * Lightweight endpoint for the container to poll drain state. Used by
 * the heartbeat module when no agents are running — the per-agent
 * heartbeat loop has nothing to iterate, so a separate check is needed
 * to discover the drain nonce and call /container-ready.
 *
 * Authenticated with the container-scoped JWT.
 */
export async function handleDrainStatus(
  c: Context<HelldeskAppEnv>,
  params: { departmentId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.departmentId !== params.departmentId) {
    return c.json(resError('Cross-department access denied'), 403);
  }

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const [draining, drainNonce] = await Promise.all([department.isDraining(), department.getDrainNonce()]);

  return c.json(resSuccess({ draining, drainNonce }), 200);
}

/**
 * POST /api/departments/:departmentId/container-ready
 *
 * Called by the replacement container on startup to signal readiness.
 * Clears the draining flag only if the provided `drainNonce` matches
 * the nonce generated during the eviction that triggered the drain.
 *
 * Authenticated with the container-scoped JWT.
 */
export async function handleContainerReady(
  c: Context<HelldeskAppEnv>,
  params: { departmentId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    console.error('[container-ready] failed to resolve HELLDESK_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.departmentId !== params.departmentId) {
    return c.json(resError('Cross-department access denied'), 403);
  }

  let nonce: string | undefined;
  try {
    const body: unknown = await c.req.json();
    if (
      body &&
      typeof body === 'object' &&
      'nonce' in body &&
      typeof (body as { nonce: unknown }).nonce === 'string'
    ) {
      nonce = (body as { nonce: string }).nonce;
    }
  } catch {
    // No body or invalid JSON
  }

  if (!nonce) {
    return c.json(resError('Missing required field: nonce'), 400);
  }

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const cleared = await department.acknowledgeContainerReady(nonce);

  console.log(`[container-ready] department=${params.departmentId} nonce=${nonce} cleared=${cleared}`);
  return c.json(resSuccess({ cleared }), 200);
}
