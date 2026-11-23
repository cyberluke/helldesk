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

/**
 * True when a crew member is doing live work.
 *
 * The room projection exposes BOTH the crew status word and the engine
 * checkpoint. A running engine checkpoint is authoritative liveness, so it
 * counts even if a status word drifts (or an older daemon is still serving).
 * The operator header must never read "0 working" for a producing mission.
 */
export const isAgentWorking = (agent: RoomAgent): boolean =>
  agent.status === 'working' ||
  (agent as { checkpoint?: { running?: boolean } | null }).checkpoint?.running === true

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
  revision_state?: string | null
  revisionState?: string | null
  review_job_state?: string | null
  reviewJobState?: string | null
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

// ── Mission completion / acceptance / re-review (token injected by the proxy) ─
export interface MissionReportRole {
  role: string
  providerID: string | null
  modelID: string | null
  status: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  cost: number | null
  costRule?: string | null
  costSource?: 'reported' | 'calculated' | null
}
export interface MissionReportFinding {
  severity: string
  confidence: string
  title: string
  file: string | null
  lineStart: number | null
  lineEnd: number | null
  evidence: string
  reviewerIds: string[]
  adjudicated: number
  adjudication: string | null
}
export interface MissionReport {
  mission: {
    missionId: string
    state: string
    objective: string
    createdAt: string
    updatedAt: string
    verifiedAt: string | null
    controls: Record<string, unknown>
    humanAcceptance: 'accepted' | 'changes_requested' | null
    humanAcceptedAt: string | null
    humanAcceptanceNote: string | null
    humanAcceptedBy: string | null
    awaitingHumanAcceptance: boolean
  }
  tickets: Array<{
    ticketId: string
    title: string
    executionState: string
    verificationState: string
    revisionId: string | null
    revisionNo: number | null
    revisionState: string | null
    reviewJobId: string | null
    reviewJobState: string | null
    reviewResult: string | null
    storyPoints: number | null
    tshirtSize: string | null
    sizeConfidence: string | null
    sizeRationale: string | null
    sizingState: string | null
  }>
  review: {
    jobId: string | null
    state: string | null
    result: string | null
    requestedAt: string | null
    completedAt: string | null
    revisionId: string | null
    revisionNo: number | null
    ticketId: string | null
    policy: { controls: Record<string, unknown>; summary: string; reviewerA: boolean; reviewerB: boolean; governor: boolean } | null
    roles: MissionReportRole[]
    findings: MissionReportFinding[]
    tokens: { input: number; output: number; total: number; cost: number | null; costPartial?: boolean }
  }
  gates: Array<{ gateKey: string; status: string; evaluator: string | null; checkedAt: string; evidenceRefs: unknown }>
  evidence: Array<{
    artifactId: string
    kind: string
    path: string | null
    sha256: string
    bytes: number
    producer: string | null
    command: string | null
    exitCode: number | null
    createdAt: string
  }>
  commits: { baseHash: string | null; headHash: string | null }
  acceptanceHistory: Array<{ event_id: string; mission_id: string; decision: string; note: string | null; actor: string | null; created_at: string }>
}

async function missionJson<T>(path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  const response = await fetch(path, {
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const payload = (await response.json().catch(() => null)) as any
  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? payload?.reason ?? `HTTP ${response.status}`)
  }
  return payload as T
}

export async function getMissionReport(missionId: string): Promise<MissionReport | null> {
  try {
    return await missionJson<MissionReport>(`/api/v1/missions/${encodeURIComponent(missionId)}/report`)
  } catch {
    return null
  }
}

export async function submitMissionAcceptance(
  missionId: string,
  decision: 'accepted' | 'changes_requested',
  note?: string,
  actor = 'operator'
): Promise<{ ok: boolean; decision: string; state: string }> {
  return missionJson(`/api/v1/missions/${encodeURIComponent(missionId)}/acceptance`, { decision, note, actor })
}

export async function requestMissionReReview(
  missionId: string
): Promise<{ ok: boolean; action: string; jobId: string | null; reason?: string }> {
  return missionJson(`/api/v1/missions/${encodeURIComponent(missionId)}/re-review`, {})
}

export async function updateMissionTicketSize(
  ticketId: string,
  tshirt: string
): Promise<{ ok: boolean; ticketId: string; storyPoints: number; tshirtSize: string }> {
  return missionJson(`/api/v1/tickets/${encodeURIComponent(ticketId)}/size`, { tshirt })
}

