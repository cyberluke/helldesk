import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdateDepartmentConfig } from './department-config.handler';
import type { HelldeskEnv } from '../helldesk.worker';

const department = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../dos/Department.do', async () => {
  const { DepartmentConfigSchema: Schema } = await import('../types');
  return {
    getDepartmentDOStub: () => ({
      async getDepartmentConfig() {
        return Schema.parse({ owner_user_id: 'user-owner' });
      },
      async updateDepartmentConfig(update: Record<string, unknown>) {
        department.updates.push(update);
        return Schema.parse({ owner_user_id: 'user-owner' });
      },
      async updateFrontDeskSystemPrompt() {},
    }),
  };
});

function restApp() {
  const app = new Hono<HelldeskEnv>();
  app.patch('/api/departments/:departmentId/config', c => handleUpdateDepartmentConfig(c, c.req.param()));
  return app;
}

describe('handleUpdateDepartmentConfig', () => {
  beforeEach(() => {
    department.updates.length = 0;
  });

  it('does not let a config update change department ownership', async () => {
    const response = await restApp().request(
      '/api/departments/11111111-2222-4333-8444-555555555555/config',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_type: 'org',
          owner_id: 'org-other',
          owner_user_id: 'user-other',
          organization_id: 'org-other',
          created_by_user_id: 'user-other',
          default_model: 'kilo/test-model',
        }),
      },
      {} as Env
    );

    expect(response.status).toBe(200);
    expect(department.updates).toHaveLength(1);
    const update = department.updates[0];
    for (const field of [
      'owner_type',
      'owner_id',
      'owner_user_id',
      'organization_id',
      'created_by_user_id',
    ]) {
      expect(update).not.toHaveProperty(field);
    }
    expect(update).toMatchObject({ default_model: 'kilo/test-model' });
  });
});
