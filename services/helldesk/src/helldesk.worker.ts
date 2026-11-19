import * as Sentry from '@sentry/cloudflare';
import { withSentry } from '@sentry/cloudflare';
import { TRPCError } from '@trpc/server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { every } from 'hono/combine';
import { z } from 'zod';
import { getDepartmentContainerStub } from './dos/DepartmentContainer.do';
import { getDepartmentDOStub } from './dos/Department.do';
import { DepartmentConfigUpdateSchema } from './types';
import { resError } from './util/res.util';
import { writeEvent } from './util/analytics.util';
import { logger } from './util/log.util';
import {
  authMiddleware,
  agentOnlyMiddleware,
  departmentIdMiddleware,
  type AuthVariables,
} from './middleware/auth.middleware';
import { createKiloAuthMiddleware } from '@kilocode/worker-utils/kilo-auth-middleware';
import { HELLDESK_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { resolveSecret } from './util/secret.util';
import { validateCfAccessRequest } from '@kilocode/worker-utils/cf-access';

import { trpcServer } from '@hono/trpc-server';
import { wrappedHelldeskRouter } from './trpc/router';
import {
  handleCreateTicket,
  handleListTickets,
  handleGetTicket,
  handleUpdateTicketStatus,
  handleCloseTicket,
  handleSlingTicket,
  handleDeleteTicket,
} from './handlers/workstation-tickets.handler';
import {
  handleRegisterAgent,
  handleListAgents,
  handleGetAgent,
  handleHookTicket,
  handleUnhookTicket,
  handlePrime,
  handleAgentDone,
  handleRequestChanges,
  handleAgentCompleted,
  handleAgentWaiting,
  handleWriteCheckpoint,
  handleWriteEvictionContext,
  handleCheckMemo,
  handleHeartbeat,
  handleGetOrCreateAgent,
  handleDeleteAgent,
  handleUpdateAgentStatusMessage,
  handleGetPendingNudges,
  handleNudgeDelivered,
  handleNudge,
} from './handlers/workstation-agents.handler';
import { handleSendMemo } from './handlers/workstation-memo.handler';
import { handleAppendAgentEvent, handleGetAgentEvents } from './handlers/workstation-agent-events.handler';
import {
  handleSubmitToReviewQueue,
  handleCompleteReview,
} from './handlers/workstation-review-queue.handler';
import { handleCreateEscalation } from './handlers/workstation-escalations.handler';
import { handleResolveTriage } from './handlers/workstation-triage.handler';
import { handleListTicketEvents } from './handlers/workstation-ticket-events.handler';
import { handleListDepartmentEvents } from './handlers/department-events.handler';
import {
  handleContainerStartAgent,
  handleContainerStopAgent,
  handleContainerSendMessage,
  handleContainerAgentStatus,
  handleContainerStreamTicket,
  handleContainerHealth,
  handleContainerProxy,
} from './handlers/department-container.handler';
import {
  handleCreateDepartment,
  handleListDepartments,
  handleGetDepartment,
  handleCreateWorkstation,
  handleGetWorkstation,
  handleListWorkstations,
  handleDeleteDepartment,
  handleDeleteWorkstation,
} from './handlers/departments.handler';
import {
  handleCreateOrgDepartment,
  handleListOrgDepartments,
  handleGetOrgDepartment,
  handleCreateOrgWorkstation,
  handleListOrgWorkstations,
  handleGetOrgWorkstation,
  handleDeleteOrgDepartment,
  handleDeleteOrgWorkstation,
} from './handlers/org-departments.handler';
import {
  handleConfigureFrontDesk,
  handleSendFrontDeskMessage,
  handleGetFrontDeskStatus,
  handleEnsureFrontDesk,
  handleFrontDeskCompleted,
  handleDestroyFrontDesk,
  handleBroadcastUiAction,
  handleSetDashboardContext,
} from './handlers/frontDesk.handler';
import {
  handleFrontDeskSling,
  handleFrontDeskSlingBatch,
  handleFrontDeskListWorkstations,
  handleFrontDeskListTickets,
  handleFrontDeskListAgents,
  handleFrontDeskSendMemo,
  handleFrontDeskListShifts,
  handleFrontDeskShiftStatus,
  handleFrontDeskTicketUpdate,
  handleFrontDeskTicketReassign,
  handleFrontDeskAgentReset,
  handleFrontDeskShiftClose,
  handleFrontDeskShiftUpdate,
  handleFrontDeskTicketDelete,
  handleFrontDeskBulkDeleteTickets,
  handleFrontDeskDeleteTicketsByStatus,
  handleFrontDeskEscalationAcknowledge,
  handleFrontDeskShiftStart,
  handleFrontDeskUiAction,
  handleFrontDeskGetPendingNudges,
  handleFrontDeskShiftAddTicket,
  handleFrontDeskShiftRemoveTicket,
} from './handlers/front-desk-tools.handler';
import {
  handleHelldeskBrowse,
  handleHelldeskClaim,
  handleHelldeskPost,
  handleHelldeskDone,
} from './handlers/helldesk-tools.handler';
import { frontDeskAuthMiddleware } from './middleware/front-desk-auth.middleware';
import { departmentAuthMiddleware } from './middleware/department-auth.middleware';
import { orgAuthMiddleware } from './middleware/org-auth.middleware';
import { userAuthMiddleware } from './middleware/user-auth.middleware';
import {
  helldeskAccessMiddleware,
  helldeskRouteAccessMiddleware,
} from './middleware/helldesk-access.middleware';
import { resolveWorkerAdminMiddleware } from './middleware/worker-admin.middleware';
import { timingMiddleware, instrumented } from './middleware/analytics.middleware';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import { handleGetDepartmentConfig, handleUpdateDepartmentConfig } from './handlers/department-config.handler';
import {
  handleGetTicketCaseCurrentStep,
  handleAdvanceTicketCaseStep,
  handleCreateTicketCase,
} from './handlers/workstation-ticket-cases.handler';
import { handleCreateShift, handleOnTicketClosed } from './handlers/department-shifts.handler';
import {
  handleListEscalations,
  handleAcknowledgeEscalation,
} from './handlers/department-escalations.handler';
import {
  handleContainerEviction,
  handleContainerReady,
  handleDrainStatus,
} from './handlers/department-eviction.handler';
import { handleRefreshGitToken } from './handlers/refresh-git-token.handler';
import { handleRefreshContainerToken } from './handlers/department-container-token.handler';

export { HelldeskUserDO } from './dos/HelldeskUser.do';
export { HelldeskOrgDO } from './dos/HelldeskOrg.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';
export { DepartmentDO } from './dos/Department.do';
export { DepartmentContainerDO } from './dos/DepartmentContainer.do';
export { AgentDO } from './dos/Agent.do';

export type HelldeskEnv = {
  Bindings: Env;
  Variables: AuthVariables;
};

const app = new Hono<HelldeskEnv>();

const kiloAuthMiddleware = createKiloAuthMiddleware<HelldeskEnv>({
  resolveSecret,
  audiencePolicy: { audience: HELLDESK_AUDIENCE, mode: 'allow-legacy' },
  onAuthenticated: payload => logger.setTags({ userId: payload.kiloUserId }),
});

const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

async function cfAccessDebugMiddleware(c: Context<HelldeskEnv>, next: () => Promise<void>) {
  const hostname = new URL(c.req.url).hostname;
  if (c.env.ENVIRONMENT === 'development' && LOCAL_DEV_HOSTNAMES.has(hostname)) {
    return next();
  }

  try {
    await validateCfAccessRequest(c.req.raw, {
      team: c.env.CF_ACCESS_TEAM,
      audience: c.env.CF_ACCESS_AUD,
    });
  } catch (e) {
    console.warn(`CF Access validation failed ${e instanceof Error ? e.message : 'unknown'}`, {
      error: e,
    });
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  return next();
}

// Capture high-resolution start timestamp before any other middleware.
app.use('*', timingMiddleware);

// Establishes AsyncLocalStorage context so all downstream logs are tagged.
// Cast needed: workers-tagged-logger@1.0.0 was built against an older Hono.
app.use('*', useWorkersLogger('helldesk-worker') as unknown as MiddlewareHandler);

// Use Hono path matching (not regex) so tags are sourced from
// c.req.param() once the route is matched. Each handler runs only
// when its prefix matches; if a request hits /api/departments/:departmentId/workstations/:workstationId,
// both department and workstation handlers run in order.
app.use('/api/orgs/:orgId/*', async (c, next) => {
  const orgId = c.req.param('orgId');
  if (orgId) logger.setTags({ orgId });
  await next();
});
app.use('/api/departments/:departmentId/*', async (c, next) => {
  const departmentId = c.req.param('departmentId');
  if (departmentId) logger.setTags({ departmentId });
  await next();
});
app.use('/api/frontDesk/:departmentId/*', async (c, next) => {
  const departmentId = c.req.param('departmentId');
  if (departmentId) logger.setTags({ departmentId });
  await next();
});
app.use('/api/orgs/:orgId/departments/:departmentId/*', async (c, next) => {
  const departmentId = c.req.param('departmentId');
  if (departmentId) logger.setTags({ departmentId });
  await next();
});
app.use('/api/users/:userId/departments/:departmentId/*', async (c, next) => {
  const departmentId = c.req.param('departmentId');
  if (departmentId) logger.setTags({ departmentId });
  await next();
});
app.use('/api/users/:userId/workstations/:workstationId/*', async (c, next) => {
  const workstationId = c.req.param('workstationId');
  if (workstationId) logger.setTags({ workstationId });
  await next();
});
app.use('/api/departments/:departmentId/workstations/:workstationId/*', async (c, next) => {
  const workstationId = c.req.param('workstationId');
  if (workstationId) logger.setTags({ workstationId });
  await next();
});
app.use('/api/orgs/:orgId/workstations/:workstationId/*', async (c, next) => {
  const workstationId = c.req.param('workstationId');
  if (workstationId) logger.setTags({ workstationId });
  await next();
});
app.use('/api/frontDesk/:departmentId/tools/workstations/:workstationId/*', async (c, next) => {
  const workstationId = c.req.param('workstationId');
  if (workstationId) logger.setTags({ workstationId });
  await next();
});
app.use('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/*', async (c, next) => {
  const agentId = c.req.param('agentId');
  if (agentId) logger.setTags({ agentId });
  await next();
});
app.use('/api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/*', async (c, next) => {
  const agentId = c.req.param('agentId');
  if (agentId) logger.setTags({ agentId });
  await next();
});

// Allow browser requests from the main Kilo app. In development, allow
// localhost and LAN origins for the Next.js dev server.

const localIpPattern =
  /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+|192\.168\.\d+\.\d+|\[(::1|fd[0-9a-f]{2}:[0-9a-f:]+|fe80:[0-9a-f:]+)\])(:\d+)?$/i;

const corsMiddleware = cors({
  origin: (origin, c: Context<HelldeskEnv>) => {
    if (c.env.ENVIRONMENT === 'development') {
      if (localIpPattern.test(origin)) return origin;
    }
    // Production origins
    const allowed = ['https://app.kilo.ai', 'https://kilo.ai'];
    return allowed.includes(origin) ? origin : '';
  },
  allowHeaders: ['Content-Type', 'Authorization', 'X-Kilo-Worker-Capability'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 3600,
  credentials: true,
});

app.use('/api/*', corsMiddleware);
app.use('/trpc/*', corsMiddleware);

app.get('/', c => c.json({ service: 'helldesk', status: 'ok' }));
app.get('/health', c => c.json({ status: 'ok' }));

app.use('/debug/*', cfAccessDebugMiddleware);

app.get('/debug/departments/:departmentId/status', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  const alarmStatus = await department.getAlarmStatus();
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const agentMeta = await department.debugAgentMetadata();
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const ticketSummary = await department.debugTicketSummary();
  return c.json({ alarmStatus, agentMeta, ticketSummary });
});

app.post('/debug/departments/:departmentId/reconcile-dry-run', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await department.debugDryRun();
  return c.json(result);
});

