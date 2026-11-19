/**
 * Local HELLDESK — auth middleware shim.
 *
 * Local single-user experience: no Cloudflare auth. `getEnforcedAgentId`
 * resolves the acting agent id from request context (header `x-agent-id`),
 * never from a trusted JWT.
 */
import type { Context } from 'hono';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

export interface AuthVariables {
  userId?: string;
  agentId?: string;
  departmentId?: string;
  workstationId?: string;
}

export type KiloAuthVariables = AuthVariables;

/** Dev-auth: the acting agent is the `x-agent-id` header when present. */
export function getEnforcedAgentId(c: Context<HelldeskAppEnv>): string | null {
  const h = c.req.header('x-agent-id');
  if (h && h.trim()) return h.trim();
  const stored = (c.get as (k: string) => unknown)('agentId');
  return typeof stored === 'string' && stored ? stored : null;
}

export function getEnforcedUserId(_c: Context<HelldeskAppEnv>): string | null {
  return 'local-dev';
}

export function requireBearerToken(_c: Context<HelldeskAppEnv>): boolean {
  return true;
}