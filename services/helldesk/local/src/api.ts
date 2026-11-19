import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';
import type { Db } from './db';
import type { Engine } from './engine';
import type { Config } from './config';
import type { RuntimeConfigStore } from './config-runtime';
import { getJob, listJobs } from './jobs';
import { takePendingEvents, enqueueEvent } from './events';
import {
  getMission, listMissions, listTickets, listRevisions, getQualityGates, diagnoseFailure,
  createMission, createMissionRequest, addTicket, updateMissionState, updateRevision, getTicket, getRevision, listEvidence,
} from './mission-repository';
import { registerWorkspace, getWorkspace } from './workspace-registry';
import { sampleMutationActivity, countTrackedFiles } from './mutation-activity';
import { verifyPendingVerify } from './mission-controller';
import { CreateJobRequestSchema } from './schemas';
import { transitionJob } from './state-machine';
import { REWORK_MAX_RETRIES } from './helldesk-semantics';
import { listHosts, listSessions, getHost, isSimulatedHost } from './host-registry';
import { acceptWorkerResult } from './worker-supervisor';
import { listTranscript } from './job-transcript';

/**
 * localhost-only HTTP JSON API + event feed.
 * Mutations require the per-user local token. Binds to 127.0.0.1 only.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export interface ApiContext {
  d: Db;
  engine: Engine;
  config: Config;
  /** Runtime config store — enables GET/PATCH /v1/config. */
  configStore: RuntimeConfigStore;
  token: string;
  queueDepth: () => { queued: number; running: number; inFlight: number };
}

export async function handleRequest(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  if (method === 'GET' && url.pathname === '/health') {
    const hosts = listHosts(ctx.d);
    const sessions = listSessions(ctx.d);
    const q = ctx.queueDepth();
    const queues = workerQueueStats(ctx);
    const realHosts = hosts.filter((h) => !isSimulatedHost(h) && h.status === 'connected');
    const simulatedHosts = hosts.filter((h) => isSimulatedHost(h));
    const realHostIds = new Set(realHosts.map((h) => h.hostId));
    const activeSessions = sessions.filter((s) => s.status === 'active');
    const realActiveSessions = activeSessions.filter((s) => realHostIds.has(s.hostId));
    return json(
      {
        status: 'ok',
        alive: true,
        dbReady: true,
        schedulerOperational: true,
        queueOperational: true,
        modelConnectivity: 'unknown',
        queueDepth: q,
        hostCount: hosts.length,
        realHostCount: realHosts.length,
        simulatedHostCount: simulatedHosts.length,
        activeSessionCount: activeSessions.length,
        realActiveSessionCount: realActiveSessions.length,
        reviewerQueueDepth: queues.reviewer,
        adjudicatorQueueDepth: queues.adjudicator,
        workerCount: queues.workers,
      },
      200
    );
  }

  // ── host / session / queue / worker / metrics observability ───────────
  if (method === 'GET' && url.pathname === '/v1/hosts') return json({ hosts: listHosts(ctx.d) });
  if (method === 'GET' && url.pathname === '/v1/sessions') {
    const hostId = url.searchParams.get('hostId') ?? undefined;
    return json({ sessions: listSessions(ctx.d, hostId) });
  }
  if (method === 'GET' && url.pathname === '/v1/queue') return json({ queue: ctx.queueDepth() });
if (method === 'GET' && url.pathname === '/v1/workers') {
    const workers = ctx.d.db
      .query<Record<string, unknown>, []>(`SELECT worker_id, job_id, attempt_id, role, pid, status, provider_id, model_id, started_at, finished_at, exit_code, error FROM workers ORDER BY started_at DESC LIMIT 100`)
      .all();
    return json({ workers });
  }
  // Full-QA observability transcript: what each agent did (messages, tool calls,
  // diffs, findings, events), filterable by mission/revision/job. Filters the
  // durable job_transcript journal.
  if (method === 'GET' && url.pathname === '/v1/journal') {
    const missionId = url.searchParams.get('mission_id') ?? undefined;
    const revisionId = url.searchParams.get('revision_id') ?? undefined;
    const jobId = url.searchParams.get('job_id') ?? undefined;
    const limitStr = url.searchParams.get('limit');
    const limit = limitStr ? Number(limitStr) : undefined;
    return json({ entries: listTranscript(ctx.d, { missionId, revisionId, jobId, limit }) });
  }
  if (method === 'GET' && url.pathname === '/v1/metrics') {
    return json({
      hostCount: listHosts(ctx.d).length,
      sessionCount: listSessions(ctx.d).length,
      queueDepth: ctx.queueDepth(),
      workers: workerQueueStats(ctx).workers,
      recentWorkerErrors: recentWorkerErrors(ctx),
    });
  }

  const hostMatch = url.pathname.match(/^\/v1\/hosts\/([^/]+)$/);
  if (method === 'GET' && hostMatch) {
    const host = getHost(ctx.d, hostMatch[1]!);
    if (!host) return json({ error: 'not_found' }, 404);
    return json({ host, sessions: listSessions(ctx.d, host.hostId) });
  }

  // Worker result submission (from detached worker processes).
  const workerResultMatch = url.pathname.match(/^\/v1\/workers\/([^/]+)\/result$/);
  if (method === 'POST' && workerResultMatch) {
    const body = await safeJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const b = body as Record<string, unknown>;
    const out = acceptWorkerResult({
      d: ctx.d,
      attemptId: String(b.attemptId ?? ''),
      jobId: String(b.jobId ?? ''),
      role: String(b.role ?? ''),
      resultPath: String(b.resultPath ?? ''),
      providerID: String(b.providerID ?? ''),
      modelID: String(b.modelID ?? ''),
      workerId: String(b.workerId ?? ''),
    });
    if (!out.ok) return json({ error: out.reason ?? 'stale' }, out.stale ? 409 : 422);
    return json({ ok: true }, 200);
  }

  if (method === 'GET' && url.pathname === '/v1/jobs') {
    const state = url.searchParams.get('state') ?? undefined;
    const ws = url.searchParams.get('workspaceId') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? '50');
    return json({ jobs: listJobs(ctx.d, { state, workspaceId: ws, limit }) });
  }

  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const job = getJob(ctx.d, jobMatch[1]!);
    if (!job) return json({ error: 'not_found' }, 404);
    return json({ job });
  }

  const reportMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)$/);
  if (method === 'GET' && reportMatch) {
    const jsonPath = `${ctx.engine.reportDir}\\${reportMatch[1]!}.json`;
    if (!existsSync(jsonPath)) return json({ error: 'not_found' }, 404);
    try {
      const content = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      return json({ report: content });
    } catch {
      return json({ error: 'invalid_report' }, 500);
    }
  }

