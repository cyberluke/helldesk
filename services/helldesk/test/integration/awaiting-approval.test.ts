import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('Awaiting approval — shift landing MR respawn suppression', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `awaiting-approval-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  async function setupShiftWithLandingMr() {
    const result = await department.slingShift({
      workstationId: 'workstation-1',
      shiftTitle: 'Landing MR Test',
      tasks: [{ title: 'Task 1' }],
      merge_mode: 'review-then-land',
    });

    const ticketId = result.tickets[0].ticket.ticket_id;

    await runDurableObjectAlarm(department);

    const ticket = await department.getTicketAsync(ticketId);
    const agentId = ticket!.assignee_agent_ticket_id!;
    expect(agentId).toBeTruthy();

    await department.agentDone(agentId, {
      branch: 'gt/soul/test-branch',
      summary: 'Completed task',
    });

    await runDurableObjectAlarm(department);

    const sourceTicket = await department.getTicketAsync(ticketId);
    expect(sourceTicket?.status).toBe('in_review');

    const allMrs = await department.listTickets({ type: 'merge_request' });
    const mrTicket = allMrs.find(b => b.metadata?.source_ticket_id === ticketId);
    expect(mrTicket).toBeTruthy();

    return {
      shiftId: result.shift.id,
      ticketId,
      mrTicketId: mrTicket!.ticket_id,
      featureBranch: result.shift.feature_branch!,
    };
  }

  it('should not fail an MR ticket via Rule 4 timeout when awaiting_approval is set', async () => {
    const { mrTicketId } = await setupShiftWithLandingMr();

    const mrTicket = await department.getTicketAsync(mrTicketId);
    await department.updateTicket(
      mrTicketId,
      {
        metadata: {
          ...(mrTicket?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
          last_poll_at: new Date(Date.now() - 45 * 60_000).toISOString(),
        },
      },
      'system'
    );

    await department.updateTicketStatus(mrTicketId, 'in_progress', 'system');

    await runDurableObjectAlarm(department);

    const after = await department.getTicketAsync(mrTicketId);
    expect(after?.status).toBe('in_progress');
    expect(after?.metadata?.awaiting_approval).toBe(1);
  });

  it('should not re-dispatch qualityAssurance (Rule 6) when awaiting_approval is set', async () => {
    const { mrTicketId } = await setupShiftWithLandingMr();

    const mrTicket = await department.getTicketAsync(mrTicketId);
    await department.updateTicket(
      mrTicketId,
      {
        metadata: {
          ...(mrTicket?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );
    await department.updateTicketStatus(mrTicketId, 'in_progress', 'system');

    const refineries = await department.listAgents({ role: 'qualityAssurance' });
    if (refineries.length > 0) {
      await department.updateAgentStatus(refineries[0].id, 'idle');
    }

    await runDurableObjectAlarm(department);

    const after = await department.getTicketAsync(mrTicketId);
    expect(after?.status).toBe('in_progress');
    expect(after?.metadata?.awaiting_approval).toBe(1);
  });

  it('should suppress shift landing MR respawn when failed MR has awaiting_approval', async () => {
    const { shiftId, ticketId, mrTicketId, featureBranch } = await setupShiftWithLandingMr();

    await department.updateTicketStatus(ticketId, 'closed', 'system');
    await runDurableObjectAlarm(department);

    const mrTicket = await department.getTicketAsync(mrTicketId);
    await department.updateTicket(
      mrTicketId,
      {
        metadata: {
          ...(mrTicket?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );
    await department.updateTicketStatus(mrTicketId, 'failed', 'system');

    await runDurableObjectAlarm(department);

    const allMrs = await department.listTickets({ type: 'merge_request' });
    const failedWithApproval = allMrs.filter(
      b => b.status === 'failed' && b.metadata?.awaiting_approval === 1
    );
    expect(failedWithApproval.length).toBeGreaterThan(0);

    const shiftStatus = await department.getShiftStatus(shiftId);
    expect(shiftStatus?.status).not.toBe('failed');
  });

  it('should allow MR to proceed when awaiting_approval is cleared', async () => {
    const { mrTicketId } = await setupShiftWithLandingMr();

    const mrTicket = await department.getTicketAsync(mrTicketId);
    await department.updateTicket(
      mrTicketId,
      {
        metadata: {
          ...(mrTicket?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
        },
      },
      'system'
    );
    await department.updateTicketStatus(mrTicketId, 'in_progress', 'system');

    await runDurableObjectAlarm(department);

    const during = await department.getTicketAsync(mrTicketId);
    expect(during?.status).toBe('in_progress');

    const withApproval = await department.getTicketAsync(mrTicketId);
    await department.updateTicket(
      mrTicketId,
      {
        metadata: {
          ...(withApproval?.metadata ?? {}),
          awaiting_approval: 0,
          review_decision: 'APPROVED',
          merge_state_status: 'CLEAN',
        },
      },
      'system'
    );

    await runDurableObjectAlarm(department);

    const after = await department.getTicketAsync(mrTicketId);
    expect(after?.metadata?.awaiting_approval).toBe(0);
    expect(after?.status).toBe('in_progress');
  });
});

describe('PR feedback vs awaiting approval — CHANGES_REQUESTED creates feedback ticket, REVIEW_REQUIRED does not', () => {
  let department: ReturnType<typeof getDepartmentStub>;
  let departmentName: string;

  beforeEach(async () => {
    departmentName = `feedback-vs-approval-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
    await department.setDepartmentId(departmentName);
    await department.addWorkstation({
      workstationId: 'workstation-1',
      name: 'main-workstation',
      gitUrl: 'https://github.com/test/repo.git',
      defaultBranch: 'main',
    });
  });

  it('should not create a feedback ticket for REVIEW_REQUIRED (awaiting approval)', async () => {
    const result = await department.slingShift({
      workstationId: 'workstation-1',
      shiftTitle: 'Review Required Test',
      tasks: [{ title: 'Task 1' }],
    });

    const ticketId = result.tickets[0].ticket.ticket_id;
    await runDurableObjectAlarm(department);

    const ticket = await department.getTicketAsync(ticketId);
    const agentId = ticket!.assignee_agent_ticket_id!;

    await department.agentDone(agentId, {
      branch: 'gt/soul/test-branch',
      summary: 'Completed task',
    });
    await runDurableObjectAlarm(department);

    const allMrs = await department.listTickets({ type: 'merge_request' });
    const mrTicket = allMrs.find(b => b.metadata?.source_ticket_id === ticketId);
    expect(mrTicket).toBeTruthy();

    const mrWithApproval = await department.getTicketAsync(mrTicket!.ticket_id);
    await department.updateTicket(
      mrTicket!.ticket_id,
      {
        metadata: {
          ...(mrWithApproval?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'REVIEW_REQUIRED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );

    const feedbackTicketsBefore = await department.listTickets({});
    const prFeedbackTicketsBefore = feedbackTicketsBefore.filter(b =>
      b.labels?.includes('gt:pr-feedback')
    );

    await runDurableObjectAlarm(department);

    const feedbackTicketsAfter = await department.listTickets({});
    const prFeedbackTicketsAfter = feedbackTicketsAfter.filter(b =>
      b.labels?.includes('gt:pr-feedback')
    );

    expect(prFeedbackTicketsAfter.length).toBe(prFeedbackTicketsBefore.length);
  });

  it('should create a feedback ticket for CHANGES_REQUESTED even when also awaiting approval', async () => {
    const result = await department.slingShift({
      workstationId: 'workstation-1',
      shiftTitle: 'Changes Requested Test',
      tasks: [{ title: 'Task 1' }],
    });

    const ticketId = result.tickets[0].ticket.ticket_id;
    await runDurableObjectAlarm(department);

    const ticket = await department.getTicketAsync(ticketId);
    const agentId = ticket!.assignee_agent_ticket_id!;

    await department.agentDone(agentId, {
      branch: 'gt/soul/test-branch',
      summary: 'Completed task',
    });
    await runDurableObjectAlarm(department);

    const allMrs = await department.listTickets({ type: 'merge_request' });
    const mrTicket = allMrs.find(b => b.metadata?.source_ticket_id === ticketId);
    expect(mrTicket).toBeTruthy();

    const mrWithChanges = await department.getTicketAsync(mrTicket!.ticket_id);
    await department.updateTicket(
      mrTicket!.ticket_id,
      {
        metadata: {
          ...(mrWithChanges?.metadata ?? {}),
          awaiting_approval: 1,
          review_decision: 'CHANGES_REQUESTED',
          merge_state_status: 'BLOCKED',
        },
      },
      'system'
    );

    await department.debugInsertDepartmentEvent({
      event_type: 'pr_feedback_detected',
      ticket_id: mrTicket!.ticket_id,
      payload: {
        mr_ticket_id: mrTicket!.ticket_id,
        pr_url: 'https://github.com/test/repo/pull/1',
        pr_number: 1,
        repo: 'test/repo',
        branch: 'gt/soul/test-branch',
        has_unresolved_comments: true,
        has_failing_checks: false,
        has_unchecked_runs: false,
      },
    });

    await runDurableObjectAlarm(department);

    const feedbackTickets = await department.listTickets({});
    const prFeedbackTickets = feedbackTickets.filter(b => b.labels?.includes('gt:pr-feedback'));
    expect(prFeedbackTickets.length).toBeGreaterThan(0);
  });
});
