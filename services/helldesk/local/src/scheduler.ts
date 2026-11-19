import type { Db } from './db';
import type { DaemonConfig } from './config';

/**
 * Bounded dispatch scheduler with fairness and concurrency/rate limits.
 * Default: one job with two independent reviewers in parallel + one
 * adjudicator afterwards. Multiple jobs cannot exhaust unlimited resources.
 */

export interface SchedulerState {
  running: number;
}

export class Scheduler {
  private d: Db;
  private cfg: DaemonConfig;
  private runningJobs = 0;
  private pendingTicker: ReturnType<typeof setTimeout> | null = null;

  constructor(d: Db, cfg: DaemonConfig) {
    this.d = d;
    this.cfg = cfg;
  }

  get running(): number {
    return this.runningJobs;
  }

  /** Return the next QUEUED job to run, respecting the concurrency ceiling. */
  takeNextQueued(): { jobId: string } | null {
    if (this.runningJobs >= this.cfg.maxConcurrentJobs) return null;
    const row = this.d.db
      .query<{ job_id: string }, []>(
        `SELECT job_id FROM review_jobs
         WHERE state='QUEUED'
         ORDER BY requested_at ASC
         LIMIT 1`
      )
      .get();
    if (!row) return null;
    return { jobId: row.job_id };
  }

  begin(): void {
    this.runningJobs++;
  }

  end(): void {
    this.runningJobs = Math.max(0, this.runningJobs - 1);
  }

  /** How many jobs are queued/tracked today (fairness/depth). */
  queueDepth(): { queued: number; running: number; inFlight: number } {
    const stat =
      this.d.db
        .query<{ queued: number; running: number; inflight: number }, []>(
          `SELECT
             COALESCE(SUM(state='QUEUED'),0) AS queued,
             COALESCE(SUM(state='REVIEWING_A_B' OR state='ADJUDICATING'),0) AS running,
             COALESCE(SUM(state IN ('REVIEWING_A_B','ADJUDICATING','QUEUED','DISCOVERED','SNAPSHOTTED')),0) AS inflight
           FROM review_jobs`
        )
        .get() ?? { queued: 0, running: 0, inflight: 0 };
    return { queued: stat.queued, running: stat.running, inFlight: stat.inflight };
  }
}