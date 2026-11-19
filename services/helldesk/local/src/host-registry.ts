import type { Db } from './db';
import { now } from './ids';

/**
 * Global host + session registry for the control plane.
 *
 * One control plane governs many Kilo hosts, each with many sessions and
 * projects. Host identity is the plugin RUNTIME (instanceId), never the PID
 * alone. Sessions are scoped by (host_id, session_id) so the same session id
 * in two different runtimes is not conflated.
 */

export interface HostRecord {
  hostId: string;
  instanceId: string;
  runtimeId?: string;
  pid: number;
  sdkServerUrl?: string;
  workspaceRoots: string[];
  pluginVersion?: string;
  sdkVersion?: string;
  capabilities: string[];
  status: 'connected' | 'idle' | 'disconnected';
  registeredAt: string;
  lastHeartbeatAt: string;
  leaseExpiresAt: string;
  /** True for test/mock hosts (placeholder pid=0, synthetic mock workspace root,
   *  throwaway runtime id) so consumers can tell real VS Code hosts from those
   *  created by the test suites. Derived at read time from the host's shape. */
  isSimulated?: boolean;
}

/** Heuristic: a host is simulated when it looks like a synthetic test fixture —
 *  no real PID and a clearly-mock workspace root (C:/mock/...) or a reserved
 *  throwaway runtime id. Real VS Code plugin hosts always carry pid>0 and real
 *  workspace paths, so they are never misclassified. */
export function isSimulatedHost(h: HostRecord): boolean {
  if (h.pid !== 0) return false;
  if (h.workspaceRoots.length === 0) return false;
  const root = h.workspaceRoots[0] ?? '';
  const mockRoot = /^[a-zA-Z]:[\\/]mock[\\/]/i.test(root) || root.startsWith('C:/mock/');
  if (mockRoot) return true;
  if (h.runtimeId && /^(nv|mock|sim|test)[-_]/i.test(h.runtimeId)) return true;
  if (h.instanceId && /(^|[-_])sim|mock|test/i.test(h.instanceId)) return true;
  return false;
}

function withSimulated(h: HostRecord): HostRecord {
  const isSimulated = isSimulatedHost(h);
  return isSimulated ? { ...h, isSimulated: true } : h;
}

export interface SessionRecord {
  hostId: string;
  sessionId: string;
  workspaceRoot?: string;
  worktreeRoot?: string;
  agentId?: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  status: 'active' | 'idle' | 'disconnected';
  lastEventSequence: number;
  taskEpoch: number;
}

export interface RegisterHostInput {
  instanceId: string;
  runtimeId?: string;
  pid: number;
  sdkServerUrl?: string;
  workspaceRoots?: string[];
  pluginVersion?: string;
  sdkVersion?: string;
  capabilities?: string[];
}

export function registerHost(d: Db, input: RegisterHostInput, leaseSeconds: number): HostRecord {
  const hostId = input.instanceId.startsWith('host_') ? input.instanceId : `host_${input.instanceId}`;
  const exp = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const t = now();
  d.db
    .query(
      `INSERT INTO hosts
         (host_id, instance_id, runtime_id, pid, sdk_server_url, workspace_roots, plugin_version,
          sdk_version, capabilities, status, registered_at, last_heartbeat_at, lease_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,'connected',?,?,?)
       ON CONFLICT(host_id) DO UPDATE SET
         pid=excluded.pid, sdk_server_url=excluded.sdk_server_url,
         workspace_roots=excluded.workspace_roots, runtime_id=excluded.runtime_id,
         status='connected', last_heartbeat_at=excluded.last_heartbeat_at,
         lease_expires_at=excluded.lease_expires_at, disconnected_at=NULL`
    )
    .run(
      hostId,
      input.instanceId,
      input.runtimeId ?? null,
      input.pid,
      input.sdkServerUrl ?? null,
      JSON.stringify(input.workspaceRoots ?? []),
      input.pluginVersion ?? null,
      input.sdkVersion ?? null,
      JSON.stringify(input.capabilities ?? []),
      t,
      t,
      exp
    );
  return getHost(d, hostId)!;
}

export function getHost(d: Db, hostId: string): HostRecord | null {
  const r = d.db
    .query<
      {
        host_id: string; instance_id: string; runtime_id: string | null; pid: number;
        sdk_server_url: string | null; workspace_roots: string; plugin_version: string | null;
        sdk_version: string | null; capabilities: string; status: string; registered_at: string;
        last_heartbeat_at: string; lease_expires_at: string;
      },
      [string]
    >(`SELECT * FROM hosts WHERE host_id=?`)
    .get(hostId);
  if (!r) return null;
  return withSimulated({
    hostId: r.host_id,
    instanceId: r.instance_id,
    runtimeId: r.runtime_id ?? undefined,
    pid: r.pid,
    sdkServerUrl: r.sdk_server_url ?? undefined,
    workspaceRoots: JSON.parse(r.workspace_roots) as string[],
    pluginVersion: r.plugin_version ?? undefined,
    sdkVersion: r.sdk_version ?? undefined,
    capabilities: JSON.parse(r.capabilities) as string[],
    status: r.status as HostRecord['status'],
    registeredAt: r.registered_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    leaseExpiresAt: r.lease_expires_at,
  });
}

