import 'server-only';
import {
  HELLDESK_SERVICE_URL,
  HELLDESK_CF_ACCESS_CLIENT_ID,
  HELLDESK_CF_ACCESS_CLIENT_SECRET,
} from '@/lib/config.server';
import { z } from 'zod';

// ── Response schemas ──────────────────────────────────────────────────────

const HelldeskErrorResponse = z.object({
  success: z.literal(false),
  error: z.string(),
});

// ── Domain schemas ────────────────────────────────────────────────────────
// Mirror the helldesk worker's record schemas for validation at the IO boundary.

function parseJsonOrIssue(v: string, ctx: z.RefinementCtx, label: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} is not valid JSON`,
    });
    return z.NEVER;
  }
}

export const DepartmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Department = z.output<typeof DepartmentSchema>;

export const WorkstationSchema = z.object({
  id: z.string(),
  department_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Workstation = z.output<typeof WorkstationSchema>;

export const TicketSchema = z.object({
  ticket_id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent']),
  status: z.enum(['open', 'in_progress', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  assignee_agent_ticket_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.union([
    z.array(z.string()),
    z
      .string()
      .transform((v, ctx) => parseJsonOrIssue(v, ctx, 'labels'))
      .pipe(z.array(z.string())),
  ]),
  metadata: z.union([
    z.record(z.string(), z.unknown()),
    z
      .string()
      .transform((v, ctx) => parseJsonOrIssue(v, ctx, 'metadata'))
      .pipe(z.record(z.string(), z.unknown())),
  ]),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});
export type Ticket = z.output<typeof TicketSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  workstation_id: z.string().nullable(),
  role: z.enum(['soul', 'qualityAssurance', 'frontDesk', 'complianceWitness']),
  name: z.string(),
  identity: z.string(),
  status: z.enum(['idle', 'working', 'stalled', 'dead']),
  current_hook_ticket_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  last_activity_at: z.string().nullable(),
  checkpoint: z.unknown().optional(),
  created_at: z.string(),
});
export type Agent = z.output<typeof AgentSchema>;

export const StreamTicketSchema = z.object({
  url: z.string(),
  ticket: z.string().optional(),
});
export type StreamTicket = z.output<typeof StreamTicketSchema>;

// ── Client ────────────────────────────────────────────────────────────────

export class HelldeskApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'HelldeskApiError';
  }
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (HELLDESK_CF_ACCESS_CLIENT_ID && HELLDESK_CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = HELLDESK_CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = HELLDESK_CF_ACCESS_CLIENT_SECRET;
  }

  return headers;
}

const CLIENT_LOG = '[helldesk-client]';

async function helldeskFetch(path: string, init?: RequestInit): Promise<unknown> {
  if (!HELLDESK_SERVICE_URL) {
    console.error(`${CLIENT_LOG} HELLDESK_SERVICE_URL is not configured!`);
    throw new HelldeskApiError('HELLDESK_SERVICE_URL is not configured', 500);
  }

  const url = `${HELLDESK_SERVICE_URL}${path}`;
  const method = init?.method ?? 'GET';
  console.log(`${CLIENT_LOG} ${method} ${url}`);
  if (init?.body && typeof init.body === 'string') {
    try {
      const bodyKeys = Object.keys(JSON.parse(init.body));
      console.log(`${CLIENT_LOG} ${method} ${path} bodyKeys=[${bodyKeys.join(',')}]`);
    } catch {
      // not JSON
    }
  }
  if (init?.body) {
    const safeBody =
      typeof init.body === 'string'
        ? init.body
            .replace(/"kilocode_token":"[^"]*"/g, '"kilocode_token":"[REDACTED]"')
            .slice(0, 500)
        : '[non-string body]';
    console.log(`${CLIENT_LOG}   body: ${safeBody}`);
  }

  const startTime = Date.now();
  const response = await fetch(url, {
    ...init,
    headers: {
      ...getHeaders(),
      ...init?.headers,
    },
  });
  const elapsed = Date.now() - startTime;

  console.log(`${CLIENT_LOG} ${method} ${path} -> ${response.status} (${elapsed}ms)`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    console.error(`${CLIENT_LOG} Non-JSON response from ${path}: status=${response.status}`);
    throw new HelldeskApiError(
      `HELLDESK returned non-JSON response (${response.status})`,
      response.status
    );
  }

  if (!response.ok) {
    const parsed = HelldeskErrorResponse.safeParse(body);
    const message = parsed.success ? parsed.data.error : `HELLDESK API error (${response.status})`;
    console.error(`${CLIENT_LOG} Error from ${path}: ${response.status} - ${message}`);
    console.error(`${CLIENT_LOG}   Response body: ${JSON.stringify(body).slice(0, 500)}`);
    throw new HelldeskApiError(message, response.status);
  }

  console.log(`${CLIENT_LOG} ${method} ${path} response: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function parseSuccessData<T>(body: unknown, schema: z.ZodType<T>): T {
  const envelope = z.object({ success: z.literal(true), data: schema }).parse(body);
  return envelope.data;
}

