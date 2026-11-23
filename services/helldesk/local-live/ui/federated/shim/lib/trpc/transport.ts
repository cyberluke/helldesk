/**
 * @/lib/trpc/transport.ts — federated transport
 *
 * Reusable block: the local transport for the federated HELLDESK UI.
 *
 * This is the single boundary between the (verbatim) original HELLDESK client
 * components and the local runtime surface. It reintroduces the exact zod
 * schemas the original `helldesk-client.ts` used (faithful 1:1 data contract),
 * but points `helldeskFetch` at the local-live `/api/*` REST routes served by
 * the Bun runtime (:8790) — the same routes the original cloudflare backend
 * exposed — and, for the richer frontDesk/stream/pty surfaces, the NAI-Lattice
 * engine JSON-RPC via the local-live dashboard proxy.
 *
 * No Cloudflare, no CF-Access, no server-only import: native localhost.
 */
import { z } from 'zod';
import { ObservabilitySnapshotSchema, type ObservabilitySnapshot } from './observability';
import {
  CommitDetailSchema,
  CommitFileDiffSchema,
  CommitListSchema,
  CommitProvenanceSchema,
  CommitWorkspaceSchema,
  type CommitDetail,
  type CommitFileDiff,
  type CommitList,
  type CommitProvenance,
  type CommitWorkspace,
} from './commits';

