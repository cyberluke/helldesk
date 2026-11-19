import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { signAgentJWT } from '../../src/util/jwt.util';

const JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars-long';

/**
 * In the test environment ENVIRONMENT=development, so authMiddleware is skipped.
 * These helpers provide headers for requests that don't need auth in dev mode.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...extra,
  };
}

function agentHeaders(
  payload: { agentId: string; workstationId: string; departmentId?: string; userId?: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  const token = signAgentJWT(
    {
      agentId: payload.agentId,
      workstationId: payload.workstationId,
      departmentId: payload.departmentId ?? 'test-department',
      userId: payload.userId ?? 'test-user',
    },
    JWT_SECRET
  );
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function api(path: string): string {
  return `http://localhost${path}`;
}

describe('HTTP API', () => {
  const departmentId = 'test-department-http-api';
  const workstationId = () => `workstation-${crypto.randomUUID()}`;

  describe('dashboard', () => {
    it('should serve HTML at /', async () => {
      const res = await SELF.fetch(api('/'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('HELLDESK Dashboard');
    });
  });

  describe('health', () => {
    it('should return ok', async () => {
      const res = await SELF.fetch(api('/health'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('not found', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await SELF.fetch(api('/api/unknown'), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Not found');
    });
  });

  describe('tickets', () => {
    it('should create a ticket', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          type: 'issue',
          title: 'Fix the widget',
          body: 'It is broken',
          priority: 'high',
          labels: ['bug'],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.title).toBe('Fix the widget');
      expect(body.data.type).toBe('issue');
      expect(body.data.status).toBe('open');
      expect(body.data.priority).toBe('high');
    });

    it('should validate required fields', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
    });

    it('should list tickets', async () => {
      const id = workstationId();
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Ticket 1' }),
      });
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'message', title: 'Ticket 2' }),
      });

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(2);
    });

    it('should filter tickets by type', async () => {
      const id = workstationId();
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Issue' }),
      });
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'message', title: 'Message' }),
      });

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets?type=issue`), {
        headers: headers(),
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].type).toBe('issue');
    });

    it('should get a single ticket', async () => {
      const id = workstationId();
      const createRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Get me' }),
      });
      const created = await createRes.json();
      const ticketId = created.data.ticket_id;

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets/${ticketId}`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ticket_id).toBe(ticketId);
      expect(body.data.title).toBe('Get me');
    });

    it('should return 404 for non-existent ticket', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets/nonexistent`), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
    });

    it('should update ticket status', async () => {
      const id = workstationId();
      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Status test' }),
      });
      const ticket = (await ticketRes.json()).data;

      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `p1-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/tickets/${ticket.ticket_id}/status`),
        {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ status: 'in_progress', agent_id: agent.id }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('in_progress');
    });

    it('should close a ticket', async () => {
      const id = workstationId();
      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Close me' }),
      });
      const ticket = (await ticketRes.json()).data;

      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `close-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/tickets/${ticket.ticket_id}/close`),
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ agent_id: agent.id }),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe('closed');
      expect(body.data.closed_at).toBeDefined();
    });
  });

  describe('agents', () => {
    it('should register an agent', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'soul-1', identity: `p-${id}` }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.role).toBe('soul');
      expect(body.data.name).toBe('soul-1');
      expect(body.data.status).toBe('idle');
    });

    it('should list agents', async () => {
      const id = workstationId();
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `p1-${id}` }),
      });
      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'qualityAssurance', name: 'R1', identity: `r1-${id}` }),
      });

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        headers: headers(),
      });
      const body = await res.json();
      expect(body.data).toHaveLength(2);
    });

    it('should get agent by id', async () => {
      const id = workstationId();
      const createRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `get-${id}` }),
      });
      const agent = (await createRes.json()).data;

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(agent.id);
    });

    it('should return 404 for non-existent agent', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents/nonexistent`), {
        headers: headers(),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('hooks', () => {
    it('should hook and unhook a ticket', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `hook-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Hook target' }),
      });
      const ticket = (await ticketRes.json()).data;

      const hookRes = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/hook`),
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ ticket_id: ticket.ticket_id }),
        }
      );
      expect(hookRes.status).toBe(200);
      const hookBody = await hookRes.json();
      expect(hookBody.data.hooked).toBe(true);

      const agentCheck = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}`),
        {
          headers: headers(),
        }
      );
      const agentState = (await agentCheck.json()).data;
      expect(agentState.status).toBe('idle');
      expect(agentState.current_hook_ticket_id).toBe(ticket.ticket_id);

      const unhookRes = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/hook`),
        {
          method: 'DELETE',
          headers: headers(),
        }
      );
      expect(unhookRes.status).toBe(200);
    });

    it('should hook via agent JWT auth', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `jwt-hook-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'JWT hook target' }),
      });
      const ticket = (await ticketRes.json()).data;

      const jwtHeaders = agentHeaders({ agentId: agent.id, workstationId: id });
      const hookRes = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/hook`),
        {
          method: 'POST',
          headers: jwtHeaders,
          body: JSON.stringify({ ticket_id: ticket.ticket_id }),
        }
      );
      expect(hookRes.status).toBe(200);
    });
  });

  describe('prime', () => {
    it('should return prime context', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `prime-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const res = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/prime`),
        {
          headers: headers(),
        }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.agent.id).toBe(agent.id);
      expect(body.data.hooked_Ticket).toBeNull();
      expect(body.data.undelivered_memo).toHaveLength(0);
      expect(body.data.open_tickets).toHaveLength(0);
    });
  });

  describe('agent done', () => {
    it('should mark agent done and submit to review queue', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `done-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Done test' }),
      });
      const ticket = (await ticketRes.json()).data;

      await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/hook`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ticket_id: ticket.ticket_id }),
      });

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/done`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          branch: 'feature/done',
          pr_url: 'https://github.com/org/repo/pull/1',
          summary: 'All done',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.done).toBe(true);

      const agentCheck = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}`),
        {
          headers: headers(),
        }
      );
      const agentState = (await agentCheck.json()).data;
      expect(agentState.status).toBe('idle');
      expect(agentState.current_hook_ticket_id).toBeNull();
    });
  });

  describe('checkpoint', () => {
    it('should write and read checkpoint', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `cp-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const writeRes = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}/checkpoint`),
        {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ data: { step: 5, notes: 'halfway' } }),
        }
      );
      expect(writeRes.status).toBe(200);

      const agentCheck = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${agent.id}`),
        {
          headers: headers(),
        }
      );
      const agentState = (await agentCheck.json()).data;
      expect(agentState.checkpoint).toEqual({ step: 5, notes: 'halfway' });
    });
  });

  describe('memo', () => {
    it('should send and check memo', async () => {
      const id = workstationId();
      const senderRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'Sender', identity: `sender-${id}` }),
      });
      const sender = (await senderRes.json()).data;

      const receiverRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'Receiver', identity: `receiver-${id}` }),
      });
      const receiver = (await receiverRes.json()).data;

      const sendRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/memo`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          from_agent_id: sender.id,
          to_agent_id: receiver.id,
          subject: 'Hello',
          body: 'How are you?',
        }),
      });
      expect(sendRes.status).toBe(201);

      const memoRes = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${receiver.id}/memo`),
        {
          headers: headers(),
        }
      );
      expect(memoRes.status).toBe(200);
      const memoBody = await memoRes.json();
      expect(memoBody.data).toHaveLength(1);
      expect(memoBody.data[0].subject).toBe('Hello');

      const memoRes2 = await SELF.fetch(
        api(`/api/departments/${departmentId}/workstations/${id}/agents/${receiver.id}/memo`),
        {
          headers: headers(),
        }
      );
      const memoBody2 = await memoRes2.json();
      expect(memoBody2.data).toHaveLength(0);
    });
  });

  describe('review queue', () => {
    it('should submit to review queue', async () => {
      const id = workstationId();
      const agentRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/agents`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ role: 'soul', name: 'P1', identity: `rq-${id}` }),
      });
      const agent = (await agentRes.json()).data;

      const ticketRes = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type: 'issue', title: 'Review me' }),
      });
      const ticket = (await ticketRes.json()).data;

      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/review-queue`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          agent_id: agent.id,
          ticket_id: ticket.ticket_id,
          branch: 'feature/review',
          pr_url: 'https://github.com/org/repo/pull/3',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.submitted).toBe(true);
    });
  });

  describe('escalations', () => {
    it('should create an escalation ticket', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/escalations`), {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          title: 'Critical failure',
          body: 'Something went very wrong',
          priority: 'critical',
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.type).toBe('escalation');
      expect(body.data.title).toBe('Critical failure');
      expect(body.data.priority).toBe('critical');
    });
  });

  // These tests use agent JWTs to verify identity enforcement still works
  // even though authMiddleware is skipped in dev mode — the agentOnlyMiddleware
  // is separate and still applies to agent-scoped routes when a JWT is present.

  describe('query param validation', () => {
    it('should reject non-numeric limit', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets?limit=abc`), {
        headers: headers(),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('non-negative integers');
    });

    it('should reject negative offset', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets?offset=-1`), {
        headers: headers(),
      });
      expect(res.status).toBe(400);
    });

    it('should accept valid limit and offset', async () => {
      const id = workstationId();
      const res = await SELF.fetch(api(`/api/departments/${departmentId}/workstations/${id}/tickets?limit=10&offset=0`), {
        headers: headers(),
      });
      expect(res.status).toBe(200);
    });
  });
});