export function listHosts(d: Db): HostRecord[] {
  return d.db
    .query<{ host_id: string }, []>(`SELECT host_id FROM hosts ORDER BY registered_at`)
    .all()
    .map((r) => getHost(d, r.host_id)!);
}

/** Real (non-simulated) hosts only — used for observability counts so the two
 *  mock hosts registered by the test suites never mask the true connected state. */
export function listRealHosts(d: Db): HostRecord[] {
  return listHosts(d).filter((h) => !isSimulatedHost(h));
}

/** Renew a host lease. Returns false when the lease already expired (stale host). */
export function heartbeatHost(d: Db, hostId: string, leaseSeconds: number): boolean {
  const exp = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const res = d.db
    .query(`UPDATE hosts SET last_heartbeat_at=?, lease_expires_at=?, status='connected', disconnected_at=NULL WHERE host_id=?`)
    .run(now(), exp, hostId);
  return res.changes === 1;
}

export function heartbeatHostByInstance(d: Db, instanceId: string, leaseSeconds: number): boolean {
  const host = getHostByInstance(d, instanceId);
  if (!host) return false;
  return heartbeatHost(d, host.hostId, leaseSeconds);
}

export function getHostByInstance(d: Db, instanceId: string): HostRecord | null {
  const r = d.db.query<{ host_id: string }, [string]>(`SELECT host_id FROM hosts WHERE instance_id=?`).get(instanceId);
  return r ? getHost(d, r.host_id) : null;
}

export function disconnectHost(d: Db, hostId: string): void {
  d.db
    .query(`UPDATE hosts SET status='disconnected', disconnected_at=? WHERE host_id=?`)
    .run(now(), hostId);
}

/** Recover expired leases: mark hosts disconnected (never cancel active reviews from a live host). */
export function recoverExpiredHostLeases(d: Db): number {
  const nowIso = now();
  const expired = d.db
    .query<{ host_id: string }, [string]>(`SELECT host_id FROM hosts WHERE lease_expires_at < ? AND status='connected'`)
    .all(nowIso);
  for (const h of expired) disconnectHost(d, h.host_id);
  return expired.length;
}

/** Prune stale host rows whose backing process is gone AND which have been
 *  disconnected for at least `minDisconnectedMs`. Never touches connected rows,
 *  live-pid rows, or any review/job evidence. Keeps the registry truthful after
 *  test/crash probes leave dead-pid orphans behind. */
export function pruneStaleHosts(d: Db, minDisconnectedMs = 3 * 60_000): number {
  const cutoff = new Date(Date.now() - minDisconnectedMs).toISOString();
  // Disconnected hosts (dead backing pid) whose last heartbeat is old enough to
  // be an orphan. `disconnected_at` may be NULL on legacy rows, so fall back to
  // last_heartbeat_at via COALESCE.
  const stale = d.db
    .query<{ host_id: string; pid: number }, [string]>(
      `SELECT host_id, pid FROM hosts
       WHERE status='disconnected'
         AND COALESCE(disconnected_at, last_heartbeat_at) < ?`
    )
    .all(cutoff);
  let removed = 0;
  for (const h of stale) {
    let alive = false;
    if (h.pid && h.pid > 0) {
      try { process.kill(h.pid, 0); alive = true; } catch (e) { alive = ((e as NodeJS.ErrnoException).code === 'EPERM'); }
    }
    if (alive) continue; // still a live process — keep its host row
    // Host-scoped session/task rows (sessions-like tables), then the host.
    // (host_sessions + session_events + task_epochs are keyed by host_id.)
    d.db.query(`DELETE FROM host_sessions WHERE host_id=?`).run(h.host_id);
    d.db.query(`DELETE FROM session_events WHERE host_id=?`).run(h.host_id);
    d.db.query(`DELETE FROM task_epochs WHERE host_id=?`).run(h.host_id);
    d.db.query(`DELETE FROM hosts WHERE host_id=?`).run(h.host_id);
    removed++;
  }
  return removed;
}

// ── session registry ───────────────────────────────────────────────────

export interface RegisterSessionInput {
  hostId: string;
  sessionId: string;
  workspaceRoot?: string;
  worktreeRoot?: string;
  agentId?: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  status?: 'active' | 'idle';
}

