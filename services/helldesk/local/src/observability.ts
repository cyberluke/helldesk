/**
 * observability.ts — one honest, read-only snapshot of what the engine did.
 *
 * CONTEXT.md §Observability requires structured events, queue depth, worker
 * health, gate outcomes, cost/resource usage and time-to-verification, with no
 * fabricated metrics. This module reads the durable SQLite state directly and
 * aggregates it for the operator console. Nothing is synthesized: a value is
 * either measured from the journal/tables or reported as null/zero.
 *
 * Why server-side aggregation: the Observability page used to fetch the last N
 * events and derive every chart in the browser. With 80k+ journal rows, N events
 * cover minutes, not a day, so the 24h charts silently lied. Here the 24h window
 * is aggregated over the WHOLE window in SQLite, while only a small tail is
 * shipped for the event feed.
 */
import { basename } from 'node:path';
import type { Db } from './db';
import { countEvents, countEventsSince, listEventsSince, listEventsTail, type OutboxItem } from './events';
import { buildAgileMetrics, type AgileMetrics } from './agile-metrics';

export interface ObservabilityQueueDepth {
  queued: number;
  running: number;
  inFlight: number;
}

export interface ObservabilityEvent {
  seq: number;
  eventType: string;
  jobId: string | null;
  missionId: string | null;
  ticketId: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  createdAt: string;
  payload: unknown;
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  engine: { live: true; queue: ObservabilityQueueDepth };
  events: {
    total: number;
    last24h: number;
    lastHour: number;
    byType24h: Array<{ eventType: string; count: number }>;
    perHour24h: Array<{ hour: string; count: number }>;
    byWorkspace24h: Array<{ workspaceId: string | null; workspaceName: string; count: number }>;
    latest: ObservabilityEvent[];
  };
  missions: {
    total: number;
    active: number;
    blocked: number;
    verified: number;
    verified24h: number;
    byState: Array<{ state: string; count: number }>;
  };
  reviews: {
    total: number;
    open: number;
    completed24h: number;
    pass24h: number;
    findings24h: number;
    inconclusive24h: number;
    avgTimeToVerdictMs: number | null;
    oldestOpenAgeMs: number | null;
    byState: Array<{ state: string; count: number }>;
  };
  findings: {
    total: number;
    bySeverity: Array<{ severity: string; count: number }>;
  };
  gates: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    byGate: Array<{ gateKey: string; pass: number; fail: number; unverified: number; blocked: number }>;
  };
  workers: {
    total: number;
    running: number;
    recentFailures24h: number;
    byStatus: Array<{ status: string; count: number }>;
    active: Array<{
      workerId: string;
      jobId: string;
      role: string | null;
      status: string;
      providerId: string | null;
      modelId: string | null;
      pid: number | null;
      startedAt: string | null;
      ageMs: number | null;
    }>;
  };
  usage: {
    runs: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    avgRunDurationMs: number | null;
  };
  recovery: {
    requeued24h: number;
    retried24h: number;
    recovered24h: number;
    replanned24h: number;
    blocked24h: number;
    failedRepairs24h: number;
  };
  recentJobs: Array<{
    jobId: string;
    workspaceId: string;
    workspaceName: string;
    state: string;
    requestedAt: string;
    completedAt: string | null;
    attemptCount: number;
    durationMs: number | null;
  }>;
  /** Kanban/Agile metrics: mission burndown, throughput, cycle time, workstation velocity, review latency, WIP. */
  agile: AgileMetrics;
}