export async function requestTaskSizingBackfill(
  limit = 10
): Promise<{ ok: boolean; queued: number; sized: number; failed: number; remaining: number; running?: boolean }> {
  return missionJson(`/api/v1/tasks/backfill-sizes`, { limit }, 120_000)
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

/** Tier-resolved budget returned by GET /api/v1/config (server-side truth). */
export interface ContextBudgetView {
  selection: string
  tier: string
  source: 'config-window' | 'config-tier' | 'kilo-jsonc' | 'default'
  contextWindow: number
  inputBudgetTokens: number
  outputBudgetTokens: number
  charsPerToken: number
  promptUtilization: number
  userPromptCharBudget: number
  reviewDiffCharBudget: number
  kiloConfigTransportLimitChars: number
  detected?: { context?: number; input?: number; output?: number } | null
}

export interface EngineContextConfig {
  tier?: string
  /** `null` explicitly clears a previously persisted override. */
  contextWindow?: number | null
  charsPerToken?: number
  promptUtilization?: number
  /** `null` explicitly clears a previously persisted override. */
  reservedOutputTokens?: number | null
}

export interface EngineConfigResponse {
  config?: {
    daemon?: Record<string, any>
    policy?: Record<string, any>
    autonomy?: Record<string, any>
    context?: EngineContextConfig
    workspaces?: EngineWorkspace[]
  }
  meta?: Record<string, Record<string, 'live' | 'restart'>>
  path?: string
  context_resolution?: ContextBudgetView
}

export interface EngineConfigPatchResult {
  ok: boolean
  applied_live: string[]
  applies_on_restart: string[]
  rejected: Array<{ field: string; issues: string[] }>
  config_path?: string
  config?: Record<string, any>
  context_resolution?: ContextBudgetView
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
export type Enforcer = 'auto' | 'excellenceGovernor' | 'soul' | 'reviewer' | 'reviewerAndGovernor'

/** Task shape selected in Task Studio and sent to the prompt enhancer. */
export type TaskType = 'engine' | 'feature' | 'bugfix' | 'refactor' | 'extraction'
export type WriteTarget = 'workspace' | 'output_repo'
export type Delivery = 'startup' | 'production'
export type EnhanceMode = 'text' | 'repos'

export interface SourceRepoInput {
  id: string
  path: string
  label?: string
  branch?: string
}

/** Map a chosen enforcer to metadata.break_room_controls. 'auto' sends no override,
 *  letting the colony/reconciler decide the default dispatch behavior.
 *
 *  The enforcer picker now matches its label exactly: "Build + ExcellenceGovernor"
 *  enables the governor stage ONLY (the A/B reviewer layer stays off until the
 *  operator turns Reviewer A/B on in the Kanban card or task drawer). The
 *  "HELLDESK Reviewer" enforcer enables the independent A/B reviewers and leaves
 *  the governor stage off; "Souls" keeps the department default review policy. */
export const enforcerToControls = (e: Exclude<Enforcer, 'auto'>) => {
  if (e === 'excellenceGovernor') {
    return { agents: true, reviewer: false, reviewerA: false, reviewerB: false, excellenceGovernor: true }
  }
  if (e === 'reviewer') {
    return { agents: true, reviewer: true, reviewerA: true, reviewerB: true, excellenceGovernor: false }
  }
  if (e === 'reviewerAndGovernor') {
    return { agents: true, reviewer: true, reviewerA: true, reviewerB: true, excellenceGovernor: true }
  }
  // Souls: implement + land under the department's default review policy.
  return { agents: true }
}

// ── Prompt enhancer (Task Studio shape → enhanced spec) ────────────────────
// The enhancer is an optional server-side assist: it rewrites/expands the
// operator's spec using the task shape and the routed repos. It NEVER creates
// a task; the operator reviews the result in EnhancePreview and applies it.

/** One minimum-proof entry: the claim, the test that proves it, the evidence to capture. */
export interface MinimumProofItem {
  claim: string
  test: string
  evidence: string
}

/** The enhanced task contract returned by POST /api/v1/enhance. */
export interface EnhancedSpec {
  title: string
  taskType: TaskType
  writeTarget: WriteTarget
  delivery: Delivery
  spec: string
  assumptions: string[]
  questions: string[]
  minimumProof: MinimumProofItem[]
  notDoneIf: string[]
  risks: string[]
}

/** Independent adversarial product-owner verdict shown at the approval gate. */
export type QaVerdict = 'PASS' | 'REVISE' | 'REJECT' | 'UNAVAILABLE'
export interface QaFinding {
  severity: 'blocker' | 'major' | 'minor'
  issue: string
  evidence?: string
  requiredChange?: string
}
export interface QaReview {
  verdict: QaVerdict
  summary: string
  findings: QaFinding[]
}

const taskTypeSchema = z.enum(['engine', 'feature', 'bugfix', 'refactor', 'extraction'])
const writeTargetSchema = z.enum(['workspace', 'output_repo'])
const deliverySchema = z.enum(['startup', 'production'])

const minimumProofItemSchema = z.object({
  claim: z.string(),
  test: z.string(),
  evidence: z.string(),
}).passthrough()

const qaFindingSchema = z.object({
  severity: z.enum(['blocker', 'major', 'minor']).default('major'),
  issue: z.string(),
  evidence: z.string().optional(),
  requiredChange: z.string().optional(),
}).passthrough()

const qaReviewSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE', 'REJECT', 'UNAVAILABLE']),
  summary: z.string().default(''),
  findings: z.array(qaFindingSchema).default([]),
}).passthrough()

