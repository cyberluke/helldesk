import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkerAdminAuthority,
  workerAdminBindingDigest,
  type WorkerAdminTarget,
} from '@kilocode/worker-utils/worker-admin-capability';

const getDepartmentConfig = vi.fn();
const getDepartmentAsync = vi.fn();
const getPersonalWorkstation = vi.fn();
const getOrgWorkstation = vi.fn();

vi.mock('../../src/dos/Department.do', () => ({
  getDepartmentDOStub: () => ({
    getDepartmentConfig,
    listAgents: async () => [],
    listTickets: async () => [],
    getWorkstationAsync: async () => null,
  }),
}));
vi.mock('../../src/dos/DepartmentContainer.do', () => ({
  getDepartmentContainerStub: () => ({ fetch: vi.fn() }),
}));
vi.mock('../../src/dos/HelldeskUser.do', () => ({
  getHelldeskUserStub: () => ({ getDepartmentAsync, getWorkstationAsync: getPersonalWorkstation }),
}));
vi.mock('../../src/dos/HelldeskOrg.do', () => ({
  getHelldeskOrgStub: () => ({ getWorkstationAsync: getOrgWorkstation }),
}));
vi.mock('../../src/middleware/worker-admin.middleware', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/middleware/worker-admin.middleware')>();
  return { ...actual, emitWorkerAdminDecision: vi.fn() };
});

import { helldeskRouter } from '../../src/trpc/router';
import { router, type TRPCContext } from '../../src/trpc/init';

const wrapped = router({ helldesk: helldeskRouter });

const NOW = Math.floor(Date.now() / 1000);
const CALLER = 'caller-1';
const department = '00000000-0000-4000-8000-000000000001';

async function authorityFor(
  actions: string[],
  target: WorkerAdminTarget = { kind: 'department', id: department }
) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'kid-1', alg: 'ES256', use: 'sig' };
  const token = await new SignJWT({
    iss: 'kilo-web',
    sub: CALLER,
    aud: 'helldesk-admin',
    env: 'test',
    iat: NOW,
    nbf: NOW,
    exp: NOW + 300,
    jti: `jti-${actions.join('-')}`,
    cap: { v: 1, actions, targets: [target] },
    bnd: {
      pep: await workerAdminBindingDigest('pepper-1'),
      wsp: await workerAdminBindingDigest(''),
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'kilo-worker-cap+jwt', kid: 'kid-1' })
    .sign(privateKey);

  return createWorkerAdminAuthority({
    mode: 'reject',
    audience: 'helldesk-admin',
    identity: { kiloUserId: CALLER, apiTokenPepper: 'pepper-1', env: 'test' },
    legacyClaim: false,
    capabilityToken: token,
    jwks: { keys: [publicJwk] },
    introspect: async () => ({ active: true }),
    now: () => NOW * 1000,
  });
}

async function noCapabilityAuthority() {
  return createWorkerAdminAuthority({
    mode: 'reject',
    audience: 'helldesk-admin',
    identity: { kiloUserId: CALLER, apiTokenPepper: 'pepper-1', env: 'test' },
    legacyClaim: false,
    capabilityToken: null,
    jwks: null,
    introspect: async () => ({ active: true }),
    now: () => NOW * 1000,
  });
}

function caller(
  workerAdmin: Awaited<ReturnType<typeof authorityFor>>,
  overrides: Partial<TRPCContext> = {}
) {
  return wrapped.createCaller({
    env: {} as never,
    executionCtx: {} as never,
    userId: CALLER,
    workerAdmin,
    procedurePath: '',
    apiTokenPepper: 'pepper-1',
    helldeskAccess: true,
    orgMemberships: [],
    ...overrides,
  } as TRPCContext);
}

