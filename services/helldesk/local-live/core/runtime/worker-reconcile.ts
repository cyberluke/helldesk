/**
 * worker-reconcile.ts — no-split-brain AGENT projection from the control plane.
 *
 * The GUI "Agents" surface must show the REAL autonomous workers the engine is
 * running (adjudicator/review/mutation on the effective model route), never a divergent local
 * store. This projects the control-plane /v1/workers into the local Agent shape
 * the GUI renders (server-side via the absolute loopback proxy which injects the
 * token). Read-time projection only — no writes, cannot disturb the runtime.
 */
import { z } from 'zod';
import type { Agent } from '../types';

const SELF = `http://${process.env.HELLDESK_HOST ?? '127.0.0.1'}:${process.env.HELLDESK_PORT ?? '8790'}`;
const WorkersDTO = z.object({ workers: z.array(z.object({
  worker_id: z.string(),
  job_id: z.string().nullable().optional(),
  attempt_id: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  pid: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
  provider_id: z.string().nullable().optional(),
  model_id: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
})) });

/** Map a control-plane worker role onto the local agent role vocabulary. */
function roleToAgentRole(role: string | null | undefined): Agent['role'] {
  const r = (role ?? '').toLowerCase();
  if (r.includes('adj') || r.includes('review')) return 'qualityAssurance';
  if (r.includes('mayor') || r.includes('operator') || r.includes('orchestrat')) return 'soul';
  return 'soul';
}

/**
 * Map the control plane's PROCESS status onto the crew's STATUS vocabulary.
 *
 * `running`/`launching` IS `working`: the operator header counts the literal
 * `working` status, so projecting a live mission as `active` made a producing
 * agent read as "0 working". Keep this the single translation point.
 */
export function crewStatusOf(processStatus: string | null | undefined): Agent['status'] {
  const s = (processStatus ?? '').toLowerCase();
  return s === 'running' || s === 'launching' ? 'working' : 'idle';
}

/**
 * Merge the engine worker projection into a local roster.
 *
 * Engine workers are DEPARTMENT-scoped: the projection carries
 * workstation_id=null. They belong on the department roster only. A seat roster
 * (workstation filter) shows only agents registered to that workstation;
 * merging the unfiltered projection made every workstation page render the same
 * crew.
 *
 * STABLE IDENTITY: one projected entry per ROLE, but a NAMED local agent always
 * wins over the synthetic `role:<id>` projection for the same role. Worker
 * projections carry a stable `role:<id>` (role:reviewer-a, role:adjudicator, …)
 * because their process ids change; local agents are the real, addressable crew
 * (Toast, FrontDesk, …). Local agents are deduped by ID, never by role, so two
 * named souls on two workstations both stay visible. The synthetic soul remains
 * available whenever no local soul exists (missions can always address it).
 */
