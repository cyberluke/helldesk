import type { Db } from './db';
import { generateId, now } from './ids';
import {
  staleMs,
  getDispatchCooldownMs,
  MAX_DISPATCH_ATTEMPTS,
  STUCK_REVIEW_TIMEOUT_MS,
  STALE_IN_PROGRESS_TIMEOUT_MS,
  HEARTBEAT_LOST_MS,
} from './helldesk-semantics';

/**
 * Reconciler: leases, retries, death recovery, and circuit breaker.
 *
 * Adapted from the upstream HELLDESK reconciler (`src/dos/department/reconciler.ts`):
 * - expired working-agent heartbeat -> idle (HEARTBEAT_LOST_MS)
 * - stuck review (in_progress, no live owner) -> reset to open after
 *   STUCK_REVIEW_TIMEOUT_MS
 * - stale in-progress work -> re-dispatch after STALE_IN_PROGRESS_TIMEOUT_MS
 * - exponential dispatch backoff via getDispatchCooldownMs
 * - bounded dispatch attempts (MAX_DISPATCH_ATTEMPTS) -> fail, never infinite
 * - circuit breaker trips after a failure bound and cooldowns
 *
 * The local adapter adds ownership leases with fencing to the upstream
 * staleness semantics: an expired RUNNING lease returns the job to QUEUE
 * safely, and a fenced (late) worker cannot overwrite a newer result.
 */

export interface Lease {
  leaseId: string;
  owner: string;
  expiresAt: string;
  heartbeatAt: string;
}

export function acquireLease(d: Db, purpose: string, owner: string, ttlMs: number): Lease | null {
  const leaseId = `lease_${generateId().slice(0, 20)}`;
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const hb = now();
  // Precondition: a LIVE lease for the same purpose+owner must not already exist.
  // Query only unexpired rows: an old expired row must never mask a live lease
  // (LIMIT 1 without the expiry filter did exactly that, letting two review
  // executions own the same job at once — duplicate leases, duplicate attempts,
  // duplicate workers).
  const live = d.db
    .query<{ lease_id: string }, [string, string, string]>(
      `SELECT lease_id FROM leases WHERE owner=? AND leasee=? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1`
    )
    .get(owner, purpose, hb);
  if (live) return null; // held by a live owner
  // Housekeeping: expired rows for this owner are dead; remove them so they can
  // never shadow a future acquisition.
  d.db.query(`DELETE FROM leases WHERE owner=? AND leasee=? AND expires_at <= ?`).run(owner, purpose, hb);
  d.db
    .query(
      `INSERT INTO leases (lease_id, owner, expires_at, heartbeat_at, leasee)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lease_id) DO NOTHING`
    )
    .run(leaseId, owner, exp, hb, purpose);
  return { leaseId, owner, expiresAt: exp, heartbeatAt: hb };
}

/**
 * LIVENESS: reclaim a lease whose HOLDER IS DEAD. A mutation that dies mid-run
 * (server-boot timeout / process crash) leaves its writer lease held until
 * expiry (default 10 min), stranding every subsequent mutation for that
 * workspace in `mutation-workspace-busy` — a silent 10-minute deadlock. If the
 * last heartbeat is older than `staleMs`, the holder is presumed dead: delete
 * the lease so dispatch can proceed. Safe because a live mutation renews its
 * lease at a fraction of `staleMs`; only a dead holder goes quiet that long.
 */
export function reclaimStaleLease(d: Db, owner: string, purpose: string, staleMs: number): boolean {
  const row = d.db
    .query<{ lease_id: string; heartbeat_at: string }, [string, string]>(
      `SELECT lease_id, heartbeat_at FROM leases WHERE owner=? AND leasee=? LIMIT 1`
    )
    .get(owner, purpose);
  if (!row) return false; // nothing held
  const hbMs = Date.parse(row.heartbeat_at);
  if (!Number.isFinite(hbMs)) {
    d.db.query(`DELETE FROM leases WHERE lease_id=?`).run(row.lease_id);
    return true;
  }
  if (Date.now() - hbMs > staleMs) {
    d.db.query(`DELETE FROM leases WHERE lease_id=?`).run(row.lease_id);
    return true;
  }
  return false;
}

