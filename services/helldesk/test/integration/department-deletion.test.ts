import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name: string) {
  return env.department.get(env.department.idFromName(name));
}

function getUserStub(name: string) {
  return env.HELLDESK_USER.get(env.HELLDESK_USER.idFromName(name));
}

function getAgentStub(name: string) {
  return env.AGENT.get(env.AGENT.idFromName(name));
}

describe('Department deletion (#1182)', () => {
  let departmentName: string;
  let department: ReturnType<typeof getDepartmentStub>;

  beforeEach(() => {
    departmentName = `department-del-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
  });

  describe('DepartmentDO.destroy()', () => {
    it('should clear all storage so tickets are no longer retrievable', async () => {
      await department.createTicket({ type: 'issue', title: 'Doomed ticket' });
      await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `del-agent-${departmentName}`,
      });

      await department.destroy();

      const tickets = await department.listTickets({});
      expect(tickets).toHaveLength(0);
    });

    it('should clear all agents from storage', async () => {
      await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `del-agents-a-${departmentName}`,
      });
      await department.registerAgent({
        role: 'qualityAssurance',
        name: 'R1',
        identity: `del-agents-b-${departmentName}`,
      });

      const agentsBefore = await department.listAgents();
      expect(agentsBefore).toHaveLength(2);

      await department.destroy();

      const agentsAfter = await department.listAgents();
      expect(agentsAfter).toHaveLength(0);
    });

    it('should delete the alarm so it does not re-fire', async () => {
      // setDepartmentId is required for armAlarmIfNeeded to arm the alarm
      await department.setDepartmentId(departmentName);
      await department.slingTicket({ type: 'issue', title: 'Alarm ticket', workstationId: 'test-workstation' });
      const ranBefore = await runDurableObjectAlarm(department);
      expect(ranBefore).toBe(true);

      await department.destroy();

      // After destroy, the alarm should not re-fire
      const ranAfter = await runDurableObjectAlarm(department);
      expect(ranAfter).toBe(false);
    });

    it('should destroy AgentDOs (clearing their event tables)', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `del-agentdo-${departmentName}`,
      });

      const agentDO = getAgentStub(agent.id);
      await agentDO.appendEvents([{ type: 'session.start', data: JSON.stringify({ test: true }) }]);

      const eventsBefore = await agentDO.getEvents();
      expect(eventsBefore.length).toBeGreaterThan(0);

      await department.destroy();

      const eventsAfter = await agentDO.getEvents();
      expect(eventsAfter).toHaveLength(0);
    });
  });

  describe('alarm exit condition', () => {
    it('should not re-arm alarm on a destroyed DO', async () => {
      // setDepartmentId is required for armAlarmIfNeeded to arm the alarm
      await department.setDepartmentId(departmentName);
      await department.configureWorkstation({
        workstationId: 'test-workstation',
        departmentId: departmentName,
        gitUrl: 'https://github.com/org/repo.git',
        defaultBranch: 'main',
        userId: 'test-user',
      });

      await department.slingTicket({ type: 'issue', title: 'Active ticket', workstationId: 'test-workstation' });
      const ranBefore = await runDurableObjectAlarm(department);
      expect(ranBefore).toBe(true);

      await department.destroy();

      // deleteAll() with compat date >= 2026-02-24 clears alarms,
      // so this should return false
      const ranAfterDestroy = await runDurableObjectAlarm(department);
      expect(ranAfterDestroy).toBe(false);
    });

    it('should not resurrect alarm when accessing a destroyed department', async () => {
      await department.createTicket({ type: 'issue', title: 'Soon to die' });

      await department.destroy();

      // Accessing the destroyed DO triggers ensureInitialized() →
      // armAlarmIfNeeded(), which should NOT re-arm because department:id is gone
      const tickets = await department.listTickets({});
      expect(tickets).toHaveLength(0);

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(false);
    });
  });

  describe('HelldeskUserDO.deleteDepartment()', () => {
    it('should remove the department from the user list', async () => {
      const userId = `user-${crypto.randomUUID()}`;
      const userStub = getUserStub(userId);

      // createDepartment generates its own id; it requires name + owner_user_id
      const created = await userStub.createDepartment({
        name: 'Test Department',
        owner_user_id: userId,
      });

      const departmentsBefore = await userStub.listDepartments();
      expect(departmentsBefore).toHaveLength(1);

      const deleted = await userStub.deleteDepartment(created.id);
      expect(deleted).toBe(true);

      const departmentsAfter = await userStub.listDepartments();
      expect(departmentsAfter).toHaveLength(0);
    });
  });

  describe('full deletion flow', () => {
    it('should clean up DepartmentDO storage and user records', async () => {
      const userId = `user-${crypto.randomUUID()}`;
      const userStub = getUserStub(userId);

      // createDepartment generates its own id; it requires name + owner_user_id
      const created = await userStub.createDepartment({
        name: 'Full Delete Department',
        owner_user_id: userId,
      });
      const departmentId = created.id;

      // Set up DepartmentDO with data (setDepartmentId mirrors the tRPC createDepartment flow)
      const departmentStub = getDepartmentStub(departmentId);
      await departmentStub.setDepartmentId(departmentId);
      await departmentStub.createTicket({ type: 'issue', title: 'Ticket in deleted department' });
      await departmentStub.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `full-del-${departmentId}`,
      });

      // Simulate the fixed tRPC deleteDepartment flow:
      // 1. Destroy DepartmentDO (agents, container, alarms, storage)
      await departmentStub.destroy();
      // 2. Remove from user's list
      await userStub.deleteDepartment(departmentId);

      const departments = await userStub.listDepartments();
      expect(departments).toHaveLength(0);

      const tickets = await departmentStub.listTickets({});
      expect(tickets).toHaveLength(0);
      const agents = await departmentStub.listAgents();
      expect(agents).toHaveLength(0);

      const ran = await runDurableObjectAlarm(departmentStub);
      expect(ran).toBe(false);
    });
  });
});