if (method === 'GET' && url.pathname === '/v1/events') {
    const after = Number(url.searchParams.get('after') ?? '0');
    const events = takePendingEvents(ctx.d, after, 200).map((e) => ({
      seq: e.seq,
      eventType: e.eventType,
      jobId: e.jobId,
      payload: e.payload,
      createdAt: e.createdAt,
    }));
    // The SSE consumer resumes with `seq > after`, so a resume cursor MUST be the
    // last delivered seq (NOT lastSeq+1) or the next poll skips that last event.
    return json({ events, nextSeq: events.length ? events[events.length - 1]!.seq : after });
  }

  // Durable SSE projection over `events_outbox` (Ender loop P0-H).
  //   * id: <events_outbox.seq> (the durable SQLite sequence — never invented)
  //   * Last-Event-ID / ?after=N resume (effective cursor = max(valid))
  //   * heartbeats every 10s as SSE comments (never INSERTed into sqlite)
  //   * never closes on job.completed / mission.verified / replan / idle —
  //     closes ONLY on client abort, daemon shutdown, or transport error.
if (method === 'GET' && url.pathname === '/v1/events/stream') {
    const liLast = req.headers.get('Last-Event-ID');
    const afterParam = Number(url.searchParams.get('after') ?? '0');
    const cursor = Math.max(Number(liLast ?? '0') || 0, Number.isFinite(afterParam) ? afterParam : 0);
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("retry: 1000\n\n"));
        let c = cursor;
        let lastHeartbeat = Date.now();
        const enc = new TextEncoder();
        while (!req.signal.aborted) {
          const nowMs = Date.now();
          if (nowMs - lastHeartbeat >= 10_000) {
            controller.enqueue(enc.encode(`: heartbeat ${new Date(nowMs).toISOString()}\n\n`));
            lastHeartbeat = nowMs;
          }
          const events = takePendingEvents(ctx.d, c, 200);
          if (events.length) {
            for (const e of events) {
              controller.enqueue(enc.encode(`id: ${e.seq}\nevent: ${e.eventType}\ndata: ${JSON.stringify(e.payload)}\n\n`));
              c = e.seq;
            }
            if (events.length === 200) continue;
          }
          await new Promise((res) => setTimeout(res, 400));
        }
        try { controller.close(); } catch { /* already closed on abort */ }
      },
      cancel() { /* transport closed: stop draining (backpressure) */ },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    });
  }

  // Mission/ticket read endpoints (Phase 28) — read-only, no token needed.
  if (method === 'GET' && url.pathname === '/v1/missions') {
    const missions = listMissions(ctx.d).map((m) => ({ missionId: m.mission_id, workspaceId: m.workspace_id, objective: m.objective, state: m.state, currentTicketId: m.current_ticket_id, verifiedAt: m.verified_at, blockedReason: m.blocked_reason }));
    return json({ missions });
  }
  const misMatch = /^\/v1\/missions\/([^/]+)\/tickets$/.exec(url.pathname);
  if (method === 'GET' && misMatch) {
    const tickets = listTickets(ctx.d, misMatch[1]!).map(filterTicketPublic);
    return json({ missionId: misMatch[1], tickets });
  }
