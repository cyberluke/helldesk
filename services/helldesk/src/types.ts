import { z } from 'zod';
import type { TicketRecord } from './db/tables/tickets.table';
import type { AgentMetadataRecord } from './db/tables/agent-metadata.table';

// -- Tickets --

export const TicketStatus = z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketType = z.enum([
  'issue',
  'message',
  'escalation',
  'merge_request',
  'shift',
  'TicketCase',
  'agent',
]);
export type TicketType = z.infer<typeof TicketType>;

export const TicketPriority = z.enum(['low', 'medium', 'high', 'critical']);
export type TicketPriority = z.infer<typeof TicketPriority>;

export type Ticket = TicketRecord;

export type CreateTicketInput = {
  type: TicketType;
  title: string;
  body?: string;
  priority?: TicketPriority;
  labels?: string[];
  metadata?: Record<string, unknown>;
  assignee_agent_ticket_id?: string;
  parent_ticket_id?: string;
  workstation_id?: string;
  created_by?: string;
};

export type TicketFilter = {
  status?: TicketStatus;
  type?: TicketType;
  assignee_agent_ticket_id?: string;
  parent_ticket_id?: string;
  workstation_id?: string;
  limit?: number;
  offset?: number;
};

// -- Agents (now tickets + agent_metadata) --

export const AgentRole = z.enum(['soul', 'qualityAssurance', 'frontDesk']);
export type AgentRole = z.infer<typeof AgentRole>;

export const AgentStatus = z.enum(['idle', 'working', 'waiting', 'stalled', 'dead']);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * An Agent is a ticket (type='agent') joined with its agent_metadata row.
 * This combined type is used throughout the codebase.
 */
export type Agent = {
  /** The agent's ticket_id (primary key across both tables) */
  id: string;
  workstation_id: string | null;
  role: AgentMetadataRecord['role'];
  name: string;
  identity: string;
  status: AgentMetadataRecord['status'];
  current_hook_ticket_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  // Opaque JSON blob from SQLite; `unknown` breaks Cloudflare's Rpc.Serializable<T> type
  // inference, and recursive JSON types cause "excessively deep" instantiation.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  checkpoint: any;
  created_at: string;
  agent_status_message: string | null;
  agent_status_updated_at: string | null;
};

export type RegisterAgentInput = {
  role: AgentRole;
  name: string;
  identity: string;
  workstation_id?: string;
};

export type AgentFilter = {
  role?: AgentRole;
  status?: AgentStatus;
  workstation_id?: string;
};

// -- Memo (now tickets with type='message') --

export type Memo = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
  delivered: boolean;
  created_at: string;
  delivered_at: string | null;
};

export type SendMemoInput = {
  from_agent_id: string;
  to_agent_id: string;
  subject: string;
  body: string;
};

// -- Review Queue (now tickets with type='merge_request' + review_metadata) --

export const ReviewStatus = z.enum(['pending', 'running', 'merged', 'failed']);
export type ReviewStatus = z.infer<typeof ReviewStatus>;

export type ReviewQueueEntry = {
  id: string;
  agent_id: string;
  ticket_id: string;
  workstation_id: string;
  branch: string;
  pr_url: string | null;
  status: ReviewStatus;
  summary: string | null;
  created_at: string;
  processed_at: string | null;
};

export type ReviewQueueInput = {
  agent_id: string;
  ticket_id: string;
  workstation_id: string;
  branch: string;
  pr_url?: string;
  summary?: string;
  /** The workstation's default branch. Used as target when not overridden by shift feature branch. */
  default_branch?: string;
};

// -- TicketCases (now tickets with type='TicketCase' + child step tickets) --

export const TicketCaseStatus = z.enum(['active', 'completed', 'failed']);
export type TicketCaseStatus = z.infer<typeof TicketCaseStatus>;

export type TicketCase = {
  id: string;
  ticket_id: string;
  formula: unknown;
  current_step: number;
  status: TicketCaseStatus;
  created_at: string;
  updated_at: string;
};

// -- Prime context --