app.post('/debug/departments/:departmentId/replay-events', async c => {
  const departmentId = c.req.param('departmentId');
  const body: { from?: string; to?: string } = await c.req.json();
  if (!body.from || !body.to) {
    return c.json({ error: 'Missing required fields: from, to (ISO timestamps)' }, 400);
  }
  const fromDate = new Date(body.from);
  const toDate = new Date(body.to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return c.json({ error: 'Invalid date format. Use ISO 8601 timestamps.' }, 400);
  }
  if (fromDate > toDate) {
    return c.json({ error: '"from" must be before or equal to "to"' }, 400);
  }
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await department.debugReplayEvents(body.from, body.to);
  return c.json(result);
});

app.get('/debug/departments/:departmentId/drain-status', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const draining = await department.isDraining();
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const drainNonce = await department.getDrainNonce();
  return c.json({ draining, drainNonce });
});

app.get('/debug/departments/:departmentId/nudges', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const nudges = await department.debugPendingNudges();
  return c.json({ nudges });
});

app.post('/debug/departments/:departmentId/send-message', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const body: { message: string; model?: string } = await c.req.json();
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const result = await department.sendFrontDeskMessage(
    body.message,
    body.model ?? 'anthropic/claude-sonnet-4.6'
  );
  return c.json(result);
});