// ── Department operations ───────────────────────────────────────────────────────

export async function createDepartment(userId: string, name: string): Promise<Department> {
  const body = await helldeskFetch(`/api/users/${userId}/departments`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return parseSuccessData(body, DepartmentSchema);
}

export async function listDepartments(userId: string): Promise<Department[]> {
  const body = await helldeskFetch(`/api/users/${userId}/departments`);
  return parseSuccessData(body, DepartmentSchema.array());
}

export async function getDepartment(userId: string, departmentId: string): Promise<Department> {
  const body = await helldeskFetch(`/api/users/${userId}/departments/${departmentId}`);
  return parseSuccessData(body, DepartmentSchema);
}

// ── Workstation operations ────────────────────────────────────────────────────────

export async function createWorkstation(
  userId: string,
  input: {
    department_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    kilocode_token?: string;
    platform_integration_id?: string;
  }
): Promise<Workstation> {
  const body = await helldeskFetch(`/api/users/${userId}/workstations`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, WorkstationSchema);
}

export async function getWorkstation(userId: string, workstationId: string): Promise<Workstation> {
  const body = await helldeskFetch(`/api/users/${userId}/workstations/${workstationId}`);
  return parseSuccessData(body, WorkstationSchema);
}

export async function listWorkstations(userId: string, departmentId: string): Promise<Workstation[]> {
  const body = await helldeskFetch(`/api/users/${userId}/departments/${departmentId}/workstations`);
  return parseSuccessData(body, WorkstationSchema.array());
}

// ── Ticket operations (via Workstation DO) ──────────────────────────────────────────

export async function createTicket(
  departmentId: string,
  workstationId: string,
  input: {
    type: string;
    title: string;
    body?: string;
    priority?: string;
    labels?: string[];
    metadata?: Record<string, unknown>;
    assignee_agent_id?: string;
  }
): Promise<Ticket> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/tickets`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, TicketSchema);
}

const SlingResultSchema = z.object({
  ticket: TicketSchema,
  agent: AgentSchema,
});
export type SlingResult = z.output<typeof SlingResultSchema>;

export async function slingTicket(
  departmentId: string,
  workstationId: string,
  input: { title: string; body?: string; metadata?: Record<string, unknown> }
): Promise<SlingResult> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/sling`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, SlingResultSchema);
}

export async function listTickets(
  departmentId: string,
  workstationId: string,
  filter?: { status?: string }
): Promise<Ticket[]> {
  const params = new URLSearchParams();
  if (filter?.status) params.set('status', filter.status);
  const qs = params.toString();
  const path = `/api/departments/${departmentId}/workstations/${workstationId}/tickets${qs ? `?${qs}` : ''}`;
  const body = await helldeskFetch(path);
  return parseSuccessData(body, TicketSchema.array());
}

// ── Agent operations (via Workstation DO) ─────────────────────────────────────────