const enhancedSpecSchema = z.object({
  title: z.string(),
  taskType: taskTypeSchema,
  writeTarget: writeTargetSchema,
  delivery: deliverySchema,
  spec: z.string(),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
  minimumProof: z.array(minimumProofItemSchema).default([]),
  notDoneIf: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
}).passthrough()

type EnhancedSpecWire = z.infer<typeof enhancedSpecSchema>

/** Bounded, read-only repo profile the enhancer attaches for `repos` mode. */
const repoProfileSummarySchema = z.object({
  path: z.string(),
  kind: z.string().optional(),
  head: z.string().nullish(),
  branch: z.string().nullish(),
  dirtyFiles: z.number().nullish(),
  trackedCount: z.number().nullish(),
  topLevel: z.array(z.string()).optional(),
  frameworks: z.array(z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  keyFiles: z.array(z.string()).optional(),
}).passthrough()

const enhanceAnalysisSchema = z.object({
  workspace: repoProfileSummarySchema,
  output: repoProfileSummarySchema.optional(),
}).passthrough()
export type EnhanceAnalysis = z.infer<typeof enhanceAnalysisSchema>

const enhanceMetaSchema = z.object({
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  qaProviderID: z.string().optional(),
  qaModelID: z.string().optional(),
  tookMs: z.number().optional(),
}).passthrough()
export type EnhanceMeta = z.infer<typeof enhanceMetaSchema>

const enhanceEnvelopeSchema = z.object({
  ok: z.boolean().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  enhanced: enhancedSpecSchema.optional(),
  result: enhancedSpecSchema.optional(),
  qa: qaReviewSchema.optional(),
  analysis: enhanceAnalysisSchema.optional(),
  meta: enhanceMetaSchema.optional(),
  data: z.unknown().optional(),
}).passthrough()

const enhanceRecordSchema = z.record(z.string(), z.unknown())

const asEnhanceRecord = (value: unknown): Record<string, unknown> | null => {
  const parsed = enhanceRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const toEnhancedSpec = (wire: EnhancedSpecWire): EnhancedSpec => ({
  title: wire.title,
  taskType: wire.taskType,
  writeTarget: wire.writeTarget,
  delivery: wire.delivery,
  spec: wire.spec,
  assumptions: wire.assumptions,
  questions: wire.questions,
  minimumProof: wire.minimumProof.map((item) => ({ claim: item.claim, test: item.test, evidence: item.evidence })),
  notDoneIf: wire.notDoneIf,
  risks: wire.risks,
})

const enhanceErrorText = (payload: unknown, fallback: string): string => {
  const record = asEnhanceRecord(payload)
  const message = record?.message ?? record?.detail ?? record?.error
  if (typeof message === 'string' && message.trim() && message !== 'invalid_body') return message
  const issues = record?.issues
  if (Array.isArray(issues)) {
    const readable = issues.slice(0, 3).map((issue) => {
      const item = asEnhanceRecord(issue)
      const issueMessage = typeof item?.message === 'string' ? item.message : ''
      if (!issueMessage) return ''
      const path = Array.isArray(item?.path) ? item.path.filter((part) => typeof part === 'string').join('.') : ''
      return path ? `${path}: ${issueMessage}` : issueMessage
    }).filter(Boolean)
    if (readable.length) return readable.join('; ')
  }
  if (typeof message === 'string' && message.trim()) return message
  return fallback
}

/** Accept either the documented envelope ({enhanced}|{result}|{data:{enhanced}})
 *  or a bare enhanced-spec object. Unknown shapes are rejected, not guessed. */
function readEnhancedPayload(source: unknown): {
  enhanced?: EnhancedSpec
  qa?: QaReview
  analysis?: EnhanceAnalysis
  meta?: EnhanceMeta
} {
  const direct = enhancedSpecSchema.safeParse(source)
  if (direct.success) return { enhanced: toEnhancedSpec(direct.data) }
  const envelope = enhanceEnvelopeSchema.safeParse(source)
  if (!envelope.success) return {}
  const inner = envelope.data.enhanced ?? envelope.data.result
  if (inner) {
    return {
      enhanced: toEnhancedSpec(inner),
      qa: envelope.data.qa,
      analysis: envelope.data.analysis,
      meta: envelope.data.meta,
    }
  }
  const nested = asEnhanceRecord(envelope.data.data)
  const fromNested = nested ? readEnhancedPayload(nested) : {}
  return {
    enhanced: fromNested.enhanced,
    qa: envelope.data.qa ?? fromNested.qa,
    analysis: envelope.data.analysis ?? fromNested.analysis,
    meta: envelope.data.meta ?? fromNested.meta,
  }
}

export interface EnhanceTaskInput {
  mode: EnhanceMode
  title: string
  spec: string
  workspace: string
  outputRepo?: string
  writeTarget: WriteTarget
  taskType: TaskType
  delivery: Delivery
  sources: SourceRepoInput[]
  /** Previous adversarial QA findings, used by Regenerate with QA fixes. */
  qaFindings?: string[]
}

/** Typed result: `ok` means HTTP success AND a usable enhanced spec. `status`
 *  is the HTTP status (0 = no response). `error` is operator-readable. */
export interface EnhanceResult {
  ok: boolean
  status: number
  error?: string
  enhanced?: EnhancedSpec
  qa?: QaReview
  analysis?: EnhanceAnalysis
  meta?: EnhanceMeta
}

/** Ask the local enhancer to improve/analyze the spec. Never creates a task. */
export async function enhanceTaskSpec(input: EnhanceTaskInput): Promise<EnhanceResult> {
  // Mirror the server contract before spending a model turn on a 400.
  const missing: string[] = []
  if (!input.title.trim()) missing.push('a title')
  if (!input.spec.trim()) missing.push('a spec')
  if (!input.workspace.trim()) missing.push('a project workspace')
  if (missing.length) {
    return { ok: false, status: 0, error: `Add ${missing.join(', ')} before running the enhancer.` }
  }
  try {
    const response = await fetch('/api/v1/enhance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(420000),
      body: JSON.stringify({
        mode: input.mode,
        title: input.title.trim(),
        spec: input.spec.trim(),
        workspace: input.workspace.trim(),
        outputRepo: input.outputRepo?.trim() || undefined,
        writeTarget: input.writeTarget,
        taskType: input.taskType,
        delivery: input.delivery,
        sources: input.sources
          .filter((source) => source.id.trim() && source.path.trim())
          .map((source) => ({ id: source.id.trim(), path: source.path.trim() })),
        qaFindings: input.qaFindings?.length ? input.qaFindings : undefined,
      }),
    })
    const text = await response.text().catch(() => '')
    let payload: unknown = null
    try { payload = text.trim() ? JSON.parse(text) : null } catch { payload = null }
    if (!response.ok) {
      const fallback = text.trim().slice(0, 300)
      return { ok: false, status: response.status, error: enhanceErrorText(payload, fallback || `Enhancer request failed (${response.status}).`) }
    }
    const { enhanced, qa, analysis, meta } = readEnhancedPayload(payload)
    if (!enhanced) {
      return { ok: false, status: response.status, error: enhanceErrorText(payload, 'The enhancer returned no enhanced spec.') }
    }
    return { ok: true, status: response.status, enhanced, qa, analysis, meta }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      status: 0,
      error: timedOut
        ? 'The enhancer timed out after 420 seconds.'
        : error instanceof Error
          ? error.message
          : 'The enhancer is unavailable.',
    }
  }
}

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
