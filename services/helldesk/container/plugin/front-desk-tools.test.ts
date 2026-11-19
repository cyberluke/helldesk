import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FrontDeskHelldeskClient } from './client';
import type {
  Agent,
  Ticket,
  Shift,
  ShiftDetail,
  ShiftStartResult,
  Workstation,
  SlingBatchResult,
  SlingResult,
} from './types';

// Mock the @kilocode/plugin module to avoid its broken ESM import chain.
import { z } from 'zod';

function toolFn(def: Record<string, unknown>) {
  return def;
}
toolFn.schema = z;

vi.mock('@kilocode/plugin', () => ({
  tool: toolFn,
}));

const { createFrontDeskTools } = await import('./front-desk-tools');

const FAKE_TICKET: Ticket = {
  ticket_id: 'ticket-1',
  type: 'issue',
  status: 'in_progress',
  title: 'Add auth middleware',
  body: null,
  workstation_id: 'workstation-1',
  parent_ticket_id: null,
  assignee_agent_ticket_id: 'agent-ticket-1',
  priority: 'medium',
  labels: [],
  metadata: {},
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  updated_at: '2026-03-05T00:00:00Z',
  closed_at: null,
};

const FAKE_AGENT: Agent = {
  id: 'agent-1',
  workstation_id: 'workstation-1',
  role: 'soul',
  name: 'Toast',
  identity: 'toast-workstation1',
  status: 'working',
  current_hook_ticket_id: 'ticket-1',
  dispatch_attempts: 0,
  last_activity_at: '2026-03-05T00:00:00Z',
  checkpoint: null,
  created_at: '2026-03-05T00:00:00Z',
};

const FAKE_SHIFT: Shift = {
  id: 'shift-1',
  title: 'JWT Authentication',
  status: 'active',
  staged: false,
  total_tickets: 3,
  closed_tickets: 1,
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  landed_at: null,
};

const FAKE_STAGED_SHIFT: Shift = {
  id: 'shift-staged-1',
  title: 'Big Refactor',
  status: 'active',
  staged: true,
  total_tickets: 2,
  closed_tickets: 0,
  created_by: null,
  created_at: '2026-03-05T00:00:00Z',
  landed_at: null,
};

