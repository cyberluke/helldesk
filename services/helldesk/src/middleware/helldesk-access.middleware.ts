import { createMiddleware } from 'hono/factory';
import type { HelldeskEnv } from '../helldesk.worker';
import { resError } from '../util/res.util';

/**
 * Requires the `helldeskAccess` claim minted after the `helldesk-access`
 * PostHog flag check. Admins do not bypass this check.
 *
 * Must run after `kiloAuthMiddleware`, which sets `kiloHelldeskAccess`.
 */
export const helldeskAccessMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  if (!c.get('kiloHelldeskAccess')) {
    return c.json(resError('HELLDESK access required'), 403);
  }
  return next();
});

/**
 * Requires the `helldeskAccess` claim or an admin token, like
 * `helldeskProcedure` does for tRPC. User routes also accept plain Kilo API
 * keys, which never carry the claim, so this keeps those keys out once the
 * flag is off.
 *
 * Must run after `kiloAuthMiddleware`, which sets `kiloHelldeskAccess`.
 */
export const helldeskRouteAccessMiddleware = createMiddleware<HelldeskEnv>(async (c, next) => {
  if (!c.get('kiloHelldeskAccess') && !c.get('kiloIsAdmin')) {
    return c.json(resError('HELLDESK access required'), 403);
  }
  return next();
});
