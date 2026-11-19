import type { ContainerUsageRpcMethods, RecordStartInput } from '@kilocode/container-usage';
import { describe, expect, it, vi } from 'vitest';
import {
  HELLDESK_CONTAINER_SKU,
  getContainerUsageClient,
  isContainerUsageMeteringEnabled,
  isHelldeskBillingEnforced,
  isUsageIntervalNotFoundError,
} from './container-usage.billing';

const usageBinding = {
  recordStart: vi.fn(),
  recordHeartbeat: vi.fn(),
  recordStop: vi.fn(),
} satisfies ContainerUsageRpcMethods;

function envFixture(overrides: Partial<Env>): Env {
  return overrides as Env;
}

describe('HELLDESK billing configuration', () => {
  it('enforces billing only for the exact true value', () => {
    expect(isHelldeskBillingEnforced(envFixture({ HELLDESK_BILLING_ENABLED: 'true' }))).toBe(true);
    expect(isHelldeskBillingEnforced(envFixture({ HELLDESK_BILLING_ENABLED: 'false' }))).toBe(false);
    expect(isHelldeskBillingEnforced(envFixture({}))).toBe(false);
  });

  it('meters usage whenever the binding exists, regardless of the enforcement flag', () => {
    // Reporting must run even with enforcement off so we can monitor real usage
    // before turning enforcement on.
    expect(
      isContainerUsageMeteringEnabled(
        envFixture({ CONTAINER_USAGE: usageBinding, HELLDESK_BILLING_ENABLED: 'false' })
      )
    ).toBe(true);
    expect(
      isContainerUsageMeteringEnabled(
        envFixture({ CONTAINER_USAGE: usageBinding, HELLDESK_BILLING_ENABLED: 'true' })
      )
    ).toBe(true);
    expect(isContainerUsageMeteringEnabled(envFixture({}))).toBe(false);
  });

  it('uses the production HELLDESK SKU', () => {
    expect(HELLDESK_CONTAINER_SKU).toBe('helldesk-standard-2026-07');
  });

  it('creates a client backed by the WorkerEntrypoint binding', async () => {
    const recordStart = vi.fn(async (_input: RecordStartInput) => ({
      success: true as const,
      ack: { intervalId: 'test', durable: 'pg' as const, dedup: false },
    }));
    const binding = {
      recordStart,
      recordHeartbeat: vi.fn(),
      recordStop: vi.fn(),
    } satisfies ContainerUsageRpcMethods;

    await getContainerUsageClient(envFixture({ CONTAINER_USAGE: binding })).recordStart({
      instanceId: 'container-1',
      sku: HELLDESK_CONTAINER_SKU,
      subject: { type: 'user', id: 'user-1' },
      actor: { type: 'user', id: 'user-1' },
      sessionId: 'department-1',
      metadata: { departmentId: 'department-1' },
      startEpochMs: 1_000,
    });

    expect(recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'helldesk',
        sku: 'helldesk-standard-2026-07',
        idempotencyKey: 'v1:helldesk:container-1:1000:start',
      })
    );
  });

  it('fails closed when the binding is absent', () => {
    expect(() => getContainerUsageClient(envFixture({ ENVIRONMENT: 'development' }))).toThrow(
      'CONTAINER_USAGE binding is required'
    );
  });

  it('recognizes a missing remote interval across the RPC error boundary', () => {
    const namedError = new Error('missing');
    namedError.name = 'UsageIntervalNotFoundError';
    expect(isUsageIntervalNotFoundError(namedError)).toBe(true);
    expect(
      isUsageIntervalNotFoundError(
        new Error('Container usage interval not found: helldesk:instance:start')
      )
    ).toBe(true);
    expect(isUsageIntervalNotFoundError(new Error('Postgres unavailable'))).toBe(false);
  });
});