export function projectWorkersIntoRoster(
  local: Agent[],
  workers: Agent[],
  filter?: { workstation_id?: string },
): Agent[] {
  if (filter?.workstation_id) return local;
  const localRoles = new Set(
    local.map((a) => (a.role ?? '').toLowerCase()).filter(Boolean),
  );
  const merged = [
    ...local,
    ...workers.filter((a) => {
      const id = a.id ?? '';
      const projectedRole = (id.startsWith('role:') ? id.slice(5) : (a.role ?? '')).toLowerCase();
      return !projectedRole || !localRoles.has(projectedRole);
    }),
  ];
  const seenIds = new Set<string>();
  return merged.filter((a) => {
    const id = a.id ?? '';
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

/** Nicely format how long an agent has been on its current job (the 'stuck?' signal). */
function fmtDuration(startedAt: string | null | undefined): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

/**
 * Fetch the engine's real workers.
 * @param onlyActive when true (default) returns only RUNNING workers (the live
 *   crew), hiding succeeded/terminated/idle history so the panel is not 100 stale
 *   rows. Pass false to include the full history (for a filter button).
 */
export async function listWorkersProjected(onlyActive = true): Promise<Agent[]> {
  let res: Response;
  try {
    // Server-side fetch via the local-live proxy (/api/v1/workers) so the
    // control-plane token is injected here, not by the browser. Direct
    // :4790/v1/workers bypasses token injection and returns empty in-process.
    res = await fetch(`${SELF}/api/v1/workers`, { signal: AbortSignal.timeout(6000) });
  } catch { return stableSoul(); }
  if (!res || !res.ok) return stableSoul();
  let parsed;
  try { parsed = WorkersDTO.parse(await res.json()); } catch { return stableSoul(); }

  const nowIso = new Date().toISOString();
  const workers = parsed.workers ?? [];
  const active = onlyActive ? workers.filter((w) => (w.status ?? '').toLowerCase() === 'running') : workers;

  // ONE entry per ROLE with a STABLE id. Worker ids (`wk_*`) are per-process and
  // change on every restart; projecting them individually produced duplicate
  // crew rows (several "mutation@…") and made mission assignments dangle. The
  // stable identity is the ROLE, not the process.
  const byRole = new Map<string, (typeof active)[number]>();
  for (const w of active) {
    // The mutation runner's raw worker role is "mutation"; its stable crew
    // identity is the SOUL. Reviewer roles stay distinct (a/b/adjudicator).
    const rawRole = (w.role ?? 'agent').toLowerCase();
    const role = rawRole === 'mutation' ? 'soul' : rawRole;
    const prev = byRole.get(role);
    if (!prev || String(w.started_at ?? '') > String(prev.started_at ?? '')) byRole.set(role, w);
  }
  const label = (role: string): string => {
    switch (role) {
      case 'soul': return 'Soul';
      case 'reviewer-a': return 'Reviewer A';
      case 'reviewer-b': return 'Reviewer B';
      case 'adjudicator': return 'Adjudicator';
      case 'governor': return 'ExcellenceGovernor';
      case 'qualityassurance': return 'ExcellenceGovernor';
      case 'frontdesk': return 'FrontDesk';
      default: return role.replace(/(^|[-_ ])(\w)/g, (_m, sep: string, c: string) => (sep ? ' ' : '') + c.toUpperCase());
    }
  };
  const projected: Agent[] = [...byRole.entries()].map(([role, w]) => {
    const running = (w.status ?? '').toLowerCase() === 'running';
    const dur = fmtDuration(w.started_at);
    const model = w.model_id || w.provider_id || 'engine';
    const message = running
      ? `${label(role)} on ${w.job_id ? w.job_id.slice(0, 14) : 'job'} for ${dur}`
      : (w.status ?? 'done');
    return {
      id: `role:${role}`,
      workstation_id: null,
      role: roleToAgentRole(w.role),
      name: label(role),
      identity: `${w.provider_id ?? 'engine'}:${model}:${role}`,
      // Map process states to crew statuses so a finished/crashed worker never
      // disappears or shows a raw exit state. A RUNNING worker must be `working`
      // (see crewStatusOf) — that is what the operator header counts.
      status: crewStatusOf(w.status),
      current_hook_ticket_id: null,
      dispatch_attempts: 0,
      last_activity_at: w.finished_at ?? w.started_at ?? nowIso,
      agent_status_message: `${message} · ${model}`,
      agent_status_updated_at: w.started_at ?? nowIso,
      checkpoint: { engine: true, worker_id: w.worker_id, job_id: w.job_id, attempt_id: w.attempt_id, pid: w.pid, provider_id: w.provider_id, model_id: w.model_id, running, started_at: w.started_at, duration: dur },
      created_at: w.started_at ?? nowIso,
    };
  });
  // The soul is a stable ROLE even when no worker happens to be running: missions
  // are owned by it and the console must always be able to address it.
  if (!projected.some((a) => (a.role ?? '').toLowerCase() === 'soul')) projected.unshift(stableSoul()[0]!);
  return projected;
}

/** Stable soul identity, independent of any worker process. */
function stableSoul(): Agent[] {
  const nowIso = new Date().toISOString();
  return [{
    id: 'role:soul',
    workstation_id: null,
    role: roleToAgentRole('soul'),
    name: 'Soul',
    identity: 'engine:soul',
    // No running worker behind this fallback: the stable soul is addressable but
    // NOT working. Claiming 'working' here would fake a live crew member.
    status: 'idle',
    current_hook_ticket_id: null,
    dispatch_attempts: 0,
    last_activity_at: nowIso,
    agent_status_message: 'engine soul (mutation runner)',
    agent_status_updated_at: nowIso,
    checkpoint: { engine: true, stable: true },
    created_at: nowIso,
  } as Agent];
}