function parseJsonOrIssue(v: string, ctx: z.RefinementCtx, label: string): unknown {
  try {
    return JSON.parse(v) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is not valid JSON` });
    return z.NEVER;
  }
}

// ── Domain schemas (mirror of the original helldesk-client.ts) ───────────────
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

// Local-live workstation records carry `id`/`config` but may omit department_id/updated_at.
export const LooseWorkstationSchema = WorkstationSchema.partial({ department_id: true, updated_at: true, platform_integration_id: true }).passthrough();
export type LooseWorkstation = z.output<typeof LooseWorkstationSchema>;

export const TicketSchema = z.object({
  ticket_id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent']),
  status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  assignee_agent_ticket_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.union([
    z.array(z.string()),
    z.string().transform((v, ctx) => parseJsonOrIssue(v, ctx, 'labels')).pipe(z.array(z.string())),
  ]),
  metadata: z.union([
    z.record(z.string(), z.unknown()),
    z.string().transform((v, ctx) => parseJsonOrIssue(v, ctx, 'metadata')).pipe(z.record(z.string(), z.unknown())),
  ]),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});
export type Ticket = z.output<typeof TicketSchema>;

// Local-live tickets carry `type`/`status` that matches the original enum except
// it may also use richer strings (e.g. `in_review`, `merge_request`). Keep the
// schema for the pure contract but accept a looser label at the carrier edge.
export const LooseTicketSchema = TicketSchema.extend({
  type: z.string(),
  status: z.string(),
}).passthrough();
export type LooseTicket = z.output<typeof LooseTicketSchema>;

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
export const LooseAgentSchema = AgentSchema.extend({ role: z.string(), status: z.string() }).passthrough();
export type LooseAgent = z.output<typeof LooseAgentSchema>;

export const StreamTicketSchema = z.object({
  url: z.string(),
  ticket: z.string().optional(),
});
export type StreamTicket = z.output<typeof StreamTicketSchema>;

export const TicketEventSchema = z.object({
  ticket_event_id: z.string(),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.union([
    z.record(z.string(), z.unknown()),
    z.string().transform((v, ctx) => parseJsonOrIssue(v, ctx, 'event metadata')).pipe(z.record(z.string(), z.unknown())),
  ]),
  created_at: z.string(),
});
export type TicketEvent = z.output<typeof TicketEventSchema>;

export const TaggedTicketEventSchema = TicketEventSchema.extend({
  workstation_id: z.string().nullable().optional(),
  workstation_name: z.string().nullable().optional(),
});
export type DepartmentEvent = z.output<typeof TaggedTicketEventSchema>;

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
  max_souls_per_workstation: z.number().optional(),
  qualityAssurance: z
    .object({
      gates: z.array(z.string()),
      auto_merge: z.boolean(),
      require_clean_merge: z.boolean(),
    })
    .optional(),
  alarm_interval_active: z.number().optional(),
  alarm_interval_idle: z.number().optional(),
  container: z.object({ sleep_after_minutes: z.number().optional() }).optional(),
});
export type DepartmentConfig = z.output<typeof DepartmentConfigSchema>;

export const FrontDeskSendResultSchema = z.object({
  agentId: z.string(),
  sessionStatus: z.enum(['idle', 'active', 'starting']),
});
export type FrontDeskSendResult = z.output<typeof FrontDeskSendResultSchema>;

export const FrontDeskStatusSchema = z.object({
  configured: z.boolean(),
  session: z
    .object({ agentId: z.string(), sessionId: z.string(), status: z.enum(['idle', 'active', 'starting']), lastActivityAt: z.string() })
    .nullable(),
  departmentId: z.string().nullable(),
});
export type FrontDeskStatus = z.output<typeof FrontDeskStatusSchema>;

export const RepoSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  private: z.boolean(),
});
export type Repo = z.output<typeof RepoSchema>;

export class HelldeskApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'HelldeskApiError';
  }
}

// ── Transport ───────────────────────────────────────────────────────────────
// The SPA is served behind local-live (:8790) which proxies /api, /project and
// /dashboard to the engine, so relative paths work in dev and in production.
const CLIENT = '[helldesk-client]';

export async function helldeskFetch(path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? 'GET';
  const start = Date.now();
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HelldeskApiError(`network error reaching ${path}: ${message}`, 0);
  }
  const elapsed = Date.now() - start;
  console.log(`${CLIENT} ${method} ${path} -> ${response.status} (${elapsed}ms)`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HelldeskApiError(`HELLDESK returned non-JSON response (${response.status})`, response.status);
  }
  if (!response.ok) {
    const parsed = z.object({ success: z.literal(false), error: z.string() }).safeParse(body);
    const message = parsed.success ? parsed.data.error : `HELLDESK API error (${response.status})`;
    console.error(`${CLIENT} Error from ${path}: ${response.status} - ${message}`);
    throw new HelldeskApiError(message, response.status);
  }
  return body;
}

function parseSuccessData<T>(body: unknown, schema: z.ZodType<T>): T {
  const envelope = z.object({ success: z.literal(true), data: schema }).safeParse(body);
  if (envelope.success) return envelope.data.data;
  // Some local routes return bare data or `{ ok: true, ... }`; loosen gracefully.
  const bare = schema.safeParse(body);
  if (bare.success) return bare.data;
  throw new HelldeskApiError(`unexpected response shape for ${JSON.stringify(body).slice(0, 200)}`, 500);
}
export { parseSuccessData };

// ── Department / Workstation / Ticket / Agent / Event client fns (faithful to the original) ──
export const api = {
  listDepartments: async (): Promise<Department[]> =>
    parseSuccessData(await helldeskFetch('/api/departments'), DepartmentSchema.array()),
  getDepartment: async (departmentId: string): Promise<Department> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}`), DepartmentSchema),
  createDepartment: async (name: string): Promise<Department> =>
    parseSuccessData(await helldeskFetch('/api/departments', { method: 'POST', body: JSON.stringify({ name }) }), DepartmentSchema),
  deleteDepartment: async (departmentId: string): Promise<void> => {
    await helldeskFetch(`/api/departments/${departmentId}`, { method: 'DELETE' });
  },

  listWorkstations: async (departmentId: string): Promise<LooseWorkstation[]> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations`), LooseWorkstationSchema.array()),
  getWorkstation: async (workstationId: string): Promise<LooseWorkstation> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentIdOf(workstationId)}/workstations/${workstationId}`), LooseWorkstationSchema),
  createWorkstation: async (departmentId: string, input: { name: string; git_url?: string; default_branch?: string }): Promise<LooseWorkstation> =>
    // Local workstation rows carry no department_id/updated_at (single-department
    // runtime), so parse with the loose contract; the strict cloud shape would
    // reject a create that actually succeeded. A repository is optional: Task
    // Studio routes each task to its own workspace path (git_url defaults to '').
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations`, { method: 'POST', body: JSON.stringify(input) }), LooseWorkstationSchema),
  deleteWorkstation: async (departmentId: string, workstationId: string): Promise<void> => {
    await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}`, { method: 'DELETE' });
  },

  listTickets: async (departmentId: string, workstationId?: string, includeArchived?: boolean): Promise<LooseTicket[]> => {
    // A workstation filter is the seat board; no filter is the department board
    // (which also carries the department-scoped engine mission projection).
    const base = workstationId
      ? `/api/departments/${departmentId}/workstations/${workstationId}/tickets`
      : `/api/departments/${departmentId}/tickets`;
    const path = includeArchived ? `${base}?include_archived=1` : base;
    return parseSuccessData(await helldeskFetch(path), LooseTicketSchema.array());
  },
  createTicket: async (departmentId: string, workstationId: string, input: { type: string; title: string; body?: string; priority?: string; labels?: string[]; metadata?: Record<string, unknown> }): Promise<LooseTicket> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/tickets`, { method: 'POST', body: JSON.stringify(input) }), LooseTicketSchema),
  sling: async (departmentId: string, workstationId: string, input: { title: string; body?: string; metadata?: Record<string, unknown> }): Promise<{ ticket: LooseTicket; agent: LooseAgent }> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/sling`, { method: 'POST', body: JSON.stringify(input) }), z.object({ ticket: LooseTicketSchema, agent: LooseAgentSchema })),
  deleteTicket: async (departmentId: string, workstationId: string | undefined, ticketId: string): Promise<void> => {
    const path = workstationId
      ? `/api/departments/${departmentId}/workstations/${workstationId}/tickets/${ticketId}`
      : `/api/departments/${departmentId}/tickets/${ticketId}`;
    await helldeskFetch(path, { method: 'DELETE' });
  },
  archiveTickets: async (departmentId: string, input: { ticketIds: string[]; archived?: boolean }): Promise<{ archived: boolean; count: number }> =>
    parseSuccessData(
      await helldeskFetch(`/api/departments/${departmentId}/tickets/archive`, { method: 'POST', body: JSON.stringify(input) }),
      z.object({ archived: z.boolean(), count: z.number() }),
    ),
  updateTicketStatus: async (departmentId: string, workstationId: string | undefined, ticketId: string, status: string): Promise<LooseTicket> => {
    // The PATCH returns EITHER a department Ticket OR a mission-move ack
    // ({ticketId,status,missionId,delivery,assignment}) when the ticket is
    // mission-owned (drag/assign on a mis_* mission ticket). Accept BOTH so the
    // console never rejects the mission shape as 'unexpected response shape'.
    // NOTE: helldeskFetch ALREADY parses JSON (returns the body, not a Response) —
    // never call .json() on its return value.
    const path = workstationId
      ? `/api/departments/${departmentId}/workstations/${workstationId}/tickets/${ticketId}/status`
      : `/api/departments/${departmentId}/tickets/${ticketId}/status`;
    const body = await helldeskFetch(path, {
      method: 'PATCH',
      body: JSON.stringify({ status, agent_id: 'operator' }),
    });
    // Prefer the full Ticket shape; passthrough so extra mission fields are kept.
    const ticket = LooseTicketSchema.passthrough().safeParse(body && (body as { data?: unknown }).data ? (body as { data: unknown }).data : body);
    if (ticket.success) return ticket.data as LooseTicket;
    // Mission-move ack (not a full Ticket) — map onto a conservative Ticket-like
    // shape so the UI doesn't throw; callers treat a missing title/type as a move.
    return parseSuccessData(body, LooseTicketSchema.partial().passthrough()) as unknown as LooseTicket;
  },

  listAgents: async (departmentId: string, workstationId: string): Promise<LooseAgent[]> => {
    if (!workstationId) return [];
    return parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents`), LooseAgentSchema.array());
  },
  listDepartmentAgents: async (departmentId: string): Promise<LooseAgent[]> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/agents`), LooseAgentSchema.array()),
  createAgent: async (departmentId: string, workstationId: string, input: { role: string; name: string; identity: string }): Promise<LooseAgent> =>
    parseSuccessData(
      await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      LooseAgentSchema,
    ),
  deleteAgent: async (departmentId: string, workstationId: string, agentId: string): Promise<void> => {
    await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/agents/${agentId}`, { method: 'DELETE' });
  },

  listDepartmentEvents: async (departmentId: string, options?: { since?: string; limit?: number }): Promise<DepartmentEvent[]> => {
    const qs = new URLSearchParams();
    if (options?.since) qs.set('since', options.since);
    if (options?.limit) qs.set('limit', String(options.limit));
    const q = qs.toString();
    return parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/events${q ? `?${q}` : ''}`), TaggedTicketEventSchema.array());
  },
  // Full observability snapshot from the engine (server-side aggregate over the
  // complete 24h window). The generic /api/v1/* proxy injects the control-plane
  // token; the engine response is bare JSON (parseSuccessData accepts that too).
  getObservability: async (): Promise<ObservabilitySnapshot> =>
    parseSuccessData(await helldeskFetch('/api/v1/observability'), ObservabilitySnapshotSchema),

  // ── Read-only git commit observability ─────────────────────────────────────
  listCommitWorkspaces: async (): Promise<CommitWorkspace[]> => {
    const parsed = await parseSuccessData(
      await helldeskFetch('/api/v1/commits/workspaces'),
      z.object({ workspaces: CommitWorkspaceSchema.array() })
    );
    return parsed.workspaces;
  },
  listCommitProvenance: async (workspaceId: string): Promise<CommitProvenance[]> => {
    const qs = new URLSearchParams({ workspaceId });
    const parsed = await parseSuccessData(
      await helldeskFetch(`/api/v1/commits/provenance?${qs.toString()}`),
      z.object({ workspaceId: z.string(), commits: CommitProvenanceSchema.array() })
    );
    return parsed.commits;
  },
  listCommits: async (workspaceId: string, limit = 80): Promise<CommitList> => {
    const qs = new URLSearchParams({ workspaceId, limit: String(limit) });
    return parseSuccessData(
      await helldeskFetch(`/api/v1/commits?${qs.toString()}`),
      CommitListSchema
    );
  },
  getCommit: async (workspaceId: string, sha: string): Promise<CommitDetail> => {
    const qs = new URLSearchParams({ workspaceId });
    const parsed = await parseSuccessData(
      await helldeskFetch(`/api/v1/commits/${encodeURIComponent(sha)}?${qs.toString()}`),
      z.object({ commit: CommitDetailSchema })
    );
    return parsed.commit;
  },
  getCommitFileDiff: async (
    workspaceId: string,
    sha: string,
    path: string,
    oldPath?: string | null,
    context = 3
  ): Promise<CommitFileDiff> => {
    const qs = new URLSearchParams({ workspaceId, path, context: String(context) });
    if (oldPath) qs.set('oldPath', oldPath);
    const parsed = await parseSuccessData(
      await helldeskFetch(`/api/v1/commits/${encodeURIComponent(sha)}/file?${qs.toString()}`),
      z.object({ file: CommitFileDiffSchema })
    );
    return parsed.file;
  },
  listTicketEvents: async (departmentId: string, workstationId: string, options?: { ticketId?: string; since?: string; limit?: number }): Promise<TicketEvent[]> => {
    const qs = new URLSearchParams();
    if (options?.ticketId) qs.set('ticket_id', options.ticketId);
    if (options?.since) qs.set('since', options.since);
    if (options?.limit) qs.set('limit', String(options.limit));
    const q = qs.toString();
    return parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/workstations/${workstationId}/events${q ? `?${q}` : ''}`), TicketEventSchema.array());
  },

  getDepartmentConfig: async (departmentId: string): Promise<DepartmentConfig> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/config`), DepartmentConfigSchema),
  updateDepartmentConfig: async (departmentId: string, update: Partial<DepartmentConfig>): Promise<DepartmentConfig> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/config`, { method: 'PATCH', body: JSON.stringify(update) }), DepartmentConfigSchema),

  // ── FrontDesk / PTY (REAL local parity) ───────────────────────────────────────
  // These call the local-live frontDesk + native-pty REST routes. `ensure` eagerly
  // creates the frontDesk PTY; `getFrontDeskStatus` yields a session once it exists;
  // `createPtySession` returns a live WebSocket URL; `resizePtySession` resizes.
  ensureFrontDesk: async (departmentId: string): Promise<FrontDeskSendResult> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/frontDesk/ensure`, { method: 'POST', body: '{}' }), FrontDeskSendResultSchema),
  getFrontDeskStatus: async (departmentId: string): Promise<FrontDeskStatus> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/frontDesk/status`), FrontDeskStatusSchema),
  sendFrontDeskMessage: async (departmentId: string, message: string): Promise<FrontDeskSendResult> =>
    parseSuccessData(await helldeskFetch(`/api/departments/${departmentId}/frontDesk/message`, { method: 'POST', body: JSON.stringify({ message }) }), FrontDeskSendResultSchema),
  createPtySession: async (departmentId: string, agentId: string): Promise<{ pty: { id: string }; wsUrl: string }> => {
    // The backend returns `{ success: true, data: { pty: { id, wsUrl } } }`.
    // parseSuccessData unwraps `.data`; normalize to the `{ pty: { id }, wsUrl }`
    // shape the fed terminal panes read (top-level wsUrl).
    const data = await parseSuccessData(
      await helldeskFetch(`/api/departments/${departmentId}/container/agents/${agentId}/pty`, { method: 'POST', body: '{}' }),
      z.object({ pty: z.object({ id: z.string(), wsUrl: z.string() }) })
    );
    return { pty: { id: data.pty.id }, wsUrl: data.pty.wsUrl };
  },
  resizePtySession: async (departmentId: string, agentId: string, ptyId: string, cols: number, rows: number): Promise<void> => {
    await helldeskFetch(`/api/departments/${departmentId}/container/agents/${agentId}/pty/${ptyId}`, { method: 'PUT', body: JSON.stringify({ size: { cols, rows } }) });
  },
};

// workstationId → departmentId is not always known client-side; hydrate via a department lookup.
let _departmentIdByWorkstation: Record<string, string> = {};
export function setWorkstationDepartmentIndex(map: Record<string, string>): void {
  _departmentIdByWorkstation = map;
}
function departmentIdOf(workstationId: string): string {
  return _departmentIdByWorkstation[workstationId] ?? 'default';
}
