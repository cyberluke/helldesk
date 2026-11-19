import { Hono } from 'hono';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { helldeskAccessMiddleware } from '../middleware/helldesk-access.middleware';
import { handleCreateDepartment } from './departments.handler';
import { handleCreateOrgDepartment } from './org-departments.handler';
import { helldeskRouter } from '../trpc/router';
import type { HelldeskEnv } from '../helldesk.worker';
import type { TRPCContext } from '../trpc/init';

const storage = vi.hoisted(() => {
  const departments: Record<string, string>[] = [];
  return {
    departments,
    createDepartment: async (input: Record<string, string>) => {
      const department = {
        ...input,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      departments.push(department);
      return department;
    },
  };
});

vi.mock('../dos/HelldeskUser.do', () => ({
  getHelldeskUserStub: () => ({ createDepartment: storage.createDepartment }),
}));
vi.mock('../dos/HelldeskOrg.do', () => ({
  getHelldeskOrgStub: () => ({ createDepartment: storage.createDepartment }),
}));
vi.mock('../dos/Department.do', () => ({
  getDepartmentDOStub: () => ({
    async setDepartmentId() {},
    async updateDepartmentConfig() {},
  }),
}));
vi.mock('../dos/DepartmentContainer.do', () => ({ getDepartmentContainerStub: vi.fn() }));

const userId = 'oauth/department-creator';
const orgId = '11111111-2222-4333-8444-555555555555';
const testEnv = {
  NEXTAUTH_SECRET: 'local-test-nextauth-secret-at-least-32-characters',
} as unknown as Env;

type Claims = {
  helldeskAccess: boolean;
  isAdmin?: boolean;
};

function restApp(claims: Claims) {
  const app = new Hono<HelldeskEnv>();
  app.use('*', async (c, next) => {
    c.set('kiloUserId', userId);
    c.set('kiloIsAdmin', claims.isAdmin ?? false);
    c.set('kiloHelldeskAccess', claims.helldeskAccess);
    c.set('kiloOrgMemberships', [{ orgId, role: 'owner' }]);
    return next();
  });
  app.post('/personal', helldeskAccessMiddleware, c => handleCreateDepartment(c, { userId }));
  app.post('/organization', helldeskAccessMiddleware, c => handleCreateOrgDepartment(c, { orgId }));
  return app;
}

function trpcContext(claims: Claims): TRPCContext {
  return {
    env: testEnv,
    executionCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    userId,
    workerAdmin: {
      legacyClaim: claims.isAdmin ?? false,
      decide: async () => ({
        allowed: false,
        source: 'none',
        status: 403,
        reason: 'legacy_claim_rejected',
      }),
    } as never,
    procedurePath: '',
    apiTokenPepper: null,
    helldeskAccess: claims.helldeskAccess,
    orgMemberships: [{ orgId, role: 'owner' }],
  };
}

async function createDepartment(
  entryPoint: 'personal REST' | 'organization REST' | 'personal tRPC' | 'organization tRPC',
  claims: Claims
): Promise<number> {
  if (entryPoint.endsWith('REST')) {
    const app = restApp(claims);
    const path = entryPoint.startsWith('personal') ? '/personal' : '/organization';
    const response = await app.request(
      `http://localhost${path}`,
      { method: 'POST', body: JSON.stringify({ name: 'New department' }) },
      testEnv
    );
    return response.status;
  }

  const caller = helldeskRouter.createCaller(trpcContext(claims));
  try {
    if (entryPoint.startsWith('personal')) {
      await caller.createDepartment({ name: 'New department' });
    } else {
      await caller.createOrgDepartment({ organizationId: orgId, name: 'New department' });
    }
    return 201;
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
    return getHTTPStatusCodeFromError(error);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.departments.length = 0;
});

describe.each([
  'personal REST',
  'organization REST',
  'personal tRPC',
  'organization tRPC',
] as const)('%s department creation', entryPoint => {
  it('rejects creation without HELLDESK access', async () => {
    expect(await createDepartment(entryPoint, { helldeskAccess: false })).toBe(403);
    expect(storage.departments).toEqual([]);
  });

  it('does not exempt admins without HELLDESK access', async () => {
    expect(await createDepartment(entryPoint, { helldeskAccess: false, isAdmin: true })).toBe(403);
    expect(storage.departments).toEqual([]);
  });

  it('allows creation with HELLDESK access', async () => {
    expect(await createDepartment(entryPoint, { helldeskAccess: true })).toBe(201);
    expect(storage.departments).toEqual([expect.objectContaining({ name: 'New department' })]);
  });
});
