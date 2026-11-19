import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateHelldeskAccessFlag,
  HELLDESK_ACCESS_FLAG,
  parseHelldeskAccessVerdict,
} from './helldesk-access-flag.util';

const productionEnv = {
  ENVIRONMENT: 'production',
  NEXT_PUBLIC_POSTHOG_KEY: 'phc_test',
} as unknown as Env;

function flagsBody(enabled: boolean) {
  return { flags: { [HELLDESK_ACCESS_FLAG]: { key: HELLDESK_ACCESS_FLAG, enabled } } };
}

describe('parseHelldeskAccessVerdict', () => {
  it.each([
    ['enabled flag', flagsBody(true), 'allowed'],
    ['disabled flag', flagsBody(false), 'denied'],
    ['flag missing from a complete response', { flags: {} }, 'denied'],
    ['partial evaluation', { ...flagsBody(false), errorsWhileComputingFlags: true }, 'unknown'],
    ['quota limit', { flags: {}, quotaLimited: ['feature_flags'] }, 'unknown'],
    ['unexpected body', 'not json', 'unknown'],
  ] as const)('maps %s', (_name, body, verdict) => {
    expect(parseHelldeskAccessVerdict(body)).toBe(verdict);
  });
});

describe('evaluateHelldeskAccessFlag', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows every user outside production without calling PostHog', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const env = { ENVIRONMENT: 'development' } as unknown as Env;
    await expect(evaluateHelldeskAccessFlag(env, 'user-1')).resolves.toBe('allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('evaluates the flag for the user in production', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(flagsBody(false)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(evaluateHelldeskAccessFlag(productionEnv, 'user-1')).resolves.toBe('denied');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://us.i.posthog.com/flags/?v=2');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'phc_test',
      distinct_id: 'user-1',
      groups: {},
      person_properties: {},
      group_properties: {},
      geoip_disable: true,
      flag_keys_to_evaluate: [HELLDESK_ACCESS_FLAG],
    });
  });

  it('returns unknown when PostHog responds with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('down', { status: 503 })));

    await expect(evaluateHelldeskAccessFlag(productionEnv, 'user-1')).resolves.toBe('unknown');
  });

  it('returns unknown when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(evaluateHelldeskAccessFlag(productionEnv, 'user-1')).resolves.toBe('unknown');
  });
});
