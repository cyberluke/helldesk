/**
 * worker-reconcile.ts — no-split-brain AGENT projection from the control plane.
 *
 * The GUI "Agents" surface must show the REAL autonomous workers the engine is
 * running (adjudicator/review/mutation on litellm-edge), never a divergent local
 * store. This projects the control-plane /v1/workers into the local Agent shape
 * the GUI renders (server-side via the absolute loopback proxy which injects the
 * token). Read-time projection only — no writes, cannot disturb the runtime.
 */
import { z } from 'zod';
import type { Agent } from '../types';

const SELF = 'http://127.0.0.1:8790';
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
  } catch { return []; }
  if (!res || !res.ok) return [];
  let parsed;
  try { parsed = WorkersDTO.parse(await res.json()); } catch { return []; }

  const nowIso = new Date().toISOString();
  const workers = parsed.workers ?? [];
  const active = onlyActive ? workers.filter((w) => (w.status ?? '').toLowerCase() === 'running') : workers;
  return active.map((w) => {
    const running = (w.status ?? '').toLowerCase() === 'running';
    const dur = fmtDuration(w.started_at);
    // Insight: a running reviewer shows role + job + how long it's been running,
    // so you can SEE what's live (vs a frozen worker that looks 'stuck').
    const message = running
      ? `${w.role ?? 'agent'} on ${w.job_id ? w.job_id.slice(0, 14) : 'job'} for ${dur}`
      : (w.status ?? 'done');
    return {
      id: w.worker_id,
      workstation_id: null,
      role: roleToAgentRole(w.role),
      name: `${w.role ?? 'agent'}@${w.model_id || w.provider_id || 'engine'}`,
      identity: `${w.provider_id ?? 'litellm-edge'}:${w.model_id ?? 'differential_sseproxy'}:${w.worker_id.slice(0, 8)}`,
      status: w.status === 'succeeded' ? 'idle' : (w.status === 'running' ? 'active' : (w.status ?? 'idle')),
      current_hook_ticket_id: null,
      dispatch_attempts: 0,
      last_activity_at: w.finished_at ?? w.started_at ?? nowIso,
      agent_status_message: message,
      agent_status_updated_at: w.started_at ?? nowIso,
      checkpoint: { engine: true, worker_id: w.worker_id, job_id: w.job_id, attempt_id: w.attempt_id, pid: w.pid, provider_id: w.provider_id, model_id: w.model_id, running, started_at: w.started_at, duration: dur },
      created_at: w.started_at ?? nowIso,
    };
  });
}