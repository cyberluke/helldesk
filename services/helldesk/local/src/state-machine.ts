import type { Db } from './db';

/**
 * Transactional review-job state machine.
 *
 * Ported from helldesk's reconciler/state semantics: every transition is a
 * single atomic compare-and-swap on the row; invalid transitions throw.
 * No `SELECT` then unrelated `UPDATE` race.
 */

export type JobState =
  | 'DISCOVERED'
  | 'SNAPSHOTTED'
  | 'QUEUED'
  | 'REVIEWING_A_B'
  | 'ADJUDICATING'
  | 'COMPLETED_PASS'
  | 'COMPLETED_FINDINGS'
  | 'INCONCLUSIVE'
  | 'FAILED_TERMINAL'
  | 'CANCELLED';

/** Allowed transitions (also exported for tests/audit). */
export const TRANSITIONS: Record<JobState, JobState[]> = {
  DISCOVERED: ['SNAPSHOTTED', 'QUEUED', 'FAILED_TERMINAL', 'CANCELLED'],
  SNAPSHOTTED: ['QUEUED', 'FAILED_TERMINAL', 'CANCELLED'],
  QUEUED: ['REVIEWING_A_B', 'CANCELLED', 'INCONCLUSIVE', 'FAILED_TERMINAL'],
  // Reviewer verdicts are FINAL when the ExcellenceGovernor stage is disabled by
  // operator policy, so the reviewing state must be able to terminalize directly
  // instead of pretending an adjudication happened.
  REVIEWING_A_B: ['ADJUDICATING', 'COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL', 'CANCELLED', 'QUEUED'],
  ADJUDICATING: ['COMPLETED_PASS', 'COMPLETED_FINDINGS', 'INCONCLUSIVE', 'FAILED_TERMINAL', 'CANCELLED', 'QUEUED'],
  COMPLETED_PASS: [],
  COMPLETED_FINDINGS: [],
  INCONCLUSIVE: ['QUEUED'],           // retry via reconciler
  FAILED_TERMINAL: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: JobState, to: JobState) {
    super(`Invalid review_job transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Transition a job. Throws InvalidTransitionError on illegal moves. */
export function transitionJob(
  d: Db,
  jobId: string,
  from: JobState,
  to: JobState
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
  const now = new Date().toISOString();
  const res = d.db
    .query(
      `UPDATE review_jobs
       SET state=?, updated_at=?, completed_at=CASE WHEN ? IN
         ('COMPLETED_PASS','COMPLETED_FINDINGS','INCONCLUSIVE','FAILED_TERMINAL','CANCELLED')
         THEN ? ELSE completed_at END
       WHERE job_id=? AND state=?`
    )
    .run(to, now, to, now, jobId, from);
  if (res.changes !== 1) {
    // re-read current to give a useful error
    const row = d.db
      .query<{ state: JobState }, [string]>(
        `SELECT state FROM review_jobs WHERE job_id=?`
      )
      .get(jobId);
    throw new InvalidTransitionError(row?.state ?? from, to);
  }
}

/** Force-set a job state (used only by reconciler for recovery, not public transitions). */
export function forceJobState(d: Db, jobId: string, to: JobState): void {
  const now = new Date().toISOString();
  d.db
    .query(
      `UPDATE review_jobs SET state=?, updated_at=? WHERE job_id=?`
    )
    .run(to, now, jobId);
}

export const JOB_STATES: JobState[] = [
  'DISCOVERED',
  'SNAPSHOTTED',
  'QUEUED',
  'REVIEWING_A_B',
  'ADJUDICATING',
  'COMPLETED_PASS',
  'COMPLETED_FINDINGS',
  'INCONCLUSIVE',
  'FAILED_TERMINAL',
  'CANCELLED',
];