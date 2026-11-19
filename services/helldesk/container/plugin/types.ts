// Types mirroring the Department DO domain model.
// These are the API response shapes — the plugin never touches SQLite directly.

export type TicketStatus = 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed';
export type TicketType =
  | 'issue'
  | 'message'
  | 'escalation'
  | 'merge_request'
  | 'shift'
  | 'TicketCase'
  | 'agent';
export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';

export type Ticket = {
  ticket_id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
  body: string | null;
  workstation_id: string | null;
  parent_ticket_id: string | null;
  assignee_agent_ticket_id: string | null;
  priority: TicketPriority;
  labels: string[];
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type AgentRole = 'soul' | 'qualityAssurance' | 'frontDesk';
export type AgentStatus = 'idle' | 'working' | 'stalled' | 'dead';

export type Agent = {
  id: string;
  workstation_id: string | null;
  role: AgentRole;
  name: string;
  identity: string;
  status: AgentStatus;
  current_hook_ticket_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  checkpoint: unknown | null;
  created_at: string;
};

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

export type PrimeContext = {
  agent: Agent;
  hooked_Ticket: Ticket | null;
  undelivered_memo: Memo[];
  open_tickets: Ticket[];
};

export type ApiSuccess<T> = { success: true; data: T };
export type ApiError = { success: false; error: string };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// Workstation metadata (from HelldeskUserDO)
export type Workstation = {
  id: string;
  department_id: string;
  name: string;
  git_url: string;
  default_branch: string;
  created_at: string;
  updated_at: string;
};

export type SlingResult = {
  ticket: Ticket;
  agent: Agent;
};

// agent is null for staged shifts (agents aren't assigned until gt_shift_start)
export type SlingBatchResult = {
  shift: Shift;
  tickets: Array<{ ticket: Ticket; agent: Agent | null }>;
};

// HELLDESK origin tag carried on tickets created in response to a wanted-item event.
// Mirrors `HelldeskTicketOrigin` in services/helldesk/src/dos/department/helldesk-ticket-origin.ts.
export type HelldeskOrigin = {
  kind: 'wanted-item-claim';
  helldesk_id: string;
  item_id: string;
  pull_id?: string | null;
  source_url?: string | null;
};

// Result of POST /helldesk/claim — returned to gt_helldesk_claim so the
// frontDesk has everything it needs to plan the work without a second round-trip.
export type HelldeskClaimResult = {
  claim: { success: true; pr_url: string | null };
  /** The full wanted-item row from the upstream board, or null if not found. */
  item: Record<string, unknown> | null;
  planning: {
    /** Origin tag the frontDesk MUST attach to whatever tickets it creates next. */
    helldesk_origin: HelldeskOrigin;
    /** A local workstation_id the frontDesk should consider scoping the work to. May be null. */
    suggested_workstation_id: string | null;
  };
};

// Staging is tracked by the `staged` boolean, not the status field.
// status tracks the shift lifecycle: active (in progress) or landed (complete).
export type Shift = {
  id: string;
  title: string;
  status: 'active' | 'landed';
  staged: boolean;
  total_tickets: number;
  closed_tickets: number;
  created_by: string | null;
  created_at: string;
  landed_at: string | null;
};

// Result returned by POST /shifts/:id/start
export type ShiftStartResult = {
  shift: Shift;
  tickets: Array<{ ticket: Ticket; agent: Agent }>;
};

export type ShiftDetail = Shift & {
  tickets: Array<{
    ticket_id: string;
    title: string;
    status: TicketStatus;
    workstation_id: string | null;
    assignee_agent_name: string | null;
  }>;
};

// UI Action — commands the frontDesk can send to control the user's dashboard
export type UiActionInput =
  | { type: 'open_ticket_drawer'; ticketId: string; workstationId: string }
  | { type: 'open_shift_drawer'; shiftId: string; departmentId: string }
  | { type: 'open_agent_drawer'; agentId: string; workstationId: string; departmentId: string }
  | { type: 'navigate'; page: 'department-overview' | 'tickets' | 'agents' | 'workstations' | 'settings' }
  | { type: 'highlight_Ticket'; ticketId: string; workstationId: string };

// Environment variable config for the plugin (workstation-scoped agents)
export type HelldeskEnv = {
  apiUrl: string;
  /** Container-scoped JWT (shared by all agents, refreshed by alarm). */
  containerToken?: string;
  /** Legacy per-agent JWT (8h expiry) — fallback during rollout. */
  sessionToken: string;
  agentId: string;
  workstationId: string;
  departmentId: string;
};

// Environment variable config for the frontDesk (department-scoped)
export type FrontDeskHelldeskEnv = {
  apiUrl: string;
  /** Container-scoped JWT (shared by all agents, refreshed by alarm). */
  containerToken?: string;
  /** Legacy per-agent JWT (8h expiry) — fallback during rollout. */
  sessionToken: string;
  agentId: string;
  departmentId: string;
};