export type PrimeContext = {
  agent: Agent;
  hooked_Ticket: Ticket | null;
  undelivered_memo: Memo[];
  open_tickets: Ticket[];
  /** Present when the hooked ticket is a rework request (gt:rework label). */
  rework_context: {
    feedback: string;
    branch: string | null;
    target_branch: string | null;
    files: string[];
    original_ticket_title: string | null;
    mr_ticket_id: string | null;
  } | null;
  /** Present when the hooked ticket is a PR fixup (gt:pr-fixup label). */
  pr_fixup_context: {
    pr_url: string | null;
    branch: string | null;
    target_branch: string | null;
  } | null;
  /** Present when the hooked ticket is a PR conflict resolution (gt:pr-conflict label). */
  pr_conflict_context: {
    pr_url: string | null;
    branch: string | null;
    target_branch: string | null;
    /** When true, the ticket also has pending review feedback to address after resolving conflicts. */
    has_feedback: boolean;
  } | null;
};

// -- Agent done --

export type AgentDoneInput = {
  branch: string;
  pr_url?: string;
  summary?: string;
};

// -- Attendance --

export type AttendanceResult = {
  dead_agents: string[];
  stale_agents: string[];
  orphaned_tickets: string[];
};

// -- Merge Strategy --

export const MergeStrategy = z.enum(['direct', 'pr']);
export type MergeStrategy = z.infer<typeof MergeStrategy>;

// -- Department Configuration --

export const DepartmentConfigSchema = z.object({
  /** Environment variables injected into all agent processes */
  env_vars: z.record(z.string(), z.string()).default({}),

  /** Git authentication (used by git-manager for clone/push) */
  git_auth: z
    .object({
      github_token: z.string().optional(),
      gitlab_token: z.string().optional(),
      gitlab_instance_url: z.string().optional(),
      /** Platform integration ID used to refresh tokens (stored for token refresh) */
      platform_integration_id: z.string().optional(),
    })
    .default({}),

  /** Owner user ID — stored so the frontDesk can mint JWTs without a workstation config */
  owner_user_id: z.string().optional(),

  /** Department ownership type */
  owner_type: z.enum(['user', 'org']).optional().default('user'),
  /** Owner identifier — userId when owner_type='user', orgId when owner_type='org' */
  owner_id: z.string().optional(),
  /** The userId who originally created this department (for audit trail in org departments) */
  created_by_user_id: z.string().optional(),
  /** Organization ID — set when owner_type='org', convenience alias for owner_id */
  organization_id: z.string().optional(),

  /** Kilo API token for LLM gateway authentication */
  kilocode_token: z.string().optional(),

  /** Default LLM model for new agent sessions */
  default_model: z.string().optional(),

  /** Per-role model overrides. When set, the specified role uses this model
   *  instead of default_model. */
  role_models: z
    .object({
      frontDesk: z.string().optional(),
      qualityAssurance: z.string().optional(),
      soul: z.string().optional(),
    })
    .optional(),

  /** Lightweight model for title generation, explore subagent, etc. */
  small_model: z.string().optional(),

  /** Maximum concurrent souls per workstation */
  max_souls_per_workstation: z.number().int().min(1).max(50).optional(),

  /**
   * department-level merge strategy. Workstations inherit this when they don't set their own.
   * - 'direct': QualityAssurance pushes directly to main (no PR)
   * - 'pr': QualityAssurance creates a GitHub PR / GitLab MR for human review
   *
   * NOTE: new departments are seeded with 'pr' by seedNewDepartmentConfig(); the schema
   * default below is preserved at 'direct' so existing persisted configs
   * that never specified a merge_strategy keep their historical behavior.
   */
  merge_strategy: MergeStrategy.default('direct'),

  /** QualityAssurance configuration */
  qualityAssurance: z
    .object({
      gates: z.array(z.string()).default([]),
      auto_merge: z.boolean().default(true),
      require_clean_merge: z.boolean().default(true),
      /** When enabled, the qualityAssurance agent reviews code (runs gates, checks
       *  the diff). When disabled, the qualityAssurance is completely skipped —
       *  MR tickets go straight to poll_pr for auto-merge/auto-resolve. */
      code_review: z.boolean().default(true),
      /** Controls how the qualityAssurance communicates review findings:
       *  - 'rework': creates internal rework tickets via gt_request_changes (default)
       *  - 'comments': posts GitHub review comments on the PR (requires merge_strategy: 'pr') */
      review_mode: z.enum(['rework', 'comments']).default('rework'),
      /** When enabled, a soul is automatically dispatched to address
       *  unresolved review comments and failing CI checks on open PRs. */
      auto_resolve_pr_feedback: z.boolean().default(false),
      /** When enabled, a soul is automatically dispatched to rebase and
       *  resolve merge conflicts on open PRs. */
      auto_resolve_merge_conflicts: z.boolean().default(true).optional(),
      /** After all CI checks pass and all review threads are resolved,
       *  automatically merge the PR after this many minutes.
       *  0 = immediate, null = disabled (require manual merge). */
      auto_merge_delay_minutes: z.number().int().min(0).nullable().default(null),
    })
    .optional(),

  /** Alarm interval when agents are active (seconds) */
  alarm_interval_active: z.number().int().min(5).max(600).optional(),

  /** Alarm interval when idle (seconds) */
  alarm_interval_idle: z.number().int().min(30).max(3600).optional(),

  /** Container settings */
  container: z
    .object({
      sleep_after_minutes: z.number().int().min(5).max(120).optional(),
    })
    .optional(),

  /** When true, all shifts are created as staged by default (agents not dispatched until started).
   *  New departments are seeded with `true` via seedNewDepartmentConfig(); existing
   *  persisted configs that never specified this key fall back to `false`. */
  staged_shifts_default: z.boolean().default(false),

  /** Default merge mode for new shifts.
   *  - 'review-then-land': tickets merge into a shift feature branch, then a single landing PR is created (default)
   *  - 'review-and-merge': each ticket gets its own PR directly to the target branch */
  shift_merge_mode: z.enum(['review-then-land', 'review-and-merge']).default('review-then-land'),

  /** GitHub PAT used exclusively for `gh` CLI operations (PRs, issues, etc.).
   *  Git clone/push still uses the integration token from git_auth. */
  github_cli_pat: z.string().optional(),

  /** Custom git commit author name. When set, the user becomes the primary author
   *  and the AI agent is added as co-author (unless disable_ai_coauthor is true). */
  git_author_name: z.string().optional(),

  /** Custom git commit author email. Used alongside git_author_name. */
  git_author_email: z.string().optional(),

  /** When true, AI agent co-authorship trailer is omitted from commits.
   *  Only takes effect when git_author_name is set. */
  disable_ai_coauthor: z.boolean().default(false),

  /** Per-role custom instructions appended to the agent's system prompt. */
  custom_instructions: z
    .object({
      soul: z.string().max(2000).optional(),
      qualityAssurance: z.string().max(2000).optional(),
      frontDesk: z.string().max(2000).optional(),
    })
    .optional(),
});

