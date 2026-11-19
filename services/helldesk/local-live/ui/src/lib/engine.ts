// Typed adapter: the standalone HELLDESK UI speaks to the canonical NAI-Lattice
// engine (JSON-RPC over /project + /dashboard on :8787) and, where richer, the
// local-live REST surface (:8790 /api). No Cloudflare, no auth — native local.
//
// This is the single transport boundary. Every view consumes these typed fns.
import { z } from 'zod'

const operationResultSchema = z.object({ success: z.boolean().optional(), ok: z.boolean().optional(), error: z.string().optional(), data: z.unknown().optional() }).passthrough()
export async function operatorRequest(url: string, body?: unknown): Promise<{ success: boolean; error?: string; data?: unknown }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    const parsed = operationResultSchema.safeParse(await response.json())
    if (!parsed.success) return { success: false, error: 'The server returned an invalid response.' }
    if (!response.ok || (parsed.data.success !== true && parsed.data.ok !== true) || parsed.data.success === false || parsed.data.ok === false || parsed.data.error)
      return { ...parsed.data, success: false, error: parsed.data.error || `Request failed (${response.status}).` }
    return { ...parsed.data, success: true }
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : 'Server unavailable.' } }
}

const roomAgentSchema = z.object({ id: z.string().optional(), ticket_id: z.string().optional(), agent_id: z.string().optional(), name: z.string().optional(), role: z.string().optional(), status: z.string().optional(), workstation_id: z.string().nullable().optional(), current_hook_ticket_id: z.string().nullable().optional() }).passthrough()
const roomTicketSchema = z.object({ ticket_id: z.string(), title: z.string(), status: z.string(), workstation_id: z.string().nullable().optional(), assignee_agent_ticket_id: z.string().nullable().optional() }).passthrough()
const roomSchema = z.object({ agents: z.array(roomAgentSchema), tickets: z.array(roomTicketSchema), workstations: z.array(z.object({ id: z.string().optional(), workstation_id: z.string().optional(), name: z.string().optional() }).passthrough()) })
export type RoomState = z.infer<typeof roomSchema>
export type RoomAgent = RoomState['agents'][number]
export async function readOperatorRoom(departmentId: string): Promise<RoomState> {
  const response = await operatorRequest(`/api/departments/${encodeURIComponent(departmentId)}/room`)
  if (!response.success) throw new Error(response.error)
  return roomSchema.parse(response.data)
}
export const roomAgentId = (agent: RoomAgent) => agent.id || agent.ticket_id || agent.agent_id || ''

export interface Ticket {
  ticket_id: string
  ticket_type?: string
  status: 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed'
  title: string
  body?: string | null
  workstation_id?: string | null
  parent_ticket_id?: string | null
  assignee_agent_ticket_id?: string | null
  dispatch_attempts?: number
  labels?: string[]
  metadata?: Record<string, any>
  updated_at?: string
  created_at?: string
}

export interface ShiftView {
  shift_id: string
  tickets: Ticket[]
  blocks_edges?: { ticket: string; awaits: string; kind: string }[]
}

export interface Project {
  project_id: string
  name?: string
  repo_path?: string
  resource_roots?: string[]
  shift_ids?: string[]
  active_ticket_id?: string | null
  completed_primary_tickets?: string[]
}

export interface UniveralDashboard {
  projects: Project[]
  all_primaries: Ticket[]
  shifts?: ShiftView[]
  tickets?: Ticket[]
}

export interface Agent {
  ticket_id: string
  role: 'soul' | 'qualityAssurance' | 'frontDesk' | string
  name: string
  status: string
  workstation_id?: string | null
  current_hook_ticket_id?: string | null
  identity?: string
}

export interface Workstation {
  workstation_id: string
  name: string
  department_id?: string
  default_branch?: string
  config?: Record<string, any>
}

// ---- JSON-RPC over the canonical engine ----

type RpcArgs = Record<string, unknown>

async function rpc(method: string, args: RpcArgs = {}): Promise<any> {
  // Every engine JSON-RPC method (gt.* project domain AND helldesk.orto.*
  // orchestration) is dispatched by the canonical engine only on /project.
  // /dashboard is a read-only aggregate GET, not an RPC dispatcher — sending
  // RPC there makes health and every helldesk.orto.* call fail ("engine offline").
  const ep = method.startsWith('gt.') || method.startsWith('helldesk.') ? '/project' : '/dashboard'
  try {
    const res = await fetch(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args }),
    })
    const txt = await res.text()
    try { return JSON.parse(txt) } catch { return { raw: txt, status: res.status } }
  } catch (e) {
    return { error: String(e) }
  }
}

