import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { signKiloToken, type SignKiloTokenExtra } from '@kilocode/worker-utils/kilo-token';
import { HELLDESK_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { getHelldeskUserStub } from '../../src/dos/HelldeskUser.do';
import { getDepartmentDOStub } from '../../src/dos/Department.do';
import { getDepartmentContainerStub } from '../../src/dos/DepartmentContainer.do';
import type { UserDepartmentRecord } from '../../src/db/tables/user-departments.table';
import type { UserWorkstationRecord } from '../../src/db/tables/user-workstations.table';

const JWT_SECRET = 'test-nextauth-secret-must-be-at-least-32-chars-long';
const ACCESS = { helldeskAccess: true } as const;
const routes = [
  ['POST', 'departments', 201],
  ['GET', 'departments', 200],
  ['GET', 'departments/:departmentId', 200],
  ['POST', 'workstations', 201],
  ['GET', 'workstations/:workstationId', 200],
  ['GET', 'departments/:departmentId/workstations', 200],
  ['DELETE', 'departments/:departmentId', 200],
  ['DELETE', 'workstations/:workstationId', 200],
] as const;

async function headersFor(userId: string, extra: SignKiloTokenExtra = {}) {
  const { token } = await signKiloToken({
    userId,
    secret: JWT_SECRET,
    audience: HELLDESK_AUDIENCE,
    expiresInSeconds: 60,
    extra,
  });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('Personal user route authorization', () => {
  let callerId: string;
  let ownerId: string;
  let department: UserDepartmentRecord;
  let workstation: UserWorkstationRecord;

  beforeEach(async () => {
    callerId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    const user = getHelldeskUserStub(env, ownerId);
    department = await user.createDepartment({ name: 'Private department', owner_user_id: ownerId });
    workstation = await user.createWorkstation({
      department_id: department.id,
      name: 'Private workstation',
      git_url: 'https://example.com/private.git',
      default_branch: 'main',
    });
    const departmentStub = getDepartmentDOStub(env, department.id);
    await departmentStub.setDepartmentId(department.id);
    await runInDurableObject(departmentStub, async (_instance, state) => {
      await state.storage.put('user-route-auth:sentinel', 'Private work');
    });
  });

  function url(userId: string, path: string) {
    const suffix = path.replace(':departmentId', department.id).replace(':workstationId', workstation.id);
    return `http://localhost/api/users/${userId}/${suffix}`;
  }

  function requestBody(method: string) {
    if (method !== 'POST') return undefined;
    return JSON.stringify({
      name: 'New resource',
      department_id: department.id,
      git_url: 'https://example.com/new.git',
    });
  }

  async function expectPrivateState() {
    const user = getHelldeskUserStub(env, ownerId);
    expect(await user.listDepartments()).toEqual([department]);
    expect(await user.listWorkstations(department.id)).toEqual([workstation]);
    const sentinel = await runInDurableObject(getDepartmentDOStub(env, department.id), (_instance, state) =>
      state.storage.get('user-route-auth:sentinel')
    );
    expect(sentinel).toBe('Private work');
  }

  it.each(routes)('rejects another user for %s %s', async (method, path) => {
    const response = await SELF.fetch(url(ownerId, path), {
      method,
      headers: await headersFor(callerId, ACCESS),
      body: requestBody(method),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
    await expectPrivateState();
  });

  it.each(routes)('rejects the owner without HELLDESK access for %s %s', async (method, path) => {
    const response = await SELF.fetch(url(ownerId, path), {
      method,
      headers: await headersFor(ownerId),
      body: requestBody(method),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'HELLDESK access required',
    });
    await expectPrivateState();
  });

  it.each(routes.filter(([method, path]) => method !== 'POST' || path !== 'departments'))(
    'allows the owner for %s %s',
    async (method, path, status) => {
      const response = await SELF.fetch(url(ownerId, path), {
        method,
        headers: await headersFor(ownerId, ACCESS),
        body: requestBody(method),
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ success: true });
    }
  );

  it('rejects department creation without HELLDESK access', async () => {
    const response = await SELF.fetch(url(ownerId, 'departments'), {
      method: 'POST',
      headers: await headersFor(ownerId),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'HELLDESK access required',
    });
    await expectPrivateState();
  });

  it('does not exempt admins without HELLDESK access', async () => {
    const response = await SELF.fetch(url(ownerId, 'departments'), {
      method: 'POST',
      headers: await headersFor(ownerId, { isAdmin: true }),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'HELLDESK access required',
    });
    await expectPrivateState();
  });

  it('allows department creation with HELLDESK access', async () => {
    const response = await SELF.fetch(url(ownerId, 'departments'), {
      method: 'POST',
      headers: await headersFor(ownerId, { helldeskAccess: true }),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { name: 'New resource', owner_user_id: ownerId },
    });
  });

  it.each(['departments', 'departments/:departmentId/workstations'])(
    'preserves admin support access to another user: %s',
    async path => {
      const response = await SELF.fetch(url(ownerId, path), {
        headers: await headersFor(callerId, { isAdmin: true }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: [{ id: expect.any(String) }],
      });
    }
  );

  it.each(routes.filter(([method]) => method !== 'GET'))(
    'rejects cross-user admin writes for %s %s',
    async (method, path) => {
      const response = await SELF.fetch(url(ownerId, path), {
        method,
        headers: await headersFor(callerId, { isAdmin: true }),
        body: requestBody(method),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
      await expectPrivateState();
    }
  );

  it.each([
    ['POST', 'workstations', 201],
    ['DELETE', 'departments/:departmentId', 200],
    ['DELETE', 'workstations/:workstationId', 200],
  ] as const)('allows admin writes to owned resources for %s %s', async (method, path, status) => {
    const response = await SELF.fetch(url(ownerId, path), {
      method,
      headers: await headersFor(ownerId, { isAdmin: true }),
      body: requestBody(method),
    });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('rejects a missing token', async () => {
    const response = await SELF.fetch(url(ownerId, 'departments'));
    expect(response.status).toBe(401);
    await expectPrivateState();
  });

  it('rejects an invalid token', async () => {
    const response = await SELF.fetch(url(ownerId, 'departments'), {
      headers: { Authorization: 'Bearer invalid' },
    });
    expect(response.status).toBe(401);
    await expectPrivateState();
  });

  it('rejects creation under a nonexistent user', async () => {
    const fakeUserId = crypto.randomUUID();
    const response = await SELF.fetch(url(fakeUserId, 'departments'), {
      method: 'POST',
      headers: await headersFor(callerId, ACCESS),
      body: requestBody('POST'),
    });

    expect(response.status).toBe(403);
    expect(await getHelldeskUserStub(env, fakeUserId).listDepartments()).toEqual([]);
  });

  it('does not destroy an unowned department through the caller user path', async () => {
    const response = await SELF.fetch(url(callerId, 'departments/:departmentId'), {
      method: 'DELETE',
      headers: await headersFor(callerId, ACCESS),
    });

    expect(response.status).toBe(404);
    await expectPrivateState();
  });
});

describe('Department and org route HELLDESK access', () => {
  let ownerId: string;
  let departmentId: string;

  beforeEach(async () => {
    ownerId = crypto.randomUUID();
    const department = await getHelldeskUserStub(env, ownerId).createDepartment({
      name: 'Department routes',
      owner_user_id: ownerId,
    });
    departmentId = department.id;
    const departmentStub = getDepartmentDOStub(env, departmentId);
    await departmentStub.setDepartmentId(departmentId);
    await departmentStub.updateDepartmentConfig({
      owner_user_id: ownerId,
      owner_type: 'user',
      owner_id: ownerId,
    });
  });

  function departmentUrl(path: string) {
    return `http://localhost/api/departments/${departmentId}/${path}`;
  }

  it('rejects the owner without HELLDESK access', async () => {
    const response = await SELF.fetch(departmentUrl('config'), { headers: await headersFor(ownerId) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'HELLDESK access required',
    });
  });

  it('rejects a frontDesk message without HELLDESK access', async () => {
    const response = await SELF.fetch(departmentUrl('frontDesk/message'), {
      method: 'POST',
      headers: await headersFor(ownerId),
      body: JSON.stringify({ message: 'run something' }),
    });

    expect(response.status).toBe(403);
    expect(await getDepartmentContainerStub(env, departmentId).getState()).toEqual({ status: 'stopped' });
  });

  it('allows the owner with HELLDESK access', async () => {
    const response = await SELF.fetch(departmentUrl('config'), {
      headers: await headersFor(ownerId, ACCESS),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('preserves admin support access', async () => {
    const response = await SELF.fetch(departmentUrl('config'), {
      headers: await headersFor(crypto.randomUUID(), { isAdmin: true }),
    });

    expect(response.status).toBe(200);
  });

  it('returns the ownership rejection to another user', async () => {
    const response = await SELF.fetch(departmentUrl('config'), {
      headers: await headersFor(crypto.randomUUID(), ACCESS),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'Forbidden' });
  });

  it('rejects org routes without HELLDESK access', async () => {
    const orgId = crypto.randomUUID();
    const response = await SELF.fetch(`http://localhost/api/orgs/${orgId}/departments`, {
      headers: await headersFor(ownerId, { orgMemberships: [{ orgId, role: 'owner' }] }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: 'HELLDESK access required',
    });
  });
});
