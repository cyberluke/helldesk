/**
 * @/lib/trpc/utils.ts — useTRPC() adapter for the federated HELLDESK UI.
 *
 * The original client components call `useTRPC()` and consume
 * `trpc.helldesk.<proc>.queryOptions(input)` / `.mutationOptions(opts)` /
 * `.queryKey(input)`. Here we back that exact TanStack-Query-v5 surface with
 * the local transport (transport.ts) mapped onto the NAI-Lattice/local-live
 * runtime.
 *
 * This is a shim for the cloud monorepo's `@/lib/trpc/utils` in the original
 * HELLDESK UI: it reuses the identical procedural API so the verbatim client
 * pages/components need no edits.
 */
import { useMemo } from 'react';
import { api, setWorkstationDepartmentIndex, type Department, type Workstation, type LooseTicket, type LooseAgent, type DepartmentEvent, type DepartmentConfig } from './transport';

export type { Department, Workstation, LooseTicket as Ticket, LooseAgent as Agent, DepartmentEvent, DepartmentConfig };

// ── Query/mutation option builders ──────────────────────────────────────────
// Lean re-implementation of the tRPC + TanStack v5 `queryOptions` shape used by
// the original client. Each proc is a plain function object with the three
// accessors the components rely on. Because react-query v5's `queryOptions`
// takes a plain object, we build those objects directly.

function qOpts<T>(queryKey: unknown[], fn: () => Promise<T>) {
  return {
    queryKey,
    queryFn: (): Promise<T> => fn(),
  };
}

