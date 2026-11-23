import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from './db';
import type { Engine } from './engine';
import type { Config } from './config';
import type { RuntimeConfigStore } from './config-runtime';
import { getJob, listJobs } from './jobs';
import { takePendingEvents, enqueueEvent, listEventsTail } from './events';
import { buildObservabilitySnapshot, enrichOutboxEvents } from './observability';
import {
  getMission, listMissions, listTickets, listRevisions, getQualityGates, diagnoseFailure,
  createMission, createMissionRequest, addTicket, updateMissionState, updateRevision, getTicket, getRevision, listEvidence,
  assignTicketToAgent, emitMissionEvent, setMissionOperatorStatus, resumeMissionState,
  getMissionReviewControls, setMissionReviewControls,
  isAwaitingHumanAcceptance, recordMissionAcceptance, listMissionAcceptanceEvents,
  listUnsizedTickets, updateTicketSize,
} from './mission-repository';
import { TSHIRT_POINTS, TSHIRT_SIZES, type TShirtSize } from './task-sizer';
import { mergeReviewControls, normalizeReviewControls, parseReviewControls, validateReviewControls } from './review-controls';
import { getMissionReport } from './mission-report';
import { reReviewMission } from './mission-review-service';
import { registerWorkspace, getWorkspace } from './workspace-registry';
import { sampleMutationActivity, countTrackedFiles } from './mutation-activity';
import { verifyPendingVerify } from './mission-controller';
import { resolveEffectiveModelRoute } from './engine-review-hook';
import { resolveKiloProviderOptions } from './config-resolve';
import { EnhanceRequestSchema, checkEnhanceWorkspace, createKiloEnhancerRunner, createOpenAiEnhancerRunner, enhanceTask } from './enhancer';
import { resolveContextBudget } from './context-tiers';
import { propagateEngineRoute } from './config-propagation';
import { CreateJobRequestSchema } from './schemas';
import { transitionJob } from './state-machine';
import { REWORK_MAX_RETRIES } from './helldesk-semantics';
import { listHosts, listSessions, getHost, isSimulatedHost } from './host-registry';
import { acceptWorkerResult } from './worker-supervisor';
import { listTranscript } from './job-transcript';
import { addMissionChatMessage, listMissionChatMessages } from './mission-chat-repository';
import {
  GitError, getCommitDetail, getCommitFileDiff, listCommitWorkspaces, listCommits, requireWorkspace,
} from './git-commits';

/**
 * localhost-only HTTP JSON API + event feed.
 * Mutations require the per-user local token. Binds to 127.0.0.1 only.
 */

/** One background sizing pass at a time; the route returns immediately. */
let sizingBackfillRunning = false;

function gitErrorResponse(error: unknown): Response {
  if (error instanceof GitError) {
    const message = error.message;
    const status = /required|invalid/i.test(message)
      ? 400
      : /not found|does not exist|not a git/i.test(message)
        ? 404
        : 422;
    return json({ error: 'git_error', message, detail: error.detail?.slice(0, 4000) }, status);
  }
  return json({ error: 'git_error', message: error instanceof Error ? error.message : String(error) }, 500);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}


/**
 * Apply a NON-BLOCKING operator steering note (shared by /steer and the chat
 * composer). The note is appended to the mission + open tickets so the next
 * mutation boundary sees it; a VERIFIED mission becomes a follow-up. It never
 * aborts running work — the human is an async peer, not a gate.
 */
function applySteeringNote(
  d: Db,
  mission: NonNullable<ReturnType<typeof getMission>>,
  note: string,
  kind: string
): void {
  const now = new Date().toISOString();
  const suffix = `\n\n[Async CTO ${kind} ${now}]\n${note}`;
  d.tx((db) => {
    db.query('UPDATE autonomy_missions SET objective=objective || ?, updated_at=? WHERE mission_id=?').run(suffix, now, mission.mission_id);
    db.query("UPDATE mission_tickets SET objective=COALESCE(objective,'') || ?, updated_at=? WHERE mission_id=? AND execution_state != 'CLOSED'").run(suffix, now, mission.mission_id);
  });
  if (mission.state === 'VERIFIED_10_10') {
    addTicket(d, mission.mission_id, { title: 'CTO follow-up', objective: mission.objective + suffix });
    updateMissionState(d, mission.mission_id, 'ACTIVE');
  }
}

/**
 * REAL operator chat for a mission. GET pages the persisted transcript (real
 * Kilo session parts + operator messages). POST stores the operator message and
 * applies it as steering so the mission actually reacts.
 */
