import { describe, expect, it } from 'bun:test';
import {
  KILO_INFERENCE_MAX_ATTEMPTS,
  KILO_RETRY_MAX_MS,
  isTransientKiloError,
  kiloRetryDelayMs,
} from '../../src/kilo-headless';

describe('isTransientKiloError', () => {
  it('retries the exact observed socket close (network busy)', () => {
    expect(
      isTransientKiloError(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
    ).toBe(true);
  });

  it('retries common transport failures', () => {
    for (const error of [
      'fetch failed',
      'read ECONNRESET',
      'connect ECONNREFUSED 127.0.0.1:4000',
      'ETIMEDOUT',
      'socket hang up',
      '503 Service Unavailable',
      '429 Too Many Requests',
      'network error',
      'Unexpected server error. Check server logs for details. (ref err_c83d230f)',
    ]) {
      expect(isTransientKiloError(error)).toBe(true);
    }
  });

  it('does not retry configuration/contract failures', () => {
    for (const error of [
      'structured output unavailable',
      '401 Unauthorized',
      'invalid model id',
      'kilo inference bound exceeded (20 min)',
      '',
      undefined,
    ]) {
      expect(isTransientKiloError(error as string | undefined)).toBe(false);
    }
  });
});

describe('kiloRetryDelayMs', () => {
  it('backs off exponentially and caps (2s / 6s / 18s / 30s)', () => {
    expect(kiloRetryDelayMs(1)).toBe(2_000);
    expect(kiloRetryDelayMs(2)).toBe(6_000);
    expect(kiloRetryDelayMs(3)).toBe(18_000);
    expect(kiloRetryDelayMs(4)).toBe(KILO_RETRY_MAX_MS);
    expect(kiloRetryDelayMs(99)).toBe(KILO_RETRY_MAX_MS);
  });

  it('has a bounded total attempt budget', () => {
    expect(KILO_INFERENCE_MAX_ATTEMPTS).toBe(4);
  });
});
