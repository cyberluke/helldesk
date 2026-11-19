import { createMiddleware } from 'hono/factory';
import { verifyAgentJWT, verifyContainerJWT } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { HelldeskEnv } from '../helldesk.worker';
import { extractBearerToken } from '@kilocode/worker-utils';
import { resolveSecret } from '../util/secret.util';

/**
 * Auth middleware for frontDesk tool routes. Accepts either:
 * 1. A container secret (HMAC-based, no expiry) — preferred
 * 2. A legacy agent JWT (HS256, 8h expiry) — backwards compatibility
 *
 * Validates the token's `departmentId` matches the `:departmentId` route param.
 * Unlike the workstation-scoped `authMiddleware`, this does NOT check `workstationId`
 * because the frontDesk operates cross-workstation.
 *
 * Sets `agentJWT` on the Hono context.
 */
export const frontDeskAuthMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    console.error('[front-desk-auth] failed to resolve HELLDESK_JWT_SECRET from Secrets Store');
    return c.json(resError('Internal server error'), 500);
  }

  // Try container-scoped JWT first (scope: 'container', carries departmentId + userId)
  const containerResult = verifyContainerJWT(token, secret);
  if (containerResult.success) {
    const departmentId = c.req.param('departmentId');
    if (departmentId && containerResult.payload.departmentId !== departmentId) {
      return c.json(resError('Token departmentId does not match route'), 403);
    }
    c.set('agentJWT', {
      agentId: '',
      workstationId: '',
      departmentId: containerResult.payload.departmentId,
      userId: containerResult.payload.userId,
    });
    return next();
  }

  // Fall back to legacy JWT verification
  const result = verifyAgentJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  // Verify the departmentId in the JWT matches the route param
  const departmentId = c.req.param('departmentId');
  if (departmentId && result.payload.departmentId !== departmentId) {
    return c.json(resError('Token departmentId does not match route'), 403);
  }

  c.set('agentJWT', result.payload);
  return next();
});