app.get('/debug/departments/:departmentId/tickets/:ticketId', async c => {
  const departmentId = c.req.param('departmentId');
  const ticketId = c.req.param('ticketId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const result = await department.debugGetTicket(ticketId);
  return c.json(result);
});

app.post('/debug/departments/:departmentId/graceful-stop', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const containerStub = getDepartmentContainerStub(c.env, departmentId);
  await containerStub.stop();
  return c.json({ stopped: true });
});

app.get('/debug/departments/:departmentId/helldesk', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const connection = await department.getHelldeskConnection();
  return c.json({ connection });
});

// List every ticket in the department that carries a `metadata.helldesk` tag, plus
// the deep-link URL the TicketPanel UI should render for it. Use this to verify
// the helldesk → ticket bridge end-to-end without going through the UI.
app.get('/debug/departments/:departmentId/helldesk-tickets', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const rawTickets = await department.debugListHelldeskTickets();
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const workstationList = await department.listWorkstations();

  const DebugTicketRow = z.object({
    ticket_id: z.string(),
    type: z.string(),
    status: z.string(),
    title: z.string(),
    workstation_id: z.string().nullable(),
    created_by: z.string().nullable(),
    labels: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()),
  });
  const ticketRows = DebugTicketRow.array().parse(rawTickets);

  const WorkstationRow = z.object({ id: z.string(), name: z.string() });
  const workstations = WorkstationRow.array().parse(workstationList);
  const ridToName = new Map(workstations.map(r => [r.id, r.name]));

  const HelldeskTag = z.object({
    helldesk_id: z.string(),
    item_id: z.string(),
  });

  const enriched = ticketRows.map(b => {
    const wl = HelldeskTag.safeParse(b.metadata.helldesk);
    const expectedHref = wl.success
      ? `/helldesk/${wl.data.helldesk_id}/wanted?itemId=${encodeURIComponent(wl.data.item_id)}`
      : null;
    return {
      ticket_id: b.ticket_id,
      type: b.type,
      status: b.status,
      title: b.title,
      workstation_id: b.workstation_id,
      workstation_name: b.workstation_id ? (ridToName.get(b.workstation_id) ?? null) : null,
      created_by: b.created_by,
      labels: b.labels,
      metadata: b.metadata,
      ui: {
        drawer_open_url: `/helldesk/${departmentId}#ticket=${b.ticket_id}&workstation=${b.workstation_id ?? ''}`,
        helldesk_link_href: expectedHref,
      },
    };
  });
  return c.json({ tickets: enriched, count: enriched.length });
});

app.get('/debug/departments/:departmentId/config', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const cfg = await department.getDepartmentConfig();
  return c.json(cfg);
});

app.patch('/debug/departments/:departmentId/config', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const parsed = DepartmentConfigUpdateSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: 'Invalid config', issues: parsed.error.issues }, 400);
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await department.updateDepartmentConfig(parsed.data);
  return c.json(result);
});

app.get('/debug/departments/:departmentId/workstations', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const workstations = await department.listWorkstations();
  return c.json({ workstations });
});

app.post('/debug/departments/:departmentId/sling-shift', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const body: {
    workstationId: string;
    shiftTitle: string;
    tasks: Array<{ title: string; body?: string; depends_on?: number[] }>;
    merge_mode?: 'review-then-land' | 'review-and-merge';
    staged?: boolean;
  } = await c.req.json();
  if (!body.workstationId || !body.shiftTitle || !Array.isArray(body.tasks)) {
    return c.json({ error: 'Missing required fields: workstationId, shiftTitle, tasks' }, 400);
  }
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await department.slingShift({
    workstationId: body.workstationId,
    shiftTitle: body.shiftTitle,
    tasks: body.tasks,
    merge_mode: body.merge_mode,
    staged: body.staged,
  });
  return c.json(result);
});

app.get('/debug/departments/:departmentId/shifts', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const shifts = await department.listShifts();
  return c.json({ shifts });
});

// All workstation routes live under /api/departments/:departmentId/workstations/:workstationId so the departmentId
// is always available from the URL path.
// departmentIdMiddleware always runs (even in dev) so c.get('departmentId') is
// guaranteed for handlers. Auth middleware is skipped in dev.

