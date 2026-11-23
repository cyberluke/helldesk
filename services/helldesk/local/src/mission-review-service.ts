/**
 * mission-review-service.ts — operator-triggered re-review of the CURRENT
 * immutable revision with the CURRENT review policy.
 *
 * The common case: the review is QUEUED (or the mission is waiting on an
 * inconclusive review) and the operator changed Governor / Reviewer A/B. We do
 * NOT mutate the source tree and do NOT fabricate a new revision; we create a
 * fresh review attempt over the SAME snapshot and link it to the revision. The
 * previous verdict/findings remain in the audit trail.
 */
import type { Engine } from './engine';
import { getJob } from './jobs';
import {
  getMission,
  getRevision,
  getTicket,
  getMissionReviewControls,
  listTickets,
  updateRevision,
  emitMissionEvent,
} from './mission-repository';

export type ReReviewAction = 'executed' | 'queued' | 'in_flight' | 'rejected';

export interface ReReviewResult {
  action: ReReviewAction;
  jobId: string | null;
  previousJobId: string | null;
  reason?: string;
}

function activeTicket(missionId: string, d: Engine['d']) {
  const mission = getMission(d, missionId)!;
  const current = mission.current_ticket_id ? getTicket(d, mission.current_ticket_id) : null;
  if (current?.active_revision_id) return current;
  return (
    listTickets(d, missionId, false).find((ticket) => {
      if (!ticket.active_revision_id) return false;
      const revision = getRevision(d, ticket.active_revision_id);
      return Boolean(revision?.review_job_id);
    }) ?? null
  );
}

export async function reReviewMission(
  engine: Engine,
  missionId: string,
  options?: { start?: boolean },
): Promise<ReReviewResult> {
  const d = engine.d;
  const mission = getMission(d, missionId);
  if (!mission) return { action: 'rejected', jobId: null, previousJobId: null, reason: 'mission_not_found' };
  if (mission.state === 'VERIFIED_10_10' || mission.state === 'CANCELLED') {
    return { action: 'rejected', jobId: null, previousJobId: null, reason: 'mission_terminal' };
  }
  const ticket = activeTicket(missionId, d);
  if (!ticket?.active_revision_id) {
    return { action: 'rejected', jobId: null, previousJobId: null, reason: 'no_active_revision' };
  }
  const revision = getRevision(d, ticket.active_revision_id);
  if (!revision?.review_job_id) {
    return { action: 'rejected', jobId: null, previousJobId: null, reason: 'no_review_job' };
  }
  const job = getJob(d, revision.review_job_id);
  if (!job) return { action: 'rejected', jobId: null, previousJobId: null, reason: 'review_job_missing' };
  const controls = getMissionReviewControls(d, missionId);
  if (job.state === 'REVIEWING_A_B' || job.state === 'ADJUDICATING' || job.state === 'RUNNING') {
    return { action: 'in_flight', jobId: job.jobId, previousJobId: null, reason: 'review_in_flight' };
  }
  if (job.state === 'QUEUED' || job.state === 'DISCOVERED' || job.state === 'SNAPSHOTTED') {
    // The controls were already written to open job meta by setMissionReviewControls;
    // execute now instead of waiting for the next scheduler tick.
    emitMissionEvent(d, 'mission.re_review_started', {
      mission_id: missionId,
      ticket_id: ticket.ticket_id,
      revision_id: revision.revision_id,
      job_id: job.jobId,
      policy: controls,
    });
    if (options?.start !== false) {
      void engine.executeQueuedJob(job.jobId).catch(() => undefined);
    }
    return { action: 'executed', jobId: job.jobId, previousJobId: null };
  }
  if (revision.state !== 'EVIDENCE_CAPTURED' && revision.state !== 'VERIFYING') {
    return {
      action: 'rejected',
      jobId: job.jobId,
      previousJobId: null,
      reason: `revision_${revision.state.toLowerCase()}_not_reviewable`,
    };
  }
  const fresh = await engine.reReviewSnapshot({
    jobId: job.jobId,
    controls,
    source: 'mission-re-review',
  });
  updateRevision(d, revision.revision_id, { review_job_id: fresh.jobId });
  emitMissionEvent(d, 'mission.re_review_queued', {
    mission_id: missionId,
    ticket_id: ticket.ticket_id,
    revision_id: revision.revision_id,
    previous_job_id: fresh.previousJobId,
    job_id: fresh.jobId,
    policy: controls,
  });
  if (options?.start !== false) {
    void engine.executeQueuedJob(fresh.jobId).catch(() => undefined);
  }
  return { action: 'queued', jobId: fresh.jobId, previousJobId: fresh.previousJobId };
}
