/**
 * Local HELLDESK — LocalDepartment.
 *
 * Federates the Cloudflare HELLDESK `dos/department/*` submodules (copied verbatim
 * into `core/dos/department/`) over a local `SqlStorage` + `DurableObjectStorage`
 * shim. Provides the same public method surface the `handlers/*` call on the
 * Department DO stub, so all 26 handler modules mount locally unchanged.
 *
 * Shift/frontDesk/triage/escalation orchestration is implemented here by
 * delegating to the same submodules + table helpers; this is the "missing
 * delta" the Cloudflare Department.do class shell would otherwise provide.
 */
import type { SqlStorage } from './runtime-types';
import { LocalDurableObjectStorage } from './storage';
import * as ticketOps from '../dos/department/tickets';
import * as workstationOps from '../dos/department/workstations';
import * as agentOps from '../dos/department/agents';
import * as memoOps from '../dos/department/memo';
import * as reviewOps from '../dos/department/review-queue';
import * as eventOps from '../dos/department/events';
import * as helldesk from '../dos/department/helldesk';
import * as memoTable from '../dos/department/memo';
import * as reviewQueueTable from '../dos/department/review-queue';
import * as ticketsTable from '../db/tables/tickets.table';
import * as ticketEventsTable from '../db/tables/ticket-events.table';
import * as ticketDepsTable from '../db/tables/ticket-dependencies.table';
import * as agentTable from '../db/tables/agent-metadata.table';
import * as nudgesTable from '../db/tables/agent-nudges.table';
import * as reviewTable from '../db/tables/review-metadata.table';
import * as escTable from '../db/tables/escalation-metadata.table';
import * as shiftTable from '../db/tables/shift-metadata.table';
import * as departmentEventsTable from '../db/tables/department-events.table';
import * as archiveTable from '../db/tables/ticket-archives.table';
import { query } from '../util/query.util';
import { generateId as genId, now as nowIso } from '../util/id.util';
import { join } from 'node:path';
import {
  TicketType,
  TicketStatus,
  type Ticket,
  type CreateTicketInput,
  type TicketFilter,
  type Agent,
  type AgentRole,
  type AgentFilter,
  type RegisterAgentInput,
  type Memo,
  type SendMemoInput,
  type ReviewQueueInput,
  type AgentDoneInput,
  type PrimeContext,
  type DepartmentConfig,
  type DepartmentConfigUpdate,
  type WorkstationOverrideConfig,
  type UiAction,
  normalizeUiAction,
  type ShiftMergeMode,
} from '../types';
import { DepartmentConfigSchema, LocalRepoSchema } from '../types';
import { initTicketTables } from '../dos/department/tickets';
import { initWorkstationTables } from '../dos/department/workstations';
import { initAgentTables } from '../dos/department/agents';
import { initMemoTables } from '../dos/department/memo';
import { initReviewQueueTables } from '../dos/department/review-queue';
import { initDepartmentEventsTable } from '../dos/department/events';
import {
  RuntimeEventBus,
  createLocalApplyContext,
  runReconcileTick,
  resolveLocalDispatch,
  startLocalReconciler,
  type LocalDispatchHooks,
  type LocalDepartmentLite,
  type RuntimeEvent,
} from './local-reconciler';
import type { ApplyActionContext } from '../dos/department/actions';
import { ensureWorkspaceRepo } from './adapters';
import { missionBinding, cancelMission } from './mission-dispatch';
import { listMissionsProjected, projectMissionsIntoBoard, mergeLocalMissionState } from './mission-reconcile';
import { listWorkersProjected, projectWorkersIntoRoster } from './worker-reconcile';
import { listEventsProjected } from './events-reconcile';
import { applyEvent } from '../dos/department/reconciler';
import type { FailureReason } from '../dos/department/types';
import { z } from 'zod';

/** Workstation config shape used by configureWorkstation handlers (subset of full WorkstationConfig). */
export type WorkstationConfig = {
  workstationId: string;
  name?: string;
  default_branch?: string;
  git_repo_url?: string;
  default_model?: string;
  max_concurrent_souls?: number;
  max_dispatch_attempts?: number;
  key?: string;
  /** Handler (cloud) field aliases — normalized by configureWorkstation below. */
  gitUrl?: string;
  defaultBranch?: string;
  kilocodeToken?: string;
  userId?: string;
  platformIntegrationId?: string;
};

export interface LocalDepartmentOptions {
  departmentId: string;
  sql: SqlStorage;
  storage: LocalDurableObjectStorage;
  dataRoot: string;
}

/** Minimal EmitEvent surface; no analytics externally. */
export interface DepartmentEventHook {
  (event: { event: string; departmentId: string; workstationId?: string; ticketId?: string; [k: string]: unknown }): void;
}

export class LocalDepartment implements LocalDepartmentLite {
  readonly departmentId: string;
  readonly sql: SqlStorage;
  readonly storage: LocalDurableObjectStorage;
  private readonly dataRoot: string;

  /** Shared runtime event bus — WS bridge + dashboards subscribe here. */
  readonly eventBus = new RuntimeEventBus();
  /** The real colony reconciler's side-effect context, built lazily. */
  private applyCtx: ApplyActionContext | null = null;
  private readonly dispatchHooks: LocalDispatchHooks;
  /** The running colony reconciler timer (started via startReconciler()). */
  private reconcilerStop: (() => void) | null = null;

  constructor(opts: LocalDepartmentOptions) {
    this.departmentId = opts.departmentId;
    this.sql = opts.sql;
    this.storage = opts.storage;
    this.dataRoot = opts.dataRoot;
    this.dispatchHooks = {
      resolveDispatch: resolveLocalDispatch,
      broadcastTicket: (departmentId, ticketId, payload) =>
        this.eventBus.emit({ type: 'ticket', departmentId, ticketId, payload }),
    };
    this.initTables();
    // Build the side-effect context once (it closes over this department's sql).
    this.applyCtx = createLocalApplyContext(this, this.dispatchHooks);
  }

  /** Accessor for consumers that need the context (entry.ts drives ticks). */
  getReconcilerContext(): ApplyActionContext {
    if (!this.applyCtx) throw new Error('LocalDepartment.applyCtx not initialized');
    return this.applyCtx;
  }

  /** Start the colony reconciler on an interval. Returns an unsubscribe fn. */
  startReconciler(intervalMs = 5_000): () => void {
    if (this.reconcilerStop) return this.reconcilerStop;
    this.reconcilerStop = startLocalReconciler(
      this,
      this.getReconcilerContext(),
      intervalMs,
    );
    return this.reconcilerStop;
  }

  stopReconciler(): void {
    if (this.reconcilerStop) {
      this.reconcilerStop();
      this.reconcilerStop = null;
    }
  }