async function handleMissionChat(
  d: Db,
  mission: NonNullable<ReturnType<typeof getMission>>,
  req: Request,
  url: URL,
  method: string
): Promise<Response> {
  if (method === 'GET') {
    const sinceRaw = Number(url.searchParams.get('since') ?? '0');
    const limitRaw = Number(url.searchParams.get('limit') ?? '500');
    const tailRaw = Number(url.searchParams.get('tail') ?? '0');
    const messages = listMissionChatMessages(d, mission.mission_id, {
      sinceSeq: Number.isFinite(sinceRaw) ? sinceRaw : 0,
      limit: Number.isFinite(limitRaw) ? limitRaw : 500,
      tail: Number.isFinite(tailRaw) && tailRaw > 0 ? tailRaw : undefined,
    });
    return json({ missionId: mission.mission_id, messages });
  }
  if (method === 'POST') {
    const input = z
      .object({
        text: z.string().trim().min(1).max(16000),
        kind: z.enum(['message', 'interrupt', 'force-review', 'disapprove']).default('message'),
      })
      .safeParse(await safeJson(req));
    if (!input.success) return json({ error: 'invalid_message' }, 400);
    if (mission.state === 'CANCELLED') return json({ error: 'mission_cancelled' }, 409);
    const ticket = mission.current_ticket_id ? getTicket(d, mission.current_ticket_id) : null;
    const row = addMissionChatMessage(d, {
      missionId: mission.mission_id,
      ticketId: ticket?.ticket_id,
      role: 'operator',
      kind: 'text',
      text: input.data.text,
    });
    applySteeringNote(d, mission, input.data.text, input.data.kind);
    return json({
      ok: true,
      missionId: mission.mission_id,
      messageId: row?.message_id ?? null,
      kind: input.data.kind,
      delivery: 'queued_for_next_boundary',
    });
  }
  return json({ error: 'method_not_allowed' }, 405);
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
      tokensIn: typeof b.tokensIn === 'number' ? b.tokensIn : undefined,
      tokensOut: typeof b.tokensOut === 'number' ? b.tokensOut : undefined,
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
    const tailParam = Number(url.searchParams.get('tail') ?? '0');
    const limitParam = Number(url.searchParams.get('limit') ?? '0');
    const tail = Number.isFinite(tailParam) && tailParam > 0 ? Math.min(tailParam, 1000) : 0;
    const limit =
      tail ||
      (Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200);
    // Two honest read modes over the SAME durable journal:
    //   ?after=N  cursor mode (SSE resume) — the subscriber's unseen events.
    //   ?tail=N   tail mode (observability) — the NEWEST N events, chronological.
    // `tail` used to be indistinguishable from `after=0`, so every dashboard read
    // returned the oldest 200 rows and looked days stale while work was live.
    const raw = tail ? listEventsTail(ctx.d, tail) : takePendingEvents(ctx.d, after, limit);
    const events = enrichOutboxEvents(ctx.d, raw);
    // The SSE consumer resumes with `seq > after`, so a resume cursor MUST be the
    // last delivered seq (NOT lastSeq+1) or the next poll skips that last event.
    return json({ events, nextSeq: events.length ? events[events.length - 1]!.seq : after });
  }

  // One read-only observability snapshot over the durable engine state:
  // event volume/types/workstations, queue, missions, reviews, gates, workers,
  // usage and recovery — aggregated server-side so charts cover the whole 24h
  // window instead of whatever the browser happened to fetch.
  if (method === 'GET' && url.pathname === '/v1/observability') {
    return json(buildObservabilitySnapshot(ctx.d, ctx.queueDepth()));
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
    // Runtime detail: the coarse engine state is not enough for an honest board.
    // Surface the ACTIVE revision state and the review-job state so the dashboard
    // can show EVIDENCE_CAPTURED / REVIEWING_A_B / ADJUDICATING / INCONCLUSIVE.
    const runtimeFor = (missionId: string) =>
      ctx.d.db
        .query<{ rev_state: string | null; rev_no: number | null; job_state: string | null }, [string]>(
          `SELECT r.state AS rev_state, r.revision_no AS rev_no, j.state AS job_state
             FROM mission_tickets t
             LEFT JOIN ticket_revisions r ON r.revision_id = t.active_revision_id
             LEFT JOIN review_jobs j ON j.job_id = r.review_job_id
            WHERE t.mission_id = ?
            ORDER BY t.rowid DESC LIMIT 1`
        )
        .get(missionId);
    const missions = listMissions(ctx.d).map((m) => {
      const rt = runtimeFor(m.mission_id);
      return {
        missionId: m.mission_id,
        workspaceId: m.workspace_id,
        objective: m.objective,
        state: m.state,
        currentTicketId: m.current_ticket_id,
        verifiedAt: m.verified_at,
        blockedReason: m.blocked_reason,
        operatorStatus: m.operator_status ?? null,
        operatorStatusAt: m.operator_status_at ?? null,
        revisionState: rt?.rev_state ?? null,
        revisionNo: rt?.rev_no ?? null,
        reviewJobState: rt?.job_state ?? null,
        // Per-task review policy so mission-projected Kanban cards can render and
        // toggle Governor / Reviewer A / Reviewer B exactly like local tickets.
        controls: parseReviewControls(m.controls_json),
        // Machine VERIFIED_10_10 is not human acceptance. The board waits for the
        // operator's explicit decision before it closes the card.
        humanAcceptance: m.human_acceptance ?? null,
        humanAcceptedAt: m.human_accepted_at ?? null,
        humanAcceptanceNote: m.human_acceptance_note ?? null,
        humanAcceptedBy: m.human_accepted_by ?? null,
        awaitingHumanAcceptance: isAwaitingHumanAcceptance(m),
      };
    });
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
    return json({ mission: { ...mission, engineMatrix, controls: parseReviewControls(mission.controls_json), mutationActivity } });
  }

