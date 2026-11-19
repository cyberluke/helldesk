/**
 * engine-client.ts — reusable NAI-Lattice engine client (loopback JSON-RPC +
 * raw token-gated endpoints). Single source for the control token + engine
 * host/port, so every caller uses the same framed, token-injected wire.
 *
 * Loopback-only; never logs the token.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

export const ENGINE_HOST = process.env.NAI_LATTICE_HOST ?? '127.0.0.1';
export const ENGINE_PORT = Number(process.env.NAI_LATTICE_PORT ?? 8787);
export const ENGINE_URL = `http://${ENGINE_HOST}:${ENGINE_PORT}/project`;
const TOKEN_PATH = () => join(process.env.LOCALAPPDATA ?? '', 'NAI', 'HELLDESK', 'control.token');

/** The loopback control token (never logged/returned to the browser). */
export function assetToken(): string {
  try {
    return readFileSync(TOKEN_PATH(), 'utf-8').trim();
  } catch {
    return '';
  }
}

/** JSON-RPC dispatch to the engine `/project` dispatcher (gt.* / helldesk.*). */
export async function engineJsonRpc(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = assetToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(ENGINE_URL, { method: 'POST', headers, body: JSON.stringify({ method, args }) });
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, status: res.status, error: `non-JSON engine response ${res.status}` };
  }
}

/** Raw token-gated fetch to an engine HTTP endpoint (e.g. /excellenceGovernor). */
export async function engineRaw(path: string, opts: { method?: string; token: string }): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}${path}`, { method: opts.method ?? 'GET', headers });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return { raw: txt, status: res.status }; }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}