const ok = (r: any): boolean => !!(r && r.ok)

// ---- Engine domain fns (typed) ----

export const engine = {
  health: async (): Promise<boolean> => ok(await rpc('helldesk.orto.health')),
  dashboard: async (): Promise<UniveralDashboard> => {
    const r = await rpc('gt.dashboard.universal', {})
    if (ok(r)) return r as UniveralDashboard
    return { projects: [], all_primaries: [], shifts: [], tickets: [] }
  },
  projectList: async (): Promise<Project[]> => {
    const r = await rpc('gt.project.list', {})
    return ok(r) ? (r.projects ?? []) : []
  },
  projectGet: async (projectId: string): Promise<Project | null> => {
    const r = await rpc('gt.project.get', { project_id: projectId })
    return ok(r) ? (r.project ?? null) : null
  },
  projectView: async (projectId: string): Promise<{ active_ticket_id?: string; shifts?: ShiftView[]; completed_primary_tickets?: string[] }> => {
    const r = await rpc('gt.project.view', { project_id: projectId })
    return ok(r) ? r : {}
  },
  projectCreate: async (name: string, repoPath?: string): Promise<Project | null> => {
    const r = await rpc('gt.project.create', { name, repo_path: repoPath })
    return ok(r) ? (r.project ?? null) : null
  },
  projectAddPrimary: async (projectId: string, title: string): Promise<any> =>
    rpc('gt.project.add_primary', { project_id: projectId, title }),
  projectSetActiveTicket: async (projectId: string, ticketId: string): Promise<any> =>
    rpc('gt.project.set_active_Ticket', { project_id: projectId, ticket_id: ticketId }),
  projectSetResourceRoots: async (projectId: string, resourceRoots: string[]): Promise<any> =>
    rpc('gt.project.set_resource_roots', { project_id: projectId, resource_roots: resourceRoots }),
  projectSetTicketGates: async (ticketId: string, gates: any[]): Promise<any> =>
    rpc('gt.project.set_ticket_gates', { ticket_id: ticketId, gates }),
  projectDispatchCorrective: async (projectId: string, instructions: string): Promise<any> =>
    rpc('gt.project.dispatch_corrective', { project_id: projectId, instructions }),

  // FrontDesk chat (real frontDesk decomposes a request into a shift/tickets).
  frontDeskRequest: async (request: string, workstationId = 'workstation-local'): Promise<any> =>
    rpc('helldesk.orto.front_desk_request', { request, workstation_id: workstationId }),

  // Workstation + ticket control via the canonical engine.
  addWorkstation: async (name: string): Promise<any> => rpc('helldesk.orto.add_workstation', { name }),
  createTicket: async (type: string, title: string): Promise<any> =>
    rpc('helldesk.orto.create_Ticket', { type, title }),
  createShift: async (title: string): Promise<any> => rpc('helldesk.orto.create_shift', { title }),
  setTicketStatus: async (ticketId: string, status: string): Promise<any> =>
    rpc('helldesk.orto.set_ticket_status', { ticket_id: ticketId, status }),
  tick: async (): Promise<any> => rpc('helldesk.orto.reconcile_tick', {}),
}

// ---- local-live REST (richer department/workstation/ticket/memo/events data) ----

