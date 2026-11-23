import { connect } from 'node:net';

export interface ProviderProbeResult {
  readonly ok: boolean;
  readonly error?: string;
}

interface CachedProbe {
  readonly at: number;
  readonly result: ProviderProbeResult;
}

const cache = new Map<string, CachedProbe>();
const OK_TTL_MS = 30_000;
const FAIL_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 1_500;

/**
 * Fast provider-endpoint preflight.
 *
 * The mission loop used to learn that a gateway was dead only by spawning a
 * worker per revision: 177 `ECONNREFUSED`s on `litellm-edge` looked like 177
 * model turns. A TCP reachability probe (any connect = reachable; auth is not
 * this layer's job) turns that into one explicit `provider_unreachable` result
 * per attempt, which the review backoff then spaces out.
 *
 * Results are cached briefly: a busy/unreachable provider should not be probed
 * by every worker, but recovery must be picked up within seconds.
 */
export async function probeProvider(
  baseURL: string,
  options: { timeoutMs?: number } = {},
): Promise<ProviderProbeResult> {
  if (!baseURL) return { ok: true };
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return { ok: true };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: true };
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const key = `${host}:${port}`;
  const cached = cache.get(key);
  const ttl = cached?.result.ok ? OK_TTL_MS : FAIL_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.result;

  const result = await new Promise<ProviderProbeResult>((resolvePromise) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (value: ProviderProbeResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      cache.set(key, { at: Date.now(), result: value });
      resolvePromise(value);
    };
    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: `provider ${host}:${port} timed out` }));
    socket.once('error', (error: Error) =>
      finish({ ok: false, error: `provider_unreachable: ${host}:${port} — ${error.message}` }),
    );
  });
  return result;
}

/** Test hook / operator reset for the short-lived reachability cache. */
export function clearProviderProbeCache(): void {
  cache.clear();
}