export type DepartmentConfig = z.infer<typeof DepartmentConfigSchema>;

// -- Workstation Override Configuration --

export const WorkstationOverrideConfigSchema = z.object({
  // Model overrides (override departmentConfig.default_model / role_models)
  default_model: z.string().optional(),
  role_models: z
    .object({
      soul: z.string().optional(),
      qualityAssurance: z.string().optional(),
    })
    .optional(),

  // Review behavior
  review_mode: z.enum(['rework', 'comments']).optional(),
  /** false = skip qualityAssurance entirely */
  code_review: z.boolean().optional(),
  auto_resolve_pr_feedback: z.boolean().optional(),
  auto_resolve_merge_conflicts: z.boolean().optional(),
  auto_merge_delay_minutes: z.number().int().min(0).nullable().optional(),

  // Merge strategy
  merge_strategy: z.enum(['direct', 'pr']).optional(),
  shift_merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),

  // Custom instructions
  custom_instructions: z
    .object({
      soul: z.string().optional(),
      qualityAssurance: z.string().optional(),
    })
    .optional(),

  // Git
  git_push_flags: z.string().optional(),

  // Agent limits
  max_concurrent_souls: z.number().int().positive().optional(),
  max_dispatch_attempts: z.number().int().positive().optional(),
});

export type WorkstationOverrideConfig = z.infer<typeof WorkstationOverrideConfigSchema>;

/**
 * Partial update schema — all fields optional, NO defaults.
 * DepartmentConfigSchema.partial() can't be used here because Zod still fires
 * .default() during parsing, injecting phantom values (e.g. merge_strategy:
 * 'direct') that overwrite existing config on partial updates.
 */
