/**
 * Local `@kilocode/worker-utils` — LOCAL STACK ONLY, NO CLOUD AUTHORITY.
 *
 * Federates just the symbols the federated HELLDESK domain actually imports.
 * On localhost there is no real Kilo Gateway to mint/verify JWTs, so this is a
 * dev-auth, non-cryptographic surrogate with the same shape:
 *  - who is "the user" is inferred from a fixed dev token (NAI ExcellenceGovernor token
 *    prefilled by default), never trusted for anything external.
 *
 * Anything security-critical MUST NOT rely on these types locally; they exist
 * purely so the (auth-free) local HELLDESK control plane mounts verbatim.
 */
import type { Context, MiddlewareHandler } from 'hono';

export interface RepoCoordinates {
  owner: string;
  repo: string;
  /** Platform name expected by some SCM call sites (github/gitlab/bitbucket). */
  platform?: string;
}

/** Not used by federated core; present for the worker shell if mounted. */
export type KiloAuthVariables = Record<string, unknown>;
export type KiloTokenPayload = Record<string, unknown>;
export type WorkerAdminAuthority = { can: (action: string) => boolean };
export type WorkerAdminDecision = { allow: boolean; reason?: string };

/** Deterministic owner/repo from a git URL. */
export function parseGitUrl(raw: string): RepoCoordinates {
  const s = raw.trim().replace(/\.git$/, '');
  const m = s.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/#?]+)/);
  if (m) return { owner: m[1]!, repo: m[2]! };
  const alt = s.split('/').filter(Boolean);
  if (alt.length >= 2) return { owner: alt[alt.length - 2]!, repo: alt[alt.length - 1]! };
  return { owner: 'unknown', repo: s };
}

/** Local passthrough: BYOK is treated as "not direct BYOK" unless disabled. */
export function isDirectByokModelId(_id: string | null | undefined): boolean {
  return false;
}

/**
 * Retry async work with exponential backoff, matching the Cloudflare
 * `withDORetry(factory, then?, opts?)` signature used across the domain.
 */
export async function withDORetry<T>(
  factory: () => T | Promise<T>,
  then?: (value: Awaited<T>) => unknown,
  _opts?: { maxRetries?: number; retryMs?: number }
): Promise<T> {
  const maxRetries = _opts?.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const value = await factory();
      if (then) { await then(value); }
      return value;
    } catch (e) {
      lastErr = e;
      const delay = (_opts?.retryMs ?? 50) * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Extract bearer token from an Authorization header (or null). */
export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

export const HELLDESK_AUDIENCE = 'helldesk-local';

/** Local auth middleware: accepts any bearer token (dev). */
export function createKiloAuthMiddleware(_opts?: unknown): MiddlewareHandler<Record<string, unknown>, string, { in: { [k: string]: unknown }; out: { [k: string]: unknown } }> {
  return async (c: Context<Record<string, unknown>, string>, next: () => Promise<void>) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('kiloUser', { id: 'local-dev' });
    await next();
  };
}

/** CF Access validation — locally always allowed (no CF in front). */
export async function validateCfAccessRequest(): Promise<boolean> {
  return true;
}

import { SignJWT, jwtVerify } from 'jose';

export function signKiloToken(_payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(_payload as never)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('local-helldesk')
    .sign(new TextEncoder().encode('local-dev-secret'));
}
export function kiloTokenPayload(_token: string): Promise<KiloTokenPayload> {
  return jwtVerify(_token, new TextEncoder().encode('local-dev-secret')).then((r) =>
    (r.payload as unknown) as KiloTokenPayload,
  );
}

/** Response envelope helpers (same shape as the Kilo worker-utils res util). */
export interface SuccessResponse<T = unknown> { success: true; data: T }
export interface ErrorResponse { success: false; error: string; issues?: unknown[] }
export function resSuccess<T = unknown>(data: T): SuccessResponse<T> { return { success: true, data }; }
export function resError(message: string, issues?: unknown[]): ErrorResponse { return { success: false, error: message, issues }; }