export const local = {
  base: '/api',
  departmentDashboard: async (departmentId = 'default'): Promise<any> => {
    const res = await fetch(`${local.base}/departments/${departmentId}/dashboard`).catch(() => null)
    if (!res) return {}
    try { return await res.json() } catch { return {} }
  },
  departmentConfig: async (departmentId = 'default'): Promise<any> => {
    const res = await fetch(`${local.base}/departments/${departmentId}/config`).catch(() => null)
    if (!res) return {}
    try { return await res.json() } catch { return {} }
  },
  events: async (departmentId = 'default'): Promise<any[]> => {
    const res = await fetch(`${local.base}/departments/${departmentId}/events`).catch(() => null)
    if (!res) return []
    try {
      const j = await res.json()
      return Array.isArray(j) ? j : (j.events ?? (j.data ?? []))
    } catch { return [] }
  },
  // Full-QA observability: the durable per-mission agent transcript (messages,
  // tool calls, file diffs, review findings, mission events) proxied from the
  // control plane's /v1/journal. Filtered by mission/revision/job.
  journal: async (opts: { missionId?: string; revisionId?: string; jobId?: string; limit?: number } = {}): Promise<any[]> => {
    const q = new URLSearchParams()
    if (opts.missionId) q.set('mission_id', opts.missionId)
    if (opts.revisionId) q.set('revision_id', opts.revisionId)
    if (opts.jobId) q.set('job_id', opts.jobId)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    const res = await fetch(`/api/v1/journal${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (!res || !res.ok) return []
    try {
      const j = await res.json()
      return Array.isArray(j) ? j : (j.entries ?? [])
    } catch { return [] }
  },
}

// ── Control-plane mission telemetry (proxied server-side; the browser never
// holds the token). `<data>/missions` carries live ExcellenceGovernor mission state for
// `mission`, so an actively-working agent is never silent in the operator-console.
// NOTE: the control-plane /v1/missions returns CAMELCASE (missionId, verifiedAt,
// updatedAt, blockedReason). The accessor normalizes to BOTH so callers (board +
// observability) can read either shape without surprises.
export interface ColonyMission {
  mission_id?: string
  missionId?: string
  state?: string
  current_ticket_id?: string | null
  currentTicketId?: string | null
  current_revision_id?: string | null
  updated_at?: string | null
  updatedAt?: string | null
  verified_at?: string | null
  verifiedAt?: string | null
  blocked_reason?: string | null
  blockedReason?: string | null
  objective?: string
  idempotency_key?: string
}
const normMissionId = (o: any): string => o?.mission_id ?? o?.missionId ?? ''
const normMissionUpdated = (o: any): string | null => o?.updated_at ?? o?.updatedAt ?? null
const normMissionVerified = (o: any): string | null => o?.verified_at ?? o?.verifiedAt ?? null
const normMissionBlocked = (o: any): string | null => o?.blocked_reason ?? o?.blockedReason ?? null

export async function listColonyMissions(): Promise<ColonyMission[]> {
  const res = await fetch('/api/v1/missions', { signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!res || !res.ok) return []
  try {
    const j = (await res.json()) as any
    const raw = Array.isArray(j) ? j : (j.missions ?? []) as any[]
    return raw.map((r) => ({
      mission_id: normMissionId(r),
      missionId: normMissionId(r),
      state: r?.state,
      current_ticket_id: r?.current_ticket_id ?? r?.currentTicketId ?? null,
      currentTicketId: r?.current_ticket_id ?? r?.currentTicketId ?? null,
      updated_at: normMissionUpdated(r),
      updatedAt: normMissionUpdated(r),
      verified_at: normMissionVerified(r),
      verifiedAt: normMissionVerified(r),
      blocked_reason: normMissionBlocked(r),
      blockedReason: normMissionBlocked(r),
      objective: r?.objective,
      idempotency_key: r?.idempotency_key ?? r?.idempotencyKey,
    }))
  } catch { return [] }
}
export async function getColonyMission(missionId: string): Promise<ColonyMission | null> {
  const res = await fetch(`/api/v1/missions/${encodeURIComponent(missionId)}`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  if (!res || !res.ok) return null
  try {
    const raw = ((await res.json()) as any)?.mission ?? null
    if (!raw) return null
    return {
      mission_id: normMissionId(raw),
      missionId: normMissionId(raw),
      state: raw?.state,
      current_ticket_id: raw?.current_ticket_id ?? raw?.currentTicketId ?? null,
      updated_at: normMissionUpdated(raw),
      updatedAt: normMissionUpdated(raw),
      verified_at: normMissionVerified(raw),
      verifiedAt: normMissionVerified(raw),
      blocked_reason: normMissionBlocked(raw),
      blockedReason: normMissionBlocked(raw),
      objective: raw?.objective,
    }
  } catch { return null }
}

// ── Control-plane mission board (kanban source of truth) ────────────────────
// The operator Kanban must show the REAL engine missions (mis_*) and their
// tickets + revisions, not the local-live placeholder store. These accessors
// read the proxied /api/v1/missions endpoints (server injects the token) so the
// browser only ever talks to the control-plane SQLite authority.
export interface MissionTicketCard {
  missionId: string
  ticketId: string
  title: string
  objective?: string | null
  status: 'open' | 'in_progress' | 'in_review' | 'closed'
  executionState?: string
  verificationState?: string
  revisionNo?: number
  revisionState?: string
  missionState?: string
  quality?: Array<{ gate_key: string; status: string }>
}

function missionTicketStatus(execution_state: string | undefined, verification_state: string | undefined, revision_state: string | undefined): MissionTicketCard['status'] {
  if (execution_state === 'CLOSED' || verification_state === 'VERIFIED_10_10' || revision_state === 'VERIFIED_10_10') return 'closed'
  if (execution_state === 'RUNNING' || execution_state === 'READY' || execution_state === 'MUTATING' ||
      revision_state === 'MUTATING' || revision_state === 'EVIDENCE_CAPTURED' || revision_state === 'VERIFYING') return 'in_progress'
  if (verification_state === 'REJECTED' || revision_state === 'REJECTED' || revision_state === 'BLOCKED') return 'in_review'
  return 'open'
}

export async function getMissionBoard(): Promise<MissionTicketCard[]> {
  const missions = await listColonyMissions()
  const cards: MissionTicketCard[] = []
  for (const m of missions) {
    const missionId = m.mission_id
    if (!missionId) continue
    // tickets for this mission
    const tr = await fetch(`/api/v1/missions/${encodeURIComponent(missionId)}/tickets`, { signal: AbortSignal.timeout(8000) }).catch(() => null)
    if (!tr || !tr.ok) {
      // mission with no tickets listed — still surface it as a mission card
      cards.push({ missionId, ticketId: `mission:${missionId}`, title: m.objective ? m.objective.slice(0, 80) : missionId, objective: m.objective, status: m.state === 'CANCELLED' ? 'closed' : (m.state === 'MUTATING' || m.state === 'ACTIVE' ? 'in_progress' : 'open'), missionState: m.state })
      continue
    }
    let tickets: Array<Record<string, any>> = []
    try { const j = await tr.json(); tickets = Array.isArray(j) ? j : (j.tickets ?? []) } catch { tickets = [] }
    // The control-plane public ticket shape is camelCase ({\n  "ticketId": ..., "executionState": "RUNNING",\n  "verificationState": "UNVERIFIED", "activeRevisionId": ...}); tolerate snake too.
    const tk = (o: Record<string, any>, camel: string, snake: string): any => o[camel] ?? o[snake] ?? undefined
    if (!tickets.length) {
      cards.push({ missionId, ticketId: `mission:${missionId}`, title: m.objective ? m.objective.slice(0, 80) : missionId, objective: m.objective, status: m.state === 'CANCELLED' ? 'closed' : (m.state === 'MUTATING' || m.state === 'ACTIVE' || m.state === 'VERIFYING' ? 'in_progress' : 'open'), missionState: m.state })
      continue
    }
    for (const tinput of tickets) {
      const t = tinput as Record<string, any>
      const ticketId = tk(t, 'ticketId', 'ticket_id') as string
      const title = tk(t, 'title', 'title') as string | undefined
      const objective = tk(t, 'objective', 'objective') as string | null | undefined
      const executionState = tk(t, 'executionState', 'execution_state') as string | undefined
      const verificationState = tk(t, 'verificationState', 'verification_state') as string | undefined
      cards.push({
        missionId,
        ticketId,
        title: title || (m.objective ? m.objective.slice(0, 80) : ticketId),
        objective: objective ?? m.objective,
        status: missionTicketStatus(executionState, verificationState, undefined),
        executionState,
        verificationState,
        missionState: m.state,
      })
    }
  }
  return cards
}

// ---- Control-plane runtime config (via entry.ts `/api/v1/*` proxy) ----
// Discrete CRUD on the review/autonomy engine's runtime config store. The proxy
// injects the control-plane token server-side, so the browser never holds it.

export interface EngineWorkspace {
  path: string
  enabled?: boolean
  include?: string[]
  exclude?: string[]
}

export interface EngineConfigResponse {
  config?: {
    daemon?: Record<string, any>
    policy?: Record<string, any>
    autonomy?: Record<string, any>
    workspaces?: EngineWorkspace[]
  }
  meta?: Record<string, Record<string, 'live' | 'restart'>>
  path?: string
}

export interface EngineConfigPatchResult {
  ok: boolean
  applied_live: string[]
  applies_on_restart: string[]
  rejected: Array<{ field: string; issues: string[] }>
  config_path?: string
  config?: Record<string, any>
}

export const runtimeConfig = {
  get: async (): Promise<EngineConfigResponse> => {
    const res = await fetch('/api/v1/config').catch(() => null)
    if (!res) return {}
    try {
      const j = await res.json()
      return j && j.config ? j : {}
    } catch {
      return {}
    }
  },
  patch: async (patch: Record<string, unknown>): Promise<EngineConfigPatchResult> => {
    const res = await fetch('/api/v1/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => null)
    if (!res) return { ok: false, applied_live: [], applies_on_restart: [], rejected: [] }
    try {
      return await res.json()
    } catch {
      return { ok: false, applied_live: [], applies_on_restart: [], rejected: [] }
    }
  },
}

export function short(id?: string | null, n = 8): string {
  if (!id) return '—'
  return id.length > n ? id.slice(0, n) : id
}

// ── Repo I/O + enforcer picker (HITL operator surface) ─────────────────────

/** Which NAI process enforces a task ('auto' = no override, default colony
 *  behavior). Stored as metadata.break_room_controls when not 'auto'. */
export type Enforcer = 'auto' | 'excellenceGovernor' | 'soul' | 'reviewer'

export interface SourceRepoInput {
  id: string
  path: string
  label?: string
  branch?: string
}

/** Map a chosen enforcer to metadata.break_room_controls. 'auto' sends no override,
 *  letting the colony/reconciler decide the default dispatch behavior. */
const enforcerToControls = (e: Exclude<Enforcer, 'auto'>) => ({
  agents: true,
  reviewer: e === 'reviewer' || e === 'excellenceGovernor',
  excellenceGovernor: e === 'excellenceGovernor',
})

/** Update the department's local_repo: the project WORKSPACE (input repo) + optional
 *  extra input repos + optional OUTPUT repo (cross-repo delta target). Optional:
 *  a department with no local_repo keeps its plain colony behavior. */
export const setDepartmentLocalRepo = async (departmentId: string, input: {
  repoPath: string            // project workspace / primary input repo
  outputRepo?: {
    repo_path: string         // where cross-repo deltas land (new or existing)
    branch?: string
    bare_remote?: string
    init_if_missing?: boolean
  }
  sourceRepos?: SourceRepoInput[]
  workdir?: string
}): Promise<any> => {
  const body: Record<string, unknown> = {
    local_repo: {
      adapter: 'local-git',
      repo_path: input.repoPath,
      workdir: input.workdir,
      source_repos: input.sourceRepos ?? [],
      output_repo: input.outputRepo ?? null,
    },
  }
  const res = await fetch(`/api/departments/${departmentId}/config`, {
    method: 'PATCH',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!res) return { success: false, error: 'Repo configuration service is unavailable.' }
  try { const result = operationResultSchema.parse(await res.json()); return { ...result, success: res.ok && (result.success === true || result.ok === true) && result.success !== false && result.ok !== false } } catch { return { success: false, error: 'Invalid repo configuration response.' } }
}

/** Create a kanban ticket with a spec body + an optional enforcer in ONE call.
 *  When `enforcer === 'auto'`, no break_room_controls override is sent — the task
 *  runs under the department/workstation's default colony behavior. */
export const createTask = async (departmentId: string, workstationId: string, input: {
  title: string
  spec?: string
  enforcer: Enforcer
  review_mode?: 'ReviewThenLand' | 'ReviewAndMerge'
  depends_on?: string[]
  /** Provider-agnostic per-task engine override: {mutation?:{engine,...}, review?, adjudicate?}.
   *  Stored on the ticket metadata and carried into the mission at dispatch. Unset stages
   *  fall back to the department default engine matrix. */
  engineMatrix?: Record<string, { engine?: string; providerID?: string; modelID?: string; baseURL?: string }>
}): Promise<any> => {
  const body: Record<string, unknown> = {
    type: 'issue',
    title: input.title,
    body: input.spec,
    depends_on: input.depends_on ?? [],
  }
  if (input.enforcer !== 'auto') {
    body.break_room_controls = { ...enforcerToControls(input.enforcer), review_mode: input.review_mode }
  } else if (input.enforcer === 'auto' && input.review_mode) {
    body.break_room_controls = { review_mode: input.review_mode }
  }
  if (input.engineMatrix && Object.keys(input.engineMatrix).length) {
    body.engine_matrix = input.engineMatrix
  }
  return operatorRequest(`/api/departments/${encodeURIComponent(departmentId)}/workstations/${encodeURIComponent(workstationId)}/tickets`, body)
}

/** Onboard a two-repo project through the ExcellenceGovernor path (spec → engine
 *  project + binds department local_repo). */
export const createExcellenceGovernorProject = async (departmentId: string, input: {
  name: string
  repoPath: string
  spec: string
  objective?: string
  sourceRepos?: SourceRepoInput[]
  gates?: Array<{ id: string; status?: string; evidence?: string }>
}): Promise<any> => {
  return operatorRequest(`/api/departments/${encodeURIComponent(departmentId)}/projects`, input)
}
