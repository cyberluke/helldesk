import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('Department DO Alarm', () => {
  let departmentName: string;
  let department: ReturnType<typeof getDepartmentStub>;

  beforeEach(() => {
    departmentName = `department-alarm-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
  });

  const testWorkstationConfig = (workstationId = 'test-workstation') => ({
    workstationId,
    departmentId: 'department-abc',
    gitUrl: 'https://github.com/org/repo.git',
    defaultBranch: 'main',
    userId: 'test-user',
  });

  describe('workstation config', () => {
    it('should store and retrieve workstation config', async () => {
      const cfg = testWorkstationConfig();
      await department.configureWorkstation(cfg);
      const retrieved = await department.getWorkstationConfig(cfg.workstationId);
      expect(retrieved).toMatchObject(cfg);
    });

    it('should return null when no workstation config is set', async () => {
      const retrieved = await department.getWorkstationConfig('nonexistent');
      expect(retrieved).toBeNull();
    });
  });

  describe('alarm arming', () => {
    it('should arm alarm when hookTicket is called', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `alarm-hook-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Test ticket' });

      await department.hookTicket(agent.id, ticket.id);

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(true);
    });

    it('should arm alarm when agentDone is called', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `alarm-done-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Done ticket' });
      await department.hookTicket(agent.id, ticket.id);

      await runDurableObjectAlarm(department);

      await department.agentDone(agent.id, {
        branch: 'feature/test',
        summary: 'Test done',
      });

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(true);
    });

    it('should arm alarm when slingTicket is called', async () => {
      await department.slingTicket({
        type: 'issue',
        title: 'Alarm trigger test',
        workstationId: 'test-workstation',
      });

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(true);
    });

    it('should arm alarm when touchAgentHeartbeat is called', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `alarm-heartbeat-${departmentName}`,
      });

      await department.touchAgentHeartbeat(agent.id);

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(true);
    });
  });

  describe('alarm handler', () => {
    it('should re-arm when there is active work', async () => {
      await department.configureWorkstation(testWorkstationConfig());
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `rearm-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Active work' });
      await department.hookTicket(agent.id, ticket.id);

      await runDurableObjectAlarm(department);

      const ranAgain = await runDurableObjectAlarm(department);
      expect(ranAgain).toBe(true);
    });

    it('should re-arm with idle interval when there is no active work', async () => {
      await department.slingTicket({ type: 'issue', title: 'Arm alarm', workstationId: 'test-workstation' });

      const ran = await runDurableObjectAlarm(department);
      expect(ran).toBe(true);

      // DepartmentDO always re-arms (idle interval when no active work)
      const ranAgain = await runDurableObjectAlarm(department);
      expect(ranAgain).toBe(true);
    });

    it('should process review queue entries during alarm', async () => {
      await department.configureWorkstation(testWorkstationConfig());
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `alarm-review-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Review ticket' });

      await department.submitToReviewQueue({
        agent_id: agent.id,
        ticket_id: ticket.id,
        workstation_id: 'test-workstation',
        branch: 'feature/review',
      });

      // Run alarm — the container isn't available in tests, so the merge will
      // fail gracefully and mark the review as 'failed'
      await runDurableObjectAlarm(department);

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets).toHaveLength(1);
      expect(mrTickets[0].status).not.toBe('open');
    });
  });

  describe('schedule pending work', () => {
    it('should not dispatch agents without workstation config', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `no-department-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Pending ticket' });
      await department.hookTicket(agent.id, ticket.id);

      // Run alarm — no workstation config, so scheduling should be skipped
      await runDurableObjectAlarm(department);

      const updatedAgent = await department.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('idle');
    });

    it('should attempt to dispatch idle agents with hooked tickets', async () => {
      await department.configureWorkstation(testWorkstationConfig());

      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `dispatch-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Dispatch ticket' });
      await department.hookTicket(agent.id, ticket.id);

      // Run alarm — container not available in tests, so startAgentInContainer
      // will fail, but the attempt should be made
      await runDurableObjectAlarm(department);

      const updatedAgent = await department.getAgentAsync(agent.id);
      expect(updatedAgent?.status).toBe('idle');
    });
  });

  describe('complianceWitness attendance via alarm', () => {
    it('should still detect dead agents when alarm fires', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'DeadAgent',
        identity: `alarm-dead-${departmentName}`,
      });
      await department.updateAgentStatus(agent.id, 'dead');
      await department.configureWorkstation(testWorkstationConfig());

      // Run alarm — complianceWitnessAttendance runs internally
      await runDurableObjectAlarm(department);

      const agentAfter = await department.getAgentAsync(agent.id);
      expect(agentAfter?.status).toBe('dead');
    });

    it('should handle orphaned tickets during alarm', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'OrphanMaker',
        identity: `alarm-orphan-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Orphan ticket' });
      await department.hookTicket(agent.id, ticket.id);

      // Kill the agent — ticket is now orphaned (hooked to dead agent)
      await department.updateAgentStatus(agent.id, 'dead');

      await department.configureWorkstation(testWorkstationConfig());
      await runDurableObjectAlarm(department);

      // Ticket should still exist and be in_progress (attendance doesn't auto-reassign yet)
      const ticketAfter = await department.getTicketAsync(ticket.id);
      expect(ticketAfter).not.toBeNull();
    });
  });

  describe('end-to-end alarm flow', () => {
    it('should handle the full ticket → hook → alarm → attendance cycle', async () => {
      await department.configureWorkstation(testWorkstationConfig());

      const agent = await department.registerAgent({
        role: 'soul',
        name: 'E2E-soul',
        identity: `e2e-${departmentName}`,
      });

      const ticket = await department.createTicket({
        type: 'issue',
        title: 'E2E test ticket',
        priority: 'high',
      });
      await department.hookTicket(agent.id, ticket.id);

      // hookTicket arms alarm — run it (container unavailable in tests,
      // so agent stays idle since dispatch fails)
      const alarmRan = await runDurableObjectAlarm(department);
      expect(alarmRan).toBe(true);

      const agentAfterAlarm = await department.getAgentAsync(agent.id);
      expect(agentAfterAlarm?.status).toBe('idle');
      expect(agentAfterAlarm?.current_hook_ticket_id).toBe(ticket.id);

      // Simulate agent completing work (in production the container
      // would have started the agent and it would call agentDone)
      await department.agentDone(agent.id, {
        branch: 'feature/e2e',
        pr_url: 'https://github.com/org/repo/pull/99',
        summary: 'E2E work complete',
      });

      const agentAfterDone = await department.getAgentAsync(agent.id);
      expect(agentAfterDone?.status).toBe('idle');
      expect(agentAfterDone?.current_hook_ticket_id).toBeNull();

      // Run alarm — should process the review queue entry
      // (will fail at container level but that's expected in tests)
      await runDurableObjectAlarm(department);

      // MR ticket should have been picked up and processed (failed in test env)
      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets).toHaveLength(1);
      expect(mrTickets[0].status).not.toBe('open');
    });
  });
});
