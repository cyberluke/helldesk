/**
 * Local HELLDESK — native Bun server entry.
 *
 * Serves:
 *  - the full local HELLDESK control plane (reusing the federated handlers)
 *  - the unified HELLDESK desktop at `/helldesk` (`/` redirects there)
 *  - NAI Lattice token/secret fabric
 *
 * Localhost, single-user: no Cloudflare, no billing, no Sentry, no auth.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createLocalRuntime } from '../core/runtime/registry';
import { buildHelldeskEnv, type HelldeskEnv, type HelldeskAppEnv } from '../core/helldesk.worker';
import { getDepartmentDOStub } from '../core/dos/Department.do';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { PtyManager, type PtySessionInfo } from '../core/pty/PtyManager';
import { openConnection } from '../core/pty/ws-pty-bridge';
import { ChatFabric, type ChatMessageOut } from '../core/fabric/ChatFabric';
import { handleCreateSpecProject, handleGetExcellenceGovernor, handleSetTicketControls, type Ctx } from '../core/handlers/excellenceGovernor.handler';
import { handleBreakRoomSteer, bridgeRoomActivity, type BreakRoomCtx } from '../core/handlers/break-room-steer.handler';
import type { RoomChatRow } from '../core/breakRoom/room';
import type { RuntimeEvent } from '../core/runtime/local-reconciler';
import { setMissionReviewControls, steerLocalMission } from '../core/runtime/mission-dispatch';
import {handleOperatorNudge} from '../core/handlers/operator-console.handler';
import {initializeKiloDiscovery, handleGetKiloConfig, handleReloadKiloConfig} from '../core/handlers/kilo-config.handler';

// Real local PTY backend (native Bun pty) for the frontDesk/agent terminals — full
// parity with the cloud Department Container PTY, implemented natively without Docker.
const ptyManager = new PtyManager();

// break-room-mind: one ChatFabric per department that bridges the HELLDESK dashboard to the
// NAF fabric and the Kilo VSIX extension. Publishing here mirrors the message
// to the extension; events published by the extension arrive via onEvent.
const chatFabrics = new Map<string, ChatFabric>();
function chatFabricFor(departmentId: string): ChatFabric {
  let f = chatFabrics.get(departmentId);
  if (!f) {
    f = new ChatFabric({ departmentId });
    chatFabrics.set(departmentId, f);
  }
  // Retryable: if the earlier connect failed (engine/fabric coming up), a later
  // call retries against the now-live canonical pipe.
  f.connect();
  return f;
}

// Bridge a department's colony runtime events onto its ChatFabric as live chat rows,
// once per department. The human sees every agent/reviewer move as a Discord-style
// line in BreakRoomChat, and steers back through the /breakRoom/steer endpoint.
const breakRoomBridges = new WeakSet<object>();
function bridgeBreakRoomFor(department: { departmentId: string; eventBus: { subscribe(fn: (e: RuntimeEvent) => void): () => void } }): void {
  if (breakRoomBridges.has(department)) return;
  breakRoomBridges.add(department);
  const publishChat = (row: RoomChatRow) => { void row; /* reserved for multi-peer UI */ };
  bridgeRoomActivity(
    department.departmentId,
    (fn) => department.eventBus.subscribe(fn),
    chatFabricFor(department.departmentId),
    publishChat,
  );
}

// ---------------------------------------------------------------- runtime
const DATA_ROOT = process.env.HELLDESK_DATA_ROOT ?? join(import.meta.dir, '..', 'data');
const HOST = process.env.HELLDESK_HOST ?? '127.0.0.1';
const PORT = Number(process.env.HELLDESK_PORT ?? 8790);
mkdirSync(DATA_ROOT, { recursive: true });

// Resolve the LOCAL control plane (services/helldesk/local) so this dashboard can
// surface its /v1 config + relays runtime control. Port from its config.json;
// auth token from its dataDir token file (or config daemon.token).
const localDir = join(dirname(dirname(import.meta.dir)), 'local');
// Benchmark/demo isolation: point the dashboard at an alternate local control
// plane config (and therefore an alternate port/token/data dir) without
// touching the operator's production config.
const controlConfigPath = process.env.HELLDESK_CONTROL_CONFIG || join(localDir, 'config.json');
function controlPlaneAddr(): { port: number; token: string } | null {
  try {
    if (!existsSync(controlConfigPath)) return null;
    const cfg = JSON.parse(readFileSync(controlConfigPath, 'utf-8')) as { daemon?: { port?: number; dataDir?: string; token?: string } };
    const port = cfg.daemon?.port ?? 4790;
    let token = cfg.daemon?.token ?? '';
    if (!token) {
      const dataDir = cfg.daemon?.dataDir ?? join(process.env.LOCALAPPDATA ?? '', 'HELLDESK', 'LocalDepartment');
      const tok = join(dataDir, 'token');
      if (existsSync(tok)) token = readFileSync(tok, 'utf-8').trim();
    }
    return { port, token };
  } catch {
    return null;
  }
}