interface EventContext {
  jobWorkspace: Map<string, string>;
  jobTicket: Map<string, string>;
  ticketMission: Map<string, string>;
  missionWorkspace: Map<string, string>;
  revisionTicket: Map<string, string>;
  workspacePath: Map<string, string>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function chunk<T>(items: T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function payloadString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function workspaceNameFor(path: string | undefined): string {
  if (!path) return 'unregistered';
  // `path.basename` is platform-aware (Windows separators are honoured).
  const name = basename(path);
  return name.length > 0 ? name : path;
}

function queryIds(
  d: Db,
  sql: (placeholders: string) => string,
  ids: string[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const group of chunk(ids)) {
    const placeholders = group.map(() => '?').join(',');
    if (placeholders.length === 0) continue;
    out.push(...d.db.query<Record<string, unknown>, string[]>(sql(placeholders)).all(...group));
  }
  return out;
}

/**
 * Resolve the workspace / mission / ticket identity for a batch of events.
 *
 * Events carry different identifiers depending on the emitter: job events carry
 * `job_id`; mission events carry `mission_id`; revision/gate events carry only
 * `revision_id`; some carry a `ticket_id`. All of them must land on a real
 * workspace for the per-workstation chart. Resolution follows the durable FKs,
 * never a name guess.
 */
function buildEventContext(d: Db, events: OutboxItem[]): EventContext {
  const jobIds = new Set<string>();
  const missionIds = new Set<string>();
  const ticketIds = new Set<string>();
  const revisionIds = new Set<string>();
  const workspaceIds = new Set<string>();

  for (const event of events) {
    if (event.jobId) jobIds.add(event.jobId);
    const payload = payloadObject(event.payload);
    const missionId = payloadString(payload, ['mission_id', 'missionId']);
    const ticketId = payloadString(payload, ['ticket_id', 'ticketId']);
    const revisionId = payloadString(payload, ['revision_id', 'revisionId']);
    const workspaceId = payloadString(payload, ['workspace_id', 'workspaceId']);
    if (missionId) missionIds.add(missionId);
    if (ticketId) ticketIds.add(ticketId);
    if (revisionId) revisionIds.add(revisionId);
    if (workspaceId) workspaceIds.add(workspaceId);
  }

  const jobRows = jobIds.size
    ? queryIds(
        d,
        (p) => `SELECT job_id, workspace_id FROM review_jobs WHERE job_id IN (${p})`,
        [...jobIds],
      )
    : [];
  const revisionsToTickets = revisionIds.size
    ? queryIds(
        d,
        (p) => `SELECT ticket_id, revision_id FROM ticket_revisions WHERE revision_id IN (${p})`,
        [...revisionIds],
      )
    : [];
  // Job events carry only `job_id`; the job -> ticket edge lives on the revision
  // that scheduled the review. Resolve it here so the ticket -> mission query
  // below can see it.
  const jobTicketRows = jobIds.size
    ? queryIds(
        d,
        (p) => `SELECT review_job_id, ticket_id FROM ticket_revisions WHERE review_job_id IN (${p})`,
        [...jobIds],
      )
    : [];

  // Expand the graph one hop at a time so a later query can see ids discovered
  // by an earlier query (revision/job -> ticket -> mission).
  for (const row of [...revisionsToTickets, ...jobTicketRows]) {
    if (typeof row.ticket_id === 'string') ticketIds.add(row.ticket_id);
  }
  for (const row of jobRows) {
    if (typeof row.workspace_id === 'string') workspaceIds.add(row.workspace_id);
  }

  const ticketRows = ticketIds.size
    ? queryIds(
        d,
        (p) => `SELECT ticket_id, mission_id FROM mission_tickets WHERE ticket_id IN (${p})`,
        [...ticketIds],
      )
    : [];
  for (const row of ticketRows) {
    if (typeof row.mission_id === 'string') missionIds.add(row.mission_id);
  }

  const missionRows = missionIds.size
    ? queryIds(
        d,
        (p) => `SELECT mission_id, workspace_id FROM autonomy_missions WHERE mission_id IN (${p})`,
        [...missionIds],
      )
    : [];
  for (const row of missionRows) {
    if (typeof row.workspace_id === 'string') workspaceIds.add(row.workspace_id);
  }

  const workspaceRows = workspaceIds.size
    ? queryIds(
        d,
        (p) => `SELECT workspace_id, path FROM workspaces WHERE workspace_id IN (${p})`,
        [...workspaceIds],
      )
    : [];

  return {
    jobWorkspace: new Map(jobRows.map((r) => [String(r.job_id), String(r.workspace_id)])),
    jobTicket: new Map(jobTicketRows.map((r) => [String(r.review_job_id), String(r.ticket_id)])),
    ticketMission: new Map(ticketRows.map((r) => [String(r.ticket_id), String(r.mission_id)])),
    missionWorkspace: new Map(missionRows.map((r) => [String(r.mission_id), String(r.workspace_id)])),
    revisionTicket: new Map(revisionsToTickets.map((r) => [String(r.revision_id), String(r.ticket_id)])),
    workspacePath: new Map(workspaceRows.map((r) => [String(r.workspace_id), String(r.path)])),
  };
}

function resolveEventIdentity(event: OutboxItem, ctx: EventContext): ObservabilityEvent {
  const payload = payloadObject(event.payload);
  const payloadMissionId = payloadString(payload, ['mission_id', 'missionId']);
  const payloadTicketId = payloadString(payload, ['ticket_id', 'ticketId']);
  const payloadRevisionId = payloadString(payload, ['revision_id', 'revisionId']);
  const payloadWorkspaceId = payloadString(payload, ['workspace_id', 'workspaceId']);

  const ticketFromJob = event.jobId ? ctx.jobTicket.get(event.jobId) ?? null : null;
  const ticketFromRevision = payloadRevisionId ? ctx.revisionTicket.get(payloadRevisionId) ?? null : null;
  const ticketId = payloadTicketId ?? ticketFromJob ?? ticketFromRevision;
  const missionId =
    payloadMissionId ??
    (ticketId ? ctx.ticketMission.get(ticketId) ?? null : null);

  const workspaceId =
    payloadWorkspaceId ??
    (event.jobId ? ctx.jobWorkspace.get(event.jobId) ?? null : null) ??
    (missionId ? ctx.missionWorkspace.get(missionId) ?? null : null) ??
    (ticketId ? ctx.missionWorkspace.get(ctx.ticketMission.get(ticketId) ?? '') ?? null : null);

  return {
    seq: event.seq,
    eventType: event.eventType,
    jobId: event.jobId,
    missionId,
    ticketId,
    workspaceId,
    workspaceName: workspaceNameFor(workspaceId ? ctx.workspacePath.get(workspaceId) : undefined),
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

function emptyHourBuckets(now: Date): Array<{ hour: string; count: number }> {
  const currentHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    0,
    0,
    0,
  );
  return Array.from({ length: 24 }, (_, i) => ({
    hour: new Date(currentHour - (23 - i) * HOUR_MS).toISOString(),
    count: 0,
  }));
}

/**
 * Enrich raw journal rows with the mission/ticket/workspace identity their
 * payload implies. Used by the API's event tail so the GUI can attribute
 * activity to a real workstation instead of the old "unknown" bucket.
 */
export function enrichOutboxEvents(d: Db, events: OutboxItem[]): ObservabilityEvent[] {
  const context = buildEventContext(d, events);
  return events.map((e) => resolveEventIdentity(e, context));
}

function aggregateEvents(d: Db, events: OutboxItem[], latest: OutboxItem[], now: Date): ObservabilitySnapshot['events'] {
  // Deduplicate by seq: the same event can appear in both the window and the tail.
  const context = buildEventContext(
    d,
    [...new Map([...events, ...latest].map((e) => [e.seq, e])).values()],
  );
  const enrichedWindow = events.map((e) => resolveEventIdentity(e, context));
  const enrichedLatest = latest.map((e) => resolveEventIdentity(e, context));

  const byType = new Map<string, number>();
  const byWorkspace = new Map<string, { workspaceId: string | null; workspaceName: string; count: number }>();
  const buckets = emptyHourBuckets(now);
  const currentHour = Date.parse(buckets[23]!.hour);

  for (const event of enrichedWindow) {
    byType.set(event.eventType, (byType.get(event.eventType) ?? 0) + 1);

    const key = event.workspaceId ?? '__unresolved__';
    const entry = byWorkspace.get(key) ?? {
      workspaceId: event.workspaceId,
      workspaceName: event.workspaceName ?? 'unresolved',
      count: 0,
    };
    entry.count += 1;
    byWorkspace.set(key, entry);

    const ts = Date.parse(event.createdAt);
    if (Number.isFinite(ts)) {
      // Compare hour *starts* so an event in the current, partially elapsed hour
      // lands in the last bucket instead of producing idx 24 and vanishing.
      const eventHour = Math.floor(ts / HOUR_MS) * HOUR_MS;
      const idx = 23 - Math.round((currentHour - eventHour) / HOUR_MS);
      if (idx >= 0 && idx < buckets.length) buckets[idx]!.count += 1;
    }
  }

  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  return {
    total: countEvents(d),
    // Exact counts come from SQL; the chart/type arrays use the window rows
    // (bounded by listEventsSince's 100k guard, far above any real day).
    last24h: countEventsSince(d, new Date(now.getTime() - DAY_MS).toISOString()),
    lastHour: countEventsSince(d, hourAgo),
    byType24h: [...byType.entries()]
      .map(([eventType, count]) => ({ eventType, count }))
      .sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType)),
    perHour24h: buckets,
    byWorkspace24h: [...byWorkspace.values()].sort((a, b) => b.count - a.count || a.workspaceName.localeCompare(b.workspaceName)),
    latest: enrichedLatest,
  };
}

function buildMissionsSection(d: Db, sinceIso: string): ObservabilitySnapshot['missions'] {
  const rows = d.db
    .query<{ state: string; n: number }, []>(`SELECT state, COUNT(*) AS n FROM autonomy_missions GROUP BY state`)
    .all();
  const counts = new Map(rows.map((r) => [r.state, r.n]));
  const active = (counts.get('ACTIVE') ?? 0) + (counts.get('PLANNING') ?? 0) + (counts.get('MUTATING') ?? 0) +
    (counts.get('CAPTURING_EVIDENCE') ?? 0) + (counts.get('VERIFYING') ?? 0) + (counts.get('REPLANNING') ?? 0);
  const verifiedRow = d.db
    .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM autonomy_missions WHERE verified_at >= ?`)
    .get(sinceIso);
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    active,
    blocked: counts.get('BLOCKED_EXTERNAL') ?? 0,
    verified: counts.get('VERIFIED_10_10') ?? 0,
    verified24h: verifiedRow?.c ?? 0,
    byState: rows
      .map((r) => ({ state: r.state, count: r.n }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
  };
}

function buildReviewsSection(d: Db, sinceIso: string, now: Date): ObservabilitySnapshot['reviews'] {
  const rows = d.db
    .query<{ state: string; n: number }, []>(`SELECT state, COUNT(*) AS n FROM review_jobs GROUP BY state`)
    .all();
  const counts = new Map(rows.map((r) => [r.state, r.n]));
  const completedRow = d.db
    .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM review_jobs WHERE completed_at >= ?`)
    .get(sinceIso);
  const passRow = d.db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM review_jobs WHERE state = 'COMPLETED_PASS' AND completed_at >= ?`,
    )
    .get(sinceIso);
  const findingsRow = d.db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM review_jobs WHERE state = 'COMPLETED_FINDINGS' AND completed_at >= ?`,
    )
    .get(sinceIso);
  const inconclusiveRow = d.db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM review_jobs WHERE state = 'INCONCLUSIVE' AND completed_at >= ?`,
    )
    .get(sinceIso);
  const durationRow = d.db
    .query<{ avg_ms: number | null; samples: number }, [string]>(
      `SELECT AVG((julianday(completed_at) - julianday(requested_at)) * 86400000.0) AS avg_ms,
              COUNT(*) AS samples
         FROM review_jobs
        WHERE completed_at IS NOT NULL
          AND requested_at IS NOT NULL
          AND completed_at >= ?`,
    )
    .get(sinceIso);
  const oldestOpen = d.db
    .query<{ requested_at: string | null }, []>(
      `SELECT MIN(requested_at) AS requested_at
         FROM review_jobs
        WHERE state IN ('DISCOVERED','SNAPSHOTTED','QUEUED','REVIEWING_A_B','ADJUDICATING')`,
    )
    .get();

  const open = (counts.get('DISCOVERED') ?? 0) + (counts.get('SNAPSHOTTED') ?? 0) + (counts.get('QUEUED') ?? 0) +
    (counts.get('REVIEWING_A_B') ?? 0) + (counts.get('ADJUDICATING') ?? 0);
  const oldestTs = oldestOpen?.requested_at ? Date.parse(oldestOpen.requested_at) : NaN;

  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    open,
    completed24h: completedRow?.c ?? 0,
    pass24h: passRow?.c ?? 0,
    findings24h: findingsRow?.c ?? 0,
    inconclusive24h: inconclusiveRow?.c ?? 0,
    avgTimeToVerdictMs:
      typeof durationRow?.avg_ms === 'number' && Number.isFinite(durationRow.avg_ms)
        ? Math.round(durationRow.avg_ms)
        : null,
    oldestOpenAgeMs: Number.isFinite(oldestTs) ? Math.max(0, now.getTime() - oldestTs) : null,
    byState: rows
      .map((r) => ({ state: r.state, count: r.n }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
  };
}

function buildFindingsSection(d: Db): ObservabilitySnapshot['findings'] {
  const rows = d.db
    .query<{ severity: string; n: number }, []>(`SELECT severity, COUNT(*) AS n FROM findings GROUP BY severity`)
    .all();
  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    bySeverity: rows
      .map((r) => ({ severity: r.severity, count: r.n }))
      .sort((a, b) => b.count - a.count || a.severity.localeCompare(b.severity)),
  };
}

function buildGatesSection(d: Db): ObservabilitySnapshot['gates'] {
  const statusRows = d.db
    .query<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM quality_gate_results GROUP BY status`,
    )
    .all();
  const gateRows = d.db
    .query<{ gate_key: string; status: string; n: number }, []>(
      `SELECT gate_key, status, COUNT(*) AS n
         FROM quality_gate_results
        GROUP BY gate_key, status`,
    )
    .all();
  const byGate = new Map<string, { gateKey: string; pass: number; fail: number; unverified: number; blocked: number }>();
  for (const row of gateRows) {
    const entry = byGate.get(row.gate_key) ?? {
      gateKey: row.gate_key,
      pass: 0,
      fail: 0,
      unverified: 0,
      blocked: 0,
    };
    if (row.status === 'PASS') entry.pass += row.n;
    else if (row.status === 'FAIL') entry.fail += row.n;
    else if (row.status === 'BLOCKED') entry.blocked += row.n;
    else entry.unverified += row.n;
    byGate.set(row.gate_key, entry);
  }
  return {
    total: statusRows.reduce((sum, r) => sum + r.n, 0),
    byStatus: statusRows
      .map((r) => ({ status: r.status, count: r.n }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    byGate: [...byGate.values()].sort((a, b) => a.gateKey.localeCompare(b.gateKey)),
  };
}

function buildWorkersSection(d: Db, sinceIso: string, now: Date): ObservabilitySnapshot['workers'] {
  const rows = d.db
    .query<{ status: string; n: number }, []>(`SELECT status, COUNT(*) AS n FROM workers GROUP BY status`)
    .all();
  const counts = new Map(rows.map((r) => [r.status, r.n]));
  const failures = d.db
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM workers WHERE status IN ('failed','terminated') AND finished_at >= ?`,
    )
    .get(sinceIso);
  const activeRows = d.db
    .query<
      {
        worker_id: string;
        job_id: string;
        role: string | null;
        status: string;
        provider_id: string | null;
        model_id: string | null;
        pid: number | null;
        started_at: string | null;
      },
      []
    >(
      `SELECT worker_id, job_id, role, status, provider_id, model_id, pid, started_at
         FROM workers
        WHERE status IN ('launching','running')
        ORDER BY started_at DESC
        LIMIT 50`,
    )
    .all();

  return {
    total: rows.reduce((sum, r) => sum + r.n, 0),
    running: (counts.get('launching') ?? 0) + (counts.get('running') ?? 0),
    recentFailures24h: failures?.c ?? 0,
    byStatus: rows
      .map((r) => ({ status: r.status, count: r.n }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    active: activeRows.map((r) => {
      const started = r.started_at ? Date.parse(r.started_at) : NaN;
      return {
        workerId: r.worker_id,
        jobId: r.job_id,
        role: r.role,
        status: r.status,
        providerId: r.provider_id,
        modelId: r.model_id,
        pid: r.pid,
        startedAt: r.started_at,
        ageMs: Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null,
      };
    }),
  };
}

function buildUsageSection(d: Db): ObservabilitySnapshot['usage'] {
  const row = d.db
    .query<{ runs: number; tokens_in: number; tokens_out: number; cost: number; avg_ms: number | null }, []>(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out,
              COALESCE(SUM(cost), 0) AS cost,
              AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) AS avg_ms
         FROM agent_runs`,
    )
    .get();
  return {
    runs: row?.runs ?? 0,
    tokensIn: row?.tokens_in ?? 0,
    tokensOut: row?.tokens_out ?? 0,
    cost: row?.cost ?? 0,
    avgRunDurationMs:
      typeof row?.avg_ms === 'number' && Number.isFinite(row.avg_ms) ? Math.round(row.avg_ms) : null,
  };
}

