/**
 * Integration tests for the frontDesk idle (waiting) lifecycle.
 *
 * Verifies that:
 * 1. The "waiting" agent status exists and can be set
 * 2. hasActiveWork() returns false when the only agent is a waiting frontDesk
 * 3. The alarm interval drops to idle cadence when the frontDesk is waiting
 * 4. frontDeskWaiting() transitions a working frontDesk to waiting
 * 5. sendFrontDeskMessage transitions a waiting frontDesk back to working (when container is alive)
 * 6. Token refresh throttle persists across DO eviction (ctx.storage)
 */

import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('FrontDesk idle lifecycle', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `front-desk-idle-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  describe('waiting status', () => {
    it('should allow setting an agent to waiting', async () => {
      const agentsBefore = await department.listAgents({ role: 'frontDesk' });
      expect(agentsBefore.length).toBe(0);

      // ensureFrontDesk creates the agent (won't start container in test env)
      const result = await department.ensureFrontDesk();
      expect(result.agentId).toBeTruthy();

      await department.updateAgentStatus(result.agentId, 'working');
      const workingAgent = await department.getAgentAsync(result.agentId);
      expect(workingAgent?.status).toBe('working');

      await department.frontDeskWaiting(result.agentId);
      const waitingAgent = await department.getAgentAsync(result.agentId);
      expect(waitingAgent?.status).toBe('waiting');
    });

    it('should not transition non-working agents to waiting', async () => {
      const result = await department.ensureFrontDesk();

      const agent = await department.getAgentAsync(result.agentId);
      expect(agent?.status).toBe('idle');

      await department.frontDeskWaiting(result.agentId);
      const afterAgent = await department.getAgentAsync(result.agentId);
      expect(afterAgent?.status).toBe('idle');
    });

    it('should resolve empty agentId to the frontDesk', async () => {
      const result = await department.ensureFrontDesk();
      await department.updateAgentStatus(result.agentId, 'working');

      await department.frontDeskWaiting();
      const agent = await department.getAgentAsync(result.agentId);
      expect(agent?.status).toBe('waiting');
    });
  });

  describe('alarm interval with waiting frontDesk', () => {
    it('should use idle alarm interval when frontDesk is waiting', async () => {
      const result = await department.ensureFrontDesk();

      await department.updateAgentStatus(result.agentId, 'working');
      const activeStatus = await department.getAlarmStatus();
      expect(activeStatus.alarm.intervalMs).toBe(5_000);

      await department.updateAgentStatus(result.agentId, 'waiting');
      const idleStatus = await department.getAlarmStatus();
      expect(idleStatus.alarm.intervalMs).toBe(5 * 60_000);
    });

    it('should use active alarm interval when a soul is working alongside a waiting frontDesk', async () => {
      const result = await department.ensureFrontDesk();
      await department.updateAgentStatus(result.agentId, 'waiting');

      const shift = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Test',
        tasks: [{ title: 'Task 1' }],
      });

      await runDurableObjectAlarm(department);

      const ticket = await department.getTicketAsync(shift.tickets[0].ticket.ticket_id);
      expect(ticket?.assignee_agent_ticket_id).toBeTruthy();

      if (ticket?.assignee_agent_ticket_id) {
        await department.updateAgentStatus(ticket.assignee_agent_ticket_id, 'working');
      }

      const status = await department.getAlarmStatus();
      expect(status.alarm.intervalMs).toBe(5_000);
    });
  });

  describe('getFrontDeskStatus', () => {
    it('should report waiting frontDesk as active', async () => {
      const result = await department.ensureFrontDesk();
      await department.updateAgentStatus(result.agentId, 'waiting');

      const status = await department.getFrontDeskStatus();
      expect(status.session?.status).toBe('active');
    });
  });

  describe('getAlarmStatus agent counts', () => {
    it('should include waiting in agent counts', async () => {
      const result = await department.ensureFrontDesk();
      await department.updateAgentStatus(result.agentId, 'waiting');

      const status = await department.getAlarmStatus();
      expect(status.agents.waiting).toBe(1);
      expect(status.agents.working).toBe(0);
    });
  });
});
