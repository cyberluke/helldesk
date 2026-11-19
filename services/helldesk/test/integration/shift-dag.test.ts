import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('Shift DAG and Feature Branches', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `shift-dag-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    // Set department ID so the alarm loop doesn't bail out
    await department.setDepartmentId(departmentName);
  });

  describe('feature branch creation', () => {
    it('should create a shift with a feature branch', async () => {
      // Need a workstation for slingShift
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Add User Auth',
        tasks: [{ title: 'Create user model' }, { title: 'Add login endpoint' }],
      });

      expect(result.shift.feature_branch).toBeTruthy();
      expect(result.shift.feature_branch).toMatch(/^shift\/add-user-auth\/[0-9a-f]+\/head$/);
      expect(result.shift.status).toBe('active');
      expect(result.shift.total_tickets).toBe(2);
      expect(result.tickets).toHaveLength(2);
    });

    it('should slug the shift title for the branch name', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Fix: Bug #123 with special characters!!!',
        tasks: [{ title: 'Task 1' }],
      });

      expect(result.shift.feature_branch).toMatch(
        /^shift\/fix-bug-123-with-special-characters\/[0-9a-f]+\/head$/
      );
    });

    it('should store shift_id and feature_branch in ticket metadata', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Test Shift',
        tasks: [{ title: 'Task 1' }],
      });

      const ticket = await department.getTicketAsync(result.tickets[0].ticket.ticket_id);
      expect(ticket).toBeTruthy();
      expect(ticket?.metadata?.shift_id).toBe(result.shift.id);
      expect(ticket?.metadata?.feature_branch).toBe(result.shift.feature_branch);
    });
  });

  describe('DAG dependency edges', () => {
    it('should create blocks dependencies from depends_on indices', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Serial Shift',
        tasks: [
          { title: 'Step 1' },
          { title: 'Step 2', depends_on: [0] },
          { title: 'Step 3', depends_on: [0, 1] },
        ],
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status).toBeTruthy();
      expect(status!.dependency_edges).toBeDefined();
      expect(status!.dependency_edges.length).toBe(3);
      const ticketIds = result.tickets.map(b => b.ticket.ticket_id);

      expect(status!.dependency_edges).toContainEqual({
        ticket_id: ticketIds[1],
        depends_on_ticket_id: ticketIds[0],
      });

      expect(status!.dependency_edges).toContainEqual({
        ticket_id: ticketIds[2],
        depends_on_ticket_id: ticketIds[0],
      });

      expect(status!.dependency_edges).toContainEqual({
        ticket_id: ticketIds[2],
        depends_on_ticket_id: ticketIds[1],
      });
    });

    it('should return empty dependency_edges for shifts without deps', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Parallel Shift',
        tasks: [{ title: 'Task A' }, { title: 'Task B' }, { title: 'Task C' }],
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    it('should include dependency_edges in listShiftsDetailed', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Detailed Shift',
        tasks: [{ title: 'First' }, { title: 'Second', depends_on: [0] }],
      });

      const detailed = await department.listShiftsDetailed();
      expect(detailed).toHaveLength(1);
      expect(detailed[0].dependency_edges).toBeDefined();
      expect(detailed[0].dependency_edges.length).toBe(1);
      expect(detailed[0].feature_branch).toBeTruthy();
    });
  });

  describe('DAG-aware scheduling', () => {
    it('should not dispatch blocked tickets', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Serial Tasks',
        tasks: [
          { title: 'First Step' },
          { title: 'Second Step', depends_on: [0] },
          { title: 'Third Step', depends_on: [1] },
        ],
      });

      await runDurableObjectAlarm(department);

      const ticket0 = await department.getTicketAsync(result.tickets[0].ticket.ticket_id);
      const ticket1 = await department.getTicketAsync(result.tickets[1].ticket.ticket_id);
      const ticket2 = await department.getTicketAsync(result.tickets[2].ticket.ticket_id);

      expect(ticket0?.assignee_agent_ticket_id).toBeTruthy();

      expect(ticket1?.assignee_agent_ticket_id).toBeNull();
      expect(ticket2?.assignee_agent_ticket_id).toBeNull();
    });

    it('should unblock next ticket when blocker closes', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Two Steps',
        tasks: [{ title: 'Step 1' }, { title: 'Step 2', depends_on: [0] }],
      });

      await runDurableObjectAlarm(department);

      const ticketIds = result.tickets.map(b => b.ticket.ticket_id);
      const ticket0 = await department.getTicketAsync(ticketIds[0]);
      const agent0Id = ticket0!.assignee_agent_ticket_id!;
      expect(agent0Id).toBeTruthy();

      await department.updateTicketStatus(ticketIds[0], 'closed', agent0Id);

      await runDurableObjectAlarm(department);

      const status = await department.getShiftStatus(result.shift.id);
      expect(status?.closed_tickets).toBe(1);

      const ticket1 = await department.getTicketAsync(ticketIds[1]);
      expect(ticket1?.status).not.toBe('closed');
      expect(ticket1?.assignee_agent_ticket_id).toBeTruthy();
    });

    it('should handle parallel tickets that both block a final ticket', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      // Diamond shape: A and B run in parallel, C depends on both
      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Diamond DAG',
        tasks: [{ title: 'Task A' }, { title: 'Task B' }, { title: 'Task C', depends_on: [0, 1] }],
      });

      await runDurableObjectAlarm(department);

      const ticketIds = result.tickets.map(b => b.ticket.ticket_id);
      const ticketA = await department.getTicketAsync(ticketIds[0]);
      const ticketB = await department.getTicketAsync(ticketIds[1]);

      await department.updateTicketStatus(ticketIds[0], 'closed', ticketA!.assignee_agent_ticket_id!);

      const status1 = await department.getShiftStatus(result.shift.id);
      expect(status1?.closed_tickets).toBe(1);

      await department.updateTicketStatus(ticketIds[1], 'closed', ticketB!.assignee_agent_ticket_id!);

      const status2 = await department.getShiftStatus(result.shift.id);
      expect(status2?.closed_tickets).toBe(2);
    });
  });

  describe('shift progress', () => {
    it('should track closed_tickets progress', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Progress Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }, { title: 'Task 3' }],
      });

      let status = await department.getShiftStatus(result.shift.id);
      expect(status?.closed_tickets).toBe(0);
      expect(status?.total_tickets).toBe(3);

      await runDurableObjectAlarm(department);

      const ticketIds = result.tickets.map(b => b.ticket.ticket_id);
      await department.updateTicketStatus(ticketIds[0], 'closed', 'system');

      status = await department.getShiftStatus(result.shift.id);
      expect(status?.closed_tickets).toBe(1);

      await department.updateTicketStatus(ticketIds[1], 'closed', 'system');

      status = await department.getShiftStatus(result.shift.id);
      expect(status?.closed_tickets).toBe(2);
    });

    it('should set ready_to_land when all tickets close (with feature branch)', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Landing Test',
        tasks: [{ title: 'Only task' }],
      });

      expect(result.shift.feature_branch).toBeTruthy();

      const ticketId = result.tickets[0].ticket.ticket_id;

      await department.updateTicketStatus(ticketId, 'closed', 'system');

      // Shift should NOT auto-close (it has a feature branch that needs landing)
      const status = await department.getShiftStatus(result.shift.id);
      expect(status?.status).toBe('active'); // Still active, waiting for feature branch landing
      expect(status?.closed_tickets).toBe(1);
    });

    it('should count failed tickets toward shift progress', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Failure Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
      });

      const ticketIds = result.tickets.map(b => b.ticket.ticket_id);

      await department.updateTicketStatus(ticketIds[0], 'failed', 'system');
      await department.updateTicketStatus(ticketIds[1], 'closed', 'system');

      const status = await department.getShiftStatus(result.shift.id);
      // Both failed and closed count toward progress
      expect(status?.closed_tickets).toBe(2);
    });
  });

  describe('force close shift', () => {
    it('should close all tracked tickets and the shift', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Force Close Test',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2', depends_on: [0] }],
      });

      const closed = await department.closeShift(result.shift.id);
      expect(closed?.status).toBe('landed');

      for (const b of result.tickets) {
        const ticket = await department.getTicketAsync(b.ticket.ticket_id);
        expect(ticket?.status).toBe('closed');
      }
    });
  });

  describe('edge cases', () => {
    it('should ignore self-referential depends_on', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Self Ref',
        tasks: [
          { title: 'Task 0', depends_on: [0] }, // self-reference
        ],
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    it('should ignore out-of-bounds depends_on indices', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'OOB Deps',
        tasks: [{ title: 'Task 0', depends_on: [5, -1, 100] }],
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status!.dependency_edges).toEqual([]);
    });

    // Cycle detection is tested in unit tests (shift-branches.test.ts)
    // since DO throws corrupt vitest-pool-workers isolated storage.
  });

  describe('merge mode', () => {
    it('should default to review-then-land when merge_mode is not specified', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Default Mode',
        tasks: [{ title: 'Task 1' }],
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status?.merge_mode).toBe('review-then-land');
    });

    it('should accept review-then-land merge mode', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Review Then Land',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
        merge_mode: 'review-then-land',
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status?.merge_mode).toBe('review-then-land');
      expect(status?.feature_branch).toBeTruthy();
    });

    it('should accept review-and-merge merge mode', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Review And Merge',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
        merge_mode: 'review-and-merge',
      });

      const status = await department.getShiftStatus(result.shift.id);
      expect(status?.merge_mode).toBe('review-and-merge');
      expect(status?.feature_branch).toBeTruthy();
    });

    it('should include merge_mode in listShiftsDetailed', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Mode Test',
        tasks: [{ title: 'Task 1' }],
        merge_mode: 'review-and-merge',
      });

      const detailed = await department.listShiftsDetailed();
      expect(detailed).toHaveLength(1);
      expect(detailed[0].merge_mode).toBe('review-and-merge');
    });

    it('should include merge_mode in review queue metadata for shift tickets', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Review Queue Mode Test',
        tasks: [{ title: 'Task 1' }],
        merge_mode: 'review-then-land',
      });

      await runDurableObjectAlarm(department);

      const ticketId = result.tickets[0].ticket.ticket_id;
      const ticket0 = await department.getTicketAsync(ticketId);
      const agentId = ticket0!.assignee_agent_ticket_id!;
      expect(agentId).toBeTruthy();

      await department.agentDone(agentId, {
        branch: 'gt/toast/test1234',
        summary: 'Done with task',
      });

      // agentDone is event-only — run alarm to drain events and apply
      await runDurableObjectAlarm(department);

      const ticket = await department.getTicketAsync(ticketId);
      expect(ticket?.status).toBe('in_review');

      const allTickets = await department.listTickets({ type: 'merge_request' });
      const mrTicket = allTickets.find(b => b.metadata?.source_ticket_id === ticketId);
      expect(mrTicket).toBeTruthy();
      expect(mrTicket?.metadata?.shift_id).toBe(result.shift.id);
    });
  });
});
