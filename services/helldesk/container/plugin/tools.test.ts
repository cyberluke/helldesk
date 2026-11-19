import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HelldeskClient } from './client';
import type { Ticket, Memo, PrimeContext } from './types';

// Mock the @kilocode/plugin module to avoid its broken ESM import chain.
// The real `tool` is a passthrough that attaches `tool.schema = z`.
import { z } from 'zod';

function toolFn(def: Record<string, unknown>) {
  return def;
}
toolFn.schema = z;

vi.mock('@kilocode/plugin', () => ({
  tool: toolFn,
}));

// Import after mock is registered
const { createTools } = await import('./tools');

function makeFakeClient(overrides: Partial<HelldeskClient> = {}): HelldeskClient {
  return {
    prime: vi.fn<() => Promise<PrimeContext>>().mockResolvedValue({
      agent: {
        id: 'agent-1',
        workstation_id: null,
        role: 'soul',
        name: 'Test Soul',
        identity: 'test-soul-1',
        status: 'working',
        current_hook_ticket_id: 'ticket-1',
        dispatch_attempts: 0,
        last_activity_at: '2026-02-16T00:00:00Z',
        checkpoint: null,
        created_at: '2026-02-16T00:00:00Z',
      },
      hooked_Ticket: {
        ticket_id: 'ticket-1',
        type: 'issue',
        status: 'in_progress',
        title: 'Fix the widget',
        body: null,
        workstation_id: null,
        parent_ticket_id: null,
        assignee_agent_ticket_id: 'agent-1',
        priority: 'medium',
        labels: [],
        metadata: {},
        created_by: null,
        created_at: '2026-02-16T00:00:00Z',
        updated_at: '2026-02-16T00:00:00Z',
        closed_at: null,
      },
      undelivered_memo: [],
      open_tickets: [],
    }),
    getTicket: vi.fn<(id: string) => Promise<Ticket>>().mockResolvedValue({
      ticket_id: 'ticket-1',
      type: 'issue',
      status: 'open',
      title: 'Test ticket',
      body: null,
      workstation_id: null,
      parent_ticket_id: null,
      assignee_agent_ticket_id: null,
      priority: 'medium',
      labels: [],
      metadata: {},
      created_by: null,
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: null,
    }),
    closeTicket: vi.fn<(id: string) => Promise<Ticket>>().mockResolvedValue({
      ticket_id: 'ticket-1',
      type: 'issue',
      status: 'closed',
      title: 'Test ticket',
      body: null,
      workstation_id: null,
      parent_ticket_id: null,
      assignee_agent_ticket_id: null,
      priority: 'medium',
      labels: [],
      metadata: {},
      created_by: null,
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: '2026-02-16T01:00:00Z',
    }),
    done: vi.fn().mockResolvedValue(undefined),
    sendMemo: vi.fn().mockResolvedValue(undefined),
    checkMemo: vi.fn<() => Promise<Memo[]>>().mockResolvedValue([]),
    createEscalation: vi.fn<() => Promise<Ticket>>().mockResolvedValue({
      ticket_id: 'esc-1',
      type: 'escalation',
      status: 'open',
      title: 'Blocked',
      body: null,
      workstation_id: null,
      parent_ticket_id: null,
      assignee_agent_ticket_id: null,
      priority: 'high',
      labels: [],
      metadata: {},
      created_by: null,
      created_at: '2026-02-16T00:00:00Z',
      updated_at: '2026-02-16T00:00:00Z',
      closed_at: null,
    }),
    writeCheckpoint: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as HelldeskClient;
}

// Tool context stub — tools that take no context-dependent args don't use it
const CTX = undefined as never;

describe('tools', () => {
  let client: ReturnType<typeof makeFakeClient>;
  let tools: ReturnType<typeof createTools>;

  beforeEach(() => {
    client = makeFakeClient();
    tools = createTools(client);
  });

  describe('gt_prime', () => {
    it('returns JSON-stringified prime context', async () => {
      const result = await tools.gt_prime.execute({}, CTX);
      expect(JSON.parse(result)).toHaveProperty('agent');
      expect(JSON.parse(result)).toHaveProperty('hooked_Ticket');
      expect(client.prime).toHaveBeenCalledOnce();
    });
  });

  describe('gt_ticket_status', () => {
    it('returns ticket details as JSON', async () => {
      const result = await tools.gt_ticket_status.execute({ ticket_id: 'ticket-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.ticket_id).toBe('ticket-1');
      expect(client.getTicket).toHaveBeenCalledWith('ticket-1');
    });
  });

  describe('gt_ticket_close', () => {
    it('closes the ticket and returns updated ticket', async () => {
      const result = await tools.gt_ticket_close.execute({ ticket_id: 'ticket-1' }, CTX);
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('closed');
      expect(client.closeTicket).toHaveBeenCalledWith('ticket-1');
    });
  });

  describe('gt_done', () => {
    it('sends done signal with branch and optional fields', async () => {
      const result = await tools.gt_done.execute(
        { branch: 'feat/test', pr_url: 'https://github.com/pr/1', summary: 'stuff' },
        CTX
      );
      expect(result).toContain('Done signal sent');
      expect(client.done).toHaveBeenCalledWith({
        branch: 'feat/test',
        pr_url: 'https://github.com/pr/1',
        summary: 'stuff',
      });
    });

    it('works with only required branch arg', async () => {
      await tools.gt_done.execute({ branch: 'fix/bug' }, CTX);
      expect(client.done).toHaveBeenCalledWith({
        branch: 'fix/bug',
        pr_url: undefined,
        summary: undefined,
      });
    });
  });

  describe('gt_memo_send', () => {
    it('sends memo and returns confirmation', async () => {
      const result = await tools.gt_memo_send.execute(
        { to_agent_id: 'agent-2', subject: 'hi', body: 'hello' },
        CTX
      );
      expect(result).toContain('Memo sent to agent agent-2');
      expect(client.sendMemo).toHaveBeenCalledWith({
        to_agent_id: 'agent-2',
        subject: 'hi',
        body: 'hello',
      });
    });
  });

  describe('gt_memo_check', () => {
    it('returns "No pending memo." when empty', async () => {
      const result = await tools.gt_memo_check.execute({}, CTX);
      expect(result).toBe('No pending memo.');
    });

    it('returns memo as JSON when present', async () => {
      const memo: Memo[] = [
        {
          id: 'memo-1',
          from_agent_id: 'agent-2',
          to_agent_id: 'agent-1',
          subject: 'update',
          body: 'progress report',
          delivered: false,
          created_at: '2026-02-16T00:00:00Z',
          delivered_at: null,
        },
      ];
      client = makeFakeClient({
        checkMemo: vi.fn<() => Promise<Memo[]>>().mockResolvedValue(memo),
      });
      tools = createTools(client);

      const result = await tools.gt_memo_check.execute({}, CTX);
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].subject).toBe('update');
    });
  });

  describe('gt_escalate', () => {
    it('creates escalation and returns confirmation', async () => {
      const result = await tools.gt_escalate.execute(
        { title: 'Blocked on auth', priority: 'high' },
        CTX
      );
      expect(result).toContain('Escalation created: esc-1');
      expect(result).toContain('priority: high');
    });

    it('passes metadata object through to createEscalation', async () => {
      await tools.gt_escalate.execute(
        { title: 'Test', metadata: { key: 'value', nested: 123 } },
        CTX
      );
      expect(client.createEscalation).toHaveBeenCalledWith({
        title: 'Test',
        body: undefined,
        priority: undefined,
        metadata: { key: 'value', nested: 123 },
      });
    });
  });

  describe('gt_checkpoint', () => {
    it('persists checkpoint data', async () => {
      const result = await tools.gt_checkpoint.execute(
        { data: '{"step": 3, "files": ["a.ts"]}' },
        CTX
      );
      expect(result).toBe('Checkpoint saved.');
      expect(client.writeCheckpoint).toHaveBeenCalledWith({ step: 3, files: ['a.ts'] });
    });

    it('throws on invalid JSON', async () => {
      await expect(tools.gt_checkpoint.execute({ data: '{broken' }, CTX)).rejects.toThrow(
        'Invalid JSON in "data"'
      );
    });
  });
});