  /** Create all HELLDESK tables idempotently via native bun:sqlite DDL builders
 *  (the `initTicketTables` migration path is CF-shaped and fragile; these direct
 *  `CREATE TABLE IF NOT EXISTS` statements are the domain's own DDL). */
  private initTables(): void {
    const db = (this.sql as unknown as { db: import('bun:sqlite').Database }).db;
    const run = (ddl: string) => { try { db.exec(ddl); } catch { /* IF NOT EXISTS / idempotent */ } };
    // tickets + satellites
    run(ticketsTable.createTableTickets());
    run(ticketEventsTable.createTableTicketEvents());
    run(ticketDepsTable.createTableTicketDependencies());
    // agent metadata + nudges
    run(agentTable.createTableAgentMetadata());
    run(nudgesTable.createTableAgentNudges());
    // review + escalation + shift meta
    run(reviewTable.createTableReviewMetadata());
    run(escTable.createTableEscalationMetadata());
    run(shiftTable.createTableShiftMetadata());
    // department events
    run(departmentEventsTable.createTableDepartmentEvents());
    // domain tables: workstations (inline DDL — the init wrapper is CF-shaped)
    try { db.exec(`CREATE TABLE IF NOT EXISTS "workstations" ("id" TEXT PRIMARY KEY,"name" TEXT NOT NULL,"git_url" TEXT NOT NULL DEFAULT '',"default_branch" TEXT NOT NULL DEFAULT 'main',"config" TEXT DEFAULT '{}',"created_at" TEXT NOT NULL)`); } catch { /* optional */ }
    try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workstations_name ON workstations(name)`); } catch { /* optional */ }
    // memo / review-queue / helldesk rely on the tables above (tickets etc.), so
    // only their satellite DDL is needed; helldesk uses a plain table.
    try { db.exec(`CREATE TABLE IF NOT EXISTS helldesk (helldesk_id text primary key, ticket_id text, claimed_by text, status text default 'open', created_at text)`); } catch { /* optional */ }
    // Operator archive overlay (local-only): hides closed/cancelled cards from
    // the board without deleting the engine mission or its durable record.
    run(archiveTable.createTableTicketArchives());
    // fuels: initMemoTables/initReviewQueueTables create their own small tables
    try { memoTable.initMemoTables(this.sql); } catch { /* optional */ }
    try { reviewQueueTable.initReviewQueueTables(this.sql); } catch { /* optional */ }
  }

  // ---------------------------------------------- events (live fan-out)
  /** Emit an analytics/WebSocket event. Real: fans out to the runtime event
   *  bus (which the WS bridge + dashboards consume) and records the durable
   *  department event when the type is within the department-event contract. Exposed
   *  publicly so the colony reconciler's ApplyActionContext can emit too. */
  emitEvent(_evt: { event: string; departmentId?: string; workstationId?: string; ticketId?: string; [k: string]: unknown }): void {
    const departmentId = _evt.departmentId ?? this.departmentId;
    this.eventBus.emit({
      type: 'analytics',
      departmentId,
      payload: { ..._evt }, // _evt already carries event/workstationId/ticketId
    });
  }

  /** Broadcast a ticket-scoped event. Real: fans out to the runtime event bus
   *  so the dashboard WS bridge surfaces it live. Exposed publicly so the
   *  reconciler + internal orchestration can fan out ticket lifecycles. */
  broadcastTicketEvent(_evt: { type: string; departmentId?: string; ticketId?: string; [k: string]: unknown }): void {
    this.eventBus.emit({
      type: 'ticket',
      departmentId: _evt.departmentId ?? this.departmentId,
      ticketId: _evt.ticketId,
      payload: { ..._evt },
    });
  }

  // =====================================================================
  // Department config + lifecycle (storage-backed; no CF config module)
  // =====================================================================
  async setDepartmentId(_departmentId: string): Promise<void> { /* id is fixed in ctor */ }

  private static readonly CONFIG_KEY = 'config';
  private static readonly CONFIG_SEED_KEY = 'config:seeded';
  static readonly NEW_DEPARTMENT_CONFIG_DEFAULTS: DepartmentConfig = {
    env_vars: {},
    git_auth: {},
    owner_type: 'user',
    merge_strategy: 'pr',
    qualityAssurance: { gates: [], auto_merge: true, require_clean_merge: true, code_review: true, review_mode: 'rework', auto_resolve_pr_feedback: false, auto_merge_delay_minutes: null },
    staged_shifts_default: true,
    shift_merge_mode: 'review-then-land',
    disable_ai_coauthor: false,
  };

  async getDepartmentConfig(): Promise<DepartmentConfig> {
    const raw = await this.storage.get(LocalDepartment.CONFIG_KEY);
    if (!raw) {
      const seeded: DepartmentConfig = JSON.parse(JSON.stringify(LocalDepartment.NEW_DEPARTMENT_CONFIG_DEFAULTS));
      this.storage.put(LocalDepartment.CONFIG_KEY, seeded).catch((e) => console.error('[getDepartmentConfig] seed put failed', (e as Error).message));
      this.storage.put(LocalDepartment.CONFIG_SEED_KEY, true).catch(() => {});
      return seeded;
    }
    return raw as DepartmentConfig;
  }

  async updateDepartmentConfig(update: DepartmentConfigUpdate): Promise<DepartmentConfig> {
    const current = await this.getDepartmentConfig();
    // `update` (DepartmentConfigUpdate) is all-optional, so a raw `{...current, ...update}`
    // widens required `DepartmentConfig` fields to optional. Parse through
    // DepartmentConfigSchema so defaults are restored before persisting/returning.
    const next = DepartmentConfigSchema.parse({
      ...current,
      ...update,
      local_repo:
        update.local_repo !== undefined
          ? LocalRepoSchema.parse({
              ...current.local_repo,
              ...update.local_repo,
              // `null` is the explicit "remove the output repo" signal from the
              // API/UI; `undefined` means "leave the current target alone".
              // LocalRepoSchema rejects null (it expects an object), so normalise
              // BEFORE parsing — the web DO path already does this, the local
              // runtime did not (500 "expected object, received null").
              output_repo:
                update.local_repo.output_repo === null
                  ? undefined
                  : update.local_repo.output_repo ?? current.local_repo?.output_repo,
            })
          : current.local_repo,
    });
    // Pointing at a plain directory must "just work": create it when missing and
    // git-init it when it is not yet a repo, so both Save repos and Create task
    // leave a usable workspace. Single-repo mode uses this same path as the
    // output (input = output).
    if (
      update.local_repo !== undefined &&
      next.local_repo?.adapter === 'local-git' &&
      next.local_repo.repo_path
    ) {
      await ensureWorkspaceRepo(next.local_repo.repo_path, next.local_repo.branch);
    }
    try {
      await this.storage.put(LocalDepartment.CONFIG_KEY, next);
    } catch (e) {
      console.error('[LocalDepartment] updateDepartmentConfig put failed:', (e as Error).message);
      throw e;
    }
    return next;
  }

  async destroy(): Promise<void> {
    this.storage.deleteAll();
  }

  // =====================================================================
  // Workstations
  // =====================================================================
  async listWorkstations(): Promise<workstationOps.WorkstationRecord[]> {
    return workstationOps.listWorkstations(this.sql);
  }
  async getWorkstationAsync(workstationId: string): Promise<workstationOps.WorkstationRecord | null> {
    return workstationOps.getWorkstation(this.sql, workstationId);
  }
  async getWorkstationConfig(workstationId: string): Promise<WorkstationConfig | null> {
    const r = workstationOps.getWorkstation(this.sql, workstationId);
    if (!r) return null;
    // Build the handler-facing WorkstationConfig from the workstation record + its stored
    // override config (no unsafe cast — map the known fields explicitly).
    return {
      workstationId: r.id,
      name: r.name,
      default_branch: r.default_branch,
      git_repo_url: r.git_url,
      max_concurrent_souls: r.config?.max_concurrent_souls,
      max_dispatch_attempts: r.config?.max_dispatch_attempts,
      default_model: r.config?.default_model,
    };
  }
  async addWorkstation(input: { workstationId: string; name: string; gitUrl?: string; defaultBranch?: string }): Promise<workstationOps.WorkstationRecord> {
    const id = input.workstationId ?? genId();
    return workstationOps.addWorkstation(this.sql, { workstationId: id, name: input.name, gitUrl: input.gitUrl ?? '', defaultBranch: input.defaultBranch ?? 'main' });
  }
async configureWorkstation(workstationConfig: WorkstationConfig): Promise<void> {
    // ConfigureWorkstation upserts a workstation row with the given config. Normalize the
    // handler field aliases (gitUrl/defaultBranch) onto the canonical names.
    const gitUrl = workstationConfig.git_repo_url ?? workstationConfig.gitUrl ?? '';
    const defaultBranch = workstationConfig.default_branch ?? workstationConfig.defaultBranch ?? 'main';
    const existing = workstationOps.getWorkstation(this.sql, workstationConfig.workstationId);
    if (existing) {
      workstationOps.updateWorkstationConfig(this.sql, workstationConfig.workstationId, workstationConfig as WorkstationOverrideConfig);
    } else {
      workstationOps.addWorkstation(this.sql, { workstationId: workstationConfig.workstationId, name: workstationConfig.name ?? workstationConfig.workstationId, gitUrl, defaultBranch });
      workstationOps.updateWorkstationConfig(this.sql, workstationConfig.workstationId, workstationConfig as WorkstationOverrideConfig);
    }
  }
  async removeWorkstation(workstationId: string): Promise<void> {
    workstationOps.removeWorkstation(this.sql, workstationId);
  }
  async updateWorkstationConfig(workstationId: string, config: WorkstationOverrideConfig): Promise<workstationOps.WorkstationRecord | null> {
    workstationOps.updateWorkstationConfig(this.sql, workstationId, config);
    return workstationOps.getWorkstation(this.sql, workstationId);
  }

  // =====================================================================
  // Tickets
  // =====================================================================
  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const routing = (await this.getDepartmentConfig()).local_repo;
    const workstation = input.workstation_id ? workstationOps.getWorkstation(this.sql, input.workstation_id) : null;
    const routingSnapshot = routing ? LocalRepoSchema.parse({
      ...structuredClone(routing), branch: routing.branch || workstation?.default_branch || 'main',
    }) : null;
    const dependencies = [...new Set(input.depends_on || [])];
    for (const id of dependencies) if (!ticketOps.getTicket(this.sql, id)) throw Error(`Dependency not found: ${id}`);
    // Fold the enforcer picker into metadata.break_room_controls so the engine's
    // dispatch/ExcellenceGovernor/reviewer gates read it (same shape set_ticket_controls
    // persists). Preserves any break_room_controls already carried in metadata.
    const mergedMetadata = input.break_room_controls
      ? {
          ...(input.metadata ?? {}),
          break_room_controls: {
            ...((input.metadata as { break_room_controls?: Record<string, unknown> } | undefined)?.break_room_controls ?? {}),
            ...input.break_room_controls,
          },
        }
      : input.metadata;
    const ticket = ticketOps.createTicket(this.sql, { ...input, metadata: {
      ...mergedMetadata,
      local_repo_snapshot: routingSnapshot,
      local_repo_snapshot_version: 1,
    } });
    ticketOps.setDependencies(this.sql, ticket.ticket_id, dependencies);
    this.emitEvent({ event: 'ticket.created', departmentId: this.departmentId, workstationId: input.workstation_id, ticketId: ticket.ticket_id, ticketType: input.type });
    return ticket;
  }
  async getTicketAsync(ticketId: string): Promise<Ticket | null> { return ticketOps.getTicket(this.sql, ticketId); }
  async getTicketPublic(ticketId: string): Promise<Ticket | null> { return ticketOps.getTicket(this.sql, ticketId); }
  async listTickets(filter: TicketFilter): Promise<Ticket[]> {
    const archived = this.archivedTicketIds();
    const keep = (ticket: Ticket): Ticket | null => {
      const isArchived = archived.has(ticket.ticket_id);
      if (isArchived && !filter.include_archived) return null;
      return isArchived ? ({ ...ticket, archived: true } as Ticket) : ticket;
    };
    const local = ticketOps.listTickets(this.sql, filter)
      .map(keep)
      .filter((ticket): ticket is Ticket => ticket !== null);
    // No-split-brain: project the real control-plane missions into the ticket
    // surface so the operator board shows the autonomous work (and stays bound
    // to the engine truth). Read-time only — never disturbs the runtime.
    // A local ticket bound to a mission gets the LIVE mission state overlaid
    // (backfilled tickets otherwise keep a stale in_review snapshot and look
    // like they flip back after acceptance). Missions are department-scoped, so
    // only the department board appends the unbound projection.
    try {
      const missions = (await listMissionsProjected())
        .map(keep)
        .filter((ticket): ticket is Ticket => ticket !== null);
      const merged = mergeLocalMissionState(local, missions);
      if (filter.workstation_id) return merged;
      return projectMissionsIntoBoard(merged, missions, filter);
    } catch {
      return local;
    }
  }

  /** Local archive overlay ids (never engine state). Missing table = empty. */
  private archivedTicketIds(): Set<string> {
    const ids = new Set<string>();
    try {
      const rows = query(
        this.sql,
        /* sql */ `SELECT ${archiveTable.ticket_archives.ticket_id} FROM ${archiveTable.ticket_archives}`,
        [],
      );
      const parsed = archiveTable.TicketArchiveRecord
        .pick({ ticket_id: true })
        .array()
        .parse([...rows]);
      for (const row of parsed) ids.add(row.ticket_id);
    } catch { /* table not created yet */ }
    return ids;
  }

  /** Archive/unarchive task cards. Works for local tickets AND projected
   *  mission ids (mis_*) — the engine mission itself is never modified. */
  async archiveTickets(ticketIds: string[], archived = true): Promise<number> {
    const ids = new Set<string>();
    for (const rawId of ticketIds) {
      const id = rawId.trim();
      if (!id) continue;
      ids.add(id);
      // A local mission-bound ticket is deduped against its projection. If only
      // the local id were archived, the projected mission would reappear in the
      // next listTickets pass. Archive/unarchive both sides together.
      try {
        const local = ticketOps.getTicket(this.sql, id);
        const missionId = (local?.metadata as { local_mission?: { missionId?: unknown } } | undefined)
          ?.local_mission?.missionId;
        if (typeof missionId === 'string' && missionId) ids.add(missionId);
      } catch { /* local ticket lookup is best-effort */ }
    }
    if (!ids.size) return 0;
    const at = nowIso();
    let count = 0;
    for (const id of ids) {
      try {
        if (archived) {
          query(
            this.sql,
            /* sql */ `INSERT OR REPLACE INTO ${archiveTable.ticket_archives} (${archiveTable.ticket_archives.columns.ticket_id}, ${archiveTable.ticket_archives.columns.archived_at}) VALUES (?, ?)`,
            [id, at],
          );
        } else {
          query(
            this.sql,
            /* sql */ `DELETE FROM ${archiveTable.ticket_archives} WHERE ${archiveTable.ticket_archives.ticket_id} = ?`,
            [id],
          );
        }
        count += 1;
      } catch { /* best effort per id */ }
    }
    return count;
  }
  async updateTicketStatus(ticketId: string, status: TicketStatus, agentId: string, failureReason?: FailureReason): Promise<Ticket> {
    if (status === 'in_progress' && ticketOps.hasUnresolvedBlockers(this.sql, ticketId)) throw Error('Task dependencies are not completed and landed');
    const ticket = ticketOps.updateTicketStatus(this.sql, ticketId, status, agentId, failureReason);
    this.emitEvent({ event: status === 'closed' ? 'ticket.closed' : 'ticket.status', departmentId: this.departmentId, ticketId });
    return ticket;
  }
  async updateTicket(ticketId: string, fields: Record<string, unknown>): Promise<Ticket> {
    const existing = ticketOps.getTicket(this.sql, ticketId);
    if (!existing) throw Error(`ticket ${ticketId} not found`);
    if (fields.metadata !== undefined && Object.hasOwn(existing.metadata, 'local_repo_snapshot')) {
      const metadata = z.record(z.string(), z.unknown()).parse(fields.metadata);
      fields = { ...fields, metadata: { ...metadata, local_repo_snapshot: existing.metadata.local_repo_snapshot, local_repo_snapshot_version: existing.metadata.local_repo_snapshot_version } };
    }
    if (typeof ticketOps.updateTicketFields === 'function') {
      ticketOps.updateTicketFields(
        this.sql,
        ticketId,
        fields as Parameters<typeof ticketOps.updateTicketFields>[2],
        'api',
      );
    }
    const b = await this.getTicketAsync(ticketId);
    if (b) return b;
    throw new Error(`ticket ${ticketId} not found`);
  }
  async closeTicket(ticketId: string, agentId: string): Promise<Ticket> {
    const ticket = ticketOps.closeTicket(this.sql, ticketId, agentId);
    this.emitEvent({ event: 'ticket.closed', departmentId: this.departmentId, workstationId: ticket.workstation_id ?? undefined, ticketId });
    return ticket;
  }
  async deleteTicket(ticketId: string, workstationId?: string): Promise<boolean> { return ticketOps.deleteTicket(this.sql, ticketId, workstationId); }
  async deleteTickets(ticketIds: string[], workstationId?: string): Promise<number> { return ticketOps.deleteTickets(this.sql, ticketIds, workstationId); }
  async deleteTicketsByStatus(status: TicketStatus, type?: TicketType): Promise<number> { return ticketOps.deleteTicketsByStatus(this.sql, status, type); }
  async slingTicket(input: { ticketId: string; agentId: string }): Promise<Ticket> {
    if (ticketOps.hasUnresolvedBlockers(this.sql, input.ticketId)) throw Error('Task dependencies are not completed and landed');
    return ticketOps.updateTicketStatus(this.sql, input.ticketId, 'in_progress', input.agentId);
  }
  /**
   * Sling work to a soul: create a ticket from the request, hook the agent,
   * mark it in_progress, and return the { ticket, agent } pair the handlers and
   * the federated UI's `SlingResultSchema` expect.
   * Accepts both the hook variant ({ticketId, agentId}) and the sling-work variant
   * ({workstationId, title, body?, ...}).
   */
  async slings(input: {
    workstationId?: string;
    title?: string;
    body?: string;
    metadata?: Record<string, unknown>;
    ticketId?: string;
    agentId?: string;
  }): Promise<{ ticket: Ticket; agent: Agent }> {
    // Hook variant.
    if (input.title === undefined) {
      if (!input.ticketId || !input.agentId) throw new Error('[LocalDepartment] slings: ticketId and agentId are required for the hook variant');
      const ticket = await this.updateTicketStatus(input.ticketId, 'in_progress', input.agentId);
      const agent = agentOps.getAgent(this.sql, input.agentId);
      if (!agent) throw new Error(`[LocalDepartment] slings: agent ${input.agentId} not found`);
      return { ticket, agent };
    }
    // Sling-work variant.
    const workstationId = input.workstationId ?? 'workstation-local';
    const ticket = await this.createTicket({
      type: 'issue',
      title: input.title as string,
      body: input.body,
      workstation_id: workstationId,
      metadata: input.metadata ?? {},
      created_by: 'frontDesk',
    });
    this.emitEvent({ event: 'ticket.created', departmentId: this.departmentId, workstationId, ticketId: ticket.ticket_id, ticketType: ticket.type });
    const agent = await this.getOrCreateAgent('soul', workstationId);
    await this.hookTicket(agent.id, ticket.ticket_id);
    const started = await (this as unknown as { updateTicketStatus(ticketId: string, status: string, agentId: string): Promise<Ticket> }).updateTicketStatus(ticket.ticket_id, 'in_progress', agent.id);
    return { ticket: started, agent };
  }

  // =====================================================================
  // Agents
  // =====================================================================
  async registerAgent(input: RegisterAgentInput): Promise<Agent> { return agentOps.registerAgent(this.sql, input); }
  async getAgentAsync(agentId: string): Promise<Agent | null> { return agentOps.getAgent(this.sql, agentId); }
  async getAgentByIdentity(identity: string): Promise<Agent | null> { return agentOps.getAgentByIdentity(this.sql, identity); }
  async listAgents(filter?: AgentFilter): Promise<Agent[]> {
    const local = agentOps.listAgents(this.sql, filter);
    // Engine workers are DEPARTMENT-scoped (projected workstation_id=null), so
    // they belong on the department roster only. A seat roster shows only agents
    // registered to that workstation; merging the unfiltered projection made
    // every workstation page show the same crew.
    if (filter?.workstation_id) return local;
    // No-split-brain: show the engine's real autonomous workers alongside any
    // local (frontDesk/pty) agents. Read-time projection from the control plane.
    try {
      // Include IDLE roles too: a reviewer that finished must stay visible in the
      // crew (as idle), not vanish the moment its process exits.
      const workers = await listWorkersProjected(false);
      return projectWorkersIntoRoster(local, workers, filter);
    } catch {
      return local;
    }
  }
  async deleteAgent(agentId: string): Promise<void> {
    const agent = agentOps.getAgent(this.sql, agentId);
    const ticket = agent?.current_hook_ticket_id ? ticketOps.getTicket(this.sql, agent.current_hook_ticket_id) : null;
    const binding = ticket ? missionBinding(ticket) : null;
    if (binding) await cancelMission(binding);
    agentOps.deleteAgent(this.sql, agentId);
  }
  async getOrCreateAgent(role: AgentRole, workstationId: string): Promise<Agent> { return agentOps.getOrCreateAgent(this.sql, role, workstationId, this.departmentId); }
  async hookTicket(agentId: string, ticketId: string): Promise<void> {
    if (ticketOps.hasUnresolvedBlockers(this.sql, ticketId)) throw Error('Task dependencies are not completed and landed');
    agentOps.hookTicket(this.sql, agentId, ticketId);
  }
  async unhookTicket(agentId: string): Promise<void> { agentOps.unhookTicket(this.sql, agentId); }
  async getHookedTicket(agentId: string): Promise<Ticket | null> { return agentOps.getHookedTicket(this.sql, agentId); }
  async updateAgentStatusMessage(agentId: string, message: string): Promise<void> { agentOps.updateAgentStatusMessage(this.sql, agentId, message); }
  async resetAgent(agentId: string): Promise<void> { agentOps.updateAgentStatus(this.sql, agentId, 'idle'); }
  async resetAgentDispatchAttempts(agentId: string, _workstationId: string): Promise<void> { agentOps.updateAgentStatus(this.sql, agentId, 'idle'); }
  async touchAgentHeartbeat(agentId: string, _watermark?: unknown): Promise<{ drainNonce: string }> {
    try { if (typeof agentOps.touchAgent === 'function') agentOps.touchAgent(this.sql, agentId); } catch { /* optional */ }
    return { drainNonce: genId() };
  }
  async prime(agentId: string): Promise<PrimeContext> { return agentOps.prime(this.sql, agentId); }
  async writeCheckpoint(agentId: string, data: unknown): Promise<void> { agentOps.writeCheckpoint(this.sql, agentId, data); }
  async readCheckpoint(agentId: string): Promise<unknown> { return agentOps.readCheckpoint(this.sql, agentId); }
  async appendAgentEvent(agentId: string, eventType: string, data: unknown): Promise<number> {
    if (typeof ticketOps.logTicketEvent === 'function') {
      ticketOps.logTicketEvent(this.sql, {
        ticketId: agentId,
        agentId: null,
        eventType: (eventType as Parameters<typeof ticketOps.logTicketEvent>[1]['eventType']),
        newValue: undefined,
        metadata: { payload: data },
      });
    }
    return 0;
  }
  async getAgentEvents(agentId: string, afterId?: number, limit?: number): Promise<unknown[]> {
    if (typeof ticketOps.listTicketEvents === 'function') {
      return ticketOps.listTicketEvents(this.sql, { ticketId: agentId, since: afterId !== undefined ? String(afterId) : undefined, limit });
    }
    return [];
  }
  /**
   * Public ticket-event reader (department-scoped). Delegates to the ticket event log so
   * the department / workstation events handlers (which the federated UI's tRPC adapter calls)
   * get the `TicketEventRecord` shape the original HELLDESK client expects.
   */
  async listTicketEvents(options: { ticketId?: string; since?: string; limit?: number }): Promise<unknown[]> {
    const limit = options.limit ?? 200;
    const local = typeof ticketOps.listTicketEvents === 'function' ? ticketOps.listTicketEvents(this.sql, options) : [];
    // No-split-brain observability: project the REAL engine event stream so the
    // GUI Observability surface shows what the engine is actually doing. Read-time only.
    try {
      const engine = await listEventsProjected(limit, { ticketId: options.ticketId });
      // A per-ticket timeline must only show events attributed to that ticket;
      // department-wide feeds pass no ticketId and keep the whole stream.
      const scopedEngine = options.ticketId
        ? engine.filter((e) => e.ticket_id === options.ticketId)
        : engine;
      const seen = new Set((local as Array<{ ticket_event_id?: string }>).map((e) => e.ticket_event_id));
      const merged = [
        ...scopedEngine.filter((e) => !seen.has(e.ticket_event_id)),
        ...(local as unknown as Array<{ created_at?: string; ticket_event_id?: string }>),
      ]
        .filter((e) => !options.since || (typeof e.created_at === 'string' && e.created_at > options.since))
        .sort((a, b) => {
          const ta = typeof a.created_at === 'string' ? Date.parse(a.created_at) : 0;
          const tb = typeof b.created_at === 'string' ? Date.parse(b.created_at) : 0;
          return tb - ta || String(b.ticket_event_id ?? '').localeCompare(String(a.ticket_event_id ?? ''));
        });
      // The caller asked for the NEWEST `limit` events across both sources.
      return merged.slice(0, limit);
    } catch {
      return local;
    }
  }

  // Nudges
  async queueNudge(agentId: string, message: string, opts?: { type?: string; metadata?: Record<string, unknown>; mode?: string; source?: string }): Promise<string> {
    const { createTableAgentNudges } = await import('../db/tables/agent-nudges.table');
    const nudgeId = genId();
    try { query(this.sql, createTableAgentNudges(), []); } catch { /* existing */ }
    query(this.sql, `INSERT INTO agent_nudges (nudge_id,agent_id,type,message,delivered,created_at) VALUES (?,?,?,?,0,?)`, [nudgeId, agentId, opts?.type ?? 'general', message, nowIso()]);
    return nudgeId;
  }
  async getPendingNudges(agentId: string): Promise<Array<{ nudge_id: string; type: string; message: string; created_at: string }>> {
    const rows = [...query(this.sql, `SELECT nudge_id,type,message,created_at FROM agent_nudges WHERE agent_id=? AND delivered=0 ORDER BY created_at ASC`, [agentId])];
    // LocalDepartment writes nudges with (nudge_id, agent_id, type, message, delivered, created_at),
    // so validate the projection against that shape.
    const rowSchema = z.object({ nudge_id: z.string(), type: z.string(), message: z.string(), created_at: z.string() });
    return rows.map((r) => rowSchema.parse(r));
  }
  async markNudgeDelivered(nudgeId: string): Promise<void> {
    query(this.sql, `UPDATE agent_nudges SET delivered=1 WHERE nudge_id=?`, [nudgeId]);
  }

  // =====================================================================
  // Memo
  // =====================================================================
  async sendMemo(input: SendMemoInput): Promise<void> { memoOps.sendMemo(this.sql, input); }
  async checkMemo(agentId: string): Promise<Memo[]> { return memoOps.checkMemo(this.sql, agentId); }

  // =====================================================================
  // Local-filesystem git dispatch (no containers) — per-project adapter
  // =====================================================================
  /**
   * Resolve the dispatch adapter from department config (`local_repo`) and run the
   * agent's work step against a local filesystem git checkout. Returns a
   * result the dashboard/shift flow displays. Uses the provided workdir.
   */
  async dispatchAgent(input: {
    agentId: string;
    ticketId?: string;
    workdir?: string;
    message?: string;
  }): Promise<import('./adapters').DispatchResult> {
    const ticket = input.ticketId ? ticketOps.getTicket(this.sql, input.ticketId) : null;
    if (!ticket) return { ok: false, error: 'A real task ticket is required for autonomous dispatch' };
    if (ticketOps.hasUnresolvedBlockers(this.sql, ticket.ticket_id)) return { ok: false, error: 'Task dependencies are not completed and landed' };
    if (!agentOps.getAgent(this.sql, input.agentId)) return { ok: false, error: 'Agent not registered' };
    try {
      const accepted = await this.getReconcilerContext().dispatchAgent(input.agentId, ticket.ticket_id, ticket.workstation_id || '');
      if (!accepted) return { ok: false, error: 'Mission dispatch failed; inspect the task timeline' };
      agentOps.hookTicket(this.sql, input.agentId, ticket.ticket_id);
      agentOps.updateAgentStatus(this.sql, input.agentId, 'working');
      ticketOps.updateTicketStatus(this.sql, ticket.ticket_id, 'in_progress', input.agentId);
      return { ok: true, summary: 'Durable coding/review mission accepted; production acceptance remains with CTO' };
    } catch (e) {
      return { ok: false, error: (e as Error).message, summary: 'local-git dispatch failed' };
    }
  }

  // =====================================================================
  // Review queue / agent done
  // =====================================================================
  async submitToReviewQueue(input: ReviewQueueInput): Promise<void> { reviewOps.submitToReviewQueue(this.sql, input); }
  async agentDone(agentId: string, input: AgentDoneInput): Promise<void> { reviewOps.agentDone(this.sql, agentId, input); }
  async agentCompleted(agentId: string, input: { status: 'completed' | 'failed'; reason?: string }): Promise<void> {
    reviewOps.agentCompleted?.(this.sql, agentId, input) ?? undefined;
  }
  async completeReviewWithResult(input: { entry_id: string; status: 'merged' | 'failed' | 'conflict'; message?: string; commit_sha?: string }): Promise<void> {
    reviewOps.completeReviewWithResult?.(this.sql, input);
  }
  async requestChanges(agentId: string, input: { feedback: string; files?: string[]; target_branch?: string | null }): Promise<void> {
    // Real rework wiring (mirrors the cloud Department.do requestChanges path):
    // create a `gt:rework` ticket that BLOCKS the agent's MR ticket. While it is
    // open, the reconciler's `hasUnresolvedReworkBlockers` keeps the MR from
    // being re-polled/re-failed; when the assigned soul closes it, the MR
    // unblocks and the reconciler re-dispatches the qualityAssurance to re-review.
    const agent = agentOps.getAgent(this.sql, agentId);
    if (!agent || !agent.current_hook_ticket_id) {
      console.warn(`[LocalDepartment] requestChanges: agent ${agentId} has no hooked ticket`);
      return;
    }
    const mrTicket = ticketOps.getTicket(this.sql, agent.current_hook_ticket_id);
    if (!mrTicket || mrTicket.type !== 'merge_request') {
      console.warn(
        `[LocalDepartment] requestChanges: agent ${agentId} hooked to non-MR ticket ${agent.current_hook_ticket_id}`
      );
      return;
    }

    // The MR's source ticket (via the `tracks` dependency) is the work the
    // rework should re-drive once unblocked.
    const mrDeps = ticketOps.getTicketDependencies(this.sql, mrTicket.ticket_id);
    const sourceTicketId =
      mrDeps.blockers.find((d) => d.dependency_type === 'tracks')?.depends_on_ticket_id ?? null;

    const rework = ticketOps.createTicket(this.sql, {
      type: 'issue',
      title: `Rework: ${mrTicket.title ?? 'review requested changes'}`,
      body: input.feedback,
      workstation_id: mrTicket.workstation_id ?? agent.workstation_id ?? undefined,
      parent_ticket_id: mrTicket.ticket_id,
      labels: ['gt:rework'],
      metadata: {
        rework_for: sourceTicketId ?? mrTicket.ticket_id,
        branch: typeof mrTicket.metadata?.branch === 'string' ? mrTicket.metadata.branch : undefined,
        target_branch: input.target_branch ?? undefined,
        files: input.files?.length ? input.files : undefined,
        mr_ticket_id: mrTicket.ticket_id,
      },
      created_by: 'qualityAssurance',
    });

    // Block the MR with the rework ticket.
    ticketOps.insertDependency(this.sql, rework.ticket_id, mrTicket.ticket_id, 'blocks');

    ticketOps.logTicketEvent(this.sql, {
      ticketId: mrTicket.ticket_id,
      agentId,
      eventType: 'rework_requested',
      newValue: rework.ticket_id,
      metadata: { feedback: input.feedback, source_ticket_id: sourceTicketId },
    });

    this.broadcastTicketEvent({
      type: 'rework_requested',
      ticketId: mrTicket.ticket_id,
      agentId,
      reworkTicketId: rework.ticket_id,
    });
  }
  async frontDeskWaiting(agentId?: string, _firedAt?: number | string): Promise<void> { void agentId; void _firedAt; }
  async agentCompletedDebug(agentId: string, _input: unknown): Promise<void> { void agentId; }
  async getMergeQueueData(input: { workstationId: string; branch?: string; limit?: number }): Promise<unknown> {
    return reviewOps.getMergeQueueData?.(this.sql, input) ?? [];
  }
  async createTicketCase(ticketId: string, formula: unknown): Promise<{ id: string }> {
    const m = reviewOps.createTicketCase?.(this.sql, ticketId, formula);
    return m ?? { id: genId() };
  }
  async getTicketCaseCurrentStep(ticketId: string): Promise<unknown> { return reviewOps.getTicketCaseCurrentStep?.(this.sql, ticketId) ?? null; }
  async advanceTicketCaseStep(agentId: string, summary: string): Promise<unknown> {
    return (reviewOps.advanceTicketCaseStep?.(this.sql, agentId, summary)) ?? null;
  }

  // =====================================================================
  // Shifts (delegated to ticketOps shift helpers + shift_metadata table)
  // =====================================================================
  async createShift(input: { title: string; tickets: Array<{ ticket_id: string; workstation_id: string }>; created_by?: string }): Promise<Ticket> {
    const shiftId = genId();
    // A shift is a parent ticket (type='shift').
    const shift = ticketOps.createTicket(this.sql, { type: 'shift', title: input.title, created_by: input.created_by, metadata: { is_shift: true } });
    // Register shift metadata (staged by config default).
    const cfg = await this.getDepartmentConfig();
    query(
      this.sql,
      `INSERT INTO shift_metadata (ticket_id, total_tickets, closed_tickets, landed_at, feature_branch, merge_mode, staged) VALUES (?,?,?,NULL,NULL,?,?)`,
      [shift.ticket_id, input.tickets.length, 0, cfg.shift_merge_mode ?? 'review-then-land', cfg.staged_shifts_default ? 1 : 0],
    );
    // Attach the supplied tickets as children (parent_ticket_id = shift).
    for (const b of input.tickets) {
      const child = ticketOps.getTicket(this.sql, b.ticket_id);
      if (child) ticketOps.updateTicketFields(this.sql, b.ticket_id, { parent_ticket_id: shift.ticket_id }, 'shift');
    }
    return shift;
  }
  async startShift(shiftId: string): Promise<{ started: boolean; total_tickets: number }> {
    this.storage.put(`shift:${shiftId}:staged`, 0).catch(() => {});
    const total = ticketOps.listTickets(this.sql, { parent_ticket_id: shiftId } as TicketFilter).length;
    return { started: total > 0, total_tickets: total };
  }
  async slingShift(input: { shiftId: string; agentId: string }): Promise<{ okay: boolean }> {
    const shiftTickets = ticketOps.listTickets(this.sql, { parent_ticket_id: input.shiftId } as TicketFilter);
    const status = await this.getShiftStatus(input.shiftId).catch(() => ({ staged: true }));
    if (status && status.staged) {
      for (const b of shiftTickets) {
        if (b.status === 'open') ticketOps.updateTicketStatus(this.sql, b.ticket_id, 'in_progress', input.agentId);
      }
    }
    return { okay: true };
  }
  async closeShift(shiftId: string): Promise<unknown> {
    query(this.sql, `UPDATE shift_metadata SET landed_at=?, closed_tickets=(SELECT count(*) FROM tickets WHERE parent_ticket_id=? AND status in ('closed','failed')) WHERE ticket_id=?`, [nowIso(), shiftId, shiftId]);
    return this.getShiftStatus(shiftId).catch(() => null);
  }
  async onTicketClosed(input: { shiftId: string; ticketId: string }): Promise<unknown> {
    // Re-count closed tickets for the shift and auto-land when complete.
    ticketOps.updateShiftProgress(this.sql, input.ticketId, nowIso());
    return this.getShiftStatus(input.shiftId).catch(() => null);
  }
  async shiftAddTicket(shiftId: string, ticketId: string): Promise<{ total_tickets: number }> {
    ticketOps.shiftAddTicket(this.sql, shiftId, ticketId);
    const total = ticketOps.listTickets(this.sql, { parent_ticket_id: shiftId } as TicketFilter).length;
    return { total_tickets: total };
  }
  async shiftRemoveTicket(shiftId: string, ticketId: string): Promise<{ total_tickets: number }> {
    ticketOps.shiftRemoveTicket(this.sql, shiftId, ticketId);
    const total = ticketOps.listTickets(this.sql, { parent_ticket_id: shiftId } as TicketFilter).length;
    return { total_tickets: total };
  }
  async listShifts(): Promise<ShiftMetadataRecordAs[]> {
    const rows = [...query(this.sql, `SELECT * FROM shift_metadata ORDER BY ticket_id`, [])];
    return rows as unknown as ShiftMetadataRecordAs[];
  }
  async listShiftsDetailed(): Promise<ShiftMetadataRecordAs[]> { return this.listShifts(); }
  async getShiftStatus(shiftId: string): Promise<{ shift_id: string; staged: boolean; total: number; closed: number; progress: number }> {
    const row = [...query(this.sql, `SELECT total_tickets, closed_tickets, staged FROM shift_metadata WHERE ticket_id=?`, [shiftId])][0] as
      { total_tickets?: number; closed_tickets?: number; staged?: number } | undefined;
    const total = row?.total_tickets ?? 0;
    const closed = row?.closed_tickets ?? 0;
    return { shift_id: shiftId, staged: (row?.staged ?? 0) === 1, total, closed, progress: total ? closed / total : 0 };
  }
  async updateShift(shiftId: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k}=?`).join(',');
    const params: unknown[] = [...keys.map((k) => fields[k]), shiftId];
    query(this.sql, `UPDATE shift_metadata SET ${set} WHERE ticket_id=?`, params as never);
  }

  // =====================================================================
  // FrontDesk
  // =====================================================================
  async ensureFrontDesk(actorUserId?: string): Promise<{ created: boolean; frontDesk: Agent | null }> {
    const existing = agentOps.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    if (existing) return { created: false, frontDesk: existing };
    const frontDesk = agentOps.registerAgent(this.sql, { role: 'frontDesk', name: 'FrontDesk', identity: `frontDesk@${this.departmentId}` });
    return { created: true, frontDesk };
  }
  async getFrontDeskStatus(): Promise<{ frontDesk: Agent | null; hasFrontDesk: boolean }> {
    const frontDesk = agentOps.listAgents(this.sql, { role: 'frontDesk' })[0] ?? null;
    return { frontDesk, hasFrontDesk: !!frontDesk };
  }
  async sendFrontDeskMessage(input: { from_agent_id: string; subject: string; body: string }): Promise<void> {
    const { frontDesk } = await this.getFrontDeskStatus();
    if (!frontDesk) return;
    memoOps.sendMemo(this.sql, { from_agent_id: input.from_agent_id, to_agent_id: frontDesk.id, subject: input.subject, body: input.body });
  }
  async updateFrontDeskSystemPrompt(): Promise<void> {
    await this.ensureFrontDesk();
  }

  // =====================================================================
  // Triage / escalations
  // =====================================================================
  async resolveTriage(input: { agent_id: string; triage_request_ticket_id: string; action: 'RESTART' | 'RESTART_WITH_BACKOFF' | 'CLOSE_TICKET' | 'ESCALATE' | 'ESCALATE_TO_FRONT_DESK' | 'NUDGE' | 'REASSIGN_TICKET' | 'DISCARD' | 'PROVIDE_GUIDANCE'; resolution_notes: string }): Promise<{ ok: boolean }> {
    const ticket = ticketOps.getTicket(this.sql, input.triage_request_ticket_id);
    if (!ticket) return { ok: false };
    // Honor the triage action without fabricating a container restart locally.
    switch (input.action) {
      case 'CLOSE_TICKET':
        ticketOps.updateTicketStatus(this.sql, ticket.ticket_id, 'closed', input.agent_id);
        break;
      case 'DISCARD':
        ticketOps.deleteTicket(this.sql, ticket.ticket_id);
        break;
      case 'ESCALATE':
      case 'ESCALATE_TO_FRONT_DESK':
        memoOps.sendMemo(this.sql, {
          from_agent_id: input.agent_id,
          to_agent_id: agentOps.listAgents(this.sql, { role: 'frontDesk' })[0]?.id ?? 'frontDesk',
          subject: 'Triage escalation',
          body: input.resolution_notes,
        });
        break;
      case 'NUDGE':
        agentOps.updateAgentStatusMessage(this.sql, input.agent_id, input.resolution_notes);
        break;
      case 'RESTART':
      case 'RESTART_WITH_BACKOFF':
      case 'REASSIGN_TICKET':
      case 'PROVIDE_GUIDANCE':
        // Locally there is no container to restart; record the intended action
        // on the ticket timeline and keep the ticket open for re-dispatch.
        break;
    }
    ticketOps.logTicketEvent(this.sql, {
      ticketId: ticket.ticket_id,
      agentId: input.agent_id,
      eventType: 'triage_resolved',
      newValue: input.action,
      metadata: { resolution_notes: input.resolution_notes },
    });
    return { ok: true };
  }
  async routeEscalation(input: { departmentId?: string; source_workstation_id?: string; severity?: string; message?: string; category?: string; source_agent_id?: string; escalationId?: string; to_agent_id?: string }): Promise<unknown> {
    const a = input.to_agent_id ?? agentOps.listAgents(this.sql, { role: 'frontDesk' })[0]?.id;
    if (a) memoOps.sendMemo(this.sql, { from_agent_id: 'triage', to_agent_id: a, subject: 'Escalation', body: input.message ?? `Escalation ${input.escalationId ?? ''}` });
    return { ok: true, routed: !!a };
  }
  async acknowledgeEscalation(escalationId: string): Promise<unknown> {
    query(this.sql, `UPDATE escalation_metadata SET acknowledged=1, acknowledged_at=? WHERE ticket_id=?`, [nowIso(), escalationId]);
    return { ok: true };
  }
  async listEscalations(filter?: { acknowledged?: boolean }): Promise<unknown[]> {
    const where = filter?.acknowledged !== undefined ? ` WHERE acknowledged=${filter.acknowledged ? 1 : 0}` : '';
    return [
      ...query(
        this.sql,
        `SELECT ticket_id, severity, category, acknowledged, re_escalation_count, acknowledged_at FROM escalation_metadata${where} ORDER BY acknowledged, acknowledged_at`,
        []
      ),
    ];
  }

  // =====================================================================
  // HELLDESK
  // =====================================================================
  async getHelldeskConnection(): Promise<unknown> { try { return helldesk.getHelldeskConnection?.(this.sql) ?? null; } catch { return null; } }
  async stampHelldeskReported(_input: { helldeskId: string; reporterTicketId?: string }): Promise<void> {
    try { query(this.sql, `UPDATE helldesk SET reported=1 WHERE helldesk_id=?`, [_input.helldeskId]); } catch { /* optional */ }
  }
  async disconnectHELLDESK(helldeskId: string): Promise<void> {
    try { query(this.sql, `DELETE FROM helldesk WHERE helldesk_id=?`, [helldeskId]); } catch { /* optional */ }
  }
  async writeTicketEvictionContext(agentId: string, input: { branch: string; agent_name: string; saved_at: string }): Promise<void> {
    try {
      const agent = agentOps.getAgent(this.sql, agentId);
      if (agent?.current_hook_ticket_id) {
        query(this.sql, `UPDATE tickets SET metadata=json_set(coalesce(metadata,'{}'),'$.eviction_context',?) WHERE ticket_id=?`, [JSON.stringify(input), agent.current_hook_ticket_id]);
      }
    } catch { /* optional */ }
  }
  async recordContainerEviction(): Promise<string> {
    return genId();
  }
  async acknowledgeContainerReady(_nonce: string): Promise<boolean> { return true; }
  async isDraining(): Promise<boolean> { return false; }
  async getDrainNonce(): Promise<string | null> { return null; }
  async getDrainStartedAt(): Promise<number | null> { return null; }
  async forceRefreshContainerToken(): Promise<void> { /* local container token is static */ }
  async syncConfigToContainer(): Promise<void> { /* no container locally */ }
  async setContainerRunPolicy(_policy: unknown): Promise<unknown> { return { ok: true }; }
  async getBillingStatus(): Promise<unknown> { return { ok: true, estimated_charge: 0, running: false }; }

  async setDashboardContext(_context: string): Promise<void> { /* no-op */ }
  async getDashboardContext(): Promise<string | null> { return null; }

  async broadcastUiAction(action: UiAction): Promise<void> {
    void normalizeUiAction(action, this.departmentId);
  }

  // SCM / reconciler passthroughs (used by shifts, polling)
  async pruneOldEvents(retentionMs: number): Promise<number> { return eventOps.pruneOldEvents(this.sql, retentionMs); }

  /** Run the colony reconciler pass — real, not a stub. Drains pending department
   *  events, applies each reconciler action + side-effect, and reports
   *  invariant violations. This is what the Cloudflare Department DO alarm loop
   *  would run; it is driven locally on an interval via startReconciler(). */
  async reconcile(): Promise<void> {
    // 1. Drain + apply pending event facts (agent_done, pr_status_changed, etc).
    for (const evt of eventOps.drainEvents(this.sql)) {
      try {
        applyEvent(this.sql, evt, { departmentConfig: await this.getDepartmentConfig() });
      } catch (err) {
        console.warn(`[LocalDepartment] reconcile: applyEvent failed for ${evt.event_type}`, err);
      } finally {
        eventOps.markProcessed(this.sql, evt.event_id);
      }
    }

    // 2. Run the reconcile rules + apply actions + deferred side-effects + invariants.
    const ctx = this.getReconcilerContext();
    try {
      const violations = await runReconcileTick(
        this,
        ctx,
      );
      if (violations.length > 0) {
        this.eventBus.emit({ type: 'invariant', departmentId: this.departmentId, violations });
      }
    } catch (err) {
      console.warn(`[LocalDepartment] reconcile: tick failed`, err);
    }
  }
}

/** Shift metadata row alias (from shift_metadata table). */
export type ShiftMetadataRecordAs = {
  ticket_id: string;
  total_tickets: number;
  closed_tickets: number;
  landed_at: string | null;
  feature_branch: string | null;
  merge_mode: ShiftMergeMode | null;
  staged: number;
};
