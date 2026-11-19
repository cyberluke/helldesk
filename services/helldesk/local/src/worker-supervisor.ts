import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { Db } from './db';
import { now, generateId } from './ids';

/**
 * Detached review worker supervision.
 *
 * The control plane spawns each reviewer/adjudicator stage as an INDEPENDENT
 * `bun` process (`src/worker.ts`), track it in `workers`, heartbeat it,
 * accept its result, and fence stale completions (an old worker can never
 * overwrite a newer completed attempt). A crashed worker is retried; a stale
 * worker is not permitted to mutate a newer result.
 */

export interface WorkerLaunch {
  workerId: string;
  pid: number;
  role: string;
  attemptId: string;
}

const WORKER_ENTRY = fileURLToPath(new URL('./worker.ts', import.meta.url));

let running = new Map<string, ChildProcess>();

interface PendingWait {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
/** In-process waiters keyed by attemptId so the control plane can await a
 *  detached worker's frozen result text (resolved by acceptWorkerResult). */
const waits = new Map<string, PendingWait>();

export function awaitWorkerResult(attemptId: string, timeoutMs = 600_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      waits.delete(attemptId);
      reject(new Error(`worker ${attemptId} timed out`));
    }, timeoutMs);
    waits.set(attemptId, { resolve, reject, timer });
  });
}

export function spawnReviewWorker(opts: {
  d: Db;
  jobId: string;
  attemptId: string;
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
  snapshotId: string;
  store: string;
  model: { providerID: string; modelID: string };
  runner: 'openai' | 'fake' | 'kilo' | 'codex';
  baseURL?: string;
  apiKey?: string;
  /** Absolute path to the headless `kilo` server binary (runner=kilo). */
  kiloBin?: string;
  controlURL: string;
  controlToken: string;
  workspace: string;
  /** For the adjudicator: the combined A+B prompt the worker should reason over. */
  userOverride?: string;
}): WorkerLaunch {
  const workerId = `wk_${generateId().slice(0, 16)}`;
  const t = now();
  opts.d.db
    .query(
      `INSERT INTO workers (worker_id, job_id, attempt_id, role, status, provider_id, model_id, started_at, last_heartbeat_at)
       VALUES (?,?,?,?, 'launching', ?,?,?,?)`
    )
    .run(workerId, opts.jobId, opts.attemptId, opts.role, opts.model.providerID, opts.model.modelID, t, t);

  const args = [
    WORKER_ENTRY,
    '--job', opts.jobId,
    '--attempt', opts.attemptId,
    '--role', opts.role,
    '--snapshot', opts.snapshotId,
    '--store', opts.store,
    '--model', `${opts.model.providerID}/${opts.model.modelID}`,
    '--runner', opts.runner,
    '--control', opts.controlURL,
    '--token', opts.controlToken,
    '--workspace', opts.workspace,
  ];
  if (opts.runner === 'openai' || opts.runner === 'kilo' || opts.runner === 'codex') {
    args.push('--baseURL', opts.baseURL ?? '');
    if (opts.apiKey) args.push('--apiKey', opts.apiKey);
    if (opts.runner === 'kilo') {
      args.push('--kiloBin', opts.kiloBin ?? '');
      args.push('--snapshotStore', opts.store);
      args.push('--directory', opts.workspace);
    }
    if (opts.runner === 'codex') {
      // codex reviewer reads the binary from GT_CODEX_BIN (same as the codex
      // mutation child). Base URL is the snapshot evidence store for read-only
      // review; the runner resolves the codex CLI/model itself.
      args.push('--snapshotStore', opts.store);
    }
  }
  if (opts.userOverride) args.push('--userOverride', opts.userOverride);

  // For codex review, expose the codex binary to the detached worker via env
  // (matching the codex mutation child contract) so it can `codex exec`.
  const childEnv: Record<string, string | undefined> = { ...process.env };
  if (opts.runner === 'codex' && opts.kiloBin) childEnv.GT_CODEX_BIN = opts.kiloBin;

  const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true, env: childEnv });
  running.set(workerId, child);
  child.unref();
  opts.d.db.query(`UPDATE workers SET pid=?, status='running' WHERE worker_id=?`).run(child.pid ?? -1, workerId);

  child.stdout?.on('data', (b: Buffer) => {
    try {
      const line = b.toString().trim();
      if (line) opts.d.db.query(`UPDATE workers SET last_heartbeat_at=? WHERE worker_id=?`).run(now(), workerId);
    } catch { /* noop */ }
  });
  let errAcc = '';
  child.stderr?.on('data', (b: Buffer) => {
    const s = b.toString();
    errAcc = (errAcc + s).slice(-4000);
    try { opts.d.db.query(`UPDATE workers SET last_heartbeat_at=? WHERE worker_id=?`).run(now(), workerId); } catch { /* noop */ }
  });
  child.on('exit', (code) => {
    opts.d.db
      .query(`UPDATE workers SET status=?, finished_at=?, exit_code=?, error=? WHERE worker_id=? AND status!='succeeded'`)
      .run(code === 0 ? 'failed' : 'terminated', now(), code ?? -1, errAcc.slice(0, 4000) || null, workerId);
    running.delete(workerId);
  });

  return { workerId, pid: child.pid ?? -1, role: opts.role, attemptId: opts.attemptId };
}

