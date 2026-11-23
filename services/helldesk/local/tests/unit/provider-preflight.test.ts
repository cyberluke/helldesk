import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { clearProviderProbeCache, probeProvider } from '../../src/provider-preflight';

const servers: Server[] = [];

afterEach(async () => {
  clearProviderProbeCache();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('probeProvider', () => {
  it('accepts a reachable HTTP endpoint regardless of auth status', async () => {
    const port = await listen();
    expect(await probeProvider(`http://127.0.0.1:${port}/v1`)).toEqual({ ok: true });
  });

  it('rejects a closed port with an explicit provider_unreachable error', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    clearProviderProbeCache();
    const result = await probeProvider(`http://127.0.0.1:${port}/v1`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('provider_unreachable');
  });

  it('skips non-HTTP / empty base URLs (no false provider failure)', async () => {
    expect(await probeProvider('')).toEqual({ ok: true });
    expect(await probeProvider('file:///tmp/snapshot')).toEqual({ ok: true });
  });
});
