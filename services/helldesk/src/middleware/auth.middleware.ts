import type { KiloAuthVariables } from '@kilocode/worker-utils/kilo-auth-middleware';
import type { WorkerAdminAuthority } from '@kilocode/worker-utils/worker-admin-capability';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { KiloTokenPayload } from '@kilocode/worker-utils/kilo-token';
import { verifyAgentJWT, verifyContainerJWT, type AgentJWTPayload } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { HelldeskEnv } from '../helldesk.worker';

export type JwtOrgMembership = NonNullable<KiloTokenPayload['orgMemberships']>[number];

export type AuthVariables = KiloAuthVariables & {
  agentJWT: AgentJWTPayload;
  departmentId: string;
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloHelldeskAccess: boolean;
  kiloOrgMemberships: JwtOrgMembership[];
  kiloControlToken: string;
  kiloUsesModernToken: boolean;
  workerAdmin: WorkerAdminAuthority;
  requestStartTime: number;
  orgId?: string;
  orgRole?: string;
};

import { resolveSecret } from '../util/secret.util';

/**
 * Extracts `departmentId` from the route param `:departmentId` and sets it on the Hono
 * context. Returns 400 if the param is missing.
 *
 * Must run unconditionally (even in dev) so handlers can always call
 * `c.get('departmentId')`. Does NOT check JWT — cross-department validation is handled
 * by `authMiddleware` which runs after this in production.
 */
export const departmentIdMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  const departmentId = c.req.param('departmentId');
  if (!departmentId) {
    return c.json(resError('Missing departmentId'), 400);
  }
  c.set('departmentId', departmentId);
  return next();
});

/**
 * Try to authenticate with a container-scoped JWT (scope: 'container').
 * Returns an AgentJWTPayload-shaped object if successful, null otherwise.
 * Container JWTs carry { departmentId, userId } but not agentId/workstationId — those
 * come from the route params and are trusted because the JWT proves the
 * request came from the right department's container.
 */
function tryContainerJWTAuth(
  c: Context<HelldeskEnv>,
  token: string,
  jwtSecret: string
): AgentJWTPayload | null {
  const result = verifyContainerJWT(token, jwtSecret);
  if (!result.success) return null;

  // Populate agentId/workstationId from route params, falling back to headers
  // for routes that don't have :agentId/:workstationId params (e.g. /triage/resolve,
  // /memo). The container JWT proves the request came from this department's
  // container, so we trust both the URL and the identity headers.
  return {
    agentId: c.req.param('agentId') ?? c.req.header('X-helldesk-Agent-Id') ?? '',
    workstationId: c.req.param('workstationId') ?? c.req.header('X-helldesk-workstation-Id') ?? '',
    departmentId: result.payload.departmentId,
    userId: result.payload.userId,
  };
}

/**
 * Auth middleware that accepts either:
 * 1. A container-scoped JWT (scope: 'container') — preferred for container→worker calls
 * 2. A legacy per-agent JWT (HS256, 8h expiry) — retained for backwards compatibility
 *
 * Sets `agentJWT` on the Hono context. Validates:
 * - departmentId always (cross-department guard)
 * - workstationId only for legacy agent JWTs (container JWTs are department-scoped;
 *   the container is trusted to call correct workstation endpoints)
 */
export const authMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    console.error('[auth] failed to resolve HELLDESK_JWT_SECRET from Secrets Store');
    return c.json(resError('Internal server error'), 500);
  }

  // Try container-scoped JWT first (scope: 'container', 8h expiry + alarm refresh)
  let payload = tryContainerJWTAuth(c, token, secret);

  // Fall back to legacy JWT verification
  if (!payload) {
    const result = verifyAgentJWT(token, secret);
    if (!result.success) {
      return c.json(resError(result.error), 401);
    }
    payload = result.payload;
  }

  // Cross-workstation guard: only enforced for legacy agent JWTs where the workstationId
  // is cryptographically bound to the token. Container JWTs are department-scoped
  // and don't carry a workstationId — the container is trusted within its department.
  const workstationId = c.req.param('workstationId');
  if (workstationId && payload.workstationId && payload.workstationId !== workstationId) {
    return c.json(resError('Token workstationId does not match route'), 403);
  }

  // Verify the departmentId matches the route param (cross-department guard)
  const departmentId = c.req.param('departmentId');
  if (departmentId && departmentId !== payload.departmentId) {
    return c.json(resError('Cross-department access denied'), 403);
  }

  c.set('agentJWT', payload);
  return next();
});

/**
 * Restricts a route to the specific agent identified by the auth token.
 * Validates the agentId route param matches the token's agentId.
 * Must be applied after `authMiddleware`.
 *
 * For container JWTs: agentId is populated from the route param by
 * tryContainerJWTAuth, so this check is a no-op (route param == route
 * param). This is intentional — the container JWT is department-scoped, and
 * the container is trusted to call the correct agent endpoints.
 * Cross-agent attacks require compromising the container itself, which
 * is the same trust boundary the container already has (it runs all
 * agents in the department).
 */
export const agentOnlyMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  const jwt = c.get('agentJWT');
  if (!jwt) {
    return c.json(resError('Authentication required'), 401);
  }

  const agentId = c.req.param('agentId');
  if (agentId && jwt.agentId && jwt.agentId !== agentId) {
    return c.json(resError('Token agentId does not match route'), 403);
  }

  return next();
});

/**
 * When the request is agent-authenticated, returns the JWT's agentId.
 */
export function getEnforcedAgentId(c: Context<HelldeskEnv>): string | null {
  const jwt = c.get('agentJWT');
  if (!jwt) return null;
  return jwt.agentId;
}