// ---- workstationId → departmentId hydration -------------------------------------------------
// Original tRPC procs key workstation work by workstationId only; local-live routes need the
// departmentId too. We cache the mapping (departments → workstations) lazily and default to
// 'default' when unknown, then refresh the map whenever departments/workstations load.
let workstationDepartmentIndex: Record<string, string> = {};
export function indexWorkstationDepartments(departments: Department[], workstationsByDepartment: Record<string, Workstation[]>): void {
  const next: Record<string, string> = {};
  for (const t of departments) {
    for (const r of workstationsByDepartment[t.id] ?? []) next[r.id] = t.id;
  }
  workstationDepartmentIndex = next;
  setWorkstationDepartmentIndex(next);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unused = workstationDepartmentIndex;

export function useTRPC(): {
  helldesk: Record<string, unknown>;
  cloudAgent: Record<string, unknown>;
} {
  return useMemo(() => {
    // Namespace objects are assembled by name so the typing stays permissive
    // enough for the original components' `inferRouterOutputs`-driven access.
    const helldesk: Record<string, unknown> = {
      listDepartments: withQueryAndMutate(() => api.listDepartments(), []),
      getDepartment: withInput('getDepartment', (i) => api.getDepartment(i.departmentId)),
      listWorkstations: withInput('listWorkstations', (i) => api.listWorkstations(i.departmentId)),
      getWorkstation: withInput('getWorkstation', (i) => api.getWorkstation(i.workstationId)),
      listTickets: withInput('listTickets', (i) => api.listTickets(i.departmentId ?? 'default', i.workstationId)),
      createTicket: withInput('createTicket', (i) => api.createTicket(i.departmentId ?? 'default', i.workstationId, i)),
      sling: withInput('sling', (i) => api.sling(i.departmentId ?? 'default', i.workstationId, i)),
      deleteTicket: withInput('deleteTicket', (i) => api.deleteTicket(i.departmentId ?? 'default', i.workstationId, i.ticketId)),
      updateTicketStatus: withInput('updateTicketStatus', (i) => api.updateTicketStatus(i.departmentId ?? 'default', i.workstationId, i.ticketId, i.status)),
      listAgents: withInput('listAgents', (i) => api.listAgents(i.departmentId ?? 'default', i.workstationId)),
      createAgent: withInput('createAgent', (i) => api.createAgent(i.departmentId ?? 'default', i.workstationId, { role: i.role, name: i.name, identity: i.identity })),
      deleteAgent: withInput('deleteAgent', (i) => api.deleteAgent(i.departmentId ?? 'default', i.workstationId, i.agentId)),
      getDepartmentEvents: withInput('getDepartmentEvents', (i) => api.listDepartmentEvents(i.departmentId, { limit: i.limit })),
      getTicketEvents: withInput('getTicketEvents', (i) => api.listTicketEvents(i.departmentId ?? 'default', i.workstationId, { ticketId: i.ticketId })),
      getDepartmentConfig: withInput('getDepartmentConfig', (i) => api.getDepartmentConfig(i.departmentId)),
      updateDepartmentConfig: withInput('updateDepartmentConfig', (i) => api.updateDepartmentConfig(i.departmentId, i.config)),
      createDepartment: withInput('createDepartment', (i) => api.createDepartment(i.name)),
      deleteDepartment: withInput('deleteDepartment', (i) => api.deleteDepartment(i.departmentId)),
      createWorkstation: withInput('createWorkstation', (i) => api.createWorkstation(i.departmentId, { name: i.name, git_url: i.gitUrl, default_branch: i.defaultBranch })),
      deleteWorkstation: withInput('deleteWorkstation', (i) => api.deleteWorkstation(i.departmentId, i.workstationId)),
      // FrontDesk/stream/pty surfaces — routed to the REAL local frontDesk + native-pty
      // REST backend (full parity: ensure creates the PTY, status yields a
      // session, createPtySession returns a live WebSocket URL).
      ensureFrontDesk: withInput('ensureFrontDesk', (i) => api.ensureFrontDesk(i.departmentId)),
      getFrontDeskStatus: withInput('getFrontDeskStatus', (i) => api.getFrontDeskStatus(i.departmentId)),
      getAgentStreamUrl: withInput('getAgentStreamUrl', async () => ({ url: '', ticket: undefined })),
      createPtySession: withInput('createPtySession', (i) => api.createPtySession(i.departmentId, i.agentId)),
      resizePtySession: withInput('resizePtySession', (i) => api.resizePtySession(i.departmentId, i.agentId, i.ptyId, i.cols, i.rows)),
      sendFrontDeskMessage: withInput('sendFrontDeskMessage', (i) => api.sendFrontDeskMessage(i.departmentId, i.message)),
    };

    const cloudAgent: Record<string, unknown> = {
      listGitHubRepositories: withInput('listGitHubRepositories', async () => ({ repositories: [], instanceUrl: '' })),
      listGitLabRepositories: withInput('listGitLabRepositories', async () => ({ repositories: [], instanceUrl: '' })),
    };

    return { helldesk, cloudAgent };
  }, []);
}

/**
 * Build a procedure object exposing `.queryOptions(input)`, `.mutationOptions(opts)`
 * and `.queryKey(input)` — matching the shape the original client components call.
 */
function withInput(name: string, run: (input: any) => Promise<any>): any {
  return {
    queryOptions: (input: any) => ({
      queryKey: ['helldesk', name, input ?? {}],
      queryFn: () => run(input ?? {}),
    }),
    mutationOptions: (opts?: any) => ({
      mutationFn: (input: any) => run(input ?? {}),
      ...(opts ?? {}),
    }),
    queryKey: (input: any) => ['helldesk', name, input ?? {}],
    useQuery: (input: any) => ({ queryKey: ['helldesk', name, input ?? {}], queryFn: () => run(input ?? {}) }),
    useMutation: (opts?: any) => ({ mutationFn: (input: any) => run(input ?? {}), ...(opts ?? {}) }),
  };
}

/** No-input proc (listDepartments). */
function withQueryAndMutate(run: () => Promise<any>, _k: unknown[]): any {
  return {
    queryOptions: () => ({ queryKey: ['helldesk', 'listDepartments', {}], queryFn: () => run() }),
    mutationOptions: (opts?: any) => ({ mutationFn: () => run(), ...(opts ?? {}) }),
    queryKey: () => ['helldesk', 'listDepartments', {}],
  };
}