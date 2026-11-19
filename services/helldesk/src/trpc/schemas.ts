import { z } from 'zod';
import { WorkstationOverrideConfigSchema } from '../types';

/**
 * Wraps a Zod schema in z.any().pipe(schema) so the TS input type is `any`
 * (avoiding "excessively deep" instantiation with Rpc.Promisified DO stubs)
 * while still performing full runtime validation via the piped schema.
 */
function rpcSafe<T extends z.ZodTypeAny>(schema: T): z.ZodPipe<z.ZodAny, T> {
  return z.any().pipe(schema);
}

// Department (from HelldeskUserDO)
export const DepartmentOutput = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

// Workstation (from HelldeskUserDO)
export const WorkstationOutput = z.object({
  id: z.string(),
  department_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

// Ticket (output shape, after transforms)
export const TicketOutput = z.object({
  ticket_id: z.string(),
  type: z.enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent']),
  status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  assignee_agent_ticket_id: z.string().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  labels: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export const AgentOutput = z.object({
  id: z.string(),
  workstation_id: z.string().nullable(),
  role: z.enum(['soul', 'qualityAssurance', 'frontDesk']).or(z.string()),
  name: z.string(),
  identity: z.string(),
  status: z.enum(['idle', 'working', 'stalled', 'dead']).or(z.string()),
  current_hook_ticket_id: z.string().nullable(),
  dispatch_attempts: z.number().default(0),
  last_activity_at: z.string().nullable(),
  checkpoint: z.unknown().optional(),
  created_at: z.string(),
  agent_status_message: z.string().nullable().optional().default(null),
  agent_status_updated_at: z.string().nullable().optional().default(null),
});

// TicketEvent (output shape, after transforms)
export const TicketEventOutput = z.object({
  ticket_event_id: z.string(),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  // Optional fields for department-level events that tag the workstation
  workstation_id: z.string().optional(),
  workstation_name: z.string().optional(),
});

export const FrontDeskSendResultOutput = z.object({
  agentId: z.string(),
  sessionStatus: z.enum(['idle', 'active', 'starting']),
});

export const FrontDeskStatusOutput = z.object({
  configured: z.boolean(),
  departmentId: z.string().nullable(),
  session: z
    .object({
      agentId: z.string(),
      sessionId: z.string(),
      status: z.enum(['idle', 'active', 'starting']),
      lastActivityAt: z.string(),
    })
    .nullable(),
});

export const BillingStatusOutput = z.object({
  enabled: z.boolean(),
  enforcing: z.boolean(),
  state: z.enum([
    'idle',
    'starting',
    'running',
    'warning',
    'stopping',
    'blocked',
    'paused',
    'degraded',
  ]),
  runPolicy: z.enum(['automatic', 'paused_by_user']),
  payer: z.object({ type: z.enum(['user', 'org']), id: z.string() }).optional(),
  remaining: z.number().optional(),
  minimumRequired: z.number().optional(),
  estimatedHourlyCharge: z.number().optional(),
  estimatedRunCharge: z.number().optional(),
  runUsageSeconds: z.number().optional(),
  intervalStartedAt: z.number().optional(),
  lastReportedAt: z.number().optional(),
});

export const StreamTicketOutput = z.object({
  url: z.string(),
  ticket: z.string(),
});

// PtySession (passthrough for extra fields)
export const PtySessionOutput = z.object({
  pty: z.object({ id: z.string() }).passthrough(),
  wsUrl: z.string(),
});

export const ShiftOutput = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['active', 'landed']),
  staged: z.boolean(),
  total_tickets: z.number(),
  closed_tickets: z.number(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  landed_at: z.string().nullable(),
  feature_branch: z.string().nullable(),
  merge_mode: z.string().nullable(),
});

// Detailed shift status with per-ticket breakdown and DAG edges
export const ShiftDetailOutput = ShiftOutput.extend({
  tickets: z.array(
    z.object({
      ticket_id: z.string(),
      title: z.string(),
      status: z.string(),
      workstation_id: z.string().nullable(),
      assignee_agent_name: z.string().nullable(),
    })
  ),
  /** 'blocks' dependency edges between tracked tickets — the execution DAG. */
  dependency_edges: z.array(
    z.object({
      ticket_id: z.string(),
      depends_on_ticket_id: z.string(),
    })
  ),
});

export const SlingResultOutput = z.object({
  ticket: TicketOutput,
  agent: AgentOutput,
});

// getWorkstation enriched result
export const WorkstationDetailOutput = z.object({
  id: z.string(),
  department_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  config: WorkstationOverrideConfigSchema.optional(),
  agents: z.array(AgentOutput),
  tickets: z.array(TicketOutput),
});

// tRPC's .output() forces TypeScript to check that the handler return type
// is assignable to the schema's input type. When handlers return values from
// Cloudflare Rpc.Promisified DO stubs, the deeply recursive proxy types
// exceed TS's instantiation depth limit. Wrapping with rpcSafe() (z.any().pipe)
// short-circuits the type check while preserving identical runtime validation.

export const RpcDepartmentOutput = rpcSafe(DepartmentOutput);
export const RpcWorkstationOutput = rpcSafe(WorkstationOutput);
export const RpcTicketOutput = rpcSafe(TicketOutput);
export const RpcAgentOutput = rpcSafe(AgentOutput);
export const RpcTicketEventOutput = rpcSafe(TicketEventOutput);
export const RpcFrontDeskSendResultOutput = rpcSafe(FrontDeskSendResultOutput);
export const RpcFrontDeskStatusOutput = rpcSafe(FrontDeskStatusOutput);
export const RpcBillingStatusOutput = rpcSafe(BillingStatusOutput);
export const RpcStreamTicketOutput = rpcSafe(StreamTicketOutput);
export const RpcPtySessionOutput = rpcSafe(PtySessionOutput);
export const RpcShiftOutput = rpcSafe(ShiftOutput);
export const RpcShiftDetailOutput = rpcSafe(ShiftDetailOutput);
export const RpcSlingResultOutput = rpcSafe(SlingResultOutput);

const AlarmStatusOutput = z.object({
  alarm: z.object({
    nextFireAt: z.string().nullable(),
    intervalMs: z.number(),
    intervalLabel: z.string(),
  }),
  agents: z.object({
    working: z.number(),
    idle: z.number(),
    stalled: z.number(),
    dead: z.number(),
    total: z.number(),
  }),
  tickets: z.object({
    open: z.number(),
    inProgress: z.number(),
    inReview: z.number(),
    failed: z.number(),
    triageRequests: z.number(),
  }),
  attendance: z.object({
    guppWarnings: z.number(),
    guppEscalations: z.number(),
    stalledAgents: z.number(),
    orphanedHooks: z.number(),
  }),
  recentEvents: z.array(
    z.object({
      time: z.string(),
      type: z.string(),
      message: z.string(),
    })
  ),
  billing: BillingStatusOutput,
});
export const RpcAlarmStatusOutput = rpcSafe(AlarmStatusOutput);
export const RpcWorkstationDetailOutput = rpcSafe(WorkstationDetailOutput);

const MergeQueueTicketOutput = z.object({
  ticket_id: z.string(),
  status: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

const ReviewMetadataOutput = z.object({
  branch: z.string(),
  target_branch: z.string(),
  merge_commit: z.string().nullable(),
  pr_url: z.string().nullable(),
  retry_count: z.number(),
});

const SourceTicketOutput = z.object({
  ticket_id: z.string(),
  title: z.string(),
  status: z.string(),
  body: z.string().nullable(),
});

const ShiftRefOutput = z.object({
  shift_id: z.string(),
  title: z.string(),
  total_tickets: z.number(),
  closed_tickets: z.number(),
  feature_branch: z.string().nullable(),
  merge_mode: z.string().nullable(),
});

const AgentRefOutput = z.object({
  agent_id: z.string(),
  name: z.string(),
  role: z.string(),
});

const MergeQueueItemOutput = z.object({
  mrTicket: MergeQueueTicketOutput,
  reviewMetadata: ReviewMetadataOutput,
  sourceTicket: SourceTicketOutput.nullable(),
  shift: ShiftRefOutput.nullable(),
  agent: AgentRefOutput.nullable(),
  workstationName: z.string().nullable(),
  staleSince: z.string().nullable(),
  failureReason: z.string().nullable(),
});

const ActivityLogEventOutput = z.object({
  ticket_event_id: z.string(),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: z.string(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

const ActivityLogMrTicketOutput = z.object({
  ticket_id: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  workstation_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

const ActivityLogReviewMetadataOutput = z.object({
  pr_url: z.string().nullable(),
  branch: z.string().nullable(),
  target_branch: z.string().nullable(),
  merge_commit: z.string().nullable(),
});

const ActivityLogSourceTicketOutput = z.object({
  ticket_id: z.string(),
  title: z.string(),
  status: z.string(),
});

const ActivityLogEntryOutput = z.object({
  event: ActivityLogEventOutput,
  mrTicket: ActivityLogMrTicketOutput.nullable(),
  sourceTicket: ActivityLogSourceTicketOutput.nullable(),
  shift: ShiftRefOutput.nullable(),
  agent: AgentRefOutput.nullable(),
  workstationName: z.string().nullable(),
  reviewMetadata: ActivityLogReviewMetadataOutput.nullable(),
});

export const MergeQueueDataOutput = z.object({
  needsAttention: z.object({
    openPRs: z.array(MergeQueueItemOutput),
    failedReviews: z.array(MergeQueueItemOutput),
    stalePRs: z.array(MergeQueueItemOutput),
  }),
  activityLog: z.array(ActivityLogEntryOutput),
});

export const RpcMergeQueueDataOutput = rpcSafe(MergeQueueDataOutput);

// OrgDepartment (from HelldeskOrgDO)
export const OrgDepartmentOutput = z.object({
  id: z.string(),
  name: z.string(),
  owner_org_id: z.string(),
  created_by_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const RpcOrgDepartmentOutput = rpcSafe(OrgDepartmentOutput);