beforeEach(() => {
  getDepartmentConfig.mockReset();
  getDepartmentAsync.mockReset();
  getPersonalWorkstation.mockReset();
  getOrgWorkstation.mockReset();
  getDepartmentAsync.mockResolvedValue(null);
  getPersonalWorkstation.mockResolvedValue(null);
  getOrgWorkstation.mockResolvedValue(null);
  getDepartmentConfig.mockResolvedValue({
    owner_type: 'org',
    organization_id: 'org-2',
    owner_user_id: null,
    name: 'Foreign department',
  });
});

describe('real helldesk procedures respect the capability action allowlist', () => {
  it.each([
    [
      'sendMessage',
      (c: ReturnType<typeof caller>) => c.helldesk.sendMessage({ departmentId: department, message: 'hi' }),
    ],
    [
      'createPtySession',
      (c: ReturnType<typeof caller>) => c.helldesk.createPtySession({ departmentId: department, agentId: department }),
    ],
  ])('%s is refused even when the capability names it', async (_name, invoke) => {
    const authority = await authorityFor([`trpc:helldesk.${_name}`]);
    await expect(invoke(caller(authority))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a workstation from another department of a user-owned foreign department', async () => {
    const workstationId = '00000000-0000-4000-8000-000000000010';
    getDepartmentConfig.mockResolvedValue({
      owner_type: 'user',
      owner_user_id: 'owner-2',
      organization_id: null,
      name: 'Foreign department',
    });
    getPersonalWorkstation
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: workstationId, department_id: '00000000-0000-4000-8000-000000000011' });
    const authority = await authorityFor(['trpc:helldesk.getWorkstation'], {
      kind: 'department',
      id: department,
    });
    await expect(caller(authority).helldesk.getWorkstation({ workstationId, departmentId: department })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a workstation from another department of an org-owned foreign department', async () => {
    const workstationId = '00000000-0000-4000-8000-000000000012';
    getOrgWorkstation.mockResolvedValue({
      id: workstationId,
      department_id: '00000000-0000-4000-8000-000000000013',
    });
    const authority = await authorityFor(['trpc:helldesk.getWorkstation'], {
      kind: 'department',
      id: department,
    });
    await expect(caller(authority).helldesk.getWorkstation({ workstationId, departmentId: department })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('positive control: an allowlisted workstation in the named department is returned', async () => {
    const workstationId = '00000000-0000-4000-8000-000000000014';
    getDepartmentConfig.mockResolvedValue({
      owner_type: 'org',
      organization_id: 'org-2',
      owner_user_id: null,
      name: 'Foreign department',
    });
    getOrgWorkstation.mockResolvedValue({
      id: workstationId,
      department_id: department,
      name: 'workstation',
      git_url: 'https://example.test/r.git',
      default_branch: 'main',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const authority = await authorityFor(['trpc:helldesk.getWorkstation']);
    await expect(caller(authority).helldesk.getWorkstation({ workstationId, departmentId: department })).resolves.toMatchObject({
      id: workstationId,
      department_id: department,
    });
  });

  it('keeps an owner working in reject mode without a capability', async () => {
    getDepartmentAsync.mockResolvedValue({
      id: department,
      name: 'Own department',
      owner_user_id: CALLER,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      caller(await noCapabilityAuthority()).helldesk.checkAdminAccess({ departmentId: department })
    ).resolves.toEqual({ isAdminViewing: false, ownerUserId: null, ownerOrgId: null });
  });

  it('keeps an org member working in reject mode without a capability', async () => {
    await expect(
      caller(await noCapabilityAuthority(), {
        orgMemberships: [{ orgId: 'org-2', role: 'member', name: 'org' }],
      }).helldesk.checkAdminAccess({ departmentId: department })
    ).resolves.toEqual({ isAdminViewing: false, ownerUserId: null, ownerOrgId: null });
  });

  it('positive control: an allowlisted read succeeds for the same foreign department', async () => {
    const authority = await authorityFor(['trpc:helldesk.checkAdminAccess']);
    await expect(caller(authority).helldesk.checkAdminAccess({ departmentId: department })).resolves.toEqual({
      isAdminViewing: true,
      ownerUserId: null,
      ownerOrgId: 'org-2',
    });
  });
});