export function renewLease(d: Db, leaseId: string, ttlMs: number): boolean {
  const exp = new Date(Date.now() + ttlMs).toISOString();
  const res = d.db.query(`UPDATE leases SET expires_at=?, heartbeat_at=? WHERE lease_id=?`).run(exp, now(), leaseId);
  return res.changes === 1;
}

export function releaseLease(d: Db, leaseId: string): void {
  d.db.query(`DELETE FROM leases WHERE lease_id=?`).run(leaseId);
}

export function isLeaseValid(d: Db, owner: string, purpose: string): boolean {
  const row = d.db
    .query<{ expires_at: string }, [string, string]>(
      `SELECT expires_at FROM leases WHERE owner=? AND leasee=? LIMIT 1`
    )
    .get(owner, purpose);
  return !!row && row.expires_at > now();
}

/** Recover all stuck leases and reset their jobs to QUEUED. */
export function recoverStuckLeases(d: Db): number {
  const nowIso = now();
  const stuck = d.db
    .query<{ lease_id: string; owner: string }, [string]>(
      `SELECT lease_id, owner FROM leases WHERE expires_at < ?`
    )
    .all(nowIso);
  for (const l of stuck) {
    // The owner is `job:<jobId>` for review jobs. Reset that job to QUEUED.
    d.db.query(`DELETE FROM leases WHERE lease_id=?`).run(l.lease_id);
    if (l.owner.startsWith('job:')) {
      const jobId = l.owner.slice('job:'.length);
      d.db
        .query(`UPDATE review_jobs SET state='QUEUED', updated_at=? WHERE job_id=? AND state IN ('REVIEWING_A_B','ADJUDICATING')`)
        .run(nowIso, jobId);
      d.db
        .query(`UPDATE review_attempts SET state='failed', finished_at=? WHERE job_id=? AND state='running'`)
        .run(nowIso, jobId);
    }
  }
  return stuck.length;
}

export interface BreakerState {
  key: string;
  failures: number;
  lastFailureAt: number;
  openedAt: number | null;
}

export class CircuitBreaker {
  private states = new Map<string, BreakerState>();
  private cfg: { threshold: number; cooldownMs: number };
  constructor(cfg: { threshold: number; cooldownMs: number }) {
    this.cfg = cfg;
  }

  /** Returns false when the circuit is open (cooldown in progress). */
  allow(key: string): boolean {
    const s = this.states.get(key);
    if (!s) return true;
    if (s.openedAt) {
      if (Date.now() - s.openedAt > this.cfg.cooldownMs) {
        // transition to half-open
        this.states.set(key, { ...s, openedAt: null });
        return true;
      }
      return false;
    }
    return s.failures < this.cfg.threshold;
  }

  recordFailure(key: string): void {
    const s = this.states.get(key) ?? { key, failures: 0, lastFailureAt: 0, openedAt: null };
    const failures = s.failures + 1;
    const openedAt = failures >= this.cfg.threshold ? Date.now() : s.openedAt;
    this.states.set(key, { key, failures, lastFailureAt: Date.now(), openedAt });
  }

  recordSuccess(key: string): void {
    this.states.delete(key);
  }

  state(key: string): BreakerState | null {
    return this.states.get(key) ?? null;
  }
}

/** Bounded retry with jitter, using the upstream-adapted exponential cooldown. */
export function retryWithJitter(attempt: number, baseMs: number, maxMs: number): number {
  // The upstream getDispatchCooldownMs curve (30s steps), scaled is already
  // the cooldown authority; here keep a capped jittered exponential for
  // provider/worker retries that does not exceed the breaker cooldown.
  const curve = getDispatchCooldownMs(Math.min(attempt, 5));
  const exp = Math.min(maxMs, Math.max(baseMs, curve));
  const jitter = exp * 0.2 * Math.random();
  return Math.floor(exp + jitter);
}

/** True when a job's state is older than the upstream stale-review horizon. */
export function isReviewStale(updatedAt: string | null, horizonMs: number = STUCK_REVIEW_TIMEOUT_MS): boolean {
  return staleMs(updatedAt, horizonMs);
}

/** True when a working/heartbeat is dead by the upstream heartbeat horizon. */
export function isOwnerDead(lastActivityAt: string | null): boolean {
  return staleMs(lastActivityAt, HEARTBEAT_LOST_MS);
}