function makeFakeFrontDeskClient(overrides: Partial<FrontDeskHelldeskClient> = {}): FrontDeskHelldeskClient {
  return {
    sling: vi.fn<() => Promise<SlingResult>>().mockResolvedValue({
      ticket: FAKE_TICKET,
      agent: FAKE_AGENT,
    }),
    listWorkstations: vi.fn<() => Promise<Workstation[]>>().mockResolvedValue([]),
    listTickets: vi.fn<() => Promise<Ticket[]>>().mockResolvedValue([]),
    listAgents: vi.fn<() => Promise<Agent[]>>().mockResolvedValue([]),
    sendMemo: vi.fn().mockResolvedValue(undefined),
    nudge: vi.fn<() => Promise<{ nudge_id: string }>>().mockResolvedValue({ nudge_id: 'nudge-1' }),
    slingBatch: vi.fn<() => Promise<SlingBatchResult>>().mockResolvedValue({
      shift: FAKE_SHIFT,
      tickets: [
        {
          ticket: { ...FAKE_TICKET, ticket_id: 'ticket-1', title: 'Task 1' },
          agent: { ...FAKE_AGENT, id: 'agent-1', name: 'Toast' },
        },
        {
          ticket: { ...FAKE_TICKET, ticket_id: 'ticket-2', title: 'Task 2' },
          agent: { ...FAKE_AGENT, id: 'agent-2', name: 'Muffin' },
        },
        {
          ticket: { ...FAKE_TICKET, ticket_id: 'ticket-3', title: 'Task 3' },
          agent: { ...FAKE_AGENT, id: 'agent-3', name: 'Bagel' },
        },
      ],
    }),
    listShifts: vi.fn<() => Promise<Shift[]>>().mockResolvedValue([FAKE_SHIFT]),
    startShift: vi.fn<() => Promise<ShiftStartResult>>().mockResolvedValue({
      shift: { ...FAKE_STAGED_SHIFT, status: 'active', staged: false },
      tickets: [
        {
          ticket: { ...FAKE_TICKET, ticket_id: 'ticket-1', title: 'Task 1' },
          agent: { ...FAKE_AGENT, id: 'agent-1', name: 'Toast' },
        },
        {
          ticket: { ...FAKE_TICKET, ticket_id: 'ticket-2', title: 'Task 2' },
          agent: { ...FAKE_AGENT, id: 'agent-2', name: 'Muffin' },
        },
      ],
    }),
    getShiftStatus: vi.fn<() => Promise<ShiftDetail>>().mockResolvedValue({
      ...FAKE_SHIFT,
      staged: false,
      tickets: [
        {
          ticket_id: 'ticket-1',
          title: 'Task 1',
          status: 'closed',
          workstation_id: 'workstation-1',
          assignee_agent_name: 'Toast',
        },
        {
          ticket_id: 'ticket-2',
          title: 'Task 2',
          status: 'in_progress',
          workstation_id: 'workstation-1',
          assignee_agent_name: 'Muffin',
        },
        {
          ticket_id: 'ticket-3',
          title: 'Task 3',
          status: 'open',
          workstation_id: 'workstation-1',
          assignee_agent_name: 'Bagel',
        },
      ],
    }),
    updateTicket: vi.fn<() => Promise<Ticket>>().mockResolvedValue(FAKE_TICKET),
    reassignTicket: vi.fn<() => Promise<Ticket>>().mockResolvedValue(FAKE_TICKET),
    deleteTicket: vi.fn().mockResolvedValue(undefined),
    resetAgent: vi.fn().mockResolvedValue(undefined),
    closeShift: vi.fn().mockResolvedValue(undefined),
    updateShift: vi.fn().mockResolvedValue(undefined),
    acknowledgeEscalation: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as FrontDeskHelldeskClient;
}

const CTX = undefined as never;

describe('frontDesk tools', () => {
  let client: ReturnType<typeof makeFakeFrontDeskClient>;
  let tools: ReturnType<typeof createFrontDeskTools>;

  beforeEach(() => {
    client = makeFakeFrontDeskClient();
    tools = createFrontDeskTools(client);
  });

  it('does not expose GitHub issue reporting', () => {
    expect(tools).not.toHaveProperty('gt_report_bug');
  });

  describe('gt_sling', () => {
    it('delegates a single task and returns result summary', async () => {
      const result = await tools.gt_sling.execute(
        { workstation_id: 'workstation-1', title: 'Fix bug', body: 'Details here' },
        CTX
      );
      expect(result).toContain('Task slung successfully');
      expect(result).toContain('ticket-1');
      expect(client.sling).toHaveBeenCalledWith({
        workstation_id: 'workstation-1',
        title: 'Fix bug',
        body: 'Details here',
        metadata: undefined,
      });
    });
  });

  describe('gt_sling_batch', () => {
    it('creates a shift with multiple tickets', async () => {
      const tasks = [
        { title: 'Task 1', body: 'Details 1' },
        { title: 'Task 2' },
        { title: 'Task 3', body: 'Details 3' },
      ];

      const result = await tools.gt_sling_batch.execute(
        { workstation_id: 'workstation-1', shift_title: 'JWT Authentication', tasks },
        CTX
      );

      expect(result).toContain('Shift created: "JWT Authentication"');
      expect(result).toContain('Tracking 3 tickets');
      expect(result).toContain('Task 1');
      expect(result).toContain('Task 2');
      expect(result).toContain('Task 3');
      expect(client.slingBatch).toHaveBeenCalledWith({
        workstation_id: 'workstation-1',
        shift_title: 'JWT Authentication',
        tasks: [
          { title: 'Task 1', body: 'Details 1' },
          { title: 'Task 2' },
          { title: 'Task 3', body: 'Details 3' },
        ],
      });
    });

    it('passes depends_on through to the client', async () => {
      const tasks = [
        { title: 'Scaffold' },
        { title: 'Add API', depends_on: [0] },
        { title: 'Add tests', depends_on: [0, 1] },
      ];

      await tools.gt_sling_batch.execute(
        { workstation_id: 'workstation-1', shift_title: 'With Dependencies', tasks },
        CTX
      );

      expect(client.slingBatch).toHaveBeenCalledWith({
        workstation_id: 'workstation-1',
        shift_title: 'With Dependencies',
        tasks: [
          { title: 'Scaffold' },
          { title: 'Add API', depends_on: [0] },
          { title: 'Add tests', depends_on: [0, 1] },
        ],
      });
    });
  });

  describe('gt_list_shifts', () => {
    it('returns shifts as JSON', async () => {
      const result = await tools.gt_list_shifts.execute({}, CTX);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('shift-1');
      expect(parsed[0].title).toBe('JWT Authentication');
      expect(client.listShifts).toHaveBeenCalledOnce();
    });

    it('returns a message when no active shifts', async () => {
      client = makeFakeFrontDeskClient({
        listShifts: vi.fn<() => Promise<Shift[]>>().mockResolvedValue([]),
      });
      tools = createFrontDeskTools(client);

      const result = await tools.gt_list_shifts.execute({}, CTX);
      expect(result).toContain('No active shifts');
    });
  });

  describe('gt_shift_status', () => {
    it('returns detailed shift status as JSON', async () => {
      const result = await tools.gt_shift_status.execute({ shift_id: 'shift-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.id).toBe('shift-1');
      expect(parsed.tickets).toHaveLength(3);
      expect(parsed.tickets[0].status).toBe('closed');
      expect(parsed.tickets[1].assignee_agent_name).toBe('Muffin');
      expect(client.getShiftStatus).toHaveBeenCalledWith('shift-1');
    });
  });

  describe('gt_list_workstations', () => {
    it('returns empty message when no workstations', async () => {
      const result = await tools.gt_list_workstations.execute({}, CTX);
      expect(result).toContain('No workstations configured');
    });
  });

  describe('gt_ticket_update', () => {
    it('updates ticket fields and returns summary', async () => {
      const result = await tools.gt_ticket_update.execute(
        { workstation_id: 'workstation-1', ticket_id: 'ticket-1', status: 'closed', priority: 'high' },
        CTX
      );
      expect(result).toContain('ticket-1');
      expect(result).toContain('updated');
      expect(client.updateTicket).toHaveBeenCalledWith('workstation-1', 'ticket-1', {
        title: undefined,
        body: undefined,
        status: 'closed',
        priority: 'high',
        labels: undefined,
      });
    });
  });

  describe('gt_ticket_reassign', () => {
    it('reassigns ticket to new agent', async () => {
      const result = await tools.gt_ticket_reassign.execute(
        { workstation_id: 'workstation-1', ticket_id: 'ticket-1', agent_id: 'agent-2' },
        CTX
      );
      expect(result).toContain('ticket-1');
      expect(result).toContain('agent-2');
      expect(client.reassignTicket).toHaveBeenCalledWith('workstation-1', 'ticket-1', 'agent-2');
    });
  });

  describe('gt_ticket_delete', () => {
    it('deletes ticket and confirms', async () => {
      const result = await tools.gt_ticket_delete.execute(
        { workstation_id: 'workstation-1', ticket_id: 'ticket-1' },
        CTX
      );
      expect(result).toContain('ticket-1');
      expect(result).toContain('deleted');
      expect(client.deleteTicket).toHaveBeenCalledWith('workstation-1', 'ticket-1');
    });
  });

  describe('gt_agent_reset', () => {
    it('resets agent to idle', async () => {
      const result = await tools.gt_agent_reset.execute(
        { workstation_id: 'workstation-1', agent_id: 'agent-1' },
        CTX
      );
      expect(result).toContain('agent-1');
      expect(result).toContain('idle');
      expect(client.resetAgent).toHaveBeenCalledWith('workstation-1', 'agent-1');
    });
  });

  describe('gt_shift_close', () => {
    it('force-closes a shift', async () => {
      const result = await tools.gt_shift_close.execute({ shift_id: 'shift-1' }, CTX);
      expect(result).toContain('shift-1');
      expect(result).toContain('closed');
      expect(client.closeShift).toHaveBeenCalledWith('shift-1');
    });
  });

  describe('gt_shift_update', () => {
    it('updates shift metadata', async () => {
      const result = await tools.gt_shift_update.execute(
        { shift_id: 'shift-1', merge_mode: 'review-and-merge' },
        CTX
      );
      expect(result).toContain('shift-1');
      expect(result).toContain('updated');
      expect(client.updateShift).toHaveBeenCalledWith('shift-1', {
        merge_mode: 'review-and-merge',
        feature_branch: undefined,
      });
    });
  });

  describe('gt_escalation_acknowledge', () => {
    it('acknowledges an escalation', async () => {
      const result = await tools.gt_escalation_acknowledge.execute({ escalation_id: 'esc-1' }, CTX);
      expect(result).toContain('esc-1');
      expect(result).toContain('acknowledged');
      expect(client.acknowledgeEscalation).toHaveBeenCalledWith('esc-1');
    });
  });

  describe('gt_sling_batch staged', () => {
    it('passes staged=true to client and reports shift as staged', async () => {
      client = makeFakeFrontDeskClient({
        slingBatch: vi.fn<() => Promise<SlingBatchResult>>().mockResolvedValue({
          shift: FAKE_STAGED_SHIFT,
          tickets: [
            {
              ticket: { ...FAKE_TICKET, ticket_id: 'ticket-1', title: 'Task 1' },
              agent: null,
            },
            {
              ticket: { ...FAKE_TICKET, ticket_id: 'ticket-2', title: 'Task 2' },
              agent: null,
            },
          ],
        }),
      });
      tools = createFrontDeskTools(client);

      const tasks = [{ title: 'Task 1' }, { title: 'Task 2', depends_on: [0] }];
      const result = await tools.gt_sling_batch.execute(
        { workstation_id: 'workstation-1', shift_title: 'Big Refactor', tasks, staged: true },
        CTX
      );

      expect(result).toContain('Shift staged:');
      expect(result).toContain('shift-staged-1');
      expect(result).toContain('gt_shift_start');
      expect(result).toContain('unassigned, pending gt_shift_start');
      expect(client.slingBatch).toHaveBeenCalledWith(expect.objectContaining({ staged: true }));
    });
  });

  describe('gt_shift_start', () => {
    it('starts a staged shift and reports ticket count', async () => {
      const result = await tools.gt_shift_start.execute({ shift_id: 'shift-staged-1' }, CTX);
      expect(result).toContain('Shift started');
      expect(result).toContain('2 ticket(s)');
      expect(client.startShift).toHaveBeenCalledWith('shift-staged-1');
    });
  });

  describe('gt_nudge', () => {
    it('sends a nudge and returns the nudge_id', async () => {
      const result = await tools.gt_nudge.execute(
        { workstation_id: 'workstation-1', target_agent_id: 'agent-1', message: 'Wake up!' },
        CTX
      );
      expect(result).toContain('nudge-1');
      expect(result).toContain('wait-idle');
      expect(client.nudge).toHaveBeenCalledWith({
        workstation_id: 'workstation-1',
        target_agent_id: 'agent-1',
        message: 'Wake up!',
        mode: 'wait-idle',
      });
    });

    it('passes explicit mode through to the client', async () => {
      await tools.gt_nudge.execute(
        { workstation_id: 'workstation-1', target_agent_id: 'agent-2', message: 'Urgent!', mode: 'immediate' },
        CTX
      );
      expect(client.nudge).toHaveBeenCalledWith({
        workstation_id: 'workstation-1',
        target_agent_id: 'agent-2',
        message: 'Urgent!',
        mode: 'immediate',
      });
    });
  });
});
