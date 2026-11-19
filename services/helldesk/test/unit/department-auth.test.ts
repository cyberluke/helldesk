import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelldeskEnv } from '../../src/helldesk.worker';

const getDepartmentConfig = vi.fn();
vi.mock('../../src/dos/Department.do', () => ({
  getDepartmentDOStub: () => ({ getDepartmentConfig }),
}));
vi.mock('../../src/middleware/worker-admin.middleware', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/middleware/worker-admin.middleware')>();
  return { ...actual, emitWorkerAdminDecision: vi.fn() };
});

import { emitWorkerAdminDecision } from '../../src/middleware/worker-admin.middleware';
import { departmentAuthMiddleware } from '../../src/middleware/department-auth.middleware';

type Decision = { allowed: boolean; status?: number; reason?: string };

function app(params: {
  userId: string;
  memberships?: Array<{ orgId: string; role: string }>;
  decision: Decision;
  hasCapability?: boolean;
  legacyClaim?: boolean;
}) {
  const decide = vi.fn(async () => ({
    allowed: params.decision.allowed,
    source: 'legacy',
    wouldDeny: false,
    jti: null,
    reason: params.decision.allowed ? 'honored' : 'legacy_claim_rejected',
    status: params.decision.status,
  }));
  const app = new Hono<HelldeskEnv>();
  app.use('*', async (c, next) => {
    c.set('kiloUserId', params.userId);
    c.set('kiloTokenClaims', { isAdmin: true, iat: 1, exp: 3601 });
    c.set('kiloOrgMemberships', params.memberships ?? []);
    c.set('workerAdmin', {
      decide,
      hasCapability: params.hasCapability ?? true,
      legacyClaim: params.legacyClaim ?? false,
    } as never);
    return next();
  });
  app.use('/api/departments/:departmentId/*', departmentAuthMiddleware);
  app.use('/api/users/:userId/departments/:departmentId/*', departmentAuthMiddleware);
  app.get('/api/departments/:departmentId/config', c => c.json({ ok: true }));
  app.get('/api/users/:userId/departments/:departmentId/events', c => c.json({ ok: true }));
  return { app, decide };
}

function config(owner: Record<string, unknown>) {
  getDepartmentConfig.mockResolvedValue(owner);
}

const department = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  getDepartmentConfig.mockReset();
  vi.mocked(emitWorkerAdminDecision).mockClear();
});

describe('departmentAuthMiddleware', () => {
  it('checks ownership before consulting the admin authority', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-1' });
    const { app: a, decide } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(decide).not.toHaveBeenCalled();
    expect(emitWorkerAdminDecision).not.toHaveBeenCalled();
  });

  it('lets an org member through without an admin decision', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({
      userId: 'user-1',
      memberships: [{ orgId: 'org-1', role: 'member' }],
      decision: { allowed: false },
    });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(decide).not.toHaveBeenCalled();
  });

  it('allows a foreign department through a granted bypass and audits it', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: true }),
      expect.objectContaining({ departmentId: department })
    );
  });

  it('denies a foreign department and audits the denial', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 403 },
    });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(403);
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: false }),
      expect.objectContaining({ departmentId: department })
    );
  });

  it('derives a user target for user-scoped events routes', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-target' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/departments/${department}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledWith('rest:GET /api/users/:userId/departments/:departmentId/events', {
      kind: 'user',
      id: 'user-target',
    });
  });

  it('lets an org member read an org department through the user route', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({
      userId: 'member-1',
      memberships: [{ orgId: 'org-1', role: 'member' }],
      decision: { allowed: false },
    });
    const response = await a.request(
      `http://localhost/api/users/member-1/departments/${department}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(200);
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects a user-target capability for another user's department", async () => {
    config({ owner_type: 'user', owner_user_id: 'owner-2' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/departments/${department}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: false, reason: 'target_mismatch' }),
      expect.objectContaining({ departmentId: department })
    );
  });

  it('rejects a user-target capability for an org-owned department', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/departments/${department}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });

  it('restores admin bypass for a department with no owner id', async () => {
    config({ owner_type: 'user', owner_user_id: null });
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(200);
  });

  it('keeps 404 for a department with no owner when no bypass applies', async () => {
    config({ owner_type: 'user', owner_user_id: null });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 403 },
    });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(404);
  });

  it('returns 503 when capability validation is unavailable', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 503 },
    });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(503);
  });

  it('restores admin bypass when department config cannot be loaded', async () => {
    getDepartmentConfig.mockRejectedValue(new Error('missing'));
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/departments/${department}/config`, {}, {} as never)).status
    ).toBe(200);
  });
});
