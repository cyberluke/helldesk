import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HelldeskClient, FrontDeskHelldeskClient, HelldeskApiError, createClientFromEnv } from './client';
import type { HelldeskEnv, FrontDeskHelldeskEnv } from './types';

const TEST_ENV: HelldeskEnv = {
  apiUrl: 'https://helldesk.example.com',
  sessionToken: 'test-jwt-token',
  agentId: 'agent-111',
  workstationId: 'workstation-222',
  departmentId: 'department-333',
};

function mockFetch(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => ({ success: true, data }),
  });
}

function mockFetchError(error: string, status = 400) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => ({ success: false, error }),
  });
}

describe('HelldeskClient', () => {
  let client: HelldeskClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new HelldeskClient(TEST_ENV);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends Authorization header with JWT token', async () => {
    const fetchMock = mockFetch({
      agent: {},
      hooked_Ticket: null,
      undelivered_memo: [],
      open_tickets: [],
    });
    globalThis.fetch = fetchMock;

    await client.prime();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/agents/agent-111/prime'
    );
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('prime() calls the correct endpoint', async () => {
    const primeData = {
      agent: {
        id: 'agent-111',
        role: 'soul',
        name: 'test',
        identity: 'test-id',
        status: 'idle',
      },
      hooked_Ticket: null,
      undelivered_memo: [],
      open_tickets: [],
    };
    globalThis.fetch = mockFetch(primeData);

    const result = await client.prime();
    expect(result).toEqual(primeData);
  });

  it('getTicket() calls the correct endpoint', async () => {
    const ticket = { id: 'ticket-1', type: 'issue', status: 'open', title: 'Test' };
    globalThis.fetch = mockFetch(ticket);

    const result = await client.getTicket('ticket-1');
    expect(result).toEqual(ticket);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/tickets/ticket-1');
  });

  it('closeTicket() sends agent_id in body', async () => {
    const ticket = { id: 'ticket-1', status: 'closed' };
    globalThis.fetch = mockFetch(ticket);

    await client.closeTicket('ticket-1');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/tickets/ticket-1/close'
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ agent_id: 'agent-111' });
  });

  it('done() posts to the agent done endpoint', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.done({
      branch: 'feat/test',
      pr_url: 'https://github.com/pr/1',
      summary: 'did stuff',
    });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/agents/agent-111/done'
    );
    expect(JSON.parse(init.body as string)).toEqual({
      branch: 'feat/test',
      pr_url: 'https://github.com/pr/1',
      summary: 'did stuff',
    });
  });

  it('sendMemo() includes from_agent_id automatically', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.sendMemo({ to_agent_id: 'agent-222', subject: 'hi', body: 'hello' });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      from_agent_id: 'agent-111',
      to_agent_id: 'agent-222',
      subject: 'hi',
      body: 'hello',
    });
  });

  it('checkMemo() calls the correct endpoint', async () => {
    const memo = [{ id: 'memo-1', subject: 'test' }];
    globalThis.fetch = mockFetch(memo);

    const result = await client.checkMemo();
    expect(result).toEqual(memo);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/agents/agent-111/memo'
    );
  });

  it('writeCheckpoint() posts data to checkpoint endpoint', async () => {
    globalThis.fetch = mockFetch(undefined);

    await client.writeCheckpoint({ step: 3, files: ['a.ts'] });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/agents/agent-111/checkpoint'
    );
    expect(JSON.parse(init.body as string)).toEqual({ data: { step: 3, files: ['a.ts'] } });
  });

  it('createEscalation() posts to escalations endpoint', async () => {
    const ticket = { id: 'esc-1', type: 'escalation', priority: 'high' };
    globalThis.fetch = mockFetch(ticket);

    const result = await client.createEscalation({ title: 'blocked', priority: 'high' });
    expect(result).toEqual(ticket);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/escalations');
    expect(JSON.parse(init.body as string)).toEqual({ title: 'blocked', priority: 'high' });
  });

  it('throws HelldeskApiError on failure response', async () => {
    globalThis.fetch = mockFetchError('Not found', 404);

    await expect(client.getTicket('nonexistent')).rejects.toThrow(HelldeskApiError);
    await expect(client.getTicket('nonexistent')).rejects.toThrow(
      'HELLDESK API error (404): Not found'
    );
  });

  it('throws HelldeskApiError on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(client.getTicket('ticket-1')).rejects.toThrow(HelldeskApiError);
    await expect(client.getTicket('ticket-1')).rejects.toThrow('Network error: fetch failed');
  });

  it('throws HelldeskApiError on non-JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await expect(client.getTicket('ticket-1')).rejects.toThrow(HelldeskApiError);
    await expect(client.getTicket('ticket-1')).rejects.toThrow('Invalid JSON response (HTTP 502)');
  });

  it('throws HelldeskApiError on unexpected response shape', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ unexpected: true }),
    });

    await expect(client.getTicket('ticket-1')).rejects.toThrow(HelldeskApiError);
    await expect(client.getTicket('ticket-1')).rejects.toThrow('Unexpected response shape');
  });

  it('handles 204 No Content as success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 204 });

    // done() returns void, so 204 should not throw
    await expect(client.done({ branch: 'feat/test' })).resolves.toBeUndefined();
  });

  it('normalizes Headers instances from callers', async () => {
    const fetchMock = mockFetch(undefined);
    globalThis.fetch = fetchMock;

    // Internally request() receives init?.headers — verify it doesn't drop them
    // by calling a method and checking the auth header is still set
    await client.done({ branch: 'test' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer test-jwt-token');
  });

  it('strips trailing slashes from baseUrl', () => {
    const c = new HelldeskClient({ ...TEST_ENV, apiUrl: 'https://helldesk.example.com///' });
    globalThis.fetch = mockFetch({
      agent: {},
      hooked_Ticket: null,
      undelivered_memo: [],
      open_tickets: [],
    });

    // Verify no double slashes in the URL by calling prime
    void c.prime();
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(
      'https://helldesk.example.com/api/departments/department-333/workstations/workstation-222/agents/agent-111/prime'
    );
  });
});