function buildRecoverySection(d: Db, sinceIso: string): ObservabilitySnapshot['recovery'] {
  const rows = d.db
    .query<{ event_type: string; n: number }, [string]>(
      `SELECT event_type, COUNT(*) AS n
         FROM events_outbox
        WHERE created_at >= ?
          AND event_type IN ('job.requeued','job.retried','revision.recovered','mission.replanned','mission.blocked','mission.budget_blocked','repair.failed')
        GROUP BY event_type`,
    )
    .all(sinceIso);
  const counts = new Map(rows.map((r) => [r.event_type, r.n]));
  return {
    requeued24h: counts.get('job.requeued') ?? 0,
    retried24h: counts.get('job.retried') ?? 0,
    recovered24h: counts.get('revision.recovered') ?? 0,
    replanned24h: counts.get('mission.replanned') ?? 0,
    // A budget halt is a real block; counting only `mission.blocked` made the
    // recovery panel read 0 while a mission was actually blocked.
    blocked24h: (counts.get('mission.blocked') ?? 0) + (counts.get('mission.budget_blocked') ?? 0),
    failedRepairs24h: counts.get('repair.failed') ?? 0,
  };
}

function buildRecentJobs(d: Db): ObservabilitySnapshot['recentJobs'] {
  const rows = d.db
    .query<
      {
        job_id: string;
        workspace_id: string;
        workspace_path: string | null;
        state: string;
        requested_at: string;
        completed_at: string | null;
        attempt_count: number;
      },
      []
    >(
      `SELECT j.job_id, j.workspace_id, w.path AS workspace_path, j.state,
              j.requested_at, j.completed_at, j.attempt_count
         FROM review_jobs j
         LEFT JOIN workspaces w ON w.workspace_id = j.workspace_id
        ORDER BY j.requested_at DESC
        LIMIT 10`,
    )
    .all();
  return rows.map((r) => {
    const requested = Date.parse(r.requested_at);
    const completed = r.completed_at ? Date.parse(r.completed_at) : NaN;
    return {
      jobId: r.job_id,
      workspaceId: r.workspace_id,
      workspaceName: workspaceNameFor(r.workspace_path ?? undefined),
      state: r.state,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      attemptCount: r.attempt_count,
      durationMs:
        Number.isFinite(requested) && Number.isFinite(completed) ? Math.max(0, completed - requested) : null,
    };
  });
}

