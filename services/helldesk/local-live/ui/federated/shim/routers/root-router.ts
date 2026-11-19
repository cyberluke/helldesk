/**
 * @/routers/root-router — type shim.
 *
 * The original client components use `inferRouterOutputs<RootRouter>['helldesk'][...]`
 * purely for typing. We expose a structural type with the same procedure names the
 * components read. This is a type-only module (no runtime surface needed).
 */

export type Department = { id: string; name: string; created_at: string; updated_at: string };
export type Workstation = { id: string; department_id: string; name: string; git_url: string; default_branch: string; created_at: string; updated_at: string };
export type Ticket = {
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  body: string | null;
  workstation_id: string | null;
  parent_ticket_id: string | null;
  assignee_agent_ticket_id: string | null;
  priority: string;
  labels: string[];
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};
export type Agent = {
  id: string;
  workstation_id: string | null;
  role: string;
  name: string;
  identity: string;
  status: string;
  current_hook_ticket_id: string | null;
  dispatch_attempts: number;
  last_activity_at: string | null;
  checkpoint?: unknown;
  created_at: string;
};
export type DepartmentEvent = {
  ticket_event_id: string;
  ticket_id: string;
  agent_id: string | null;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  workstation_id?: string;
  workstation_name?: string;
};
export type TicketEvent = DepartmentEvent;
export type DepartmentConfig = {
  env_vars: Record<string, string>;
  git_auth: { github_token?: string; gitlab_token?: string; gitlab_instance_url?: string; platform_integration_id?: string };
  default_model?: string;
  max_polecats_per_workstation?: number;
  qualityAssurance?: { gates: string[]; auto_merge: boolean; require_clean_merge: boolean };
};

/** Structural router type: `helldesk` and `cloudAgent` sub routers. */
export type RootRouter = {
  helldesk: {
    listDepartments: { input: void; output: Department[] };
    getDepartment: { input: { departmentId: string }; output: Department };
    listWorkstations: { input: { departmentId: string }; output: Workstation[] };
    getWorkstation: { input: { workstationId: string }; output: Workstation };
    listTickets: { input: { workstationId: string; departmentId?: string }; output: Ticket[] };
    createTicket: { input: { departmentId?: string; workstationId: string; type: string; title: string }; output: Ticket };
    sling: { input: { departmentId?: string; workstationId: string; title: string; body?: string }; output: { ticket: Ticket; agent: Agent } };
    deleteTicket: { input: { departmentId?: string; workstationId: string; ticketId: string }; output: void };
    listAgents: { input: { workstationId: string; departmentId?: string }; output: Agent[] };
    deleteAgent: { input: { departmentId?: string; workstationId: string; agentId: string }; output: void };
    getDepartmentEvents: { input: { departmentId: string; limit?: number }; output: DepartmentEvent[] };
    getTicketEvents: { input: { departmentId?: string; workstationId: string; ticketId?: string }; output: TicketEvent[] };
    getDepartmentConfig: { input: { departmentId: string }; output: DepartmentConfig };
    updateDepartmentConfig: { input: { departmentId: string; config: Partial<DepartmentConfig> }; output: DepartmentConfig };
    createDepartment: { input: { name: string }; output: Department };
    deleteDepartment: { input: { departmentId: string }; output: void };
    createWorkstation: { input: { departmentId: string; name: string; gitUrl: string; defaultBranch: string }; output: Workstation };
    deleteWorkstation: { input: { departmentId: string; workstationId: string }; output: void };
    ensureFrontDesk: { input: { departmentId: string }; output: { agentId: string; sessionStatus: string } };
    getFrontDeskStatus: { input: { departmentId: string }; output: { configured: boolean; session: null | { agentId: string; sessionId: string; status: string; lastActivityAt: string }; departmentId: string | null } };
    getAgentStreamUrl: { input: { departmentId: string; agentId: string }; output: { url: string; ticket?: string } };
    createPtySession: { input: { departmentId: string; agentId: string }; output: { pty: { id: string; wsUrl: string } } };
    resizePtySession: { input: { departmentId: string; agentId: string; ptyId: string; cols: number; rows: number }; output: void };
    sendFrontDeskMessage: { input: { departmentId: string; message: string; model?: string }; output: { agentId: string; sessionStatus: string } };
  };
  cloudAgent: {
    listGitHubRepositories: { input: { forceRefresh?: boolean }; output: { repositories: { id: string; fullName: string; private: boolean }[]; instanceUrl?: string } };
    listGitLabRepositories: { input: { forceRefresh?: boolean }; output: { repositories: { id: string; fullName: string; private: boolean }[]; instanceUrl?: string } };
  };
};