export function killWorker(d: Db, workerId: string): void {
  const child = running.get(workerId);
  if (child) {
    try { child.kill(); } catch { /* already dead */ }
    running.delete(workerId);
  }
  d.db.query(`UPDATE workers SET status='aborted', finished_at=? WHERE worker_id=?`).run(now(), workerId);
}

/** Accept a worker result with fencing: only applies if the attempt is the
 *  current/latest and the job is still in a reviewable state. Stale workers
 *  cannot overwrite a newer completed result. */
export function acceptWorkerResult(opts: {
  d: Db;
  workerId?: string;
  attemptId: string;
  jobId: string;
  role: string;
  resultPath: string;
  providerID: string;
  modelID: string;
}): { ok: boolean; stale: boolean; reason?: string } {
  // Fencing: only a worker belonging to the CURRENT, non-terminal job may apply.
  // Worker stages are tracked in `workers` (each independent process); a worker
  // that already succeeded, or belongs to a terminal job, is stale.
  const st = opts.d.db
    .query<{ status: string; job_state: string; worker_id: string | null }, [string, string]>(
      `SELECT w.status, j.state AS job_state, w.worker_id
       FROM workers w JOIN review_jobs j ON j.job_id = w.job_id
       WHERE w.attempt_id=? AND w.job_id=?`
    )
    .get(opts.attemptId, opts.jobId);
  if (!st) return { ok: false, stale: true, reason: 'worker not found (stale)' };
  if (st.job_state === 'COMPLETED_PASS' || st.job_state === 'COMPLETED_FINDINGS' || st.job_state === 'FAILED_TERMINAL') {
    return { ok: false, stale: true, reason: `job already terminal (${st.job_state})` };
  }
  if (st.status === 'succeeded') return { ok: false, stale: true, reason: 'worker already succeeded' };

  const blob = existsSync(opts.resultPath) ? readFileSync(opts.resultPath, 'utf-8') : null;
  if (!blob) return { ok: false, stale: false, reason: 'result blob missing' };

  // Persist the run output and mark the worker succeeded.
  const wid = (opts.workerId && opts.workerId !== '') ? opts.workerId : (st.worker_id ?? '');
  opts.d.db
    .query(`UPDATE workers SET status='succeeded', finished_at=?, provider_id=?, model_id=?, result_blob_path=? WHERE worker_id=?`)
    .run(now(), opts.providerID, opts.modelID, opts.resultPath, wid);
  // Store stage outcome (current attempt).
  opts.d.db
    .query(
      `INSERT OR REPLACE INTO agent_runs (run_id, job_id, role, provider_id, model_id, status, started_at, finished_at, raw_output_path)
       VALUES (?,?,?,?,?, 'succeeded', ?, ?, ?)`
    )
    .run(`${opts.jobId}:${opts.attemptId}:${opts.role}`, opts.jobId, opts.role, opts.providerID, opts.modelID, now(), now(), opts.resultPath);
  // Resolve any awaiting controller with the worker's frozen text.
  const wait = waits.get(opts.attemptId);
  if (wait) {
    clearTimeout(wait.timer);
    waits.delete(opts.attemptId);
    try {
      const parsed = JSON.parse(blob) as { text?: string; resultPath?: string };
      wait.resolve(parsed.text ?? readFileSync(opts.resultPath, 'utf-8'));
    } catch {
      wait.resolve(blob);
    }
  }
  return { ok: true, stale: false };
}

export function shutdownAllWorkers(d: Db): void {
  for (const [id, child] of running) {
    try { child.kill(); } catch { /* noop */ }
  }
  running.clear();
  d.db.query(`UPDATE workers SET status='terminated', finished_at=?, error='control plane shutdown' WHERE status IN ('launching','running')`).run(now());
  for (const [, wait] of waits) {
    clearTimeout(wait.timer);
    wait.reject(new Error('control plane shutdown'));
  }
  waits.clear();
}