import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getDepartmentContainerStub } from '../../src/dos/DepartmentContainer.do';
import { HELD_LABEL } from '../../src/dos/department/attendance';

// Older than the 5-minute window in which a new workstation keeps the container warm.
const OLD_WORKSTATION_CREATED_AT = new Date(Date.now() - 60 * 60_000).toISOString();

async function departmentWithRunningContainer() {
  const departmentId = `container-idle-${crypto.randomUUID()}`;
  const department = env.department.get(env.department.idFromName(departmentId));
  await department.setDepartmentId(departmentId);
  await department.addWorkstation({
    workstationId: 'workstation-1',
    name: 'Workstation',
    gitUrl: 'https://github.com/org/repo.git',
    defaultBranch: 'main',
  });
  await runInDurableObject(department, (_instance, state) => {
    state.storage.sql.exec('UPDATE workstations SET created_at = ?', OLD_WORKSTATION_CREATED_AT);
    return state.storage.setAlarm(Date.now() + 60_000);
  });
  const container = getDepartmentContainerStub(env, departmentId);
  await container.warmUp();
  return { departmentId, department, container };
}

describe('Department alarm idle container stop', () => {
  it('stops the container when the department only has work it never dispatches', async () => {
    const { department, container } = await departmentWithRunningContainer();
    // A held issue counts as active work, but the reconciler never dispatches it.
    await department.createTicket({ type: 'issue', title: 'Held', workstation_id: 'workstation-1', labels: [HELD_LABEL] });

    expect(await runDurableObjectAlarm(department)).toBe(true);

    expect(await container.getState()).toEqual({ status: 'stopped' });
  });

  it('keeps the container while an agent is working', async () => {
    const { departmentId, department, container } = await departmentWithRunningContainer();
    const agent = await department.registerAgent({
      role: 'soul',
      name: 'P1',
      identity: `soul-${departmentId}`,
    });
    const ticket = await department.createTicket({ type: 'issue', title: 'Work', workstation_id: 'workstation-1' });
    await department.hookTicket(agent.id, ticket.ticket_id);
    await department.updateAgentStatus(agent.id, 'working');
    await department.touchAgentHeartbeat(agent.id);

    expect(await runDurableObjectAlarm(department)).toBe(true);

    expect(await container.getState()).toEqual({ status: 'healthy' });
  });
});