app.use('/api/departments/:departmentId/workstations/:workstationId/*', departmentIdMiddleware);
app.use('/api/departments/:departmentId/workstations/:workstationId/*', async (c: Context<HelldeskEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

app.post('/api/departments/:departmentId/workstations/:workstationId/tickets', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/tickets', () =>
    handleCreateTicket(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/tickets', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/tickets', () =>
    handleListTickets(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', () =>
    handleGetTicket(c, c.req.param())
  )
);
app.patch('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/status', c =>
  instrumented(c, 'PATCH /api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/status', () =>
    handleUpdateTicketStatus(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/close', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId/close', () =>
    handleCloseTicket(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/sling', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/sling', () =>
    handleSlingTicket(c, c.req.param())
  )
);
app.delete('/api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', c =>
  instrumented(c, 'DELETE /api/departments/:departmentId/workstations/:workstationId/tickets/:ticketId', () =>
    handleDeleteTicket(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/agents', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents', () =>
    handleRegisterAgent(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents', () =>
    handleListAgents(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/get-or-create', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/get-or-create', () =>
    handleGetOrCreateAgent(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents/:agentId', () =>
    handleGetAgent(c, c.req.param())
  )
);
app.delete('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId', c =>
  instrumented(c, 'DELETE /api/departments/:departmentId/workstations/:workstationId/agents/:agentId', () =>
    handleDeleteAgent(c, c.req.param())
  )
);

// Dashboard-accessible agent events (before agentOnlyMiddleware so the
// frontend can query events without an agent JWT)
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/events', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/events', () =>
    handleGetAgentEvents(c, c.req.param())
  )
);

// Agent-scoped routes — agentOnlyMiddleware enforces JWT agentId match
app.use(
  '/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/*',
  async (c: Context<HelldeskEnv, string>, next) =>
    c.env.ENVIRONMENT === 'development' ? next() : agentOnlyMiddleware(c, next)
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/hook', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/hook', () =>
    handleHookTicket(c, c.req.param())
  )
);
app.delete('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/hook', c =>
  instrumented(c, 'DELETE /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/hook', () =>
    handleUnhookTicket(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/prime', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/prime', () =>
    handlePrime(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/done', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/done', () =>
    handleAgentDone(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/request-changes', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/request-changes', () =>
    handleRequestChanges(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/completed', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/completed', () =>
    handleAgentCompleted(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/waiting', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/waiting', () =>
    handleAgentWaiting(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/checkpoint', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/checkpoint', () =>
    handleWriteCheckpoint(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/eviction-context', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/eviction-context', () =>
    handleWriteEvictionContext(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/memo', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/memo', () =>
    handleCheckMemo(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/heartbeat', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/heartbeat', () =>
    handleHeartbeat(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/status', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/status', () =>
    handleUpdateAgentStatusMessage(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/pending-nudges', c =>
  handleGetPendingNudges(c, c.req.param())
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/nudge-delivered', c =>
  handleNudgeDelivered(c, c.req.param())
);

// Agent-to-agent nudge: any authenticated agent can nudge another agent in the workstation
app.post('/api/departments/:departmentId/workstations/:workstationId/nudge', c => handleNudge(c, c.req.param()));

// Called by the container when a GIT_TOKEN (GitHub App installation token,
// 1h TTL) expires mid-task. Returns a fresh token resolved via the
// standard chain. Authenticated with the container-scoped JWT.
app.post('/api/departments/:departmentId/workstations/:workstationId/refresh-git-token', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/refresh-git-token', () =>
    handleRefreshGitToken(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/agent-events', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agent-events', () =>
    handleAppendAgentEvent(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/memo', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/memo', () =>
    handleSendMemo(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/review-queue', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/review-queue', () =>
    handleSubmitToReviewQueue(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/review-queue/:entryId/complete', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/review-queue/:entryId/complete', () =>
    handleCompleteReview(c, c.req.param())
  )
);

app.get('/api/departments/:departmentId/workstations/:workstationId/events', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/events', () =>
    handleListTicketEvents(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/TicketCases', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/TicketCases', () =>
    handleCreateTicketCase(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/TicketCase/current', c =>
  instrumented(c, 'GET /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/TicketCase/current', () =>
    handleGetTicketCaseCurrentStep(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/TicketCase/advance', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/agents/:agentId/TicketCase/advance', () =>
    handleAdvanceTicketCaseStep(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/escalations', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/escalations', () =>
    handleCreateEscalation(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/workstations/:workstationId/triage/resolve', c =>
  instrumented(c, 'POST /api/departments/:departmentId/workstations/:workstationId/triage/resolve', () =>
    handleResolveTriage(c, c.req.param())
  )
);

// Called by the container on SIGTERM. Uses container JWT auth (not kilo
// user auth), so it must be registered before the kiloAuthMiddleware
// wildcard below.

app.post('/api/departments/:departmentId/container-eviction', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container-eviction', () =>
    handleContainerEviction(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/container-ready', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container-ready', () =>
    handleContainerReady(c, c.req.param())
  )
);

app.post('/api/departments/:departmentId/refresh-container-token', c =>
  instrumented(c, 'POST /api/departments/:departmentId/refresh-container-token', () =>
    handleRefreshContainerToken(c, c.req.param())
  )
);

app.get('/api/departments/:departmentId/drain-status', c =>
  instrumented(c, 'GET /api/departments/:departmentId/drain-status', () => handleDrainStatus(c, c.req.param()))
);

// Simple pass-through to DepartmentContainerDO registry.
// Protected by authMiddleware (accepts container JWTs), not kiloAuthMiddleware.

app.use('/api/departments/:departmentId/container-registry', async (c: Context<HelldeskEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

app.get('/api/departments/:departmentId/container-registry', async c => {
  const departmentId = c.req.param('departmentId');
  const tc = getDepartmentContainerStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const registry = await tc.getRegistry();
  return c.json({ success: true, data: registry });
});

app.post('/api/departments/:departmentId/container-registry', async c => {
  const departmentId = c.req.param('departmentId');
  const body: unknown = await c.req.json();
  const tc = getDepartmentContainerStub(c.env, departmentId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  await tc.updateRegistry(body);
  return c.json({ success: true });
});

// Stored in the AGENT_DB_SNAPSHOTS_KV namespace keyed by agentId.
// Protected by authMiddleware (accepts container JWTs), not kiloAuthMiddleware.
// Registered after authMiddleware but before kiloAuthMiddleware wildcard.

app.get('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/db-snapshot', async c => {
  const { agentId } = c.req.param();
  const snapshot = await c.env.AGENT_DB_SNAPSHOTS_KV.get(agentId, 'arrayBuffer');
  if (!snapshot) return c.json({ success: false, error: 'Snapshot not found' }, 404);
  return new Response(snapshot, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
});

app.post('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/db-snapshot', async c => {
  const { agentId } = c.req.param();
  const body = await c.req.arrayBuffer();
  await c.env.AGENT_DB_SNAPSHOTS_KV.put(agentId, body);
  return c.json({ success: true });
});

app.delete('/api/departments/:departmentId/workstations/:workstationId/agents/:agentId/db-snapshot', async c => {
  const { agentId } = c.req.param();
  await c.env.AGENT_DB_SNAPSHOTS_KV.delete(agentId);
  return c.json({ success: true });
});

// Returns the frontDesk's agent ID for a department so the container can prewarm
// the frontDesk's SDK server during bootHydration. Protected by authMiddleware
// (accepts container JWTs), not kiloAuthMiddleware.

app.use('/api/departments/:departmentId/front-desk-id', async (c: Context<HelldeskEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

app.get('/api/departments/:departmentId/front-desk-id', async c => {
  const departmentId = c.req.param('departmentId');
  const department = getDepartmentDOStub(c.env, departmentId);
  // Response contract (consumed by fetchFrontDeskPrewarmContext in the
  // container's process-manager.ts):
  // - When the department has a frontDesk AND a kilocode token, return the full
  //   prewarm context so KILO_CONFIG_CONTENT matches what /agents/start
  //   will send (no eviction churn in ensureSDKServer).
  // - When the frontDesk agent exists but no kilocode token is available,
  //   return { agentId } only — the container will skip prewarm.
  // - When there is no frontDesk at all, return { agentId: null } — the
  //   container treats missing/null agentId as "no frontDesk, skip prewarm".
  const ctx = await department.getFrontDeskPrewarmContext();
  if (!ctx) {
    return c.json({ success: true, agentId: null });
  }
  return c.json({ success: true, ...ctx });
});

// Container-to-worker event proxy. The container can't call writeEvent
// directly (it's worker-side), so it POSTs events here. Protected by
// authMiddleware (accepts container JWTs), not kiloAuthMiddleware.

app.use('/api/departments/:departmentId/container-events', async (c: Context<HelldeskEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

app.post('/api/departments/:departmentId/container-events', async c => {
  const departmentId = c.req.param('departmentId');
  const body: unknown = await c.req.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('event' in body) ||
    typeof (body as { event: unknown }).event !== 'string'
  ) {
    return c.json({ success: false, error: 'Missing event name' }, 400);
  }
  const data = body as { event: string; [key: string]: unknown };
  writeEvent(c.env, {
    event: data.event,
    departmentId,
    agentId: typeof data.agentId === 'string' ? data.agentId : undefined,
    durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
    role: typeof data.role === 'string' ? data.role : undefined,
    label: typeof data.label === 'string' ? data.label : undefined,
    double3: typeof data.phaseMs === 'number' ? data.phaseMs : undefined,
    double4: typeof data.elapsedMs === 'number' ? data.elapsedMs : undefined,
  });
  return c.json({ success: true });
});

// Validate Kilo user JWT (signed with NEXTAUTH_SECRET) for dashboard/user
// routes. Container→worker routes use the agent JWT middleware instead
// (authMiddleware above).

app.use('/api/users/*', async (c: Context<HelldeskEnv, string>, next) =>
  kiloAuthMiddleware(c, next)
);
app.use('/api/users/*', resolveWorkerAdminMiddleware);
app.use('/api/users/*', helldeskRouteAccessMiddleware);
app.use('/api/users/:userId/*', userAuthMiddleware);
// Department routes: kilo auth + HELLDESK access + admin audit + department ownership check (supports both personal and org-owned departments).
// Skip for container-registry and db-snapshot routes which use authMiddleware with container JWT support.
const departmentRouteAuthMiddleware = every(
  kiloAuthMiddleware,
  resolveWorkerAdminMiddleware,
  helldeskRouteAccessMiddleware,
  departmentAuthMiddleware
);
app.use('/api/departments/:departmentId/*', async (c: Context<HelldeskEnv, string>, next) => {
  const path = c.req.path;
  if (
    path.includes('/container-registry') ||
    path.includes('/db-snapshot') ||
    path.includes('/front-desk-id') ||
    path.includes('/container-events')
  ) {
    return next();
  }
  return departmentRouteAuthMiddleware(c, next);
});

// Kilo user auth + HELLDESK access + org membership check for all org routes.

app.use('/api/orgs/:orgId/*', async (c: Context<HelldeskEnv, string>, next) =>
  kiloAuthMiddleware(c, next)
);
app.use('/api/orgs/:orgId/*', resolveWorkerAdminMiddleware);
app.use('/api/orgs/:orgId/*', helldeskRouteAccessMiddleware);
app.use('/api/orgs/:orgId/*', async (c: Context<HelldeskEnv, string>, next) =>
  orgAuthMiddleware(c, next)
);

// HelldeskOrgDO instances are keyed by orgId. One DO instance per org stores
// all departments and workstations the org owns.

app.post('/api/orgs/:orgId/departments', helldeskAccessMiddleware, c =>
  instrumented(c, 'POST /api/orgs/:orgId/departments', () => handleCreateOrgDepartment(c, c.req.param()))
);
app.get('/api/orgs/:orgId/departments', c =>
  instrumented(c, 'GET /api/orgs/:orgId/departments', () => handleListOrgDepartments(c, c.req.param()))
);
app.get('/api/orgs/:orgId/departments/:departmentId', c =>
  instrumented(c, 'GET /api/orgs/:orgId/departments/:departmentId', () => handleGetOrgDepartment(c, c.req.param()))
);
app.post('/api/orgs/:orgId/workstations', c =>
  instrumented(c, 'POST /api/orgs/:orgId/workstations', () => handleCreateOrgWorkstation(c, c.req.param()))
);
app.get('/api/orgs/:orgId/departments/:departmentId/workstations', c =>
  instrumented(c, 'GET /api/orgs/:orgId/departments/:departmentId/workstations', () =>
    handleListOrgWorkstations(c, c.req.param())
  )
);
app.get('/api/orgs/:orgId/workstations/:workstationId', c =>
  instrumented(c, 'GET /api/orgs/:orgId/workstations/:workstationId', () => handleGetOrgWorkstation(c, c.req.param()))
);
app.delete('/api/orgs/:orgId/departments/:departmentId', c =>
  instrumented(c, 'DELETE /api/orgs/:orgId/departments/:departmentId', () =>
    handleDeleteOrgDepartment(c, c.req.param())
  )
);
app.delete('/api/orgs/:orgId/workstations/:workstationId', c =>
  instrumented(c, 'DELETE /api/orgs/:orgId/workstations/:workstationId', () => handleDeleteOrgWorkstation(c, c.req.param()))
);

// Department DO instances are keyed by owner_user_id. The userId path param routes
// to the correct DO instance so each user's departments are isolated.

app.post('/api/users/:userId/departments', helldeskAccessMiddleware, c =>
  instrumented(c, 'POST /api/users/:userId/departments', () => handleCreateDepartment(c, c.req.param()))
);
app.get('/api/users/:userId/departments', c =>
  instrumented(c, 'GET /api/users/:userId/departments', () => handleListDepartments(c, c.req.param()))
);
app.get('/api/users/:userId/departments/:departmentId', c =>
  instrumented(c, 'GET /api/users/:userId/departments/:departmentId', () => handleGetDepartment(c, c.req.param()))
);
app.post('/api/users/:userId/workstations', c =>
  instrumented(c, 'POST /api/users/:userId/workstations', () => handleCreateWorkstation(c, c.req.param()))
);
app.get('/api/users/:userId/workstations/:workstationId', c =>
  instrumented(c, 'GET /api/users/:userId/workstations/:workstationId', () => handleGetWorkstation(c, c.req.param()))
);
app.get('/api/users/:userId/departments/:departmentId/workstations', c =>
  instrumented(c, 'GET /api/users/:userId/departments/:departmentId/workstations', () =>
    handleListWorkstations(c, c.req.param())
  )
);
app.delete('/api/users/:userId/departments/:departmentId', c =>
  instrumented(c, 'DELETE /api/users/:userId/departments/:departmentId', () =>
    handleDeleteDepartment(c, c.req.param())
  )
);
app.delete('/api/users/:userId/workstations/:workstationId', c =>
  instrumented(c, 'DELETE /api/users/:userId/workstations/:workstationId', () => handleDeleteWorkstation(c, c.req.param()))
);

app.post('/api/departments/:departmentId/shifts', c =>
  instrumented(c, 'POST /api/departments/:departmentId/shifts', () => handleCreateShift(c, c.req.param()))
);
app.post('/api/departments/:departmentId/shifts/ticket-closed', c =>
  instrumented(c, 'POST /api/departments/:departmentId/shifts/ticket-closed', () =>
    handleOnTicketClosed(c, c.req.param())
  )
);

app.get('/api/departments/:departmentId/escalations', c =>
  instrumented(c, 'GET /api/departments/:departmentId/escalations', () =>
    handleListEscalations(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/escalations/:escalationId/acknowledge', c =>
  instrumented(c, 'POST /api/departments/:departmentId/escalations/:escalationId/acknowledge', () =>
    handleAcknowledgeEscalation(c, c.req.param())
  )
);

app.get('/api/departments/:departmentId/config', c =>
  instrumented(c, 'GET /api/departments/:departmentId/config', () => handleGetDepartmentConfig(c, c.req.param()))
);
app.patch('/api/departments/:departmentId/config', c =>
  instrumented(c, 'PATCH /api/departments/:departmentId/config', () => handleUpdateDepartmentConfig(c, c.req.param()))
);

// Returns DO IDs and namespace IDs for constructing Cloudflare dashboard URLs.
// containerDoId is only returned when the container is actually running,
// so the UI correctly shows a disabled state when the container is stopped.

app.get('/api/departments/:departmentId/cloudflare-debug', async c => {
  const departmentId = c.req.param('departmentId');
  const departmentDoId = c.env.department.idFromName(departmentId).toString();

  // Check actual container runtime state before returning the DO ID.
  // idFromName() is deterministic and always returns an ID even when
  // no container instance is running — we need to gate on getState().
  const containerStub = getDepartmentContainerStub(c.env, departmentId);
  const containerState = await containerStub.getState();
  const containerRunning =
    containerState.status === 'running' || containerState.status === 'healthy';
  const containerDoId = containerRunning
    ? c.env.DEPARTMENT_CONTAINER.idFromName(departmentId).toString()
    : null;

  return c.json({
    success: true,
    data: { departmentDoId, containerDoId },
  });
});

app.use('/api/users/:userId/departments/:departmentId/events', async (c: Context<HelldeskEnv, string>, next) =>
  departmentAuthMiddleware(c, next)
);
app.get('/api/users/:userId/departments/:departmentId/events', c =>
  instrumented(c, 'GET /api/users/:userId/departments/:departmentId/events', () =>
    handleListDepartmentEvents(c, c.req.param())
  )
);

// These routes proxy commands to the container's control server via DO.fetch().
// Protected by Cloudflare Access at the perimeter; no additional auth required.

app.post('/api/departments/:departmentId/container/agents/start', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container/agents/start', () =>
    handleContainerStartAgent(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/container/agents/:agentId/stop', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container/agents/:agentId/stop', () =>
    handleContainerStopAgent(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/container/agents/:agentId/message', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container/agents/:agentId/message', () =>
    handleContainerSendMessage(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/container/agents/:agentId/status', c =>
  instrumented(c, 'GET /api/departments/:departmentId/container/agents/:agentId/status', () =>
    handleContainerAgentStatus(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/container/agents/:agentId/stream-ticket', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container/agents/:agentId/stream-ticket', () =>
    handleContainerStreamTicket(c, c.req.param())
  )
);
// Note: GET /api/departments/:departmentId/container/agents/:agentId/stream (WebSocket)
// is handled outside Hono in the default export's fetch handler, which
// routes the upgrade directly to DepartmentContainerDO.fetch().

app.get('/api/departments/:departmentId/container/health', c =>
  instrumented(c, 'GET /api/departments/:departmentId/container/health', () =>
    handleContainerHealth(c, c.req.param())
  )
);

// PTY routes — proxy to container's SDK PTY endpoints
app.post('/api/departments/:departmentId/container/agents/:agentId/pty', c =>
  instrumented(c, 'POST /api/departments/:departmentId/container/agents/:agentId/pty', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/container/agents/:agentId/pty', c =>
  instrumented(c, 'GET /api/departments/:departmentId/container/agents/:agentId/pty', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'GET /api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.put('/api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'PUT /api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.delete('/api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'DELETE /api/departments/:departmentId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
// Note: GET /agents/:agentId/pty/:ptyId/connect (WebSocket) is handled
// in the default export's fetch handler, bypassing Hono.

// FrontDeskDO endpoints — department-level conversational agent with persistent session.

app.post('/api/departments/:departmentId/frontDesk/configure', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/configure', () =>
    handleConfigureFrontDesk(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/frontDesk/message', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/message', () =>
    handleSendFrontDeskMessage(c, c.req.param())
  )
);
app.get('/api/departments/:departmentId/frontDesk/status', c =>
  instrumented(c, 'GET /api/departments/:departmentId/frontDesk/status', () =>
    handleGetFrontDeskStatus(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/frontDesk/ensure', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/ensure', () => handleEnsureFrontDesk(c, c.req.param()))
);
app.post('/api/departments/:departmentId/frontDesk/completed', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/completed', () =>
    handleFrontDeskCompleted(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/frontDesk/destroy', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/destroy', () =>
    handleDestroyFrontDesk(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/frontDesk/dashboard-context', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/dashboard-context', () =>
    handleSetDashboardContext(c, c.req.param())
  )
);
app.post('/api/departments/:departmentId/frontDesk/ui-action', c =>
  instrumented(c, 'POST /api/departments/:departmentId/frontDesk/ui-action', () =>
    handleBroadcastUiAction(c, c.req.param())
  )
);

// Tool endpoints called by the frontDesk's kilo serve session via the HELLDESK plugin.
// Authenticated via frontDesk JWT (departmentId-scoped, no workstationId restriction).

// Always run frontDesk auth — even in dev. The handler's resolveUserId()
// reads agentJWT.userId which is only set after the middleware parses
// the token. Skipping auth in dev leaves agentJWT null and causes 401s
// from the handler itself.
app.use('/api/frontDesk/:departmentId/tools/*', frontDeskAuthMiddleware);

// FrontDesk tool: broadcast a UI action (called from the frontDesk container)
app.post('/api/frontDesk/:departmentId/tools/ui-action', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/ui-action', () =>
    handleFrontDeskUiAction(c, c.req.param())
  )
);
app.get('/api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/pending-nudges', c =>
  handleFrontDeskGetPendingNudges(c, c.req.param())
);

app.post('/api/frontDesk/:departmentId/tools/sling', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/sling', () => handleFrontDeskSling(c, c.req.param()))
);
app.post('/api/frontDesk/:departmentId/tools/sling-batch', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/sling-batch', () =>
    handleFrontDeskSlingBatch(c, c.req.param())
  )
);
app.get('/api/frontDesk/:departmentId/tools/workstations', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/workstations', () => handleFrontDeskListWorkstations(c, c.req.param()))
);
app.get('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets', () =>
    handleFrontDeskListTickets(c, c.req.param())
  )
);
app.get('/api/frontDesk/:departmentId/tools/workstations/:workstationId/agents', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/workstations/:workstationId/agents', () =>
    handleFrontDeskListAgents(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/memo', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/memo', () => handleFrontDeskSendMemo(c, c.req.param()))
);
app.get('/api/frontDesk/:departmentId/tools/shifts', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/shifts', () =>
    handleFrontDeskListShifts(c, c.req.param())
  )
);
app.get('/api/frontDesk/:departmentId/tools/shifts/:shiftId', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/shifts/:shiftId', () =>
    handleFrontDeskShiftStatus(c, c.req.param())
  )
);
app.patch('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId', c =>
  instrumented(c, 'PATCH /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId', () =>
    handleFrontDeskTicketUpdate(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId/reassign', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId/reassign', () =>
    handleFrontDeskTicketReassign(c, c.req.param())
  )
);
app.delete('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId', c =>
  instrumented(c, 'DELETE /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/:ticketId', () =>
    handleFrontDeskTicketDelete(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/bulk-delete', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/bulk-delete', () =>
    handleFrontDeskBulkDeleteTickets(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/delete-by-status', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/tickets/delete-by-status', () =>
    handleFrontDeskDeleteTicketsByStatus(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/reset', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/workstations/:workstationId/agents/:agentId/reset', () =>
    handleFrontDeskAgentReset(c, c.req.param())
  )
);
app.patch('/api/frontDesk/:departmentId/tools/shifts/:shiftId', c =>
  instrumented(c, 'PATCH /api/frontDesk/:departmentId/tools/shifts/:shiftId', () =>
    handleFrontDeskShiftUpdate(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/shifts/:shiftId/close', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/close', () =>
    handleFrontDeskShiftClose(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/escalations/:escalationId/acknowledge', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/escalations/:escalationId/acknowledge', () =>
    handleFrontDeskEscalationAcknowledge(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/shifts/:shiftId/start', c =>
  handleFrontDeskShiftStart(c, c.req.param())
);
app.post('/api/frontDesk/:departmentId/tools/shifts/:shiftId/add-ticket', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/add-ticket', () =>
    handleFrontDeskShiftAddTicket(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/shifts/:shiftId/remove-ticket', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/shifts/:shiftId/remove-ticket', () =>
    handleFrontDeskShiftRemoveTicket(c, c.req.param())
  )
);

// FrontDesk tools for interacting with hosted Helldesks. The helldesk is
// auto-resolved from the department's connection — frontDesk never supplies it.
// Auth is handled by the `/api/frontDesk/:departmentId/tools/*` wildcard middleware.
app.get('/api/frontDesk/:departmentId/tools/helldesk/browse', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/helldesk/browse', () =>
    handleHelldeskBrowse(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/claim', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/claim', () =>
    handleHelldeskClaim(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/post', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/post', () =>
    handleHelldeskPost(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/done', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/done', () =>
    handleHelldeskDone(c, c.req.param())
  )
);

// Legacy routes — accepted for backward compatibility with older frontDesk
// container plugins that still supply a helldesk_id in the URL. The
// path param is ignored; the helldesk is always resolved from the department.
app.get('/api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/browse', c =>
  instrumented(c, 'GET /api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/browse', () =>
    handleHelldeskBrowse(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/claim', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/claim', () =>
    handleHelldeskClaim(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/post', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/post', () =>
    handleHelldeskPost(c, c.req.param())
  )
);
app.post('/api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/done', c =>
  instrumented(c, 'POST /api/frontDesk/:departmentId/tools/helldesk/:legacyHelldeskId/done', () =>
    handleHelldeskDone(c, c.req.param())
  )
);
// Serve the helldesk tRPC router directly. The frontend tRPC client
// connects here instead of going through the Next.js proxy layer.

app.use('/trpc/*', kiloAuthMiddleware);
app.use('/trpc/*', resolveWorkerAdminMiddleware);
app.use(
  '/trpc/*',
  trpcServer({
    router: wrappedHelldeskRouter,
    endpoint: '/trpc',
    createContext: (_opts: unknown, c: Context<HelldeskEnv>) => ({
      env: c.env,
      executionCtx: c.executionCtx,
      userId: c.get('kiloUserId') ?? '',
      workerAdmin: c.get('workerAdmin'),
      apiTokenPepper: c.get('kiloApiTokenPepper') ?? null,
      helldeskAccess: c.get('kiloHelldeskAccess') ?? false,
      orgMemberships: c.get('kiloOrgMemberships') ?? [],
    }),
    onError: ({ error, path }: { error: Error; path?: string }) => {
      console.error(`[helldesk-trpc] error on ${path ?? 'unknown'}:`, error.message);
      if (!(error instanceof TRPCError)) {
        Sentry.captureException(error);
      }
    },
  })
);

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  Sentry.captureException(err);
  return c.json(resError('Internal server error'), 500);
});

// WebSocket upgrade requests for agent streaming must bypass Hono and go
// directly to the DepartmentContainerDO.fetch(). Hono cannot relay a 101
// WebSocket response — the DO must return the WebSocketPair client end
// directly to the runtime.

const WS_STREAM_PATTERN = /^\/api\/departments\/([^/]+)\/container\/agents\/([^/]+)\/stream$/;
const WS_PTY_PATTERN = /^\/api\/departments\/([^/]+)\/container\/agents\/([^/]+)\/pty\/([^/]+)\/connect$/;
const WS_STATUS_PATTERN = /^\/api\/departments\/([^/]+)\/status\/ws$/;

export default withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN ?? '',
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0,
    enabled: !!env.SENTRY_DSN,
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Intercept WebSocket upgrade requests for agent streaming and PTY.
      // Must bypass Hono — the DO returns a 101 + WebSocketPair that the
      // runtime handles directly.
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        // WebSocket upgrades use capability-token auth, not JWT headers.
        // Browsers cannot send custom headers on WebSocket connections.
        // The stream endpoint uses a ticket obtained via authenticated POST,
        // and PTY uses a session ID obtained via authenticated POST.
        const url = new URL(request.url);

        // Agent event stream
        const streamMatch = url.pathname.match(WS_STREAM_PATTERN);
        if (streamMatch) {
          const departmentId = streamMatch[1];
          const agentId = streamMatch[2];
          console.log(`[helldesk-worker] WS upgrade (stream): departmentId=${departmentId} agentId=${agentId}`);
          const stub = getDepartmentContainerStub(env, departmentId);
          return stub.fetch(request);
        }

        // PTY terminal connection
        const ptyMatch = url.pathname.match(WS_PTY_PATTERN);
        if (ptyMatch) {
          const departmentId = ptyMatch[1];
          const agentId = ptyMatch[2];
          const ptyId = ptyMatch[3];
          console.log(
            `[helldesk-worker] WS upgrade (pty): departmentId=${departmentId} agentId=${agentId} ptyId=${ptyId}`
          );
          const stub = getDepartmentContainerStub(env, departmentId);
          return stub.fetch(request);
        }

        // Department alarm status (real-time push)
        const statusMatch = url.pathname.match(WS_STATUS_PATTERN);
        if (statusMatch) {
          const departmentId = statusMatch[1];
          console.log(`[helldesk-worker] WS upgrade (status): departmentId=${departmentId}`);
          const stub = getDepartmentDOStub(env, departmentId);
          return stub.fetch(request);
        }
      }

      // All other requests go through Hono
      return app.fetch(request, env, ctx);
    },
  }
);
