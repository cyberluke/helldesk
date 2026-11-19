/**
 * Local HELLDESK — JWT util shim (dev).
 * Locally a container token is just a signed JSON we can verify without a real
 * gateway secret. Sign/verify with a fixed local secret; never used externally.
 */
import { jwtVerify, SignJWT } from 'jose';

const LOCAL_SECRET = new TextEncoder().encode('local-container-dev');

/** Sign a container/helldesk JWT. Accepts (payload) or (secret, payload) or (payload, opts) — local dev ignores external secrets. */
export function signContainerJWT(
  payload: Record<string, unknown>,
  ...rest: unknown[]
): Promise<string> {
  const second = rest[0] as Record<string, unknown> | undefined;
  const actualPayload = (seg => seg)(payload);
  return signing(actualPayload, second);
}

export function signAgentJWT(
  _secret: string | Uint8Array | Record<string, unknown>,
  payload?: Record<string, unknown>,
  _opts?: unknown,
): Promise<string> {
  // signature: (payload) or (secret, payload) or (secret, payload, opts)
  const p = payload ?? (_secret as Record<string, unknown>);
  return signing(p, undefined);
}

async function signing(payload: Record<string, unknown>, _opts?: Record<string, unknown>): Promise<string> {
  const jwt = new SignJWT(payload as never)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('local-helldesk')
    .setExpirationTime('1h');
  return jwt.sign(LOCAL_SECRET);
}

export async function verifyContainerJWT(token: string): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(new TextEncoder().encode(token), LOCAL_SECRET);
  return payload as Record<string, unknown>;
}

export async function verifyContainerJWTAllowExpired(token: string): Promise<Record<string, unknown>> {
  try { return await verifyContainerJWT(token); } catch { return {}; }
}