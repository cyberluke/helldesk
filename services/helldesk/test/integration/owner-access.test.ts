import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDepartmentContainerStub } from '../../src/dos/DepartmentContainer.do';
import { OWNER_ACCESS_STORAGE_KEY } from '../../src/dos/department/owner-access';

function newDepartmentId() {
  return `owner-access-${crypto.randomUUID()}`;
}

// Await the RPC call directly: `expect().rejects` pipelines extra RPC calls
// that reject unhandled.
async function startError(start: () => Promise<unknown>): Promise<string | null> {
  try {
    await start();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('Department container access revocation', () => {
  it('stops a running container and blocks every start', async () => {
    const container = getDepartmentContainerStub(env, newDepartmentId());
    await container.warmUp();
    expect(await container.getState()).toEqual({ status: 'healthy' });

    await container.setAccessRevoked(true);

    expect(await container.getState()).toEqual({ status: 'stopped' });
    expect(await startError(() => container.warmUp())).toContain('HELLDESK access is not enabled');
    expect(await startError(() => container.fetch('http://container/health'))).toContain(
      'HELLDESK access is not enabled'
    );
  });

  it('does not let the owner clear the block with the run policy', async () => {
    const container = getDepartmentContainerStub(env, newDepartmentId());
    await container.setAccessRevoked(true);

    await container.setRunPolicy('automatic');

    expect(await startError(() => container.warmUp())).toContain('HELLDESK access is not enabled');
  });

  it('allows starts again when access is restored', async () => {
    const container = getDepartmentContainerStub(env, newDepartmentId());
    await container.setAccessRevoked(true);

    await container.setAccessRevoked(false);

    expect(await container.warmUp()).toMatchObject({ coldStart: true });
  });
});

describe('Department alarm owner access', () => {
  async function configuredDepartment() {
    const departmentId = newDepartmentId();
    const department = env.department.get(env.department.idFromName(departmentId));
    await department.setDepartmentId(departmentId);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'Workstation',
      gitUrl: 'https://github.com/org/repo.git',
      defaultBranch: 'main',
    });
    // Hooked work keeps the alarm from stopping the container as idle.
    const agent = await department.registerAgent({
      role: 'soul',
      name: 'P1',
      identity: `soul-${departmentId}`,
    });
    const ticket = await department.createTicket({ type: 'issue', title: 'Work', workstation_id: 'workstation-1' });
    await department.hookTicket(agent.id, ticket.ticket_id);
    await runInDurableObject(department, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000)
    );
    return { departmentId, department };
  }

  it('starts the container of a department with work', async () => {
    const { departmentId, department } = await configuredDepartment();

    expect(await runDurableObjectAlarm(department)).toBe(true);

    const { status } = await getDepartmentContainerStub(env, departmentId).getState();
    expect(['healthy', 'running']).toContain(status);
  });

  it('does not start the container while the owner is revoked', async () => {
    const { departmentId, department } = await configuredDepartment();
    await runInDurableObject(department, (_instance, state) =>
      state.storage.put(OWNER_ACCESS_STORAGE_KEY, { revoked: true, checkedAt: Date.now() })
    );

    expect(await runDurableObjectAlarm(department)).toBe(true);

    expect(await getDepartmentContainerStub(env, departmentId).getState()).toMatchObject({ status: 'stopped' });
  });
});
