import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('HELLDESK billing feature flags', () => {
  it('reports neither metering nor enforcement without the meter binding', async () => {
    const departmentId = `billing-disabled-${crypto.randomUUID()}`;
    const department = env.department.get(env.department.idFromName(departmentId));
    await department.setDepartmentId(departmentId);

    await expect(department.getBillingStatus()).resolves.toEqual({
      enabled: false,
      enforcing: false,
      state: 'idle',
      runPolicy: 'automatic',
    });
    await expect(department.getAlarmStatus()).resolves.toMatchObject({
      billing: { enabled: false, enforcing: false, state: 'idle', runPolicy: 'automatic' },
    });
  });

  it('persists a user-controlled automatic-start pause', async () => {
    const departmentId = `billing-pause-${crypto.randomUUID()}`;
    const department = env.department.get(env.department.idFromName(departmentId));
    await department.setDepartmentId(departmentId);

    await expect(department.setContainerRunPolicy('paused_by_user')).resolves.toMatchObject({
      runPolicy: 'paused_by_user',
    });
    await expect(department.getBillingStatus()).resolves.toMatchObject({
      runPolicy: 'paused_by_user',
    });
    await expect(department.setContainerRunPolicy('automatic')).resolves.toMatchObject({
      runPolicy: 'automatic',
    });
  });
});