const revMatch = /^\/v1\/missions\/([^/]+)\/revisions$/.exec(url.pathname);
  if (method === 'GET' && revMatch) {
    const mission = getMission(ctx.d, revMatch[1]!);
    if (!mission) return json({ error: 'not_found' }, 404);
    // TRUE workspace emptiness = landed tracked-file count, NOT before===after.
    // A populated 955-file checkout whose agent produced no delta is a `no-change`
    // (the real failure), never a false `empty-workspace-no-change`.
    let tracked = 0;
    let wsPath = '';
    try {
      const ws = mission.workspace_id ? getWorkspace(ctx.d, mission.workspace_id) : null;
      wsPath = ws?.path ?? '';
      tracked = countTrackedFiles(wsPath);
    } catch { tracked = 0; }
    const revisions = listTickets(ctx.d, revMatch[1]!).flatMap((b) => listRevisions(ctx.d, b.ticket_id).map((r) => ({ ticketId: b.ticket_id, missionId: revMatch[1], revisionId: r.revision_id, revisionNo: r.revision_no, state: r.state, snapshotId: r.snapshot_id, reviewJobId: r.review_job_id, quality: getQualityGates(ctx.d, r.revision_id), workspaceTracked: tracked, diagnosis: diagnoseFailure(r.failure_signature, tracked === 0, tracked) })));
    return json({ missionId: revMatch[1], revisions, workspaceTracked: tracked });
  }
  const mIdMatch = /^\/v1\/missions\/([^/]+)$/.exec(url.pathname);
  if (method === 'GET' && mIdMatch) {
    const mission = getMission(ctx.d, mIdMatch[1]!);
    if (!mission) return json({ error: 'not_found' }, 404);
    let engineMatrix: Record<string, unknown> = {};
    try { engineMatrix = mission.engine_matrix_json ? JSON.parse(mission.engine_matrix_json) : {} } catch { /* ignore */ }
    // LIVE MUTATION OBSERVABILITY: while the mission is actively working, surface
    // what the agent is actually doing in its output workspace (source writes,
    // commits ahead, dirt, newest file) instead of a blind "MUTATING". Only
    // sampled when there is a workable workspace; never blocks the API (bounded
    // walks + git timeouts, all failures degrade to a `missing`/`no-output-checkout`
    // verdict instead of throwing).
    let mutationActivity: ReturnType<typeof sampleMutationActivity> | null = null;
    try {
      const ws = mission.workspace_id ? getWorkspace(ctx.d, mission.workspace_id) : null;
      if (ws) mutationActivity = sampleMutationActivity(ws.path || '');
    } catch { mutationActivity = null; }
    return json({ mission: { ...mission, engineMatrix, mutationActivity } });
  }

