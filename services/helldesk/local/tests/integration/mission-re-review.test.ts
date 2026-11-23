import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Engine } from '../../src/engine';
import { makeGitFixture, makeTestDb } from '../helpers';
import { createFakeRunner } from '../../src/inference';
import { getJobReviewControls } from '../../src/jobs';
import {
  addTicket,
  createMission,
  createRevision,
  getRevision,
  setMissionReviewControls,
  updateMissionState,
  updateRevision,
  updateTicket,
} from '../../src/mission-repository';
import { reReviewMission } from '../../src/mission-review-service';
import { findWorkspaceByPath } from '../../src/workspace-registry';

let h: ReturnType<typeof makeTestDb>;
let engine: Engine;

beforeAll(() => {
  h = makeTestDb({ runner: 'fake' });
  engine = new Engine({
    d: h.d,
    config: h.cfg,
    snapshotStore: h.snapshotStore,
    reportDir: h.reportDir,
    runner: createFakeRunner(),
    resolvedModels: new Map([['inherited', { providerID: 'fake-provider', modelID: 'fake-model' }]]),
  });
  engine.onStartup();
});
afterAll(() => h.close());

describe('operator re-review', () => {
  it('creates a fresh review attempt on the SAME snapshot with the CURRENT policy', async () => {
    const fixture = makeGitFixture();
    const first = await engine.createAndEnqueue({
      workspacePath: fixture.dir,
      subjectKind: 'git-head',
      source: 'test',
    });
    await engine.runJob(first.jobId);
    const workspace = findWorkspaceByPath(h.d, fixture.dir)!;
    const mission = createMission(h.d, { workspace_id: workspace.workspaceId, objective: 're-review me' });
    const ticket = addTicket(h.d, mission.mission_id, { title: 'B1', objective: 're-review me' });
    const revision = createRevision(h.d, { ticket_id: ticket.ticket_id, hypothesis_key: 'h' });
    updateRevision(h.d, revision.revision_id, { review_job_id: first.jobId, state: 'EVIDENCE_CAPTURED' });
    updateTicket(h.d, ticket.ticket_id, { active_revision_id: revision.revision_id });
    updateMissionState(h.d, mission.mission_id, 'ACTIVE');
    setMissionReviewControls(h.d, mission.mission_id, {
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });

    const result = await reReviewMission(engine, mission.mission_id, { start: false });
    expect(result.action).toBe('queued');
    expect(result.jobId).toBeTruthy();
    expect(result.jobId).not.toBe(first.jobId);
    expect(getRevision(h.d, revision.revision_id)?.review_job_id).toBe(result.jobId);
    expect(getJobReviewControls(h.d, result.jobId!)).toMatchObject({
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
  }, 30_000);

  it('refuses a terminal (verified) mission', async () => {
    const mission = createMission(h.d, { workspace_id: 'ws_re_review_terminal', objective: 'done' });
    updateMissionState(h.d, mission.mission_id, 'VERIFIED_10_10', { verified_at: new Date().toISOString() });
    const result = await reReviewMission(engine, mission.mission_id, { start: false });
    expect(result.action).toBe('rejected');
    expect(result.reason).toBe('mission_terminal');
  });
});