const runtime = createLocalRuntime(DATA_ROOT);
const env: HelldeskEnv = buildHelldeskEnv(runtime);
const app = new Hono<HelldeskAppEnv>();
app.use('*', cors());
// Hard stability guard: a single request handler that throws MUST NOT kill the
// whole local-live process (the operator console). Without app.onError, Hono
// rethrows the exception from app.fetch, which Bun.serve's fetch() propagates
// and the Bun process EXITS — this is the root cause of the recurring
// 'local-live bg process keeps exiting (hono-base.js:287)' crashes. Convert any
// handler exception into a 500 JSON so the dashboard survives a bad request.
app.onError((err, c) => {
  console.error('[local-helldesk] handler error:', err && err.message ? err.message : String(err));
  try {
    return c.json({ success: false, error: (err && err.message) || String(err) }, 500);
  } catch {
    return new Response(JSON.stringify({ success: false, error: 'server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
});
initializeKiloDiscovery();
app.get('/api/kilo/config', handleGetKiloConfig);
app.post('/api/kilo/config/reload', handleReloadKiloConfig);

// ── REAL operator chat (mission transcript + steering) ───────────────────────
// The console must show the mission's ACTUAL Kilo session messages. Those live
// in the control plane (:4790) and need its bearer token, so proxy them here
// (same trust boundary as the other control-plane relays).
async function missionProxy(c: any, method: 'GET' | 'POST', suffix: '/chat' | '/resume' | '/cancel'): Promise<Response> {
  const addr = controlPlaneAddr();
  if (!addr) return c.json({ success: false, error: 'control_plane_unavailable' }, 503);
  const missionId = c.req.param('missionId');
  const target = new URL(`http://127.0.0.1:${addr.port}/v1/missions/${encodeURIComponent(missionId)}${suffix}`);
  for (const [k, v] of new URL(c.req.url).searchParams) target.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (addr.token) headers.Authorization = `Bearer ${addr.token}`;
  let body: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = (await c.req.text()) || '{}';
  }
  try {
    const res = await fetch(target, { method, headers, body });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return c.json({ success: false, error: 'control_plane_unreachable', message: err instanceof Error ? err.message : String(err) }, 502);
  }
}
app.get('/api/missions/:missionId/chat', (c) => missionProxy(c, 'GET', '/chat'));
app.post('/api/missions/:missionId/chat', (c) => missionProxy(c, 'POST', '/chat'));
// Explicit operator recovery for a blocked/cancelled mission (engine /resume).
app.post('/api/missions/:missionId/resume', (c) => missionProxy(c, 'POST', '/resume'));
// Operator discard: cancel the engine mission (then the board archives it).
app.post('/api/missions/:missionId/cancel', (c) => missionProxy(c, 'POST', '/cancel'));

// Passive room inventory: opening the operator UI must not start a FrontDesk/model.
app.get('/api/departments/:departmentId/room', async (c) => {
  try {
    const department = runtime.getDepartment(c.req.param('departmentId'));
    if (!department) return c.json({ success: false, error: 'department_not_found' }, 404);
    const [agents, tickets, workstations] = await Promise.all([
      department.listAgents().catch(() => []),
      department.listTickets({}).catch(() => []),
      department.listWorkstations().catch(() => []),
    ]);
    return c.json({ success: true, data: { agents, tickets, workstations } });
  } catch (e) {
    return c.json({ success: false, error: (e as Error)?.message ?? 'room_unavailable' }, 500);
  }
});

// All agents in a department: the live operator-room crew (Toast, FrontDesk,
// mission soul agents — the fabric agents shown in the chat crew). The Agents tab
// must show the WHOLE crew the operator can steer, not only workstation-registered
// agents. This is the authoritative roster for the Agents page. department
// .listAgents() already returns the full crew (same source as the room route).
app.get('/api/departments/:departmentId/agents', async (c) => {
  try {
    const department = runtime.getDepartment(c.req.param('departmentId'));
    if (!department) return c.json({ success: false, error: 'department_not_found' }, 404);
    const agents = await department.listAgents().catch(() => []);
    return c.json({ success: true, data: agents });
  } catch (e) {
    return c.json({ success: false, error: (e as Error)?.message ?? 'agents_unavailable' }, 500);
  }
});

// departmentId/workstationId middleware: always set c.get('departmentId')/c.get('workstationId').
app.use('/api/departments/:departmentId/*', async (c, next) => {
  (c as unknown as { set(k: string, v: unknown): void }).set('departmentId', c.req.param('departmentId'));
  await next();
});
app.use('/api/departments/:departmentId/workstations/:workstationId/*', async (c, next) => {
  (c as unknown as { set(k: string, v: unknown): void }).set('workstationId', c.req.param('workstationId'));
  await next();
});

async function departmentDO(c: { env: HelldeskEnv }, departmentId: string) {
  return getDepartmentDOStub(c.env, departmentId) ?? (await runtime.getDepartment(departmentId));
}

// ---------------------------------------------------------------- handlers
import { handleCreateDepartment, handleListDepartments, handleGetDepartment, handleCreateWorkstation, handleGetWorkstation, handleListWorkstations, handleDeleteWorkstation } from '../core/handlers/departments.handler';
import { resSuccess, resError } from '../core/util/res.util';
import { z } from 'zod';
import { handleCreateTicket, handleListTickets, handleGetTicket, handleUpdateTicketStatus, handleCloseTicket, handleSlingTicket, handleDeleteTicket, handleSetTicketSize } from '../core/handlers/workstation-tickets.handler';
import { handleListTicketEvents } from '../core/handlers/workstation-ticket-events.handler';
import { handleAppendAgentEvent, handleGetAgentEvents } from '../core/handlers/workstation-agent-events.handler';
import { handleRegisterAgent, handleListAgents, handleGetAgent, handleDeleteAgent, handleGetOrCreateAgent, handlePrime, handleAgentDone, handleAgentCompleted, handleWriteCheckpoint, handleCheckMemo, handleHeartbeat, handleUpdateAgentStatusMessage, handleHookTicket, handleUnhookTicket, handleAgentWaiting, handleRequestChanges, handleGetPendingNudges, handleNudge, handleNudgeDelivered } from '../core/handlers/workstation-agents.handler';
import { handleCreateShift } from '../core/handlers/department-shifts.handler';
import { handleGetDepartmentConfig, handleUpdateDepartmentConfig } from '../core/handlers/department-config.handler';
import { handleListDepartmentEvents } from '../core/handlers/department-events.handler';
import { handleSendMemo } from '../core/handlers/workstation-memo.handler';
import { handleSubmitToReviewQueue, handleCompleteReview } from '../core/handlers/workstation-review-queue.handler';
import { handleResolveTriage } from '../core/handlers/workstation-triage.handler';
import { handleCreateEscalation } from '../core/handlers/workstation-escalations.handler';

// departments (single-user local: default owner_user_id = 'local')
const LOCAL_USER = 'local';
function newWorkstationId(): string {
  return `workstation-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
function toDepartmentJson(t: { departmentId: string; getDepartmentConfig(): Promise<{ local_repo?: { repo_path?: string; branch?: string } }> }): Promise<Record<string, unknown>> {
  return t.getDepartmentConfig().then((cfg) => ({
    id: t.departmentId,
    name: t.departmentId === 'default' ? 'HELLDESK' : t.departmentId,
    owner_user_id: LOCAL_USER,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    repo_path: cfg?.local_repo?.repo_path ?? null,
  }));
}
async function handleListDepartmentsLocal(c: { json(v: unknown): Response }, runtime: { getDepartment(name: string): { departmentId: string; getDepartmentConfig(): Promise<{ local_repo?: { repo_path?: string; branch?: string } }> } }): Promise<Response> {
  // Ensure the default department exists so the UI always has a department.
  const t = runtime.getDepartment('default');
  return c.json(resSuccess([await toDepartmentJson(t)]));
}
async function handleGetDepartmentLocal(c: { json(v: unknown): Response }, runtime: { getDepartment(name: string): { departmentId: string; getDepartmentConfig(): Promise<{ local_repo?: { repo_path?: string; branch?: string } }> } }): Promise<Response> {
  const departmentId = 'default'; // single-department local: any departmentId maps to the default department
  const t = runtime.getDepartment(departmentId);
  return c.json(resSuccess(await toDepartmentJson(t)));
}
async function handleCreateDepartmentLocal(c: { req: { json(): Promise<unknown> }; json(v: unknown, status?: number): Response }, runtime: { getDepartment(name: string): { departmentId: string; getDepartmentConfig(): Promise<{ local_repo?: { repo_path?: string; branch?: string } }> } }): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ name: z.string().min(1) }).safeParse(body);
  if (!parsed.success) return c.json(resError('name is required'), 400);
  const t = runtime.getDepartment('default');
  return c.json(resSuccess(await toDepartmentJson(t)), 201);
}
app.post('/api/departments', (c) => handleCreateDepartmentLocal(c, runtime));
app.get('/api/departments', (c) => handleListDepartmentsLocal(c, runtime));
app.get('/api/departments/:departmentId', (c) => handleGetDepartmentLocal(c, runtime));
// workstations (via Department DO — the runtime-backed path)
app.get('/api/departments/:departmentId/workstations', async (c) => c.json(resSuccess(await (await departmentDO(c, c.req.param('departmentId'))).listWorkstations())));
app.get('/api/departments/:departmentId/workstations/:workstationId', async (c) => {
  const workstation = await (await departmentDO(c, c.req.param('departmentId'))).getWorkstationAsync(c.req.param('workstationId'));
  if (!workstation) return c.json(resError('Workstation not found'), 404);
  return c.json(resSuccess(workstation));
});
app.post('/api/departments/:departmentId/workstations', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  // A workstation is a crew seat, not a repo: locally the workspace path is
  // routed per task in Task Studio, so a Git URL is optional.
  const parsed = z.object({ name: z.string().trim().min(1).max(64), git_url: z.string().optional(), default_branch: z.string().optional() }).safeParse(body);
  if (!parsed.success) return c.json(resError('name is required'), 400);
  const t = await departmentDO(c, c.req.param('departmentId'));
  const workstation = await t.addWorkstation({ workstationId: newWorkstationId(), name: parsed.data.name, gitUrl: parsed.data.git_url ?? '', defaultBranch: parsed.data.default_branch || 'main' });
  return c.json(resSuccess(workstation), 201);
});
app.delete('/api/departments/:departmentId/workstations/:workstationId', async (c) => {
  const t = await departmentDO(c, c.req.param('departmentId'));
  await t.removeWorkstation(c.req.param('workstationId'));
  return c.json(resSuccess({ deleted: true }));
});

// tickets
// Department-wide board: includes department-scoped engine missions. Seat boards
// (`/workstations/:id/tickets`) stay filtered to that workstation's own work.
app.get('/api/departments/:departmentId/tickets', (c) => handleListTickets(c, {}));
app.post('/api/departments/:departmentId/tickets/archive', async (c) => {
  const departmentId = c.req.param('departmentId');
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    ticketIds: z.array(z.string().min(1)).max(1000),
    archived: z.boolean().optional(),
  }).safeParse(body);
  if (!parsed.success) return c.json(resError('ticketIds is required'), 400);
  const department = runtime.getDepartment(departmentId);
  const archived = parsed.data.archived !== false;
  const count = await department.archiveTickets(parsed.data.ticketIds, archived);
  return c.json(resSuccess({ archived, count }));
});
app.delete('/api/departments/:departmentId/tickets/:ticketId', async (c) => {
  const departmentId = c.req.param('departmentId');
  const ticketId = c.req.param('ticketId');
  const department = runtime.getDepartment(departmentId);
  const ticket = await department.getTicketAsync(ticketId).catch(() => null);
  if (ticket) await department.deleteTicket(ticketId);
  await department.archiveTickets([ticketId], false).catch(() => 0);
  return c.json(resSuccess({ deleted: !!ticket }));
});
// Department-level status move (mission cards have no workstation binding; the
// handler routes mis_* to the mission controller by ticket id).
app.patch('/api/departments/:departmentId/tickets/:ticketId/status', (c) => handleUpdateTicketStatus(c, { workstationId: '', ticketId: c.req.param('ticketId') }));

// ── Task Studio attachments (images + browser-extracted PDFs) ────────────────
// Local-only store: original file, provenance, PDF markdown and page renders.
// The browser extracts/renders PDFs (pdfjs) so no native PDF/canvas dependency
// is added to the server; this endpoint persists the result and serves it back.
const ATTACHMENTS_ROOT = join(import.meta.dir, '..', 'data', 'attachments');
const AttachmentMeta = z.object({
  kind: z.enum(['image', 'pdf']),
  mode: z.enum(['inspiration', 'requirement']),
  filename: z.string().min(1).max(255),
  mime: z.string().max(160),
  size: z.number().nonnegative(),
  pageCount: z.number().int().min(0).max(10_000).optional(),
  pages: z.array(z.object({
    page: z.number().int().min(1),
    field: z.string().min(1).max(64),
  })).max(40).optional(),
});
app.post('/api/departments/:departmentId/attachments', async (c) => {
  const departmentId = c.req.param('departmentId');
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json(resError('multipart/form-data is required'), 400);
  const file = form.get('file');
  const manifestRaw = form.get('manifest');
  if (!(file instanceof File) || typeof manifestRaw !== 'string') {
    return c.json(resError('file and manifest are required'), 400);
  }
  if (file.size <= 0 || file.size > 30 * 1024 * 1024) {
    return c.json(resError('attachment must be between 1 byte and 30MB'), 400);
  }
  let parsedManifest: z.infer<typeof AttachmentMeta>;
  try {
    const parsed = AttachmentMeta.safeParse(JSON.parse(manifestRaw));
    if (!parsed.success) return c.json(resError('invalid attachment manifest'), 400);
    parsedManifest = parsed.data;
  } catch {
    return c.json(resError('invalid attachment manifest JSON'), 400);
  }
  const extension = (() => {
    const match = /\.([a-z0-9]{1,8})$/i.exec(parsedManifest.filename);
    if (match) return `.${match[1].toLowerCase()}`;
    return parsedManifest.kind === 'pdf' ? '.pdf' : '.bin';
  })();
  const isPdf = parsedManifest.kind === 'pdf' || file.type === 'application/pdf' || extension === '.pdf';
  if (isPdf && parsedManifest.kind !== 'pdf') {
    return c.json(resError('PDF attachments must declare kind=pdf'), 400);
  }
  if (!isPdf && !file.type.startsWith('image/') && !/^\.(png|jpe?g|webp|gif)$/i.test(extension)) {
    return c.json(resError('only image/* and application/pdf attachments are supported'), 400);
  }
  const attachmentId = `att_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const dir = join(ATTACHMENTS_ROOT, attachmentId);
  await mkdir(dir, { recursive: true });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const originalPath = join(dir, `original${extension}`);
  await writeFile(originalPath, bytes);

  const markdown = typeof form.get('markdown') === 'string' ? String(form.get('markdown')) : '';
  const markdownPath = markdown ? join(dir, 'extracted.md') : null;
  if (markdownPath) await writeFile(markdownPath, markdown, 'utf8');

  const pages: Array<{ page: number; path: string; url: string }> = [];
  for (const page of parsedManifest.pages ?? []) {
    const pageFile = form.get(page.field);
    if (!(pageFile instanceof File)) continue;
    const pagePath = join(dir, `page-${page.page}.png`);
    await writeFile(pagePath, new Uint8Array(await pageFile.arrayBuffer()));
    pages.push({
      page: page.page,
      path: pagePath,
      url: `/api/departments/${encodeURIComponent(departmentId)}/attachments/${attachmentId}/page-${page.page}.png`,
    });
  }

  const stored = {
    attachment_id: attachmentId,
    kind: parsedManifest.kind,
    mode: parsedManifest.mode,
    filename: parsedManifest.filename,
    mime: file.type || parsedManifest.mime,
    size: file.size,
    sha256,
    page_count: parsedManifest.pageCount ?? null,
    original_path: originalPath,
    original_url: `/api/departments/${encodeURIComponent(departmentId)}/attachments/${attachmentId}/original${extension}`,
    markdown_path: markdownPath,
    markdown_url: markdownPath
      ? `/api/departments/${encodeURIComponent(departmentId)}/attachments/${attachmentId}/extracted.md`
      : null,
    markdown: markdown || null,
    pages,
    created_at: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(stored, null, 2), 'utf8');
  return c.json(resSuccess(stored), 201);
});
app.get('/api/departments/:departmentId/attachments/:attachmentId/:file', async (c) => {
  const attachmentId = c.req.param('attachmentId');
  const fileName = c.req.param('file');
  if (!/^att_[A-Za-z0-9]+$/.test(attachmentId) || !/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return c.notFound();
  }
  const fullPath = join(ATTACHMENTS_ROOT, attachmentId, fileName);
  try {
    const data = await readFile(fullPath);
    const lower = fileName.toLowerCase();
    const contentType = lower.endsWith('.png')
      ? 'image/png'
      : /\.jpe?g$/.test(lower)
        ? 'image/jpeg'
        : lower.endsWith('.webp')
          ? 'image/webp'
          : lower.endsWith('.gif')
            ? 'image/gif'
            : lower.endsWith('.pdf')
              ? 'application/pdf'
              : lower.endsWith('.md')
                ? 'text/markdown; charset=utf-8'
                : 'application/octet-stream';
    return c.body(data, 200, { 'Content-Type': contentType });
  } catch {
    return c.notFound();
  }
});
app.post('/api/departments/:departmentId/workstations/:workstationId/tickets', (c) => handleCreateTicket(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/tickets', (c) => handleListTickets(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', (c) => handleGetTicket(c, c.req.param()));
app.patch('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/status', (c) => handleUpdateTicketStatus(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/close', (c) => handleCloseTicket(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/sling', (c) => handleSlingTicket(c, c.req.param()));
app.delete('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', (c) => handleDeleteTicket(c, c.req.param()));
// Durable event APIs were implemented but never mounted in local-live. The
// federated Observability/Drawers already call these exact contracts.
app.get('/api/departments/:departmentId/workstations/:workstationId/events', (c) => handleListTicketEvents(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agent-events', (c) => handleAppendAgentEvent(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/events', (c) => handleGetAgentEvents(c, c.req.param()));

// agents
app.post('/api/departments/:departmentId/workstations/:workstationId/agents', (c) => handleRegisterAgent(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/agents', (c) => handleListAgents(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId', (c) => handleGetAgent(c, c.req.param()));
app.delete('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId', (c) => handleDeleteAgent(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/get-or-create', (c) => handleGetOrCreateAgent(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/hook', (c) => handleHookTicket(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/unhook', (c) => handleUnhookTicket(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/prime', (c) => handlePrime(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/done', (c) => handleAgentDone(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/completed', (c) => handleAgentCompleted(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/waiting', (c) => handleAgentWaiting(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/checkpoint', (c) => handleWriteCheckpoint(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/heartbeat', (c) => handleHeartbeat(c, c.req.param()));
app.patch('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/status-message', (c) => handleUpdateAgentStatusMessage(c, c.req.param()));
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/nudges', (c) => handleGetPendingNudges(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/nudges', (c) => handleOperatorNudge(c,runtime.getDepartment(c.req.param('departmentId'))));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/nudges/:nudgeId/delivered', (c) => handleNudgeDelivered(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/request-changes', (c) => handleRequestChanges(c, c.req.param()));

// memo — durable agent mailbox. Memos are message tickets, so expose the
// department-level CRUD surface the desktop UI needs in addition to the legacy
// workstation send endpoint used by agents.
app.post('/api/departments/:departmentId/workstations/:workstationId/memo', (c) => handleSendMemo(c, c.req.param()));
app.get('/api/departments/:departmentId/memos', async (c) => {
  const department = runtime.getDepartment(c.req.param('departmentId'));
  const memos = (await department.listTickets({ type: 'message' })).filter(ticket => ticket.type === 'message');
  return c.json(resSuccess(memos));
});
app.post('/api/departments/:departmentId/memos', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    to_agent_id: z.string().min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    from_agent_id: z.string().min(1).default('operator'),
  }).safeParse(body);
  if (!parsed.success) return c.json(resError('to_agent_id, subject and body are required'), 400);
  const department = runtime.getDepartment(c.req.param('departmentId'));
  await department.sendMemo(parsed.data);
  return c.json(resSuccess({ sent: true }), 201);
});
app.patch('/api/departments/:departmentId/memos/:memoId', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ subject: z.string().min(1).optional(), body: z.string().min(1).optional() }).refine(v => v.subject !== undefined || v.body !== undefined).safeParse(body);
  if (!parsed.success) return c.json(resError('subject or body is required'), 400);
  const department = runtime.getDepartment(c.req.param('departmentId'));
  const current = await department.getTicketAsync(c.req.param('memoId'));
  if (!current || current.type !== 'message') return c.json(resError('Memo not found'), 404);
  const updated = await department.updateTicket(c.req.param('memoId'), {
    ...(parsed.data.subject ? { title: parsed.data.subject } : {}),
    ...(parsed.data.body ? { body: parsed.data.body } : {}),
  });
  return c.json(resSuccess(updated));
});
app.delete('/api/departments/:departmentId/memos/:memoId', async (c) => {
  const department = runtime.getDepartment(c.req.param('departmentId'));
  const current = await department.getTicketAsync(c.req.param('memoId'));
  if (!current || current.type !== 'message') return c.json(resError('Memo not found'), 404);
  await department.deleteTicket(c.req.param('memoId'));
  return c.json(resSuccess({ deleted: true }));
});

// review queue
app.post('/api/departments/:departmentId/workstations/:workstationId/review-queue', (c) => handleSubmitToReviewQueue(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/review-queue/:entryId/complete', (c) => handleCompleteReview(c, c.req.param()));

// triage + escalations
app.post('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/triage', (c) => handleResolveTriage(c, c.req.param()));
app.post('/api/departments/:departmentId/workstations/:workstationId/escalations', (c) => handleCreateEscalation(c, c.req.param()));

// department config + events
app.get('/api/departments/:departmentId/config', (c) => handleGetDepartmentConfig(c, c.req.param()));
app.patch('/api/departments/:departmentId/config', (c) => handleUpdateDepartmentConfig(c, c.req.param()));
app.get('/api/departments/:departmentId/events', (c) => handleListDepartmentEvents(c, { userId: 'local-dev', departmentId: c.req.param('departmentId') }));

// dispatch adapter (local-filesystem git, no containers)
app.post('/api/departments/:departmentId/dispatch', async (c) => {
  const t = await departmentDO(c, c.req.param('departmentId'));
  const body = await c.req.json().catch(() => ({}));
  const res = await t.dispatchAgent({
    agentId: body.agentId ?? 'local',
    ticketId: body.ticketId ?? c.req.param('departmentId'),
    workdir: body.workdir,
    message: body.message,
  });
  return c.json({ success: true, result: res });
});
app.get('/api/departments/:departmentId/dispatch/prepare', async (c) => {
  const t = await departmentDO(c, c.req.param('departmentId'));
  const cfg = await t.getDepartmentConfig();
  return c.json({ success: true, local_repo: cfg.local_repo ?? { adapter: 'none' } });
});

// shifts (via Department DO for list/start/sling since no dedicated handler)
app.post('/api/departments/:departmentId/shifts', (c) => handleCreateShift(c, c.req.param()));
app.get('/api/departments/:departmentId/shifts', async (c) => c.json({ success: true, shifts: await (await departmentDO(c, c.req.param('departmentId'))).listShifts() }));
app.post('/api/departments/:departmentId/shifts/:shiftId/start', async (c) => c.json({ success: true, result: await (await departmentDO(c, c.req.param('departmentId'))).startShift(c.req.param('shiftId')) }));
app.post('/api/departments/:departmentId/shifts/:shiftId/sling', async (c) => c.json({ success: true, result: await (await departmentDO(c, c.req.param('departmentId'))).slingShift({ shiftId: c.req.param('shiftId'), agentId: c.req.header('x-agent-id') ?? 'local' }) }));
app.get('/api/departments/:departmentId/shifts/:shiftId', async (c) => c.json({ success: true, result: await (await departmentDO(c, c.req.param('departmentId'))).getShiftStatus(c.req.param('shiftId')) }));
app.post('/api/departments/:departmentId/shifts/:shiftId/close', async (c) => c.json({ success: true, result: await (await departmentDO(c, c.req.param('departmentId'))).closeShift(c.req.param('shiftId')) }));

// ---------------------------------------------------------------- frontDesk + PTY (real local parity)
// Full-parity frontDesk surface: a real interactive frontDesk REPL runs inside a native
// Bun PTY and streams over WebSocket. `ensure` eagerly creates the PTY so the
// terminal is available immediately; `status` surfaces the live session as the
// cloud FrontDeskStatus contract expects.

/** Resolve (and materialise) the frontDesk agent id for a department (via the local runtime). */
async function ensureFrontDeskAgentId(c: { req: { param(k: string): string } }): Promise<string> {
  const departmentId = c.req.param('departmentId');
  const t = runtime.getDepartment(departmentId) as unknown as {
    getFrontDeskStatus(): Promise<{ frontDesk: { id: string } | null }>;
    ensureFrontDesk(): Promise<{ frontDesk: { id: string } | null }>;
  };
  const st = await t.getFrontDeskStatus().catch(() => ({ frontDesk: null }));
  if (st.frontDesk) return st.frontDesk.id;
  const ensured = await t.ensureFrontDesk().catch(() => ({ frontDesk: null }));
  return ensured.frontDesk?.id ?? `frontDesk:${departmentId}`;
}

function ptyWsUrl(departmentId: string, agentId: string, ptyId: string): string {
  return `ws://${HOST}:${PORT}/api/departments/${departmentId}/container/agents/${agentId}/pty/${ptyId}/ws`;
}

function buildFrontDeskSession(info: PtySessionInfo, agentId: string) {
  return {
    agentId,
    sessionId: info.id,
    status: info.status === 'running' ? 'active' : 'idle',
    lastActivityAt: new Date(info.createdAt).toISOString(),
  };
}

// GET /frontDesk/status — cloud FrontDeskStatus contract. Read-only: reports the PTY
// if one already exists (spawned by /frontDesk/ensure or /pty). Never side-effects
// a subprocess spawn from a bare status poll.
app.get('/api/departments/:departmentId/frontDesk/status', async (c) => {
  const departmentId = c.req.param('departmentId');
  const agentId = await ensureFrontDeskAgentId(c);
  const info = ptyManager.get(departmentId, agentId);
  return c.json({
    success: true,
    data: {
      configured: true,
      session: info && info.status === 'running'
        ? buildFrontDeskSession(info, agentId)
        : null,
      departmentId,
    },
  });
});

// POST /frontDesk/ensure — eagerly create the frontDesk PTY so the terminal is live.
app.post('/api/departments/:departmentId/frontDesk/ensure', async (c) => {
  const departmentId = c.req.param('departmentId');
  const agentId = await ensureFrontDeskAgentId(c);
  const info = ptyManager.create(departmentId, agentId, { cols: 80, rows: 24 });
  return c.json({
    success: true,
    data: {
      agentId,
      sessionStatus: info.status === 'running' ? 'active' : 'starting',
    },
  });
});

// POST /frontDesk/message — hand a mission directly to the real frontDesk (no PTY needed).
app.post('/api/departments/:departmentId/frontDesk/message', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body?.message === 'string' ? body.message : '';
  if (!message) return c.json({ success: false, error: 'message is required' }, 400);
  const departmentId = c.req.param('departmentId');
  const agentId = await ensureFrontDeskAgentId(c);
  const engine = await engineProxyFetch({ method: 'helldesk.orto.front_desk_request', args: { request: message, department_id: departmentId, workstation_id: 'workstation-local' } });
  return c.json({ success: true, data: { agentId, sessionStatus: 'active', reply: engine } });
});

// ── NAI ExcellenceGovernor integration ─────────────────────────────────────────────
// New-repo + specs → HELLDESK project that converges to a verified 10/10, and
// observe the ExcellenceGovernor verdict in the HELLDESK dashboard (not a split screen).
app.post('/api/departments/:departmentId/projects', async (c) => {
  const departmentId = c.req.param('departmentId');
  return handleCreateSpecProject(
    c as Ctx,
    { departmentId },
    {
      // One call wires BOTH brains: the ExcellenceGovernor project AND the department's
      // local_repo (workspace/input repo) + optional cross-repo output + sources
      // the kanban/CLI dispatchers use.
      bindDepartmentRepo: async (input) => {
        let department;
        try { department = runtime.getDepartment(departmentId); } catch { department = null; }
        if (!department) return;
        const current = await department.getDepartmentConfig();
        const localRepo = current.local_repo
          ? current.local_repo
          : { adapter: 'none', repo_path: '', source_repos: [] as Array<{ id: string; path: string; label?: string; branch?: string }>, allow_commit: true, workdir: undefined, bare_remote: undefined, branch: undefined, output_repo: undefined };
        await department.updateDepartmentConfig({
          local_repo: {
            adapter: 'local-git',
            repo_path: input.repoPath, // the project workspace (input repo)
            workdir: localRepo.workdir,
            output_repo: input.outputRepo ? {
              ...input.outputRepo,
              init_if_missing: input.outputRepo.init_if_missing ?? true,
            } : localRepo.output_repo,
            source_repos: input.sourceRepos ?? localRepo.source_repos ?? [],
            bare_remote: localRepo.bare_remote,
            branch: localRepo.branch ?? 'main',
            allow_commit: localRepo.allow_commit ?? true,
          },
        });
      },
    },
  );
});
app.get('/api/departments/:departmentId/excellenceGovernor', (c) => handleGetExcellenceGovernor(c as Ctx, { departmentId: c.req.param('departmentId') }));
app.put('/api/departments/:departmentId/tickets/:ticketId/controls', async (c) => {
  const departmentId = c.req.param('departmentId');
  return handleSetTicketControls(
    c as Ctx,
    { departmentId, ticketId: c.req.param('ticketId') },
    {
      getTicket: async (ticketId) => {
        try {
          return await runtime.getDepartment(departmentId).getTicketAsync(ticketId);
        } catch {
          return null;
        }
      },
      updateTicketControls: async (ticketId, controls) => {
        const department = runtime.getDepartment(departmentId);
        const ticket = await department.getTicketAsync(ticketId);
        if (!ticket) throw new Error(`ticket ${ticketId} not found`);
        // Merge (never drop) the rest of the ticket metadata; LocalDepartment
        // preserves local_repo_snapshot separately.
        await department.updateTicket(ticketId, {
          metadata: { ...(ticket.metadata ?? {}), break_room_controls: controls },
        });
      },
      setMissionControls: (missionId, controls) => setMissionReviewControls(missionId, controls),
    },
  );
});

// Manual T-shirt size override for a LOCAL ticket. Mission tickets use
// POST /api/v1/tickets/:id/size (engine contract).
app.put('/api/departments/:departmentId/tickets/:ticketId/size', async (c) => {
  const departmentId = c.req.param('departmentId');
  return handleSetTicketSize(
    c,
    { ticketId: c.req.param('ticketId') },
    {
      getTicket: async (ticketId) => {
        try {
          return await runtime.getDepartment(departmentId).getTicketAsync(ticketId);
        } catch {
          return null;
        }
      },
      updateTicketMetadata: async (ticketId, metadata) => {
        const department = runtime.getDepartment(departmentId);
        const ticket = await department.getTicketAsync(ticketId);
        if (!ticket) throw new Error(`ticket ${ticketId} not found`);
        await department.updateTicket(ticketId, { metadata });
      },
    },
  );
});

// ── BreakRoom group-chat HITL operator ───────────────────────────────────────────
// The human is an ASYNC, NON-BLOCKING peer. Agents are fully autonomous and
// approval comes from reviewer agents. These endpoints let the human steer live
// (interrupt / force-review / disapprove) without ever blocking delivery.
app.post('/api/departments/:departmentId/breakRoom/steer', async (c) => {
  const departmentId = c.req.param('departmentId');
  let department;
  try { department = runtime.getDepartment(departmentId); } catch { department = null; }
  if (!department) return c.json({ success: false, error: 'department_not_found' }, 404);
  return handleBreakRoomSteer(
    c as BreakRoomCtx,
    { departmentId },
    {
      fabric: chatFabricFor(departmentId),
      broadcast: (evt) => {
        // Fan the steering signal into the colony runtime event bus so the
        // reconciler + reviewer agents consume it asynchronously (never blocks).
        // broadcastTicketEvent expects `type`, the steer plan carries `event`.
        try {
          department.broadcastTicketEvent({
            type: evt.event,
            departmentId: evt.departmentId ?? departmentId,
            ticketId: evt.ticketId,
            agentId: evt.agentId,
            source: evt.source,
            intent: evt.intent,
            note: evt.note,
            severity: evt.severity,
          } as unknown as { type: string; departmentId?: string; ticketId?: string; [k: string]: unknown });
        } catch { /* best effort */ }
      },
      queueNudge: (agentId, message, opts) => department.queueNudge(agentId, message, opts),
      queueMissionSteer: (ticketId,note,kind) => steerLocalMission(department.sql,ticketId,note,kind),
    },
  );
});

// POST /container/agents/:agentId/pty — create a real PTY for the agent.
app.post('/api/departments/:departmentId/container/agents/:agentId/pty', async (c) => {
  const departmentId = c.req.param('departmentId');
  const agentId = c.req.param('agentId') === 'frontDesk'
    ? await ensureFrontDeskAgentId(c)
    : c.req.param('agentId');
  const body = (await c.req.json().catch(() => ({}))) as { size?: { cols?: number; rows?: number } };
  const cols = body?.size?.cols ?? 80;
  const rows = body?.size?.rows ?? 24;
  const info = ptyManager.create(departmentId, agentId, { cols, rows });
  return c.json({
    success: true,
    data: {
      pty: {
        id: info.id,
        wsUrl: ptyWsUrl(departmentId, agentId, info.id),
      },
    },
  });
});

// PUT /container/agents/:agentId/pty/:ptyId — resize the live PTY.
app.put('/api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { size?: { cols?: number; rows?: number } };
  const ok = ptyManager.resize(
    c.req.param('departmentId'),
    c.req.param('agentId'),
    c.req.param('ptyId'),
    body?.size?.cols ?? 80,
    body?.size?.rows ?? 24,
  );
  if (!ok) return c.json({ success: false, error: 'pty session not found' }, 404);
  return c.json({ success: true, data: { resized: true } });
});

// Stream ticket — the local PTY WebSocket URL (parity with the container API).
app.post('/api/departments/:departmentId/container/agents/:agentId/stream-ticket', async (c) => {
  const departmentId = c.req.param('departmentId');
  const agentId = c.req.param('agentId');
  const info = ptyManager.get(departmentId, agentId);
  if (!info) return c.json({ success: false, error: 'no pty session' }, 404);
  return c.json({ success: true, data: { url: ptyWsUrl(departmentId, agentId, info.id), ticket: info.id } });
});

/** Minimal engine JSON-RPC proxy for the /frontDesk/message direct path. */
async function engineProxyFetch(req: { method: string; args?: unknown }): Promise<unknown> {
  const token = engineToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(`http://${ENGINE_HOST}:${ENGINE_PORT}/project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: req.method, args: req.args ?? {} }),
    });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch { return { raw: txt, status: res.status }; }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------- dashboard aggregate
app.get('/dashboard', async (c) => {
  const departments = Array.from((runtime as unknown as { departmentCache: Map<string, unknown> }).departmentCache.keys());
  const departmentId = c.req.query('departmentId') ?? departments[0] ?? 'default';
  let t;
  try { t = await runtime.getDepartment(departmentId); await t.ensureFrontDesk(); } catch { t = null; }
  const agents = t ? await t.listAgents() : [];
  const workstations = t ? await t.listWorkstations() : [];
  const tickets = t ? await t.listTickets({}) : [];
  const shifts = t ? await t.listShifts() : [];
  return c.json({ departmentId, departments: departments.length ? departments : [departmentId], agents, workstations, tickets, shifts });
});

/**
 * Materialise the default department (frontDesk + local workstation + soul + qualityAssurance) and
 * start the colony reconciler so the soul/qualityAssurance flow runs locally with
 * live fan-out. This is the one routine that arms the dispatcher — it must run
 * both on-demand (dashboard boot) and automatically at server startup, so a
 * ticket created right after a reactor restart is dispatched instead of left
 * open/unassigned (the reconciler timer would otherwise never be started).
 */
async function bootDefaultDepartment(): Promise<void> {
  const t = await runtime.getDepartment('default');
  await t.ensureFrontDesk('local-dev');
  const workstation = (await t.listWorkstations())[0] ?? (await t.addWorkstation({ workstationId: 'workstation-local', name: 'Local' }));
  await t.getOrCreateAgent('soul', workstation.id ?? 'workstation-local');
  await t.getOrCreateAgent('qualityAssurance', workstation.id ?? 'workstation-local');
  runtime.startAllReconcilers();
}

// GET a default department on first dashboard call so the UI has state.
app.get('/dashboard/boot', async (c) => {
  await bootDefaultDepartment();
  return c.json({ ok: true });
});

// Control: start / inspect the colony reconciler for a department.
app.post('/api/departments/:departmentId/reconciler/start', async (c) => {
  const department = runtime.getDepartment(c.req.param('departmentId'));
  const stop = department.startReconciler();
  bridgeBreakRoomFor(department);
  return c.json({ success: true, started: true, departmentId: c.req.param('departmentId') });
});
app.get('/api/departments/:departmentId/reconciler/status', async (c) => {
  const department = runtime.getDepartment(c.req.param('departmentId'));
  return c.json({ success: true, departmentId: c.req.param('departmentId'), configured: department.getReconcilerContext() ? true : false });
});

// ---------------------------------------------------------------- system control
// Proxy the LOCAL control plane's /v1 API (config, reviews, jobs) to this
// dashboard. The auth token is injected server-side so the browser never needs
// it. Secret-bearing responses are redacted by the control plane itself.
app.all('/api/v1/*', async (c) => {
  const cp = controlPlaneAddr();
  if (!cp) return c.json({ ok: false, error: 'control_plane_config_not_found', path: controlConfigPath }, 504);
  // Strip the dashboard-local prefix and map back to the control plane's /v1 root:
  //   /api/v1/config   ->  http://127.0.0.1:<cp.port>/v1/config
  const rest = c.req.path.replace(/^\/api\/v1/, '') || '/';
  // `c.req.path` excludes the query string; without this the proxy silently
  // dropped `?tail=N` / `?after=N` / `?since=...` and the engine fell back to
  // its oldest-first defaults (the observability "stale events" bug).
  const search = new URL(c.req.url).search;
  const upstream = new URL(`http://127.0.0.1:${cp.port}/v1${rest}${search}`);
  try {
    const headers = new Headers(c.req.raw.headers);
    headers.set('Authorization', `Bearer ${cp.token}`);
    const upstreamRes = await fetch(upstream.toString(), {
      method: c.req.method,
      headers,
      body: c.req.method === 'GET' || c.req.method === 'HEAD' ? undefined : await c.req.arrayBuffer(),
    });
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: { 'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: 'control_plane_unreachable', message }, 504);
  }
});

/**
 * FORCE-RESTART ALL HELLDESK DAEMONS (control plane + dashboard + NAI ExcellenceGovernor
 * + any test daemons). Spawns the reusable scripts/restart-daemons.ps1 DETACHED
 * so it survives this process (this dashboard server is itself a restart target)
 * and returns immediately; the UI polls /api/v1/health to know when it is back.
 */
app.post('/api/system/restart', async (c) => {
  const script = join(dirname(dirname(import.meta.dir)), 'scripts', 'restart-daemons.ps1');
  if (!existsSync(script)) return c.json({ ok: false, error: 'restart_script_missing', path: script }, 500);
  const body = (await c.req.json().catch(() => ({}))) as { whatif?: boolean };
  const whatif = body?.whatif === true;
  try {
    const ps = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? 'sh');
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...(whatif ? ['-WhatIf'] : [])], {
      cwd: join(dirname(dirname(dirname(dirname(import.meta.dir))))), // repo root
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.unref();
    return c.json({ ok: true, whatif, script, relaunching: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: 'restart_spawn_failed', message }, 500);
  }
});

// ---------------------------------------------------------------- dashboard
import { dashboardHtml } from './dashboard';
// HELLDESK React is the product surface. The old standalone Department HTML is
// retained only as an explicit legacy diagnostic route, never as a competing app.
app.get('/', (c) => c.redirect('/helldesk/#/helldesk/default'));
app.get('/department', (c) => c.redirect('/helldesk/#/helldesk/default'));
app.get('/legacy/department', async (c) => c.html(dashboardHtml()));
app.get('/health', (c) => c.json({ ok: true }));

// ---------------------------------------------------------------- NAI-Lattice engine proxy
// The federated HELLDESK SPA (served at /helldesk) calls the canonical NAI-Lattice
// engine RPC endpoints (/project + /dashboard). entry.ts injects the control token
// server-side so the browser never holds it — the same token the engine persists at
// %LOCALAPPDATA%\NAI\HELLDESK\control.token. Loopback-only; never logs the token.
const ENGINE_HOST = process.env.NAI_LATTICE_HOST ?? '127.0.0.1';
const ENGINE_PORT = Number(process.env.NAI_LATTICE_PORT ?? 8787);
const ENGINE_TOKEN_PATH = () => join(process.env.LOCALAPPDATA ?? '', 'NAI', 'HELLDESK', 'control.token');
function engineToken(): string {
  try {
    return readFileSync(ENGINE_TOKEN_PATH(), 'utf-8').trim();
  } catch {
    return '';
  }
}
async function proxyEngineToLattice(c: { req: { raw: Request } }): Promise<Response> {
  const upstream = new URL(c.req.raw.url);
  upstream.hostname = ENGINE_HOST;
  upstream.port = String(ENGINE_PORT);
  upstream.protocol = 'http:';
  const headers = new Headers(c.req.raw.headers);
  const token = engineToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  try {
    const bodyMethod = c.req.raw.method;
    const body =
      bodyMethod === 'GET' || bodyMethod === 'HEAD' ? undefined : await c.req.raw.arrayBuffer();
    const upstreamRes = await fetch(upstream.toString(), {
      method: bodyMethod,
      headers,
      body,
    });
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: { 'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: 'engine_unreachable', message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
// Engine JSON-RPC endpoints for the federated SPA (canonical NAI-Lattice host).
app.all('/project', (c) => proxyEngineToLattice(c));
app.all('/project/*', (c) => proxyEngineToLattice(c));
app.all('/dashboard', (c) => proxyEngineToLattice(c));
app.all('/dashboard/*', (c) => proxyEngineToLattice(c));

// ------------------------------------------------- fully-fledged React HELLDESK UI (Option B)
// Serves the standalone Vite+React SPA from `ui/dist` at /helldesk (plus its
// hashed assets). The SPA uses HashRouter, so only index.html + /assets are needed.
const UI_DIST = join(import.meta.dir, "..", "ui", "dist");
const uiContentType: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
app.get("/helldesk", async (c) => c.html(await Bun.file(join(UI_DIST, "index.html")).text()));
app.get("/helldesk/*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  // serve hashed assets under /helldesk/assets/...
  if (pathname.startsWith("/helldesk/assets/")) {
    const rel = pathname.slice("/helldesk/assets/".length);
    const safe = rel.split("/").filter(Boolean).join("/");
    if (safe) {
      const file = Bun.file(join(UI_DIST, "assets", safe));
      if (await file.exists()) {
        const ext = safe.slice(safe.lastIndexOf("."));
        return c.body(file.stream(), { headers: { "content-type": uiContentType[ext] ?? "application/octet-stream" } });
      }
    }
    return c.notFound();
  }
  // SPA fallback (HashRouter) → index.html
  return c.html(await Bun.file(join(UI_DIST, "index.html")).text());
});

// ---------------------------------------------------------------- server
console.log(`[local-helldesk] data root: ${DATA_ROOT}`);
console.log(`[local-helldesk] dashboard: http://${HOST}:${PORT}/`);

interface PtyWsData {
  departmentId: string;
  agentId: string;
  ptyId: string;
}

interface ChatWsData {
  departmentId: string;
}

interface EventsWsData {
  departmentId: string;
}

// Per-socket live PTY connection, detached on WS close (Fix #2).
const wsPtyConnections = new WeakMap<object, { detachSub(): void }>();
// Per-socket chat fabric (unsubscribe from the ChatFabric on close).
const wsChatUnsubs = new WeakMap<object, () => void>();
// Per-socket runtime-event subscription (unsubscribe from the department eventBus).
const wsEventUnsubs = new WeakMap<object, () => void>();

function handleIncomingChatMessage(departmentId: string, message: string): void {
  let parsed: { action?: string; payload?: ChatMessageOut };
  try {
    parsed = JSON.parse(message) as { action?: string; payload?: ChatMessageOut };
  } catch {
    return;
  }
  if (parsed?.action !== 'publish' || !parsed.payload) return;
  const f = chatFabricFor(departmentId);
  f.publish({
    role: parsed.payload.role ?? 'user',
    kind: parsed.payload.kind ?? 'text',
    text: parsed.payload.text,
    toolName: parsed.payload.toolName,
    toolInput: parsed.payload.toolInput,
    toolResult: parsed.payload.toolResult,
    origin: 'helldesk',
  });
}

const server = Bun.serve<{ pty?: PtyWsData; chat?: ChatWsData; events?: EventsWsData }>({
  hostname: HOST,
  port: PORT,
  // The mission-chat proxy waits on the control plane; the default 10s idle
  // timeout killed the request and made the drawer's chat look empty.
  idleTimeout: 30,
  fetch(req, server) {
    const url = new URL(req.url);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const ptyM = url.pathname.match(
        /^\/api\/departments\/([^/]+)\/container\/agents\/([^/]+)\/pty\/([^/]+)\/ws$/
      );
      if (ptyM) {
        const upgraded = server.upgrade(req, {
          data: { pty: { departmentId: decodeURIComponent(ptyM[1]), agentId: decodeURIComponent(ptyM[2]), ptyId: decodeURIComponent(ptyM[3]) } } as never,
        });
        if (upgraded) return undefined;
      }
      const chatM = url.pathname.match(/^\/api\/departments\/([^/]+)\/chat-ws$/);
      if (chatM) {
        const upgraded = server.upgrade(req, {
          data: { chat: { departmentId: decodeURIComponent(chatM[1]) } } as never,
        });
        if (upgraded) return undefined;
      }
      const eventsM = url.pathname.match(/^\/api\/departments\/([^/]+)\/events-ws$/);
      if (eventsM) {
        const upgraded = server.upgrade(req, {
          data: { events: { departmentId: decodeURIComponent(eventsM[1]) } } as never,
        });
        if (upgraded) return undefined;
      }
    }
    return Promise.resolve(app.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} } as never)).catch((err) => {
      console.error('[local-helldesk] fetch handler error:', err && err.message ? err.message : String(err));
      return new Response(JSON.stringify({ success: false, error: 'server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    });
  },
  websocket: {
    open(ws) {
      try {
        const data = ws.data as { pty?: PtyWsData; chat?: ChatWsData; events?: EventsWsData };
        if (data?.pty) {
          const conn = openConnection(ws, { departmentId: data.pty.departmentId, agentId: data.pty.agentId, ptyId: data.pty.ptyId, pty: ptyManager });
          if (conn) wsPtyConnections.set(ws, conn);
          return;
        }
      if (data?.chat) {
        // Subscribe this socket to mirrored chat events for the department.
        const f = chatFabricFor(data.chat.departmentId);
        const unsub = f.onChat((chat) => {
          try {
            ws.send(JSON.stringify({ type: 'chat', chat }));
          } catch { /* socket gone */ }
        });
        wsChatUnsubs.set(ws, unsub);
        return;
      }
      if (data?.events) {
        // Live stream of the colony reconciler's runtime events (ticket states,
        // analytics, invariants). This is the real broadcastTicketEvent fan-out.
        try {
          const department = runtime.getDepartment(data.events.departmentId);
          const unsub = department.eventBus.subscribe((event) => {
            try {
              ws.send(JSON.stringify({ type: 'runtime', departmentId: event.departmentId, event }));
            } catch { /* socket gone */ }
          });
          wsEventUnsubs.set(ws, unsub);
        } catch {
          // Department or eventBus may be mid-teardown (reconciler race). Never let
          // an unguarded subscribe inside WS open take the whole process down.
          ws.close(1011, 'runtime unavailable');
        }
        return;
      }
      ws.close(1008, 'bad session');
      } catch (err) {
        // Any unguarded throw during WS open (e.g. race-during-teardown) must not
        // kill the process; close the offending socket instead.
        console.error('[local-helldesk] ws.open error:', err && (err as Error).message ? (err as Error).message : String(err));
        try { ws.close(1011, 'open failed'); } catch { /* ignore */ }
      }
    },
    message(ws, message) {
      try {
        const data = ws.data as { pty?: PtyWsData; chat?: ChatWsData };
        if (data?.pty) {
          const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
          ptyManager.write(data.pty.departmentId, data.pty.agentId, data.pty.ptyId, bytes);
          return;
        }
        if (data?.chat) {
          handleIncomingChatMessage(data.chat.departmentId, typeof message === 'string' ? message : new TextDecoder().decode(message));
        }
      } catch (err) {
        console.error('[local-helldesk] ws.message error:', err && (err as Error).message ? (err as Error).message : String(err));
      }
    },
    close(ws) {
      const conn = wsPtyConnections.get(ws);
      if (conn) {
        conn.detachSub();
        wsPtyConnections.delete(ws);
      }
      const chatUnsub = wsChatUnsubs.get(ws);
      if (chatUnsub) {
        chatUnsub();
        wsChatUnsubs.delete(ws);
      }
      const eventUnsub = wsEventUnsubs.get(ws);
      if (eventUnsub) {
        eventUnsub();
        wsEventUnsubs.delete(ws);
      }
      // Deliberately do NOT kill the PTY: the REPL keeps running so the next
      // terminal open can reconnect to the same live session (parity with the
      // cloud container, where the WS is just a view into a persistent process).
      // PTYs are reaped only by the idle timer (Fix #3), not by view detachment.
    },
    error(ws) {
      const conn = wsPtyConnections.get(ws);
      if (conn) {
        conn.detachSub();
        wsPtyConnections.delete(ws);
      }
      const chatUnsub = wsChatUnsubs.get(ws);
      if (chatUnsub) {
        chatUnsub();
        wsChatUnsubs.delete(ws);
      }
      const eventUnsub = wsEventUnsubs.get(ws);
      if (eventUnsub) {
        eventUnsub();
        wsEventUnsubs.delete(ws);
      }
    },
  },
});

// Arm the dispatcher on boot so a task created immediately after a restart is
// picked up by the reconciler instead of sitting open/unassigned until the
// dashboard is opened (which used to be the only thing that started the timer).
// Fires after the server is accepting connections; a missing/errored materialise
// must never take the server down, so failures are logged, not thrown.
void bootDefaultDepartment().catch((err) => {
  console.warn('[local-helldesk] automatic department boot failed (reconciler not armed):', err);
});

// Reap idle PTY sessions (Fix #3): a REPL with no WS attached / no input for
// IDLE_PTY_MS is terminated so idle `bun` subprocesses don't accumulate.
const IDLE_PTY_MS = Number(process.env.HELLDESK_PTY_IDLE_MS ?? 15 * 60 * 1000);
setInterval(() => {
  const reaped = ptyManager.reapIdle(IDLE_PTY_MS);
  if (reaped > 0) console.log(`[local-helldesk] reaped ${reaped} idle pty session(s)`);
}, 60 * 1000);
if (typeof (setInterval as unknown as { unref?: () => void }).unref === 'function') {
  (setInterval as unknown as { unref(): void }).unref();
}

export { runtime, env, app };