const SNAPSHOT_TTL_MS = 1_500;
// Keyed by the Db instance (not its path) so `:memory:` test databases — and any
// future two-handle setup — never share a snapshot.
const snapshotCache = new WeakMap<Db, { at: number; snapshot: ObservabilitySnapshot }>();

/**
 * Build (or reuse a very fresh) observability snapshot. The UI polls every few
 * seconds; a 1.5s cache avoids re-aggregating the same 24h window for concurrent
 * panels while keeping the console effectively live.
 */
export function buildObservabilitySnapshot(
  d: Db,
  queue: ObservabilityQueueDepth,
  opts?: { maxAgeMs?: number },
): ObservabilitySnapshot {
  const maxAge = opts?.maxAgeMs ?? SNAPSHOT_TTL_MS;
  const cached = snapshotCache.get(d);
  const now = Date.now();
  if (cached && now - cached.at <= maxAge) return cached.snapshot;

  const nowDate = new Date(now);
  const since24h = new Date(now - DAY_MS).toISOString();
  const windowEvents = listEventsSince(d, since24h);
  const latestEvents = listEventsTail(d, 60);

  const snapshot: ObservabilitySnapshot = {
    generatedAt: nowDate.toISOString(),
    engine: { live: true, queue },
    events: aggregateEvents(d, windowEvents, latestEvents, nowDate),
    missions: buildMissionsSection(d, since24h),
    reviews: buildReviewsSection(d, since24h, nowDate),
    findings: buildFindingsSection(d),
    gates: buildGatesSection(d),
    workers: buildWorkersSection(d, since24h, nowDate),
    usage: buildUsageSection(d),
    recovery: buildRecoverySection(d, since24h),
    recentJobs: buildRecentJobs(d),
    agile: buildAgileMetrics(d, nowDate),
  };

  snapshotCache.set(d, { at: now, snapshot });
  return snapshot;
}

/** Test/reset hook: drop the cached snapshot for a database handle. */
export function invalidateObservabilitySnapshot(d: Db): void {
  snapshotCache.delete(d);
}