// All remaining routes require the mutation token.
  if (!url.pathname.startsWith('/v1')) return json({ error: 'not_found' }, 404);
  const auth = req.headers.get('Authorization');
  if (auth !== `Bearer ${ctx.token}` && req.headers.get('x-gt-token') !== ctx.token) {
    return json({ error: 'unauthorized' }, 401);
  }

  // ── Ender mission lifecycle (production ingress, P0) ─────────────────────
  // Create a mission over a registered workspace + one ticket.
  if (method === 'POST' && url.pathname === '/v1/missions') {
    const body = await safeJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const parsed = z.object({ workspaceId: z.string().min(1), objective: z.string().min(1), idempotencyKey: z.string().min(1).max(160).optional(), taskGates: z.array(z.string().min(1)).min(1).max(100).optional(), tickets: z.array(z.object({ title: z.string().optional(), objective: z.string().optional(), dependsOn: z.array(z.string()).optional() })).optional(), engineMatrix: z.record(z.string(), z.unknown()).optional() }).safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_mission', issues: parsed.error.issues }, 400);
    const b = parsed.data;
    if (typeof b.workspaceId !== 'string' || !b.workspaceId) return json({ error: 'workspaceId required' }, 400);
    if (typeof b.objective !== 'string' || !b.objective) return json({ error: 'objective required' }, 400);
    const ws = getWorkspace(ctx.d, b.workspaceId);
    if (!ws) return json({ error: 'workspace_not_found' }, 404);
    const tickets = Array.isArray(b.tickets) && b.tickets.length ? b.tickets : [{ title: 'B1', objective: b.objective, dependsOn: [] }];
    const result = createMissionRequest(ctx.d, { workspaceId: ws.workspaceId, objective: b.objective,
      idempotencyKey: b.idempotencyKey, taskGates: b.taskGates || ['full_task_scope', 'functional_behavior', 'regression_checks', 'artifact_provenance'],
      engineMatrix: b.engineMatrix,
      tickets: tickets.map(bb => ({ title: bb.title || 'B1', objective: bb.objective || b.objective, dependsOn: bb.dependsOn || [] })) });
    if (result.conflict) return json({ error: 'idempotency_conflict', message: 'This task identity already belongs to a different mission request' }, 409);
    return json({ missionId: result.missionId, ticketIds: result.ticketIds, reused: result.reused }, result.reused ? 200 : 201);
  }

  const steerMissionMatch = /^\/v1\/missions\/([^/]+)\/steer$/.exec(url.pathname);
  if (method === 'POST' && steerMissionMatch) {
    const input = z.object({ note: z.string().trim().min(1).max(16000), kind: z.enum(['message', 'interrupt', 'force-review', 'disapprove']).default('message') }).safeParse(await safeJson(req));
    if (!input.success) return json({ error: 'invalid_steering' }, 400);
    const mission = getMission(ctx.d, steerMissionMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (mission.state === 'CANCELLED') return json({ error: 'mission_cancelled' }, 409);
    const suffix = `\n\n[Async CTO ${input.data.kind} ${new Date().toISOString()}]\n${input.data.note}`;
    ctx.d.tx(db => {
      db.query('UPDATE autonomy_missions SET objective=objective || ?, updated_at=? WHERE mission_id=?').run(suffix, new Date().toISOString(), mission.mission_id);
      db.query("UPDATE mission_tickets SET objective=COALESCE(objective,'') || ?, updated_at=? WHERE mission_id=? AND execution_state != 'CLOSED'").run(suffix, new Date().toISOString(), mission.mission_id);
    });
    if (mission.state === 'VERIFIED_10_10') {
      addTicket(ctx.d, mission.mission_id, { title: 'CTO follow-up', objective: mission.objective + suffix });
      updateMissionState(ctx.d, mission.mission_id, 'ACTIVE');
    }
    return json({ ok: true, missionId: mission.mission_id, delivery: 'queued_for_next_boundary', kind: input.data.kind });
  }

  // Resume a non-terminal mission: unblock / un-cancel / reactivate and make any
  // stuck revision dispatchable again (safe recovery).
  const resumeMatch = /^\/v1\/missions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method === 'POST' && resumeMatch) {
    const mission = getMission(ctx.d, resumeMatch[1]!);
    if (!mission) return json({ error: 'not_found' }, 404);
    if (mission.state === 'VERIFIED_10_10') return json({ error: 'already_verified' }, 409);
    updateMissionState(ctx.d, mission.mission_id, 'ACTIVE', { blocked_reason: undefined, blocked_details: undefined });
    // Reconcile any stuck/blocked revision to a dispatchable state (liveness).
    const tickets = listTickets(ctx.d, mission.mission_id);
    for (const ticket of tickets) {
      if (!ticket.active_revision_id) continue;
      const rev = getRevision(ctx.d, ticket.active_revision_id!);
      if (rev && (rev.state === 'MUTATING' || rev.state === 'EVIDENCE_CAPTURED' || rev.state === 'VERIFYING' || rev.state === 'BLOCKED')) {
        updateRevision(ctx.d, rev.revision_id, { state: 'PLANNED' });
      }
    }
    return json({ ok: true, state: 'ACTIVE' });
  }

  // Cancel an in-progress mission (terminal, irreversible).
  const cancelMissionMatch = /^\/v1\/missions\/([^/]+)\/cancel$/.exec(url.pathname);
  if (method === 'POST' && cancelMissionMatch) {
    const mission = getMission(ctx.d, cancelMissionMatch[1]!);
    if (!mission) return json({ error: 'not_found' }, 404);
    if (mission.state === 'VERIFIED_10_10') return json({ error: 'already_verified' }, 409);
    if (mission.state === 'CANCELLED') return json({ ok: true, state: 'CANCELLED' });
    updateMissionState(ctx.d, mission.mission_id, 'CANCELLED', { cancelled_at: new Date().toISOString() });
    return json({ ok: true, state: 'CANCELLED' });
  }

