import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('Review failure paths — shift progress and source ticket recovery', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `review-failure-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
  });

  async function setupShiftWithMR() {
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });

    const result = await department.slingShift({
      workstationId: 'workstation-1',
      shiftTitle: 'Review Failure Test',
      tasks: [{ title: 'Task 1' }],
    });

    await runDurableObjectAlarm(department);

    const ticketId = result.tickets[0].ticket.ticket_id;
    const ticket = await department.getTicketAsync(ticketId);
    const agentId = ticket!.assignee_agent_ticket_id!;
    expect(agentId).toBeTruthy();

    // Simulate agent completing work — inserts agent_done event
    await department.agentDone(agentId, {
      branch: 'gt/soul/test-branch',
      summary: 'Completed task',
    });

    // agentDone is event-only — run alarm to drain events and create MR ticket
    await runDurableObjectAlarm(department);

    const sourceTicket = await department.getTicketAsync(ticketId);
    expect(sourceTicket?.status).toBe('in_review');

    const allTickets = await department.listTickets({ type: 'merge_request' });
    const mrTicket = allTickets.find(b => b.metadata?.source_ticket_id === ticketId);
    expect(mrTicket).toBeTruthy();

    return { result, ticketId, agentId, mrTicketId: mrTicket!.ticket_id, shiftId: result.shift.id };
  }

  describe('completeReviewWithResult on MR failure', () => {
    it('should return source ticket to in_progress when MR ticket fails', async () => {
      const { ticketId, mrTicketId } = await setupShiftWithMR();

      // Fail the review via completeReviewWithResult (the fixed path)
      await department.completeReviewWithResult({
        entry_id: mrTicketId,
        status: 'failed',
        message: 'QualityAssurance container failed to start',
      });

      const mrTicket = await department.getTicketAsync(mrTicketId);
      expect(mrTicket?.status).toBe('failed');

      // Source ticket should be returned to open for rework (not stuck in in_review).
      // The reconciler will assign a new agent on the next alarm tick.
      const sourceTicket = await department.getTicketAsync(ticketId);
      expect(sourceTicket?.status).toBe('open');
    });

    it('should update shift progress when MR ticket is merged', async () => {
      const { ticketId, mrTicketId, shiftId } = await setupShiftWithMR();

      // Complete the review successfully
      await department.completeReviewWithResult({
        entry_id: mrTicketId,
        status: 'merged',
        message: 'Merged by qualityAssurance',
      });

      const sourceTicket = await department.getTicketAsync(ticketId);
      expect(sourceTicket?.status).toBe('closed');

      const mrTicket = await department.getTicketAsync(mrTicketId);
      expect(mrTicket?.status).toBe('closed');

      const shiftStatus = await department.getShiftStatus(shiftId);
      expect(shiftStatus?.closed_tickets).toBe(1);
    });
  });

  describe('shift progress with mixed outcomes', () => {
    it('should not stall shift when one MR fails and another merges', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Two-Task Shift',
        tasks: [{ title: 'Task 1' }, { title: 'Task 2' }],
      });

      await runDurableObjectAlarm(department);

      const ticket0Id = result.tickets[0].ticket.ticket_id;
      const ticket0 = await department.getTicketAsync(ticket0Id);
      const agent0Id = ticket0!.assignee_agent_ticket_id!;
      const ticket1Id = result.tickets[1].ticket.ticket_id;
      const ticket1 = await department.getTicketAsync(ticket1Id);
      const agent1Id = ticket1!.assignee_agent_ticket_id!;

      await department.agentDone(agent0Id, {
        branch: 'gt/soul/task-1',
        summary: 'Task 1 done',
      });
      await department.agentDone(agent1Id, {
        branch: 'gt/soul/task-2',
        summary: 'Task 2 done',
      });

      await runDurableObjectAlarm(department);

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      const mr0 = mrTickets.find(b => b.metadata?.source_ticket_id === ticket0Id);
      const mr1 = mrTickets.find(b => b.metadata?.source_ticket_id === ticket1Id);
      expect(mr0).toBeTruthy();
      expect(mr1).toBeTruthy();

      // Fail MR for task 1 via completeReviewWithResult
      await department.completeReviewWithResult({
        entry_id: mr0!.ticket_id,
        status: 'failed',
        message: 'Review failed',
      });

      const source0 = await department.getTicketAsync(ticket0Id);
      expect(source0?.status).toBe('open');

      await department.completeReviewWithResult({
        entry_id: mr1!.ticket_id,
        status: 'merged',
        message: 'Merged',
      });

      const source1 = await department.getTicketAsync(ticket1Id);
      expect(source1?.status).toBe('closed');

      // Shift should show 1 closed ticket (task 2 merged; task 1 is in_progress
      // awaiting rework, its MR is failed but the source isn't terminal yet)
      const shiftStatus = await department.getShiftStatus(result.shift.id);
      expect(shiftStatus?.closed_tickets).toBe(1);
    });
  });

  describe('agentDone transitions source ticket to in_review', () => {
    it('should set source ticket to in_review after soul calls agentDone', async () => {
      await department.addWorkstation({
        workstationId: 'workstation-1',
        name: 'main-workstation',
        gitUrl: 'https://github.com/test/repo.git',
        defaultBranch: 'main',
      });

      const result = await department.slingShift({
        workstationId: 'workstation-1',
        shiftTitle: 'Agent Done Test',
        tasks: [{ title: 'Single Task' }],
      });

      await runDurableObjectAlarm(department);

      const ticketId = result.tickets[0].ticket.ticket_id;
      const assignedTicket = await department.getTicketAsync(ticketId);
      const agentId = assignedTicket!.assignee_agent_ticket_id!;

      await department.agentDone(agentId, {
        branch: 'gt/soul/test',
        summary: 'Done',
      });

      // agentDone is event-only — run alarm to drain events
      await runDurableObjectAlarm(department);

      const updatedTicket = await department.getTicketAsync(ticketId);
      expect(updatedTicket?.status).toBe('in_review');

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets.length).toBeGreaterThan(0);
      expect(mrTickets.some(b => b.metadata?.source_ticket_id === ticketId)).toBe(true);
    });
  });
});
