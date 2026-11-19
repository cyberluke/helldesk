import type { Context } from 'hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';
import { getDepartmentDOStub } from '../dos/Department.do';
import { verifyContainerJWT } from '../util/jwt.util';
import { resolveSecret } from '../util/secret.util';
import { resSuccess, resError } from '../util/res.util';
import { resolveGitHubToken } from '../dos/department/department-scm';

/**
 * POST /api/departments/:departmentId/workstations/:workstationId/refresh-git-token
 *
 * Called by the container when a git operation fails with 401/403 —
 * i.e. the GitHub App installation token embedded in GIT_TOKEN has
 * expired (1h TTL). Resolves a fresh token via the standard chain
 * (department config → platform integration) and returns it to the caller.
 *
 * Authenticated with the container-scoped JWT (same token used for
 * all other container→worker calls).
 */
export async function handleRefreshGitToken(
  c: Context<HelldeskAppEnv>,
  params: { departmentId: string; workstationId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.HELLDESK_JWT_SECRET);
  if (!secret) {
    console.error('[refresh-git-token] failed to resolve HELLDESK_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const verified = verifyContainerJWT(token, secret);
  if (!verified.success) {
    return c.json(resError(verified.error), 401);
  }

  if (verified.payload.departmentId !== params.departmentId) {
    return c.json(resError('Cross-department access denied'), 403);
  }

  const department = getDepartmentDOStub(c.env, params.departmentId);
  const workstationConfig = await department.getWorkstationConfig(params.workstationId);

  const freshToken = await resolveGitHubToken({
    env: c.env,
    departmentId: params.departmentId,
    getDepartmentConfig: () => department.getDepartmentConfig(),
    platformIntegrationId: workstationConfig?.platformIntegrationId,
  });

  if (!freshToken.ok) {
    console.warn(
      `[refresh-git-token] no token available for department=${params.departmentId} workstation=${params.workstationId}`
    );
    return c.json(resError('No git token available for this workstation'), 404);
  }

  console.log(
    `[refresh-git-token] refreshed git token for department=${params.departmentId} workstation=${params.workstationId}`
  );
  return c.json(resSuccess({ token: freshToken.token }), 200);
}