export function upsertSession(d: Db, input: RegisterSessionInput): SessionRecord {
  const existing = getSession(d, input.hostId, input.sessionId);
  d.db
    .query(
      `INSERT INTO host_sessions
         (session_id, host_id, workspace_root, worktree_root, agent_id, selected_provider_id,
          selected_model_id, status, last_seen_at, task_epoch)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(host_id, session_id) DO UPDATE SET
         workspace_root=COALESCE(excluded.workspace_root, host_sessions.workspace_root),
         worktree_root=COALESCE(excluded.worktree_root, host_sessions.worktree_root),
         agent_id=COALESCE(excluded.agent_id, host_sessions.agent_id),
         selected_provider_id=COALESCE(excluded.selected_provider_id, host_sessions.selected_provider_id),
         selected_model_id=COALESCE(excluded.selected_model_id, host_sessions.selected_model_id),
         status=excluded.status, last_seen_at=excluded.last_seen_at`
    )
    .run(
      input.sessionId,
      input.hostId,
      input.workspaceRoot ?? null,
      input.worktreeRoot ?? null,
      input.agentId ?? null,
      input.selectedProviderId ?? null,
      input.selectedModelId ?? null,
      input.status ?? 'active',
      now(),
      existing?.taskEpoch ?? 0
    );
  return getSession(d, input.hostId, input.sessionId)!;
}

export function getSession(d: Db, hostId: string, sessionId: string): SessionRecord | null {
  const r = d.db
    .query<
      {
        session_id: string; host_id: string; workspace_root: string | null; worktree_root: string | null;
        agent_id: string | null; selected_provider_id: string | null; selected_model_id: string | null;
        status: string; last_event_sequence: number; task_epoch: number;
      },
      [string, string]
    >(`SELECT * FROM host_sessions WHERE host_id=? AND session_id=?`)
    .get(hostId, sessionId);
  if (!r) return null;
  return {
    hostId: r.host_id,
    sessionId: r.session_id,
    workspaceRoot: r.workspace_root ?? undefined,
    worktreeRoot: r.worktree_root ?? undefined,
    agentId: r.agent_id ?? undefined,
    selectedProviderId: r.selected_provider_id ?? undefined,
    selectedModelId: r.selected_model_id ?? undefined,
    status: r.status as SessionRecord['status'],
    lastEventSequence: r.last_event_sequence,
    taskEpoch: r.task_epoch,
  };
}

export function listSessions(d: Db, hostId?: string): SessionRecord[] {
  const rows = hostId
    ? d.db
        .query<{ host_id: string; session_id: string }, [string]>(
          `SELECT host_id, session_id FROM host_sessions WHERE host_id=?`
        )
        .all(hostId)
    : d.db
        .query<{ host_id: string; session_id: string }, []>(
          `SELECT host_id, session_id FROM host_sessions`
        )
        .all();
  return rows.map((r) => getSession(d, r.host_id, r.session_id)!);
}

export function nextTaskEpoch(d: Db, hostId: string, sessionId: string): number {
  const s = getSession(d, hostId, sessionId);
  const next = (s?.taskEpoch ?? 0) + 1;
  d.db.query(`UPDATE host_sessions SET task_epoch=? WHERE host_id=? AND session_id=?`).run(next, hostId, sessionId);
  return next;
}

// ── durable session-event outbox (replay after daemon loss) ─────────────

export function ingestSessionEvent(d: Db, hostId: string, sessionId: string, eventType: string, payload: unknown, taskEpoch: number): number {
  const res = d.db
    .query(
      `INSERT INTO session_events (host_id, session_id, event_type, event_payload, task_epoch, ingested_at, acked_by_host)
       VALUES (?,?,?,?,?,?,0)`
    )
    .run(hostId, sessionId, eventType, JSON.stringify(payload), taskEpoch, now());
  return Number(res.lastInsertRowid);
}

export function pendingSessionEvents(d: Db, hostId: string, sessionId: string, afterSeq = 0):
  Array<{ seq: number; eventType: string; payload: unknown; taskEpoch: number }> {
  return d.db
    .query<
      { seq: number; event_type: string; event_payload: string; task_epoch: number },
      [string, string, number]
    >(`SELECT seq, event_type, event_payload, task_epoch FROM session_events WHERE host_id=? AND session_id=? AND seq > ? ORDER BY seq`)
    .all(hostId, sessionId, afterSeq)
    .map((r) => ({ seq: r.seq, eventType: r.event_type, payload: JSON.parse(r.event_payload), taskEpoch: r.task_epoch }));
}

export function ackSessionEvents(d: Db, hostId: string, sessionId: string, upToSeq: number): void {
  d.db
    .query(`UPDATE session_events SET acked_by_host=1 WHERE host_id=? AND session_id=? AND seq <= ?`)
    .run(hostId, sessionId, upToSeq);
}