describe('createClientFromEnv', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('creates a client when all env vars are set', () => {
    process.env.HELLDESK_API_URL = 'https://helldesk.example.com';
    process.env.HELLDESK_SESSION_TOKEN = 'tok';
    process.env.HELLDESK_AGENT_ID = 'agent-1';
    process.env.HELLDESK_WORKSTATION_ID = 'workstation-1';
    process.env.HELLDESK_DEPARTMENT_ID = 'department-1';

    const client = createClientFromEnv();
    expect(client).toBeInstanceOf(HelldeskClient);
  });

  it('throws when env vars are missing', () => {
    delete process.env.HELLDESK_API_URL;
    delete process.env.HELLDESK_SESSION_TOKEN;
    delete process.env.HELLDESK_AGENT_ID;
    delete process.env.HELLDESK_WORKSTATION_ID;

    expect(() => createClientFromEnv()).toThrow('Missing required HELLDESK environment variables');
  });

  it('lists all missing vars in the error message', () => {
    delete process.env.HELLDESK_API_URL;
    process.env.HELLDESK_SESSION_TOKEN = 'tok';
    delete process.env.HELLDESK_AGENT_ID;
    process.env.HELLDESK_WORKSTATION_ID = 'workstation-1';

    expect(() => createClientFromEnv()).toThrow('HELLDESK_API_URL, HELLDESK_AGENT_ID');
  });
});

// ── FrontDeskHelldeskClient tests ─────────────────────────────────────────────

const FRONT_DESK_ENV: FrontDeskHelldeskEnv = {
  apiUrl: 'https://helldesk.example.com',
  sessionToken: 'front-desk-jwt-token',
  agentId: 'front-desk-agent-1',
  departmentId: 'department-1',
};

describe('FrontDeskHelldeskClient', () => {
  let client: FrontDeskHelldeskClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new FrontDeskHelldeskClient(FRONT_DESK_ENV);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('slingBatch() posts to sling-batch endpoint', async () => {
    const responseData = {
      shift: { id: 'shift-1', title: 'Test Shift', status: 'active', total_tickets: 2 },
      tickets: [],
    };
    const fetchMock = mockFetch(responseData);
    globalThis.fetch = fetchMock;

    const result = await client.slingBatch({
      workstation_id: 'workstation-1',
      shift_title: 'Test Shift',
      tasks: [{ title: 'Task 1' }, { title: 'Task 2', body: 'Details' }],
    });

    expect(result).toEqual(responseData);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://helldesk.example.com/api/frontDesk/department-1/tools/sling-batch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      workstation_id: 'workstation-1',
      shift_title: 'Test Shift',
      tasks: [{ title: 'Task 1' }, { title: 'Task 2', body: 'Details' }],
    });
  });

  it('listShifts() fetches shift list', async () => {
    const shifts = [{ id: 'shift-1', title: 'Test', status: 'active' }];
    globalThis.fetch = mockFetch(shifts);

    const result = await client.listShifts();
    expect(result).toEqual(shifts);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://helldesk.example.com/api/frontDesk/department-1/tools/shifts');
  });

  it('getShiftStatus() fetches detailed shift', async () => {
    const detail = {
      id: 'shift-1',
      title: 'Test',
      tickets: [{ ticket_id: 'b1', title: 'T1', status: 'open', assignee_agent_name: null }],
    };
    globalThis.fetch = mockFetch(detail);

    const result = await client.getShiftStatus('shift-1');
    expect(result).toEqual(detail);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://helldesk.example.com/api/frontDesk/department-1/tools/shifts/shift-1');
  });
});