export async function registerAgent(
  departmentId: string,
  workstationId: string,
  input: { role: string; name: string; identity: string }
): Promise<Agent> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return parseSuccessData(body, AgentSchema);
}

export async function listAgents(departmentId: string, workstationId: string): Promise<Agent[]> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents`);
  return parseSuccessData(body, AgentSchema.array());
}

export async function getOrCreateAgent(
  departmentId: string,
  workstationId: string,
  role: string
): Promise<Agent> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents/get-or-create`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
  return parseSuccessData(body, AgentSchema);
}

export async function hookTicket(
  departmentId: string,
  workstationId: string,
  agentId: string,
  ticketId: string
): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents/${agentId}/hook`, {
    method: 'POST',
    body: JSON.stringify({ ticket_id: ticketId }),
  });
}

// ── Delete operations ──────────────────────────────────────────────────────

export async function deleteDepartment(userId: string, departmentId: string): Promise<void> {
  await helldeskFetch(`/api/users/${userId}/departments/${departmentId}`, { method: 'DELETE' });
}

export async function deleteWorkstation(userId: string, workstationId: string): Promise<void> {
  await helldeskFetch(`/api/users/${userId}/workstations/${workstationId}`, { method: 'DELETE' });
}

export async function deleteTicket(departmentId: string, workstationId: string, ticketId: string): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/tickets/${ticketId}`, { method: 'DELETE' });
}

export async function deleteAgent(departmentId: string, workstationId: string, agentId: string): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents/${agentId}`, { method: 'DELETE' });
}

// ── Event operations ──────────────────────────────────────────────────────

export const TicketEventSchema = z.object({
  ticket_event_id: z.string(),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.union([
    z.record(z.string(), z.unknown()),
    z
      .string()
      .transform((v, ctx) => parseJsonOrIssue(v, ctx, 'event metadata'))
      .pipe(z.record(z.string(), z.unknown())),
  ]),
  created_at: z.string(),
});
export type TicketEvent = z.output<typeof TicketEventSchema>;

export const TaggedTicketEventSchema = TicketEventSchema.extend({
  workstation_id: z.string().optional(),
  workstation_name: z.string().optional(),
});
export type TaggedTicketEvent = z.output<typeof TaggedTicketEventSchema>;

export async function listTicketEvents(
  departmentId: string,
  workstationId: string,
  options?: { ticketId?: string; since?: string; limit?: number }
): Promise<TicketEvent[]> {
  const params = new URLSearchParams();
  if (options?.ticketId) params.set('ticket_id', options.ticketId);
  if (options?.since) params.set('since', options.since);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/api/departments/${departmentId}/workstations/${workstationId}/events${qs ? `?${qs}` : ''}`;
  const body = await helldeskFetch(path);
  return parseSuccessData(body, TicketEventSchema.array());
}

export async function listDepartmentEvents(
  userId: string,
  departmentId: string,
  options?: { since?: string; limit?: number }
): Promise<TaggedTicketEvent[]> {
  const params = new URLSearchParams();
  if (options?.since) params.set('since', options.since);
  if (options?.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/api/users/${userId}/departments/${departmentId}/events${qs ? `?${qs}` : ''}`;
  const body = await helldeskFetch(path);
  return parseSuccessData(body, TaggedTicketEventSchema.array());
}

// ── Department Configuration ────────────────────────────────────────────────────

export const DepartmentConfigSchema = z.object({
  env_vars: z.record(z.string(), z.string()),
  git_auth: z.object({
    github_token: z.string().optional(),
    gitlab_token: z.string().optional(),
    gitlab_instance_url: z.string().optional(),
    platform_integration_id: z.string().optional(),
  }),
  kilocode_token: z.string().optional(),
  owner_user_id: z.string().optional(),
  default_model: z.string().optional(),
  max_polecats_per_workstation: z.number().optional(),
  qualityAssurance: z
    .object({
      gates: z.array(z.string()),
      auto_merge: z.boolean(),
      require_clean_merge: z.boolean(),
    })
    .optional(),
  alarm_interval_active: z.number().optional(),
  alarm_interval_idle: z.number().optional(),
  container: z
    .object({
      sleep_after_minutes: z.number().optional(),
    })
    .optional(),
});
export type DepartmentConfigClient = z.output<typeof DepartmentConfigSchema>;

export async function getDepartmentConfig(departmentId: string): Promise<DepartmentConfigClient> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/config`);
  return parseSuccessData(body, DepartmentConfigSchema);
}