if (method === 'POST' && url.pathname === '/v1/workspaces/register') {
    const body = await safeJson(req);
    if (!body || typeof (body as { path?: string }).path !== 'string') {
      return json({ error: 'path required' }, 400);
    }
    const ws = registerWorkspace(ctx.d, { path: (body as { path: string }).path });
    return json({ workspace: ws }, 201);
  }

  // ── Runtime config control (token-gated; GET + PATCH) ─────────────────
  // GET exposes the effective config + per-field applicability so the UX can
  // label every control "live" vs "applies on restart". Secrets are redacted.
  if (method === 'GET' && url.pathname === '/v1/config') {
    return json(configViewForApi(ctx.configStore));
  }
  if (method === 'PATCH' && url.pathname === '/v1/config') {
    const body = await safeJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'invalid_body', message: 'PATCH body must be a JSON object {daemon?, policy?, autonomy?, workspaces?}' }, 400);
    }
    try {
      const result = await ctx.configStore.patch(body as Record<string, unknown>);
      const status = result.rejected.length ? 400 : 200;
      return json({ ok: result.rejected.length === 0, applied_live: result.appliedLive, applies_on_restart: result.appliesOnRestart, rejected: result.rejected, config_path: result.path, config: configViewForApi(ctx.configStore).config }, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: 'invalid_config', message }, 400);
    }
  }

  if (method === 'POST' && url.pathname === '/v1/reviews') {
    const body = await safeJson(req);
    const parsed = CreateJobRequestSchema.safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    const subject = parsed.data.subject;
    let workspacePath: string;
    const wsId = parsed.data.workspaceId;
    if (wsId) {
      const ws = getWorkspace(ctx.d, wsId);
      if (!ws) return json({ error: 'workspace_not_found' }, 404);
      workspacePath = ws.path;
    } else if (subject.fsPath) {
      workspacePath = subject.fsPath;
    } else {
      return json({ error: 'resolve workspacePath via workspaceId or fsPath' }, 400);
    }
    try {
const out = await ctx.engine.createAndEnqueue({
        workspacePath,
        subjectKind: subject.subjectKind,
        base: subject.baseCommit ?? subject.baseRef,
        head: subject.headCommit ?? subject.headRef,
        includeDirty: subject.includeDirty,
        includeUntracked: subject.includeUntracked,
        fsPath: subject.fsPath,
        requirements: subject.requirements,
        source: subject.source,
        triggerSessionId: subject.triggerSessionId,
      });
      return json({ jobId: out.jobId, dedupeExisting: out.dedupeExisting }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: 'snapshot_failed', message }, 422);
    }
  }

  const retryMatch = url.pathname.match(/^\/v1\/reviews\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) {
    const job = getJob(ctx.d, retryMatch[1]!);
    if (!job) return json({ error: 'not_found' }, 404);
    if (
      ['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'CANCELLED', 'FAILED_TERMINAL'].includes(job.state) ||
      job.attemptCount >= REWORK_MAX_RETRIES
    ) {
      return json({ error: 'job_in_terminal_state', reason: 'retry cap reached' }, 409);
    }
    if (job.state === 'INCONCLUSIVE') {
      transitionJob(ctx.d, job.jobId, 'INCONCLUSIVE', 'QUEUED');
    } else {
      ctx.d.db.query(`UPDATE review_jobs SET state='QUEUED', updated_at=? WHERE job_id=?`).run(new Date().toISOString(), job.jobId);
    }
    enqueueEvent(ctx.d, 'job.retried', { jobId: job.jobId }, job.jobId);
    return json({ ok: true, state: 'QUEUED' });
  }

  const cancelMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const job = getJob(ctx.d, cancelMatch[1]!);
    if (!job) return json({ error: 'not_found' }, 404);
    if (job.state === 'CANCELLED') return json({ ok: true, state: 'CANCELLED' });
    if (['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'FAILED_TERMINAL'].includes(job.state)) {
      return json({ error: 'not_cancellable' }, 409);
    }
    ctx.d.db.query(`UPDATE review_jobs SET state='CANCELLED', completed_at=?, updated_at=? WHERE job_id=?`).run(
      new Date().toISOString(),
      new Date().toISOString(),
      job.jobId
    );
    enqueueEvent(ctx.d, 'job.cancelled', { jobId: job.jobId }, job.jobId);
    return json({ ok: true, state: 'CANCELLED' });
  }

  return json({ error: 'not_found' }, 404);
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function workerQueueStats(ctx: ApiContext): {
  reviewer: number;
  adjudicator: number;
  workers: number;
  reviewersRunning: number;
  adjudicatorsRunning: number;
} {
  try {
    const s = ctx.d.db
      .query<{ reviewer: number; adjudicator: number }, []>(
        `SELECT
           COALESCE(SUM(role='reviewer-a' OR role='reviewer-b'),0) AS reviewer,
           COALESCE(SUM(role='adjudicator'),0) AS adjudicator
         FROM agent_runs WHERE status='running'`
      )
      .get() ?? { reviewer: 0, adjudicator: 0 };
    const workers = ctx.d.db
      .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM workers WHERE status IN ('launching','running')`)
      .get() ?? { c: 0 };
    return {
      reviewer: s.reviewer,
      adjudicator: s.adjudicator,
      workers: workers.c,
      reviewersRunning: s.reviewer,
      adjudicatorsRunning: s.adjudicator,
    };
  } catch {
    return { reviewer: 0, adjudicator: 0, workers: 0, reviewersRunning: 0, adjudicatorsRunning: 0 };
  }
}

function recentWorkerErrors(ctx: ApiContext): number {
  try {
    const r = ctx.d.db
      .query<{ c: number }, [string]>(`SELECT COUNT(*) AS c FROM workers WHERE status IN ('failed','terminated') AND finished_at > ?`)
      .get(new Date(Date.now() - 86_400_000).toISOString());
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}
// ── Durable SSE projection (P0-H) ────────────────────────────────────────────
// The SSE connection uses a ReadableStream that drains `events_outbox` and owns
// ONLY its local cursor (seq). We NEVER call global markDelivered('seq') from a
// single subscriber, because one client's ack is not another's. Outbox cleanup
// is retention-based, not first-subscriber-saw-it-based.
function filterTicketPublic(b: import("./mission-repository").TicketRow): Record<string, unknown> {
  return { ticketId: b.ticket_id, missionId: b.mission_id, title: b.title, objective: b.objective, executionState: b.execution_state, verificationState: b.verification_state, activeRevisionId: b.active_revision_id, priority: b.priority, updatedAt: b.updated_at };
}

/** Runtime config view for the API/UX with secrets redacted. Exposes the
 *  effective config + per-field applicability metadata so a consumer can render
 *  live vs applies-on-restart controls and know precisely what it can toggle. */
function configViewForApi(store: RuntimeConfigStore): {
  config: Record<string, unknown>;
  meta: Record<string, unknown>;
  path: string;
} {
  const view = store.view();
  return {
    config: redactConfig(JSON.parse(JSON.stringify(view.config)) as Record<string, unknown>),
    meta: view.meta,
    path: view.path,
  };
}

function redactConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const daemon = (cfg.daemon ?? {}) as Record<string, unknown>;
  if (typeof daemon.token === 'string' && daemon.token) daemon.token = '***redacted***';
  const autonomy = (cfg.autonomy ?? {}) as Record<string, unknown>;
  if (typeof autonomy.apiKey === 'string' && autonomy.apiKey) autonomy.apiKey = '***redacted***';
  const policy = (cfg.policy ?? {}) as Record<string, unknown>;
  const providers = policy.providers as Record<string, unknown> | undefined;
  if (providers) {
    for (const key of Object.keys(providers)) {
      const p = (providers[key] ?? {}) as Record<string, unknown>;
      if (typeof p.apiKey === 'string' && p.apiKey) p.apiKey = '***redacted***';
    }
  }
  return cfg;
}
