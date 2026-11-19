import type {
  Agent,
  ApiResponse,
  Ticket,
  TicketPriority,
  TicketStatus,
  TicketType,
  Shift,
  ShiftDetail,
  ShiftStartResult,
  HelldeskEnv,
  Memo,
  FrontDeskHelldeskEnv,
  PrimeContext,
  Workstation,
  SlingBatchResult,
  SlingResult,
  UiActionInput,
  HelldeskClaimResult,
} from './types';

function isApiResponse(
  value: unknown
): value is { success: boolean; error?: string; data?: unknown } {
  if (typeof value !== 'object' || value === null || !('success' in value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.success === 'boolean';
}

/**
 * One-shot refresh of `process.env.HELLDESK_CONTAINER_TOKEN` via the
 * worker's `/refresh-container-token` endpoint. Returns the fresh
 * token on success, or null on any failure (network error, non-2xx,
 * missing env). Used by the plugin clients to recover from a 401
 * caused by an expired container JWT.
 *
 * Duplicates the container/src/token-refresh.ts helper to keep the
 * plugin independent of the control-server bundle.
 */
async function refreshContainerTokenFromWorker(baseUrl: string): Promise<string | null> {
  const current = process.env.HELLDESK_CONTAINER_TOKEN;
  const departmentId = process.env.HELLDESK_DEPARTMENT_ID;
  if (!current || !departmentId) return null;
  try {
    const resp = await fetch(`${baseUrl}/api/departments/${departmentId}/refresh-container-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${current}`,
      },
      body: '{}',
    });
    if (!resp.ok) return null;
    const body: unknown = await resp.json();
    const token =
      body && typeof body === 'object' && 'data' in body
        ? (body as { data?: { token?: unknown } }).data?.token
        : undefined;
    if (typeof token !== 'string' || token.length === 0) return null;
    process.env.HELLDESK_CONTAINER_TOKEN = token;
    return token;
  } catch {
    return null;
  }
}

export class HelldeskClient {
  private baseUrl: string;
  private containerToken: string | undefined;
  private token: string;
  private agentId: string;
  private workstationId: string;
  private departmentId: string;
  constructor(env: HelldeskEnv) {
    this.baseUrl = env.apiUrl.replace(/\/+$/, '');
    this.containerToken = env.containerToken;
    this.token = env.sessionToken;
    this.agentId = env.agentId;
    this.workstationId = env.workstationId;
    this.departmentId = env.departmentId;
  }

  private workstationPath(path: string): string {
    return `${this.baseUrl}/api/departments/${this.departmentId}/workstations/${this.workstationId}${path}`;
  }

  private agentPath(path: string): string {
    return this.workstationPath(`/agents/${this.agentId}${path}`);
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      // Normalize headers so callers can pass plain objects, Headers instances, or tuples.
      // Rebuilt on every attempt so a refreshed token is picked up on retry.
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      // Prefer the live container token from process.env (refreshed by the
      // DepartmentDO alarm via POST /refresh-token or by refreshContainerTokenFromWorker),
      // then the token captured at init, then the legacy per-agent JWT.
      const authToken = process.env.HELLDESK_CONTAINER_TOKEN ?? this.containerToken ?? this.token;
      headers.set('Authorization', `Bearer ${authToken}`);
      // When using a container-scoped JWT, send agent identity headers so
      // the auth middleware can populate agentId/workstationId on routes that don't
      // have :agentId/:workstationId params (e.g. /triage/resolve, /memo).
      if (process.env.HELLDESK_CONTAINER_TOKEN || this.containerToken) {
        headers.set('X-helldesk-Agent-Id', this.agentId);
        headers.set('X-helldesk-workstation-Id', this.workstationId);
      }
      return fetch(url, { ...init, headers });
    };