export async function updateDepartmentConfig(
  departmentId: string,
  update: Partial<DepartmentConfigClient>
): Promise<DepartmentConfigClient> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/config`, {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
  return parseSuccessData(body, DepartmentConfigSchema);
}

// ── Container operations (via Department Container DO) ──────────────────────────

export async function getStreamTicket(departmentId: string, agentId: string): Promise<StreamTicket> {
  const body = await helldeskFetch(
    `/api/departments/${departmentId}/container/agents/${agentId}/stream-ticket`,
    { method: 'POST' }
  );
  return parseSuccessData(body, StreamTicketSchema);
}

// ── PTY operations (via Department Container DO) ────────────────────────────────

const PtySessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  status: z.enum(['running', 'exited']),
  pid: z.number(),
});
export type PtySession = z.output<typeof PtySessionSchema>;

export async function createPtySession(departmentId: string, agentId: string): Promise<PtySession> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/container/agents/${agentId}/pty`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return PtySessionSchema.parse(body);
}

export async function resizePtySession(
  departmentId: string,
  agentId: string,
  ptyId: string,
  cols: number,
  rows: number
): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/container/agents/${agentId}/pty/${ptyId}`, {
    method: 'PUT',
    body: JSON.stringify({ size: { cols, rows } }),
  });
}

// ── FrontDesk operations (via FrontDeskDO) ────────────────────────────────────────

const FrontDeskSendResultSchema = z.object({
  agentId: z.string(),
  sessionStatus: z.enum(['idle', 'active', 'starting']),
});
export type FrontDeskSendResult = z.output<typeof FrontDeskSendResultSchema>;

const FrontDeskStatusSchema = z.object({
  configured: z.boolean(),
  session: z
    .object({
      agentId: z.string(),
      sessionId: z.string(),
      status: z.enum(['idle', 'active', 'starting']),
      lastActivityAt: z.string(),
    })
    .nullable(),
  departmentId: z.string().nullable(),
});
export type FrontDeskStatus = z.output<typeof FrontDeskStatusSchema>;

export async function configureFrontDesk(
  departmentId: string,
  config: {
    userId: string;
    kilocodeToken?: string;
    gitUrl: string;
    defaultBranch: string;
  }
): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/frontDesk/configure`, {
    method: 'POST',
    body: JSON.stringify({ ...config, departmentId }),
  });
}

export async function sendFrontDeskMessage(
  departmentId: string,
  message: string,
  model?: string
): Promise<FrontDeskSendResult> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/frontDesk/message`, {
    method: 'POST',
    body: JSON.stringify({ message, model }),
  });
  return parseSuccessData(body, FrontDeskSendResultSchema);
}

export async function getFrontDeskStatus(departmentId: string): Promise<FrontDeskStatus> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/frontDesk/status`);
  return parseSuccessData(body, FrontDeskStatusSchema);
}

/** Eagerly ensure the frontDesk agent + container are running. */
export async function ensureFrontDesk(departmentId: string): Promise<FrontDeskSendResult> {
  const body = await helldeskFetch(`/api/departments/${departmentId}/frontDesk/ensure`, { method: 'POST' });
  return parseSuccessData(body, FrontDeskSendResultSchema);
}

export async function destroyFrontDesk(departmentId: string): Promise<void> {
  await helldeskFetch(`/api/departments/${departmentId}/frontDesk/destroy`, { method: 'POST' });
}