export const DepartmentConfigUpdateSchema = z.object({
  env_vars: z.record(z.string(), z.string()).optional(),
  git_auth: z
    .object({
      github_token: z.string().optional(),
      gitlab_token: z.string().optional(),
      gitlab_instance_url: z.string().optional(),
      platform_integration_id: z.string().optional(),
    })
    .optional(),
  owner_user_id: z.string().optional(),
  owner_type: z.enum(['user', 'org']).optional(),
  owner_id: z.string().optional(),
  created_by_user_id: z.string().optional(),
  organization_id: z.string().optional(),
  kilocode_token: z.string().optional(),
  default_model: z.string().optional(),
  role_models: z
    .object({
      frontDesk: z.string().optional(),
      qualityAssurance: z.string().optional(),
      soul: z.string().optional(),
    })
    .optional(),
  small_model: z.string().optional(),
  max_souls_per_workstation: z.number().int().min(1).max(50).optional(),
  merge_strategy: MergeStrategy.optional(),
  qualityAssurance: z
    .object({
      gates: z.array(z.string()).optional(),
      auto_merge: z.boolean().optional(),
      require_clean_merge: z.boolean().optional(),
      code_review: z.boolean().optional(),
      review_mode: z.enum(['rework', 'comments']).optional(),
      auto_resolve_pr_feedback: z.boolean().optional(),
      auto_resolve_merge_conflicts: z.boolean().optional(),
      auto_merge_delay_minutes: z.number().int().min(0).nullable().optional(),
    })
    .optional(),
  alarm_interval_active: z.number().int().min(5).max(600).optional(),
  alarm_interval_idle: z.number().int().min(30).max(3600).optional(),
  container: z
    .object({
      sleep_after_minutes: z.number().int().min(5).max(120).optional(),
    })
    .optional(),
  staged_shifts_default: z.boolean().optional(),
  shift_merge_mode: z.enum(['review-then-land', 'review-and-merge']).optional(),
  github_cli_pat: z.string().optional(),
  git_author_name: z.string().optional(),
  git_author_email: z.string().optional(),
  disable_ai_coauthor: z.boolean().optional(),
  custom_instructions: z
    .object({
      soul: z.string().max(2000).optional(),
      qualityAssurance: z.string().max(2000).optional(),
      frontDesk: z.string().max(2000).optional(),
    })
    .optional(),
});
export type DepartmentConfigUpdate = z.infer<typeof DepartmentConfigUpdateSchema>;

/** Agent-level config overrides (merged on top of department config) */
export const AgentConfigOverridesSchema = z.object({
  env_vars: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
});
export type AgentConfigOverrides = z.infer<typeof AgentConfigOverridesSchema>;

// -- UI Actions (frontDesk → dashboard WebSocket commands) --

export const UiActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_ticket_drawer'),
    ticketId: z.string().min(1),
    workstationId: z.string().min(1),
  }),
  z.object({
    type: z.literal('open_shift_drawer'),
    shiftId: z.string().min(1),
    departmentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('open_agent_drawer'),
    agentId: z.string().min(1),
    workstationId: z.string().min(1),
    departmentId: z.string().min(1),
  }),
  z.object({
    type: z.literal('navigate'),
    page: z.enum(['department-overview', 'tickets', 'agents', 'workstations', 'settings']),
  }),
  z.object({
    type: z.literal('highlight_Ticket'),
    ticketId: z.string().min(1),
    workstationId: z.string().min(1),
  }),
]);
export type UiAction = z.infer<typeof UiActionSchema>;

/**
 * Overwrite any `departmentId` field in the action with the route-scoped departmentId
 * so callers can't reference resources outside the authenticated department.
 */
export function normalizeUiAction(action: UiAction, departmentId: string): UiAction {
  if ('departmentId' in action) {
    return { ...action, departmentId };
  }
  return action;
}

/** Extract the workstationId from a UI action, if present. */
export function uiActionWorkstationId(action: UiAction): string | null {
  if ('workstationId' in action) return action.workstationId;
  return null;
}

// Re-export satellite metadata types for convenience
export type { AgentMetadataRecord } from './db/tables/agent-metadata.table';
export type { ReviewMetadataRecord } from './db/tables/review-metadata.table';
export type { EscalationMetadataRecord } from './db/tables/escalation-metadata.table';
export type { ShiftMetadataRecord, ShiftMergeMode } from './db/tables/shift-metadata.table';
export type { TicketEventRecord } from './db/tables/ticket-events.table';
export type { TicketDependencyRecord } from './db/tables/ticket-dependencies.table';