    let response: Response;
    try {
      response = await doFetch();
      // One-shot token refresh on 401: the running kilo serve child was
      // spawned with a snapshot of env and doesn't see live updates to
      // process.env. When the parent receives a 401, mint a fresh token
      // via the worker and retry once.
      if (response.status === 401) {
        const fresh = await refreshContainerTokenFromWorker(this.baseUrl);
        if (fresh) {
          response = await doFetch();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HelldeskApiError(`Network error: ${message}`, 0);
    }

    // 204 No Content — nothing to parse, return early
    if (response.status === 204) {
      return undefined as T;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HelldeskApiError(`Invalid JSON response (HTTP ${response.status})`, response.status);
    }

    if (!isApiResponse(body)) {
      throw new HelldeskApiError(
        `Unexpected response shape (HTTP ${response.status})`,
        response.status
      );
    }

    if (!body.success) {
      const errorMsg =
        'error' in body && typeof body.error === 'string' ? body.error : 'Unknown error';
      throw new HelldeskApiError(errorMsg, response.status);
    }

    return ('data' in body ? body.data : undefined) as T;
  }

  async prime(): Promise<PrimeContext> {
    return this.request<PrimeContext>(this.agentPath('/prime'));
  }

  async done(input: { branch: string; pr_url?: string; summary?: string }): Promise<void> {
    await this.request<void>(this.agentPath('/done'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async requestChanges(input: {
    feedback: string;
    files?: string[];
  }): Promise<{ rework_ticket_id: string }> {
    return this.request<{ rework_ticket_id: string }>(this.agentPath('/request-changes'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async checkMemo(): Promise<Memo[]> {
    return this.request<Memo[]>(this.agentPath('/memo'));
  }

  async writeCheckpoint(data: unknown): Promise<void> {
    await this.request<void>(this.agentPath('/checkpoint'), {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  async updateAgentStatusMessage(message: string): Promise<void> {
    await this.request<void>(this.agentPath('/status'), {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async getTicket(ticketId: string): Promise<Ticket> {
    return this.request<Ticket>(this.workstationPath(`/tickets/${ticketId}`));
  }

  async closeTicket(ticketId: string): Promise<Ticket> {
    return this.request<Ticket>(this.workstationPath(`/tickets/${ticketId}/close`), {
      method: 'POST',
      body: JSON.stringify({ agent_id: this.agentId }),
    });
  }

  async sendMemo(input: { to_agent_id: string; subject: string; body: string }): Promise<void> {
    await this.request<void>(this.workstationPath('/memo'), {
      method: 'POST',
      body: JSON.stringify({
        from_agent_id: this.agentId,
        ...input,
      }),
    });
  }

  async nudge(input: {
    target_agent_id: string;
    message: string;
    mode: 'wait-idle' | 'immediate' | 'queue';
  }): Promise<{ nudge_id: string }> {
    return this.request<{ nudge_id: string }>(this.workstationPath('/nudge'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async createEscalation(input: {
    title: string;
    body?: string;
    priority?: TicketPriority;
    metadata?: Record<string, unknown>;
  }): Promise<Ticket> {
    return this.request<Ticket>(this.workstationPath('/escalations'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getTicketCaseCurrentStep(): Promise<{
    TicketCaseId: string;
    currentStep: number;
    totalSteps: number;
    step: { title: string; instructions: string };
    status: string;
  } | null> {
    try {
      return await this.request(this.workstationPath(`/agents/${this.agentId}/TicketCase/current`));
    } catch (err) {
      if (err instanceof HelldeskApiError && err.status === 404) return null;
      throw err;
    }
  }

  async advanceTicketCaseStep(summary: string): Promise<{
    TicketCaseId: string;
    previousStep: number;
    currentStep: number;
    totalSteps: number;
    completed: boolean;
  }> {
    return this.request(this.workstationPath(`/agents/${this.agentId}/TicketCase/advance`), {
      method: 'POST',
      body: JSON.stringify({ summary }),
    });
  }

  /**
   * Resolve a triage_request ticket with the chosen action and notes.
   * The DepartmentDO closes the triage request and executes any side effects.
   */
  async resolveTriage(input: {
    triage_request_ticket_id: string;
    action: string;
    resolution_notes: string;
  }): Promise<Ticket> {
    return this.request<Ticket>(this.workstationPath('/triage/resolve'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}

/**
 * front-desk-scoped client for department-level cross-workstation operations.
 * Uses `/api/frontDesk/:departmentId/tools/*` routes authenticated via container secret or JWT.
 */
export class FrontDeskHelldeskClient {
  private baseUrl: string;
  private containerToken: string | undefined;
  private token: string;
  private agentId: string;
  private departmentId: string;

  constructor(env: FrontDeskHelldeskEnv) {
    this.baseUrl = env.apiUrl.replace(/\/+$/, '');
    this.containerToken = env.containerToken;
    this.token = env.sessionToken;
    this.agentId = env.agentId;
    this.departmentId = env.departmentId;
  }

  private frontDeskPath(path: string): string {
    return `${this.baseUrl}/api/frontDesk/${this.departmentId}/tools${path}`;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const doFetch = async (): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      // Prefer live container token (refreshed via POST /refresh-token
      // or refreshContainerTokenFromWorker), then init-time token,
      // then legacy per-agent JWT.
      const authToken = process.env.HELLDESK_CONTAINER_TOKEN ?? this.containerToken ?? this.token;
      headers.set('Authorization', `Bearer ${authToken}`);
      if (process.env.HELLDESK_CONTAINER_TOKEN || this.containerToken) {
        headers.set('X-helldesk-Agent-Id', this.agentId);
      }
      return fetch(url, { ...init, headers });
    };

    let response: Response;
    try {
      response = await doFetch();
      if (response.status === 401) {
        const fresh = await refreshContainerTokenFromWorker(this.baseUrl);
        if (fresh) {
          response = await doFetch();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HelldeskApiError(`Network error: ${message}`, 0);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HelldeskApiError(`Invalid JSON response (HTTP ${response.status})`, response.status);
    }

    if (!isApiResponse(body)) {
      throw new HelldeskApiError(
        `Unexpected response shape (HTTP ${response.status})`,
        response.status
      );
    }

    if (!body.success) {
      const errorMsg =
        'error' in body && typeof body.error === 'string' ? body.error : 'Unknown error';
      throw new HelldeskApiError(errorMsg, response.status);
    }

    return ('data' in body ? body.data : undefined) as T;
  }

  async sling(input: {
    workstation_id: string;
    title: string;
    body?: string;
    metadata?: Record<string, unknown>;
    labels?: string[];
  }): Promise<SlingResult> {
    return this.request<SlingResult>(this.frontDeskPath('/sling'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async listWorkstations(): Promise<Workstation[]> {
    return this.request<Workstation[]>(this.frontDeskPath('/workstations'));
  }

  async listTickets(
    workstationId: string,
    filter?: { status?: TicketStatus; type?: TicketType }
  ): Promise<Ticket[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.type) params.set('type', filter.type);
    const qs = params.toString();
    return this.request<Ticket[]>(this.frontDeskPath(`/workstations/${workstationId}/tickets${qs ? `?${qs}` : ''}`));
  }

  async listAgents(workstationId: string): Promise<Agent[]> {
    return this.request<Agent[]>(this.frontDeskPath(`/workstations/${workstationId}/agents`));
  }

  async sendMemo(input: {
    workstation_id: string;
    to_agent_id: string;
    subject: string;
    body: string;
  }): Promise<void> {
    await this.request<void>(this.frontDeskPath('/memo'), {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        from_agent_id: this.agentId,
      }),
    });
  }

  async slingBatch(input: {
    workstation_id: string;
    shift_title: string;
    tasks: Array<{ title: string; body?: string; depends_on?: number[] }>;
    merge_mode?: 'review-then-land' | 'review-and-merge';
    parallel?: boolean;
    staged?: boolean;
    /**
     * Metadata stamped onto BOTH the shift ticket AND every task ticket. Use
     * this to propagate cross-cutting context like the `helldesk` origin
     * tag returned by gt_helldesk_claim so every descendant ticket links
     * back to its source.
     */
    metadata?: Record<string, unknown>;
  }): Promise<SlingBatchResult> {
    return this.request<SlingBatchResult>(this.frontDeskPath('/sling-batch'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async startShift(shiftId: string): Promise<ShiftStartResult> {
    return this.request<ShiftStartResult>(this.frontDeskPath(`/shifts/${shiftId}/start`), {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async nudge(input: {
    workstation_id: string;
    target_agent_id: string;
    message: string;
    mode: 'wait-idle' | 'immediate' | 'queue';
  }): Promise<{ nudge_id: string }> {
    return this.request<{ nudge_id: string }>(
      `${this.baseUrl}/api/departments/${this.departmentId}/workstations/${input.workstation_id}/nudge`,
      {
        method: 'POST',
        body: JSON.stringify({
          target_agent_id: input.target_agent_id,
          message: input.message,
          mode: input.mode,
        }),
      }
    );
  }

  async listShifts(): Promise<Shift[]> {
    return this.request<Shift[]>(this.frontDeskPath('/shifts'));
  }

  async getShiftStatus(shiftId: string): Promise<ShiftDetail> {
    return this.request<ShiftDetail>(this.frontDeskPath(`/shifts/${shiftId}`));
  }

  async updateTicket(
    workstationId: string,
    ticketId: string,
    input: {
      title?: string;
      body?: string;
      status?: 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed';
      priority?: 'low' | 'medium' | 'high' | 'critical';
      labels?: string[];
      depends_on?: string[];
    }
  ): Promise<Ticket> {
    return this.request<Ticket>(this.frontDeskPath(`/workstations/${workstationId}/tickets/${ticketId}`), {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async shiftAddTicket(
    shiftId: string,
    ticketId: string,
    dependsOn?: string[]
  ): Promise<{ total_tickets: number }> {
    return this.request<{ total_tickets: number }>(this.frontDeskPath(`/shifts/${shiftId}/add-ticket`), {
      method: 'POST',
      body: JSON.stringify({ ticket_id: ticketId, depends_on: dependsOn }),
    });
  }

  async shiftRemoveTicket(shiftId: string, ticketId: string): Promise<{ total_tickets: number }> {
    return this.request<{ total_tickets: number }>(
      this.frontDeskPath(`/shifts/${shiftId}/remove-ticket`),
      {
        method: 'POST',
        body: JSON.stringify({ ticket_id: ticketId }),
      }
    );
  }

  async reassignTicket(workstationId: string, ticketId: string, agentId: string): Promise<Ticket> {
    return this.request<Ticket>(this.frontDeskPath(`/workstations/${workstationId}/tickets/${ticketId}/reassign`), {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async deleteTicket(workstationId: string, ticketId: string): Promise<void> {
    await this.request<void>(this.frontDeskPath(`/workstations/${workstationId}/tickets/${ticketId}`), {
      method: 'DELETE',
    });
  }

  async deleteTickets(workstationId: string, ticketIds: string[]): Promise<{ deleted: number }> {
    return this.request<{ deleted: number }>(this.frontDeskPath(`/workstations/${workstationId}/tickets/bulk-delete`), {
      method: 'POST',
      body: JSON.stringify({ ticket_ids: ticketIds }),
    });
  }

  async deleteTicketsByStatus(
    workstationId: string,
    status: 'open' | 'in_progress' | 'in_review' | 'closed' | 'failed',
    type?: string
  ): Promise<{ deleted: number }> {
    return this.request<{ deleted: number }>(
      this.frontDeskPath(`/workstations/${workstationId}/tickets/delete-by-status`),
      {
        method: 'POST',
        body: JSON.stringify({ status, ...(type ? { type } : {}) }),
      }
    );
  }

  async resetAgent(workstationId: string, agentId: string): Promise<void> {
    await this.request<void>(this.frontDeskPath(`/workstations/${workstationId}/agents/${agentId}/reset`), {
      method: 'POST',
    });
  }

  async closeShift(shiftId: string): Promise<void> {
    await this.request<void>(this.frontDeskPath(`/shifts/${shiftId}/close`), {
      method: 'POST',
    });
  }

  async updateShift(
    shiftId: string,
    input: { merge_mode?: 'review-then-land' | 'review-and-merge'; feature_branch?: string }
  ): Promise<void> {
    await this.request<void>(this.frontDeskPath(`/shifts/${shiftId}`), {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async acknowledgeEscalation(escalationId: string): Promise<void> {
    await this.request<void>(this.frontDeskPath(`/escalations/${escalationId}/acknowledge`), {
      method: 'POST',
    });
  }

  async broadcastUiAction(action: UiActionInput): Promise<void> {
    await this.request<void>(this.frontDeskPath('/ui-action'), {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
  }

  // The helldesk is auto-resolved by the worker from the department's connection.

  async helldeskBrowse(input: {
    status?: 'open' | 'claimed' | 'in_review' | 'completed' | 'validated' | 'withdrawn';
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    const qs = params.toString();
    return this.request<Array<Record<string, unknown>>>(
      this.frontDeskPath(`/helldesk/browse${qs ? `?${qs}` : ''}`)
    );
  }

  async helldeskClaim(input: { item_id: string }): Promise<HelldeskClaimResult> {
    return this.request<HelldeskClaimResult>(this.frontDeskPath(`/helldesk/claim`), {
      method: 'POST',
      body: JSON.stringify({ item_id: input.item_id }),
    });
  }

  async helldeskPost(input: {
    title: string;
    description: string;
    priority?: string;
    type?: string;
  }): Promise<{ success: boolean; wantedId: string; pr_url: string | null }> {
    return this.request<{ success: boolean; wantedId: string; pr_url: string | null }>(
      this.frontDeskPath(`/helldesk/post`),
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          description: input.description,
          priority: input.priority,
          type: input.type,
        }),
      }
    );
  }

  async helldeskDone(input: {
    item_id: string;
    evidence: string;
  }): Promise<{ success: boolean; pr_url: string | null }> {
    return this.request<{ success: boolean; pr_url: string | null }>(
      this.frontDeskPath(`/helldesk/done`),
      {
        method: 'POST',
        body: JSON.stringify({ item_id: input.item_id, evidence: input.evidence }),
      }
    );
  }
}

export class HelldeskApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(`HELLDESK API error (${status}): ${message}`);
    this.name = 'HelldeskApiError';
    this.status = status;
  }
}

export function createClientFromEnv(): HelldeskClient {
  const apiUrl = process.env.HELLDESK_API_URL;
  const containerToken = process.env.HELLDESK_CONTAINER_TOKEN;
  const sessionToken = process.env.HELLDESK_SESSION_TOKEN;
  const agentId = process.env.HELLDESK_AGENT_ID;
  const workstationId = process.env.HELLDESK_WORKSTATION_ID;
  const departmentId = process.env.HELLDESK_DEPARTMENT_ID;

  // Require either containerToken or sessionToken (prefer containerToken)
  const hasAuth = containerToken || sessionToken;
  if (!apiUrl || !hasAuth || !agentId || !workstationId || !departmentId) {
    const missing = [
      !apiUrl && 'HELLDESK_API_URL',
      !hasAuth && 'HELLDESK_CONTAINER_TOKEN or HELLDESK_SESSION_TOKEN',
      !agentId && 'HELLDESK_AGENT_ID',
      !workstationId && 'HELLDESK_WORKSTATION_ID',
      !departmentId && 'HELLDESK_DEPARTMENT_ID',
    ].filter(Boolean);
    throw new Error(`Missing required HELLDESK environment variables: ${missing.join(', ')}`);
  }

  return new HelldeskClient({
    apiUrl,
    containerToken: containerToken ?? undefined,
    sessionToken: sessionToken ?? '',
    agentId,
    workstationId,
    departmentId,
  });
}

export function createFrontDeskClientFromEnv(): FrontDeskHelldeskClient {
  const apiUrl = process.env.HELLDESK_API_URL;
  const containerToken = process.env.HELLDESK_CONTAINER_TOKEN;
  const sessionToken = process.env.HELLDESK_SESSION_TOKEN;
  const agentId = process.env.HELLDESK_AGENT_ID;
  const departmentId = process.env.HELLDESK_DEPARTMENT_ID;

  const hasAuth = containerToken || sessionToken;
  if (!apiUrl || !hasAuth || !agentId || !departmentId) {
    const missing = [
      !apiUrl && 'HELLDESK_API_URL',
      !hasAuth && 'HELLDESK_CONTAINER_TOKEN or HELLDESK_SESSION_TOKEN',
      !agentId && 'HELLDESK_AGENT_ID',
      !departmentId && 'HELLDESK_DEPARTMENT_ID',
    ].filter(Boolean);
    throw new Error(`Missing required frontDesk environment variables: ${missing.join(', ')}`);
  }

  return new FrontDeskHelldeskClient({
    apiUrl,
    containerToken: containerToken ?? undefined,
    sessionToken: sessionToken ?? '',
    agentId,
    departmentId,
  });
}
