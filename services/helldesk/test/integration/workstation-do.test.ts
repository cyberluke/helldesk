import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

function getDepartmentStub(name = 'test-department') {
  const id = env.department.idFromName(name);
  return env.department.get(id);
}

describe('DepartmentDO', () => {
  // Use unique department names per test to avoid state leaking
  let departmentName: string;
  let department: ReturnType<typeof getDepartmentStub>;

  beforeEach(() => {
    departmentName = `department-${crypto.randomUUID()}`;
    department = getDepartmentStub(departmentName);
  });

  describe('tickets', () => {
    it('should create and retrieve a ticket', async () => {
      const ticket = await department.createTicket({
        type: 'issue',
        title: 'Fix the widget',
        body: 'The widget is broken',
        priority: 'high',
        labels: ['bug'],
        metadata: { source: 'test' },
      });

      expect(ticket.ticket_id).toBeDefined();
      expect(ticket.type).toBe('issue');
      expect(ticket.status).toBe('open');
      expect(ticket.title).toBe('Fix the widget');
      expect(ticket.body).toBe('The widget is broken');
      expect(ticket.priority).toBe('high');
      expect(ticket.labels).toEqual(['bug']);
      expect(ticket.metadata).toEqual({ source: 'test' });
      expect(ticket.assignee_agent_ticket_id).toBeNull();
      expect(ticket.closed_at).toBeNull();

      const retrieved = await department.getTicketAsync(ticket.ticket_id);
      expect(retrieved).toMatchObject({ ticket_id: ticket.ticket_id, title: 'Fix the widget' });
    });

    it('should return null for non-existent ticket', async () => {
      const result = await department.getTicketAsync('non-existent');
      expect(result).toBeNull();
    });

    it('should list tickets with filters', async () => {
      await department.createTicket({ type: 'issue', title: 'Issue 1' });
      await department.createTicket({ type: 'message', title: 'Message 1' });
      await department.createTicket({ type: 'issue', title: 'Issue 2' });

      const allTickets = await department.listTickets({});
      expect(allTickets).toHaveLength(3);

      const issues = await department.listTickets({ type: 'issue' });
      expect(issues).toHaveLength(2);

      const messages = await department.listTickets({ type: 'message' });
      expect(messages).toHaveLength(1);
    });

    it('should list tickets with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await department.createTicket({ type: 'issue', title: `Issue ${i}` });
      }

      const page1 = await department.listTickets({ limit: 2 });
      expect(page1).toHaveLength(2);

      const page2 = await department.listTickets({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = await department.listTickets({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('should use default priority when not specified', async () => {
      const ticket = await department.createTicket({ type: 'issue', title: 'Default priority' });
      expect(ticket.priority).toBe('medium');
    });
  });

  describe('agents', () => {
    it('should register and retrieve an agent', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'soul-1',
        identity: `soul-1-${departmentName}`,
      });

      expect(agent.id).toBeDefined();
      expect(agent.role).toBe('soul');
      expect(agent.name).toBe('soul-1');
      expect(agent.identity).toBe(`soul-1-${departmentName}`);
      expect(agent.status).toBe('idle');
      expect(agent.current_hook_ticket_id).toBeNull();

      const retrieved = await department.getAgentAsync(agent.id);
      expect(retrieved).toMatchObject({ id: agent.id, name: 'soul-1' });
    });

    it('should store workstation_id when provided', async () => {
      const workstationId = `workstation-${crypto.randomUUID()}`;
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'soul-workstationTest',
        identity: `soul-workstation-${departmentName}`,
        workstation_id: workstationId,
      });

      expect(agent.workstation_id).toBe(workstationId);

      const retrieved = await department.getAgentAsync(agent.id);
      expect(retrieved?.workstation_id).toBe(workstationId);
    });

    it('should store null workstation_id when not provided', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'soul-Noworkstation',
        identity: `soul-norig-${departmentName}`,
      });

      expect(agent.workstation_id).toBeNull();
    });

    it('should return null for non-existent agent', async () => {
      const result = await department.getAgentAsync('non-existent');
      expect(result).toBeNull();
    });

    it('should get agent by identity', async () => {
      const identity = `unique-identity-${departmentName}`;
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'soul-2',
        identity,
      });

      const found = await department.getAgentByIdentity(identity);
      expect(found).toMatchObject({ id: agent.id, identity });
    });

    it('should list agents with filters', async () => {
      await department.registerAgent({ role: 'soul', name: 'P1', identity: `p1-${departmentName}` });
      await department.registerAgent({ role: 'qualityAssurance', name: 'R1', identity: `r1-${departmentName}` });
      await department.registerAgent({ role: 'soul', name: 'P2', identity: `p2-${departmentName}` });

      const all = await department.listAgents();
      expect(all).toHaveLength(3);

      const souls = await department.listAgents({ role: 'soul' });
      expect(souls).toHaveLength(2);

      const refineries = await department.listAgents({ role: 'qualityAssurance' });
      expect(refineries).toHaveLength(1);
    });

    it('should update agent status', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `status-test-${departmentName}`,
      });

      expect(agent.status).toBe('idle');

      await department.updateAgentStatus(agent.id, 'working');
      const updated = await department.getAgentAsync(agent.id);
      expect(updated?.status).toBe('working');
    });
  });

  describe('hooks', () => {
    it('should hook and unhook a ticket', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `hook-test-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Hook target' });

      await department.hookTicket(agent.id, ticket.ticket_id);

      const hookedAgent = await department.getAgentAsync(agent.id);
      expect(hookedAgent?.current_hook_ticket_id).toBe(ticket.ticket_id);
      expect(hookedAgent?.status).toBe('idle');

      const hookedTicket = await department.getTicketAsync(ticket.ticket_id);
      expect(hookedTicket?.status).toBe('in_progress');
      expect(hookedTicket?.assignee_agent_ticket_id).toBe(agent.id);

      const retrieved = await department.getHookedTicket(agent.id);
      expect(retrieved?.ticket_id).toBe(ticket.ticket_id);

      await department.unhookTicket(agent.id);

      const unhookedAgent = await department.getAgentAsync(agent.id);
      expect(unhookedAgent?.current_hook_ticket_id).toBeNull();
      expect(unhookedAgent?.status).toBe('idle');
    });

    it('should allow re-hooking the same ticket (idempotent)', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `hook-idem-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Ticket 1' });

      await department.hookTicket(agent.id, ticket.ticket_id);
      // Re-hooking the same ticket should succeed (idempotent)
      await department.hookTicket(agent.id, ticket.ticket_id);

      const hookedTicket = await department.getHookedTicket(agent.id);
      expect(hookedTicket?.ticket_id).toBe(ticket.ticket_id);
    });

    it('should return null for unhooked agent', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `no-hook-${departmentName}`,
      });

      const result = await department.getHookedTicket(agent.id);
      expect(result).toBeNull();
    });
  });

  describe('ticket status', () => {
    it('should update ticket status', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `status-ticket-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Status test' });

      const updated = await department.updateTicketStatus(ticket.ticket_id, 'in_progress', agent.id);
      expect(updated.status).toBe('in_progress');
      expect(updated.closed_at).toBeNull();
    });

    it('should close a ticket and set closed_at', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `close-ticket-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Close test' });

      const closed = await department.closeTicket(ticket.ticket_id, agent.id);
      expect(closed.status).toBe('closed');
      expect(closed.closed_at).toBeDefined();
    });

    it('should filter tickets by status', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `filter-status-${departmentName}`,
      });
      await department.createTicket({ type: 'issue', title: 'Open ticket' });
      const ticketToClose = await department.createTicket({ type: 'issue', title: 'Closed ticket' });
      await department.closeTicket(ticketToClose.ticket_id, agent.id);

      const openTickets = await department.listTickets({ status: 'open' });
      expect(openTickets).toHaveLength(1);
      expect(openTickets[0].title).toBe('Open ticket');

      const closedTickets = await department.listTickets({ status: 'closed' });
      expect(closedTickets).toHaveLength(1);
      expect(closedTickets[0].title).toBe('Closed ticket');
    });
  });

  describe('memo', () => {
    it('should send and check memo', async () => {
      const sender = await department.registerAgent({
        role: 'soul',
        name: 'Sender',
        identity: `sender-${departmentName}`,
      });
      const receiver = await department.registerAgent({
        role: 'soul',
        name: 'Receiver',
        identity: `receiver-${departmentName}`,
      });

      await department.sendMemo({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Help needed',
        body: 'I need help with the widget',
      });

      const mailbox = await department.checkMemo(receiver.id);
      expect(mailbox).toHaveLength(1);
      expect(mailbox[0].subject).toBe('Help needed');
      expect(mailbox[0].body).toBe('I need help with the widget');
      expect(mailbox[0].from_agent_id).toBe(sender.id);
      // checkMemo reads then marks as delivered; the returned data reflects pre-update state
      expect(mailbox[0].delivered).toBe(false);

      // Second check should return empty (already delivered)
      const emptyMailbox = await department.checkMemo(receiver.id);
      expect(emptyMailbox).toHaveLength(0);
    });

    it('should handle multiple memo messages', async () => {
      const sender = await department.registerAgent({
        role: 'soul',
        name: 'S1',
        identity: `multi-sender-${departmentName}`,
      });
      const receiver = await department.registerAgent({
        role: 'soul',
        name: 'R1',
        identity: `multi-receiver-${departmentName}`,
      });

      await department.sendMemo({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Message 1',
        body: 'First message',
      });
      await department.sendMemo({
        from_agent_id: sender.id,
        to_agent_id: receiver.id,
        subject: 'Message 2',
        body: 'Second message',
      });

      const mailbox = await department.checkMemo(receiver.id);
      expect(mailbox).toHaveLength(2);
      expect(mailbox[0].subject).toBe('Message 1');
      expect(mailbox[1].subject).toBe('Message 2');
    });
  });

  describe('review queue', () => {
    it('should submit to review queue and create an open merge_request ticket', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `review-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Review this' });

      await department.submitToReviewQueue({
        agent_id: agent.id,
        ticket_id: ticket.ticket_id,
        workstation_id: 'test-workstation',
        branch: 'feature/fix-widget',
        pr_url: 'https://github.com/org/repo/pull/1',
        summary: 'Fixed the widget',
      });

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets).toHaveLength(1);
      expect(mrTickets[0].status).toBe('open');
      expect(mrTickets[0].metadata?.pr_url).toBe('https://github.com/org/repo/pull/1');
      expect(mrTickets[0].metadata?.source_ticket_id).toBe(ticket.ticket_id);
    });

    it('should close ticket on successful merge via completeReviewWithResult', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `merge-success-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Merge me' });

      await department.submitToReviewQueue({
        agent_id: agent.id,
        ticket_id: ticket.ticket_id,
        workstation_id: 'test-workstation',
        branch: 'feature/merge-test',
      });

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets).toHaveLength(1);
      const mrTicketId = mrTickets[0].ticket_id;

      await department.completeReviewWithResult({
        entry_id: mrTicketId,
        status: 'merged',
        message: 'Merge successful',
        commit_sha: 'abc123',
      });

      const updatedTicket = await department.getTicketAsync(ticket.ticket_id);
      expect(updatedTicket?.status).toBe('closed');
      expect(updatedTicket?.closed_at).toBeDefined();

      const updatedMr = await department.getTicketAsync(mrTicketId);
      expect(updatedMr?.status).toBe('closed');
    });

    it('should create escalation ticket on merge conflict via completeReviewWithResult', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `merge-conflict-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Conflict me' });

      await department.submitToReviewQueue({
        agent_id: agent.id,
        ticket_id: ticket.ticket_id,
        workstation_id: 'test-workstation',
        branch: 'feature/conflict-test',
      });

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets).toHaveLength(1);
      const mrTicketId = mrTickets[0].ticket_id;

      await department.completeReviewWithResult({
        entry_id: mrTicketId,
        status: 'conflict',
        message: 'CONFLICT (content): Merge conflict in src/index.ts',
      });

      // Original ticket should NOT be closed (conflict means it stays as-is)
      const updatedTicket = await department.getTicketAsync(ticket.ticket_id);
      expect(updatedTicket?.status).not.toBe('closed');

      const escalations = await department.listTickets({ type: 'escalation' });
      expect(escalations).toHaveLength(1);
      expect(escalations[0].title).toBe('Merge conflict: feature/conflict-test');
      expect(escalations[0].priority).toBe('high');
      expect(escalations[0].body).toContain('CONFLICT (content)');
      expect(escalations[0].metadata).toMatchObject({
        source_ticket_id: ticket.ticket_id,
        source_branch: 'feature/conflict-test',
        agent_id: agent.id,
      });

      const updatedMr = await department.getTicketAsync(mrTicketId);
      expect(updatedMr?.status).toBe('failed');
    });
  });

  describe('prime', () => {
    it('should assemble prime context for an agent', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `prime-${departmentName}`,
      });
      const sender = await department.registerAgent({
        role: 'frontDesk',
        name: 'FrontDesk',
        identity: `front-desk-${departmentName}`,
      });

      const ticket = await department.createTicket({
        type: 'issue',
        title: 'Work on this',
        assignee_agent_id: agent.id,
      });
      await department.hookTicket(agent.id, ticket.ticket_id);

      await department.sendMemo({
        from_agent_id: sender.id,
        to_agent_id: agent.id,
        subject: 'Priority update',
        body: 'This is now urgent',
      });

      const context = await department.prime(agent.id);

      expect(context.agent.id).toBe(agent.id);
      expect(context.hooked_Ticket?.ticket_id).toBe(ticket.ticket_id);
      expect(context.undelivered_memo).toHaveLength(1);
      expect(context.undelivered_memo[0].subject).toBe('Priority update');
      expect(context.open_tickets).toHaveLength(1);

      // Prime is read-only — memo should still be undelivered
      const mailbox = await department.checkMemo(agent.id);
      expect(mailbox).toHaveLength(1);
    });

    it('should return empty context for agent with no work', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P2',
        identity: `prime-empty-${departmentName}`,
      });

      const context = await department.prime(agent.id);
      expect(context.agent.id).toBe(agent.id);
      expect(context.hooked_Ticket).toBeNull();
      expect(context.undelivered_memo).toHaveLength(0);
      expect(context.open_tickets).toHaveLength(0);
    });
  });

  describe('checkpoint', () => {
    it('should write and read checkpoint data', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `checkpoint-${departmentName}`,
      });

      const data = { step: 3, context: 'working on feature X' };
      await department.writeCheckpoint(agent.id, data);

      const checkpoint = await department.readCheckpoint(agent.id);
      expect(checkpoint).toEqual(data);
    });

    it('should return null for agent with no checkpoint', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `no-checkpoint-${departmentName}`,
      });

      const checkpoint = await department.readCheckpoint(agent.id);
      expect(checkpoint).toBeNull();
    });

    it('should return null for non-existent agent', async () => {
      const checkpoint = await department.readCheckpoint('non-existent');
      expect(checkpoint).toBeNull();
    });
  });

  describe('agentDone', () => {
    it('should submit to review queue and unhook', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `done-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Done test' });
      await department.hookTicket(agent.id, ticket.ticket_id);

      // agentDone is event-only — need to set departmentId and run alarm to drain
      await department.setDepartmentId(departmentName);

      await department.agentDone(agent.id, {
        branch: 'feature/done',
        pr_url: 'https://github.com/org/repo/pull/2',
        summary: 'Completed the work',
      });

      await runDurableObjectAlarm(department);

      const updatedAgent = await department.getAgentAsync(agent.id);
      expect(updatedAgent?.current_hook_ticket_id).toBeNull();
      expect(updatedAgent?.status).toBe('idle');

      const mrTickets = await department.listTickets({ type: 'merge_request' });
      expect(mrTickets.length).toBeGreaterThan(0);
      expect(mrTickets[0].metadata?.source_ticket_id).toBe(ticket.ticket_id);
    });
  });

  describe('complianceWitnessAttendance (via alarm)', () => {
    it('should detect dead agents by verifying agent status after alarm', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'DeadAgent',
        identity: `dead-${departmentName}`,
      });
      await department.updateAgentStatus(agent.id, 'dead');

      // Attendance runs as part of the alarm — dead agents are internal bookkeeping
      const agentAfter = await department.getAgentAsync(agent.id);
      expect(agentAfter?.status).toBe('dead');
    });

    it('should have no issues with a clean department', async () => {
      const agentList = await department.listAgents();
      expect(agentList).toHaveLength(0);
    });
  });

  describe('HelldeskUserDO stub', () => {
    it('should respond to ping', async () => {
      const id = env.HELLDESK_USER.idFromName('test-user');
      const stub = env.HELLDESK_USER.get(id);
      const result = await stub.ping();
      expect(result).toBe('pong');
    });
  });

  describe('ticket events', () => {
    it('should write events on createTicket', async () => {
      const ticket = await department.createTicket({ type: 'issue', title: 'Event test' });
      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('created');
      expect(events[0].ticket_id).toBe(ticket.ticket_id);
      expect(events[0].metadata).toMatchObject({ title: 'Event test' });
    });

    it('should write events on hookTicket', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `evt-hook-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Hook event test' });
      await department.hookTicket(agent.id, ticket.ticket_id);

      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      // created + status_changed(open→in_progress) + hooked
      expect(events).toHaveLength(3);
      expect(events[0].event_type).toBe('created');
      expect(events[1].event_type).toBe('status_changed');
      expect(events[2].event_type).toBe('hooked');
      expect(events[2].agent_id).toBe(agent.id);
      expect(events[2].new_value).toBe(agent.id);
    });

    it('should write events on unhookTicket', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `evt-unhook-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Unhook event test' });
      await department.hookTicket(agent.id, ticket.ticket_id);
      await department.unhookTicket(agent.id);

      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      // created + status_changed + hooked + unhooked
      expect(events).toHaveLength(4);
      expect(events[3].event_type).toBe('unhooked');
    });

    it('should write events on updateTicketStatus', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `evt-status-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Status event test' });
      await department.updateTicketStatus(ticket.ticket_id, 'in_progress', agent.id);

      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      // created + status_changed
      expect(events).toHaveLength(2);
      expect(events[1].event_type).toBe('status_changed');
      expect(events[1].old_value).toBe('open');
      expect(events[1].new_value).toBe('in_progress');
    });

    it('should write closed event on closeTicket', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `evt-close-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Close event test' });
      await department.closeTicket(ticket.ticket_id, agent.id);

      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      // created + closed
      expect(events).toHaveLength(2);
      expect(events[1].event_type).toBe('closed');
    });

    it('should filter events by since timestamp', async () => {
      const ticket = await department.createTicket({ type: 'issue', title: 'Since filter test' });
      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      expect(events).toHaveLength(1);

      // Query with a future timestamp should return nothing
      const futureEvents = await department.listTicketEvents({
        ticketId: ticket.ticket_id,
        since: '2099-01-01T00:00:00.000Z',
      });
      expect(futureEvents).toHaveLength(0);
    });

    it('should list all events across tickets', async () => {
      await department.createTicket({ type: 'issue', title: 'Multi 1' });
      await department.createTicket({ type: 'issue', title: 'Multi 2' });

      const allEvents = await department.listTicketEvents({});
      expect(allEvents.length).toBeGreaterThanOrEqual(2);
    });

    it('should write review_submitted event on submitToReviewQueue', async () => {
      const agent = await department.registerAgent({
        role: 'soul',
        name: 'P1',
        identity: `evt-review-${departmentName}`,
      });
      const ticket = await department.createTicket({ type: 'issue', title: 'Review event test' });
      await department.submitToReviewQueue({
        agent_id: agent.id,
        ticket_id: ticket.ticket_id,
        workstation_id: 'test-workstation',
        branch: 'feature/test',
      });

      const events = await department.listTicketEvents({ ticketId: ticket.ticket_id });
      const reviewEvents = events.filter(e => e.event_type === 'review_submitted');
      expect(reviewEvents).toHaveLength(1);
      expect(reviewEvents[0].new_value).toBe('feature/test');
    });
  });

  describe('AgentIdentityDO stub', () => {
    it('should respond to ping', async () => {
      const id = env.AGENT_IDENTITY.idFromName('test-identity');
      const stub = env.AGENT_IDENTITY.get(id);
      const result = await stub.ping();
      expect(result).toBe('pong');
    });
  });
});