// All remaining routes require the mutation token.
  if (!url.pathname.startsWith('/v1')) return json({ error: 'not_found' }, 404);
  const auth = req.headers.get('Authorization');
  if (auth !== `Bearer ${ctx.token}` && req.headers.get('x-gt-token') !== ctx.token) {
    return json({ error: 'unauthorized' }, 401);
  }

  // ── Read-only git history (operator commit observability) ────────────────
  // Every route is token-gated (above), read-only, and scoped to a REGISTERED
  // workspace. The console uses these to show commit messages, metadata and a
  // per-file diff without opening an IDE.
  if (method === 'GET' && url.pathname === '/v1/commits/workspaces') {
    return json({ workspaces: listCommitWorkspaces(ctx.d) });
  }
  // Which mission/revision produced a commit? Read-only join over the durable
  // review-job base/head hashes; the Commits console annotates matching rows.
  if (method === 'GET' && url.pathname === '/v1/commits/provenance') {
    try {
      const ws = requireWorkspace(ctx.d, url.searchParams.get('workspaceId'));
      const rows = ctx.d.db
        .query<
          {
            meta: string | null;
            mission_id: string;
            ticket_id: string;
            revision_id: string;
            revision_no: number;
            mission_state: string;
            verified_at: string | null;
            human_acceptance: string | null;
          },
          [string]
        >(
          `SELECT j.meta, t.mission_id, t.ticket_id, r.revision_id, r.revision_no,
                  m.state AS mission_state, m.verified_at, m.human_acceptance
             FROM review_jobs j
             JOIN ticket_revisions r ON r.review_job_id = j.job_id
             JOIN mission_tickets t ON t.ticket_id = r.ticket_id
             JOIN autonomy_missions m ON m.mission_id = t.mission_id
            WHERE j.workspace_id=?
            ORDER BY j.rowid DESC LIMIT 400`
        )
        .all(ws.workspaceId);
      const seen = new Set<string>();
      const commits: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        let meta: Record<string, unknown> = {};
        try { meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
        const sha = typeof meta.headHash === 'string' && meta.headHash.length >= 7 ? meta.headHash : null;
        if (!sha || seen.has(sha)) continue;
        seen.add(sha);
        commits.push({
          sha,
          missionId: row.mission_id,
          ticketId: row.ticket_id,
          revisionId: row.revision_id,
          revisionNo: row.revision_no,
          state: row.mission_state,
          verifiedAt: row.verified_at,
          humanAcceptance: row.human_acceptance,
        });
      }
      return json({ workspaceId: ws.workspaceId, commits });
    } catch (error) {
      return gitErrorResponse(error);
    }
  }
  if (method === 'GET' && url.pathname === '/v1/commits') {
    try {
      const ws = requireWorkspace(ctx.d, url.searchParams.get('workspaceId'));
      const rawLimit = Number(url.searchParams.get('limit') ?? '80');
      const limit = Number.isFinite(rawLimit) ? rawLimit : 80;
      return json({ workspaceId: ws.workspaceId, path: ws.path, commits: listCommits(ws.path, limit) });
    } catch (error) {
      return gitErrorResponse(error);
    }
  }
  const commitFileMatch = /^\/v1\/commits\/([0-9a-fA-F]{7,40})\/file$/.exec(url.pathname);
  if (method === 'GET' && commitFileMatch) {
    try {
      const ws = requireWorkspace(ctx.d, url.searchParams.get('workspaceId'));
      const filePath = url.searchParams.get('path');
      if (!filePath) return json({ error: 'git_error', message: 'path is required' }, 400);
      const oldPath = url.searchParams.get('oldPath');
      const rawContext = Number(url.searchParams.get('context') ?? '3');
      const context = Number.isFinite(rawContext) ? rawContext : 3;
      return json({
        file: getCommitFileDiff(ws.path, commitFileMatch[1]!, filePath, { oldPath, context }),
      });
    } catch (error) {
      return gitErrorResponse(error);
    }
  }
  const commitMatch = /^\/v1\/commits\/([0-9a-fA-F]{7,40})$/.exec(url.pathname);
  if (method === 'GET' && commitMatch) {
    try {
      const ws = requireWorkspace(ctx.d, url.searchParams.get('workspaceId'));
      return json({ commit: getCommitDetail(ws.path, commitMatch[1]!) });
    } catch (error) {
      return gitErrorResponse(error);
    }
  }

  // ── Ender mission lifecycle (production ingress, P0) ─────────────────────
  // Create a mission over a registered workspace + one ticket.
  if (method === 'POST' && url.pathname === '/v1/missions') {
    const body = await safeJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const parsed = z.object({ workspaceId: z.string().min(1), objective: z.string().min(1), idempotencyKey: z.string().min(1).max(160).optional(), taskGates: z.array(z.string().min(1)).min(1).max(100).optional(), tickets: z.array(z.object({
      title: z.string().optional(),
      objective: z.string().optional(),
      dependsOn: z.array(z.string()).optional(),
      storyPoints: z.number().int().min(1).max(100).optional(),
      tshirtSize: z.enum(TSHIRT_SIZES).optional(),
      sizeConfidence: z.enum(['high', 'medium', 'low']).optional(),
      sizeRationale: z.string().max(600).optional(),
      sizeModel: z.string().max(300).optional(),
      sizingState: z.string().max(40).optional(),
    })).optional(), engineMatrix: z.record(z.string(), z.unknown()).optional(), controls: z.record(z.string(), z.unknown()).optional() }).safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_mission', issues: parsed.error.issues }, 400);
    const b = parsed.data;
    if (typeof b.workspaceId !== 'string' || !b.workspaceId) return json({ error: 'workspaceId required' }, 400);
    if (typeof b.objective !== 'string' || !b.objective) return json({ error: 'objective required' }, 400);
    const ws = getWorkspace(ctx.d, b.workspaceId);
    if (!ws) return json({ error: 'workspace_not_found' }, 404);
    const controls = normalizeReviewControls(b.controls);
    const controlsError = validateReviewControls(controls);
    if (controlsError) return json({ error: 'invalid_review_controls', message: controlsError }, 400);
    const rawTickets = Array.isArray(b.tickets) && b.tickets.length ? b.tickets : [{ title: 'B1', objective: b.objective, dependsOn: [] }];
    type MissionTicketInput = Parameters<typeof createMissionRequest>[1]['tickets'][number];
    const tickets: MissionTicketInput[] = [];
    for (const bb of rawTickets) {
      const title = bb.title || 'B1';
      const objective = bb.objective || b.objective;
      let storyPoints = bb.storyPoints ?? null;
      let tshirtSize = bb.tshirtSize ?? null;
      if (storyPoints == null && tshirtSize) storyPoints = TSHIRT_POINTS[tshirtSize as TShirtSize];
      let sizeConfidence = bb.sizeConfidence ?? null;
      let sizeRationale = bb.sizeRationale ?? null;
      let sizeModel = bb.sizeModel ?? null;
      let sizingState = bb.sizingState ?? (storyPoints != null ? 'sized' : 'unsized');
      if (storyPoints == null) {
        // Direct mission API callers that did not size the task still get one
        // bounded estimate; failure leaves it unsized and never blocks creation.
        const size = await ctx.engine.sizeTask({ title, objective, workspace: ws.path, kind: 'mission-ticket' });
        if (size.state === 'sized') {
          storyPoints = size.points;
          tshirtSize = size.tshirt;
          sizeConfidence = size.confidence;
          sizeRationale = size.rationale;
          sizeModel = size.model;
          sizingState = 'sized';
        }
      }
      tickets.push({
        title,
        objective,
        dependsOn: bb.dependsOn || [],
        storyPoints,
        tshirtSize,
        sizeConfidence,
        sizeRationale,
        sizeModel,
        sizingState,
      });
    }
    const result = createMissionRequest(ctx.d, { workspaceId: ws.workspaceId, objective: b.objective,
      idempotencyKey: b.idempotencyKey, taskGates: b.taskGates || ['full_task_scope', 'functional_behavior', 'regression_checks', 'artifact_provenance'],
      engineMatrix: b.engineMatrix, controls,
      tickets });
    if (result.conflict) return json({ error: 'idempotency_conflict', message: 'This task identity already belongs to a different mission request' }, 409);
    return json({ missionId: result.missionId, ticketIds: result.ticketIds, reused: result.reused }, result.reused ? 200 : 201);
  }

  // REAL operator chat for a mission (transcript + steering) — what the console
  // renders. GET pages the persisted Kilo-session transcript; POST stores the
  // operator's message and applies it as non-blocking steering.
  const missionChatMatch = /^\/v1\/missions\/([^/]+)\/chat$/.exec(url.pathname);
  if (missionChatMatch) {
    const mission = getMission(ctx.d, missionChatMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    return handleMissionChat(ctx.d, mission, req, url, method);
  }  // Operator board-status overlay. A mission card's column is derived from the
  // engine on every read, so a kanban drag used to snap back. Record the
  // operator's chosen column here; the projection shows it until the mission is
  // terminal. The engine STATE is never faked or changed by this endpoint.
  const missionStatusMatch = /^\/v1\/missions\/([^/]+)\/status$/.exec(url.pathname);
  if (method === 'POST' && missionStatusMatch) {
    const input = z.object({ status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']) }).safeParse(await safeJson(req));
    if (!input.success) return json({ error: 'invalid_status' }, 400);
    const mission = getMission(ctx.d, missionStatusMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (mission.state === 'CANCELLED' || mission.state === 'VERIFIED_10_10') {
      return json({ error: 'mission_terminal', state: mission.state }, 409);
    }
    setMissionOperatorStatus(ctx.d, mission.mission_id, input.data.status);
    return json({ ok: true, missionId: mission.mission_id, operatorStatus: input.data.status });
  }

  // Per-task review policy (Governor / Reviewer A / Reviewer B / Agents). LIVE:
  // applies to the next review boundary and to any QUEUED job, never fabricates a
  // verdict for an already-decided snapshot.
  const missionControlsMatch = /^\/v1\/missions\/([^/]+)\/controls$/.exec(url.pathname);
  if (method === 'POST' && missionControlsMatch) {
    const body = await safeJson(req);
    if (!body) return json({ error: 'invalid_json' }, 400);
    const mission = getMission(ctx.d, missionControlsMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (mission.state === 'CANCELLED' || mission.state === 'VERIFIED_10_10') {
      return json({ error: 'mission_terminal', state: mission.state }, 409);
    }
    const patch = normalizeReviewControls(body);
    if (Object.keys(patch).length === 0) {
      return json({ error: 'invalid_review_controls', message: 'at least one of {agents, reviewer, reviewerA, reviewerB, excellenceGovernor, review_mode} is required' }, 400);
    }
    const merged = mergeReviewControls(getMissionReviewControls(ctx.d, mission.mission_id), patch);
    const controlsError = validateReviewControls(merged);
    if (controlsError) return json({ error: 'invalid_review_controls', message: controlsError }, 400);
    const saved = setMissionReviewControls(ctx.d, mission.mission_id, merged);
    return json({ ok: true, missionId: mission.mission_id, controls: saved });
  }

  // One durable completion record: review policy, verdict, findings, roles/tokens,
  // gates, evidence, commit range and the human acceptance history.
  const missionReportMatch = /^\/v1\/missions\/([^/]+)\/report$/.exec(url.pathname);
  if (method === 'GET' && missionReportMatch) {
    const cfg = ctx.configStore.get();
    const report = getMissionReport(ctx.d, missionReportMatch[1]!, {
      pricing: cfg.policy.pricing,
      runner: cfg.policy.runner,
    });
    if (!report) return json({ error: 'mission_not_found' }, 404);
    return json(report);
  }

  // ── Task T-shirt sizing (structured JSON) ────────────────────────────────
  if (method === 'POST' && url.pathname === '/v1/size-task') {
    const body = await safeJson(req);
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(500),
        objective: z.string().max(20_000).optional(),
        body: z.string().max(40_000).optional(),
        requirements: z.union([z.string().max(20_000), z.array(z.string().max(2_000)).max(100)]).optional(),
        workspace: z.string().max(2_000).optional(),
        kind: z.string().max(100).optional(),
        timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_task_spec', issues: parsed.error.issues }, 400);
    const { timeoutMs, ...spec } = parsed.data;
    const size = await ctx.engine.sizeTask(spec, { timeoutMs });
    return json({ ok: size.state === 'sized', ...size });
  }

  const ticketSizeMatch = /^\/v1\/tickets\/([^/]+)\/size$/.exec(url.pathname);
  if (method === 'POST' && ticketSizeMatch) {
    const body = await safeJson(req);
    const parsed = z
      .object({
        tshirt: z.enum(TSHIRT_SIZES),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
        rationale: z.string().trim().max(600).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_ticket_size', issues: parsed.error.issues }, 400);
    const points = TSHIRT_POINTS[parsed.data.tshirt as TShirtSize];
    const ticket = updateTicketSize(ctx.d, ticketSizeMatch[1]!, {
      tshirt: parsed.data.tshirt,
      storyPoints: points,
      confidence: parsed.data.confidence ?? null,
      rationale: parsed.data.rationale ?? null,
      model: 'manual',
      state: 'manual',
    });
    if (!ticket) return json({ error: 'ticket_not_found' }, 404);
    return json({ ok: true, ticketId: ticket.ticket_id, storyPoints: points, tshirtSize: parsed.data.tshirt });
  }

  if (method === 'POST' && url.pathname === '/v1/tasks/backfill-sizes') {
    const body = await safeJson(req);
    const parsed = z.object({ limit: z.number().int().min(1).max(10).optional() }).safeParse(body ?? {});
    if (!parsed.success) return json({ error: 'invalid_backfill', issues: parsed.error.issues }, 400);
    const limit = parsed.data.limit ?? 5;
    const remaining = () => listUnsizedTickets(ctx.d, 1000).length;
    if (sizingBackfillRunning) {
      return json({ ok: true, queued: 0, sized: 0, failed: 0, remaining: remaining(), running: true });
    }
    const tickets = listUnsizedTickets(ctx.d, limit);
    if (tickets.length === 0) {
      return json({ ok: true, queued: 0, sized: 0, failed: 0, remaining: 0, running: false });
    }
    // A cold headless model call can take 15-40s; never hold the HTTP request
    // open for a multi-ticket pass. Queue it and let the UI watch coverage.
    sizingBackfillRunning = true;
    void (async () => {
      for (const ticket of tickets) {
        try {
          const size = await ctx.engine.sizeTask(
            { title: ticket.title, objective: ticket.objective, kind: 'mission-ticket' },
            { timeoutMs: 60_000 },
          );
          if (size.state === 'sized' && size.points != null && size.tshirt) {
            updateTicketSize(ctx.d, ticket.ticket_id, {
              tshirt: size.tshirt,
              storyPoints: size.points,
              confidence: size.confidence,
              rationale: size.rationale,
              model: size.model,
              state: 'sized',
            });
          } else {
            console.warn(`[sizing] ${ticket.ticket_id} stayed unsized: ${size.error ?? 'unknown error'}`);
          }
        } catch (error) {
          console.warn(`[sizing] ${ticket.ticket_id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      sizingBackfillRunning = false;
    });
    return json({
      ok: true,
      queued: tickets.length,
      sized: 0,
      failed: 0,
      remaining: remaining(),
      running: true,
    });
  }

  const acceptanceMatch = /^\/v1\/missions\/([^/]+)\/acceptance$/.exec(url.pathname);
  if (acceptanceMatch) {
    const mission = getMission(ctx.d, acceptanceMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (method === 'GET') {
      return json({
        missionId: mission.mission_id,
        current: {
          decision: mission.human_acceptance ?? null,
          note: mission.human_acceptance_note ?? null,
          actor: mission.human_accepted_by ?? null,
          decidedAt: mission.human_accepted_at ?? null,
          awaitingHumanAcceptance: isAwaitingHumanAcceptance(mission),
        },
        history: listMissionAcceptanceEvents(ctx.d, mission.mission_id),
      });
    }
    if (method === 'POST') {
      const input = z
        .object({
          decision: z.enum(['accepted', 'changes_requested']),
          note: z.string().trim().max(16000).optional(),
          actor: z.string().trim().max(256).optional(),
        })
        .safeParse(await safeJson(req));
      if (!input.success) return json({ error: 'invalid_acceptance', issues: input.error.issues }, 400);
      try {
        const result = recordMissionAcceptance(ctx.d, {
          missionId: mission.mission_id,
          decision: input.data.decision,
          note: input.data.note,
          actor: input.data.actor,
        });
        return json({
          ok: true,
          missionId: result.mission.mission_id,
          decision: result.event.decision,
          event: result.event,
          state: result.mission.state,
        });
      } catch (error) {
        return json({ error: 'acceptance_failed', message: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    return json({ error: 'method_not_allowed' }, 405);
  }

  const reReviewMatch = /^\/v1\/missions\/([^/]+)\/re-review$/.exec(url.pathname);
  if (method === 'POST' && reReviewMatch) {
    const mission = getMission(ctx.d, reReviewMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    const result = await reReviewMission(ctx.engine, mission.mission_id);
    return json(
      { ok: result.action !== 'rejected', missionId: mission.mission_id, ...result },
      result.action === 'rejected' ? 409 : 200
    );
  }

  const steerMissionMatch = /^\/v1\/missions\/([^/]+)\/steer$/.exec(url.pathname);
  if (method === 'POST' && steerMissionMatch) {
    const input = z.object({ note: z.string().trim().min(1).max(16000), kind: z.enum(['message', 'interrupt', 'force-review', 'disapprove']).default('message') }).safeParse(await safeJson(req));
    if (!input.success) return json({ error: 'invalid_steering' }, 400);
    const mission = getMission(ctx.d, steerMissionMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (mission.state === 'CANCELLED') return json({ error: 'mission_cancelled' }, 409);
    applySteeringNote(ctx.d, mission, input.data.note, input.data.kind);
    return json({ ok: true, missionId: mission.mission_id, delivery: 'queued_for_next_boundary', kind: input.data.kind });
  }

  // Operator dispatch override: assign a mission ticket to a chosen agent (Toast).
  // Records the operator's chosen agent as the ticket's assignee so the console card
  // shows ownership instead of 'Unassigned'. The mission engine_matrix (Toast's
  // engine, e.g. an OpenAI-compatible route or the effective Kilo model) is the runner; assignment is the
  // first-class operator ownership signal. Validates the mission+ticket exist.
  const assignMatch = /^\/v1\/missions\/([^/]+)\/tickets\/([^/]+)\/assign$/.exec(url.pathname);
  if (method === 'POST' && assignMatch) {
    const input = z.object({ agentId: z.string().trim().min(1).max(256) }).safeParse(await safeJson(req));
    if (!input.success) return json({ error: 'invalid_assignment' }, 400);
    const mission = getMission(ctx.d, assignMatch[1]!);
    if (!mission) return json({ error: 'mission_not_found' }, 404);
    if (mission.state === 'CANCELLED') return json({ error: 'mission_cancelled' }, 409);
    // Resolve the real ticket: a caller may pass the MISSION id (mis_*) where the
    // TICKET id belongs. That's a real console bug the operator hit ('Ticket
    // mis_c943... not found'). Never 404 on it — resolve the mission's current
    // ticket and use that. This makes assign + steer robust across surfaces.
    let ticket = getTicket(ctx.d, assignMatch[2]!);
    if (!ticket && mission.current_ticket_id) ticket = getTicket(ctx.d, mission.current_ticket_id);
    if (!ticket && mission.mission_id) ticket = getTicket(ctx.d, mission.mission_id);
    if (!ticket) return json({ error: 'ticket_not_found' }, 404);
    if (ticket.execution_state === 'CLOSED') return json({ error: 'ticket_closed' }, 409);
    assignTicketToAgent(ctx.d, ticket.ticket_id, input.data.agentId, { by: 'operator' });
    emitMissionEvent(ctx.d, 'mission.ticket.assigned', { mission_id: mission.mission_id, ticket_id: ticket.ticket_id, agent_id: input.data.agentId, by: 'operator', assigned_at: new Date().toISOString() });
    return json({ ok: true, missionId: mission.mission_id, ticketId: ticket.ticket_id, agentId: input.data.agentId, delivery: 'operator_dispatch_override_recorded', assigned: true });
  }

  // Resume a non-terminal mission: unblock / un-cancel / reactivate and make any
  // stuck revision dispatchable again (safe recovery).
  const resumeMatch = /^\/v1\/missions\/([^/]+)\/resume$/.exec(url.pathname);
  if (method === 'POST' && resumeMatch) {
    const mission = getMission(ctx.d, resumeMatch[1]!);
    if (!mission) return json({ error: 'not_found' }, 404);
    if (mission.state === 'VERIFIED_10_10') return json({ error: 'already_verified' }, 409);
    if (!resumeMissionState(ctx.d, mission.mission_id)) return json({ error: 'not_found' }, 404);
    emitMissionEvent(ctx.d, 'mission.resumed', { mission_id: mission.mission_id, by: 'operator' });
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
      // CONFIG PROPAGATION: a live route change must reach every non-terminal task
      // immediately, not only at the next 60s reconcile.
      try {
        const cfgNow = ctx.configStore.get();
        const route = resolveEffectiveModelRoute({ providerID: cfgNow.autonomy.providerID, modelID: cfgNow.autonomy.modelID });
        propagateEngineRoute(ctx.d, route);
      } catch { /* best effort; the periodic reconcile retries */ }
      const status = result.rejected.length ? 400 : 200;
      const viewNow = configViewForApi(ctx.configStore);
      return json({ ok: result.rejected.length === 0, applied_live: result.appliedLive, applies_on_restart: result.appliesOnRestart, rejected: result.rejected, config_path: result.path, config: viewNow.config, context_resolution: viewNow.context_resolution }, status);
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

  // ── Task Studio prompt enhancer (token-gated) ───────────────────────────
  // ONE OpenAI-compatible model turn (structured JSON when the endpoint
  // supports it) that turns a terse operator brief into an implementation-ready
  // spec. Repository profiling in `repos` mode is READ-ONLY and bounded; this
  // route never writes to the workspace or output repo.
  if (method === 'POST' && url.pathname === '/v1/enhance') {
    const body = await safeJson(req);
    if (!body) return json({ error: 'invalid_body', message: 'Request body must be JSON.' }, 400);
    const parsed = EnhanceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const cfg = ctx.configStore.get();
    const route = resolveEffectiveModelRoute({
      providerID: cfg.autonomy.providerID,
      modelID: cfg.autonomy.modelID,
    });
    if (!route.providerID || !route.modelID) {
      return json(
        {
          error: 'model_route_missing',
          message: 'No effective model route is configured. Set autonomy.providerID/modelID or a default model in kilo.jsonc.',
        },
        503
      );
    }
    const provider = resolveKiloProviderOptions(route.providerID);
    if (!provider?.baseURL) {
      return json(
        {
          error: 'model_endpoint_missing',
          message: `No OpenAI-compatible baseURL is configured for provider ${route.providerID}.`,
        },
        503
      );
    }
    const workspaceCheck = checkEnhanceWorkspace(parsed.data.workspace);
    if (!workspaceCheck.ok) {
      // Fast, actionable rejection. A plain (non-git) directory makes the Kilo
      // CLI hang on Windows; Save repos initialises it (input = output).
      return json({ error: workspaceCheck.error, message: workspaceCheck.message }, 400);
    }
    const runnerKind = cfg.policy.runner ?? 'kilo';
    if (runnerKind !== 'kilo' && runnerKind !== 'openai') {
      return json(
        { error: 'runner_unsupported', message: `The enhancer does not support runner "${runnerKind}". Use kilo or openai.` },
        503
      );
    }
    const kiloBin = cfg.policy.kiloServerBin || cfg.autonomy.kiloBin || '';
    if (runnerKind === 'kilo' && !kiloBin) {
      return json(
        {
          error: 'kilo_binary_missing',
          message: 'No headless Kilo binary is configured (policy.kiloServerBin / autonomy.kiloBin).',
        },
        503
      );
    }
    const configuredQa = cfg.policy.governorModel;
    const configuredQaProvider = configuredQa ? resolveKiloProviderOptions(configuredQa.providerID) : null;
    const qaModel = configuredQa && configuredQaProvider?.baseURL ? configuredQa : route;
    const qaProvider = qaModel === route ? provider : resolveKiloProviderOptions(qaModel.providerID);
    // Tier-derived prompt budgets: a 16K/32K route must trim the repo context
    // and QA spec instead of overflowing the model window.
    const enhancerContext = resolveContextBudget({
      context: cfg.context,
      providerID: route.providerID,
      modelID: route.modelID,
    });
    const qaContext = resolveContextBudget({
      context: cfg.context,
      providerID: qaModel.providerID,
      modelID: qaModel.modelID,
    });
    const toPromptBudget = (b: ReturnType<typeof resolveContextBudget>) => ({
      contextWindowTokens: b.contextWindow,
      inputBudgetTokens: b.inputBudgetTokens,
      outputBudgetTokens: b.outputBudgetTokens,
      promptCharBudget: b.userPromptCharBudget,
    });
    const enhancerPromptBudget = toPromptBudget(enhancerContext);
    const qaPromptBudget = toPromptBudget(qaContext);
    if (enhancerPromptBudget.promptCharBudget < 8_000 || qaPromptBudget.promptCharBudget < 8_000) {
      return json(
        {
          error: 'context_window_too_small',
          message: `The enhancer/QA route leaves too little prompt budget (enhancer ${enhancerPromptBudget.promptCharBudget} chars, QA ${qaPromptBudget.promptCharBudget} chars; need at least 8000). Raise the context tier or choose a larger model.`,
        },
        503
      );
    }
    // Run the Kilo CLI in an ISOLATED temp sandbox, never in the user's
    // workspace. Even a tool-less read-only agent makes Kilo initialise .git /
    // write session snapshots in its --dir; the repo profile is embedded in the
    // prompt, so the CLI's cwd is irrelevant. This keeps Analyze strictly
    // read-only for the routed repos.
    const enhancerSandbox = mkdtempSync(join(tmpdir(), 'helldesk-enhancer-'));
    try {
      const runner = runnerKind === 'kilo'
        ? createKiloEnhancerRunner({
            modelRef: `${route.providerID}/${route.modelID}`,
            kiloBin,
            directory: enhancerSandbox,
            timeoutMs: 180_000,
          })
        : createOpenAiEnhancerRunner({
            baseURL: provider.baseURL,
            apiKey: provider.apiKey,
            modelID: route.modelID,
          });
      const qaRunner = runnerKind === 'kilo'
        ? createKiloEnhancerRunner({
            modelRef: `${qaModel.providerID}/${qaModel.modelID}`,
            kiloBin,
            directory: enhancerSandbox,
            agentName: 'helldesk-qa',
            timeoutMs: 210_000,
          })
        : createOpenAiEnhancerRunner({
            baseURL: qaProvider?.baseURL ?? provider.baseURL,
            apiKey: qaProvider?.apiKey ?? provider.apiKey,
            modelID: qaModel.modelID,
          });
      const result = await enhanceTask(parsed.data, {
        runner,
        qaRunner,
        enhancerBudget: enhancerPromptBudget,
        qaBudget: qaPromptBudget,
      });
      return json({
        ok: true,
        enhanced: result.enhanced,
        qa: result.qa,
        ...(result.analysis ? { analysis: result.analysis } : {}),
        meta: {
          providerID: route.providerID,
          modelID: route.modelID,
          qaProviderID: qaModel.providerID,
          qaModelID: qaModel.modelID,
          enhancerContextTier: enhancerContext.tier,
          enhancerContextWindow: enhancerContext.contextWindow,
          qaContextTier: qaContext.tier,
          qaContextWindow: qaContext.contextWindow,
          tookMs: result.tookMs,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: 'enhance_failed', message: message.slice(0, 2000) }, 502);
    } finally {
      try { rmSync(enhancerSandbox, { recursive: true, force: true }); } catch { /* best effort */ }
    }
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
  return { ticketId: b.ticket_id, missionId: b.mission_id, title: b.title, objective: b.objective, executionState: b.execution_state, verificationState: b.verification_state, activeRevisionId: b.active_revision_id, priority: b.priority, updatedAt: b.updated_at, assigneeAgentId: b.assignee_agent_id ?? null, assignedAt: b.assigned_at ?? null, assignedBy: b.assigned_by ?? null };
}

/** Runtime config view for the API/UX with secrets redacted. Exposes the
 *  effective config + per-field applicability metadata so a consumer can render
 *  live vs applies-on-restart controls and know precisely what it can toggle. */
function configViewForApi(store: RuntimeConfigStore): {
  config: Record<string, unknown>;
  meta: Record<string, unknown>;
  path: string;
  context_resolution: ReturnType<typeof resolveContextBudget>;
} {
  const view = store.view();
  const cfg = view.config;
  // Resolve the operator's effective route (explicit reviewer model, else the
  // autonomy/Kilo-inherited route) and surface the effective context tier so
  // settings can show what the agents will actually use.
  const route =
    cfg.policy.reviewerModel ??
    resolveEffectiveModelRoute({ providerID: cfg.autonomy.providerID, modelID: cfg.autonomy.modelID });
  return {
    config: redactConfig(JSON.parse(JSON.stringify(view.config)) as Record<string, unknown>),
    meta: view.meta,
    path: view.path,
    context_resolution: resolveContextBudget({
      context: cfg.context,
      providerID: route.providerID,
      modelID: route.modelID,
    }),
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
