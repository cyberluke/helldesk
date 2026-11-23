import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { Engine } from '../../src/engine';
import { makeGitFixture, makeTestDb } from '../helpers';
import { createFakeRunner } from '../../src/inference';
import {
  addTicket,
  createMission,
  createRevision,
  getMission,
  getTicket,
  listMissionAcceptanceEvents,
  listTickets,
  recordMissionAcceptance,
  updateMissionState,
  updateRevision,
  updateTicket,
  updateTicketSize,
} from '../../src/mission-repository';
import { getMissionReport } from '../../src/mission-report';
import { findWorkspaceByPath } from '../../src/workspace-registry';

let h: ReturnType<typeof makeTestDb>;
let engine: Engine;
const nowIso = () => new Date().toISOString();

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

function verifiedMission(objective: string) {
  const mission = createMission(h.d, { workspace_id: 'ws_acceptance', objective });
  const ticket = addTicket(h.d, mission.mission_id, { title: 'B1', objective });
  updateTicket(h.d, ticket.ticket_id, {
    verification_state: 'VERIFIED_10_10',
    execution_state: 'AWAITING_ACCEPTANCE',
    active_revision_id: null,
  });
  updateMissionState(h.d, mission.mission_id, 'VERIFIED_10_10', { verified_at: nowIso() });
  return { mission: getMission(h.d, mission.mission_id)!, ticket: getTicket(h.d, ticket.ticket_id)! };
}

describe('human acceptance gate', () => {
  it('accepting a verified mission records the decision and closes the verified ticket', () => {
    const { mission, ticket } = verifiedMission('accept me');
    const result = recordMissionAcceptance(h.d, {
      missionId: mission.mission_id,
      decision: 'accepted',
      note: 'CTO verified the gates',
      actor: 'operator',
    });
    expect(result.mission.human_acceptance).toBe('accepted');
    expect(result.mission.human_accepted_by).toBe('operator');
    expect(result.mission.human_acceptance_note).toBe('CTO verified the gates');
    expect(getTicket(h.d, ticket.ticket_id)?.execution_state).toBe('CLOSED');
    const history = listMissionAcceptanceEvents(h.d, mission.mission_id);
    expect(history).toHaveLength(1);
    expect(history[0]!.decision).toBe('accepted');
    // Idempotent: accepting twice does not create a second event.
    recordMissionAcceptance(h.d, { missionId: mission.mission_id, decision: 'accepted' });
    expect(listMissionAcceptanceEvents(h.d, mission.mission_id)).toHaveLength(1);
  });

  it('requesting changes reopens the mission with a first-class follow-up ticket', () => {
    const { mission } = verifiedMission('needs follow-up');
    const before = listTickets(h.d, mission.mission_id, false).length;
    const result = recordMissionAcceptance(h.d, {
      missionId: mission.mission_id,
      decision: 'changes_requested',
      note: 'Add the missing regression test for the empty queue',
      actor: 'operator',
    });
    expect(result.mission.state).toBe('ACTIVE');
    expect(result.mission.verified_at).toBeNull();
    expect(result.mission.human_acceptance).toBe('changes_requested');
    const tickets = listTickets(h.d, mission.mission_id, false);
    expect(tickets.length).toBe(before + 1);
    const followUp = tickets.find((ticket) => ticket.title === 'Operator change request');
    expect(followUp).toBeTruthy();
    expect(followUp?.objective).toContain('missing regression test');
    expect(listMissionAcceptanceEvents(h.d, mission.mission_id)[0]?.decision).toBe('changes_requested');
  });

  it('does not accept an unverified mission', () => {
    const mission = createMission(h.d, { workspace_id: 'ws_not_verified', objective: 'not yet' });
    addTicket(h.d, mission.mission_id, { title: 'B1', objective: 'not yet' });
    expect(() =>
      recordMissionAcceptance(h.d, { missionId: mission.mission_id, decision: 'accepted' })
    ).toThrow(/not awaiting human acceptance/);
  });
});

describe('mission completion report', () => {
  it('joins the final review policy, governor role, findings and commits', async () => {
    const fixture = makeGitFixture();
    const { jobId } = await engine.createAndEnqueue({
      workspacePath: fixture.dir,
      subjectKind: 'git-head',
      source: 'test',
      controls: { reviewer: false, reviewerA: false, reviewerB: false, excellenceGovernor: true },
    });
    await engine.runJob(jobId);
    const workspace = findWorkspaceByPath(h.d, fixture.dir)!;
    const mission = createMission(h.d, { workspace_id: workspace.workspaceId, objective: 'report me' });
    const ticket = addTicket(h.d, mission.mission_id, { title: 'B1', objective: 'report me' });
    const revision = createRevision(h.d, { ticket_id: ticket.ticket_id, hypothesis_key: 'h' });
    updateRevision(h.d, revision.revision_id, { review_job_id: jobId });
    updateTicketSize(h.d, ticket.ticket_id, {
      tshirt: 'L',
      storyPoints: 5,
      confidence: 'high',
      rationale: 'report size test',
      model: 'fake',
      state: 'sized',
    });
    updateTicket(h.d, ticket.ticket_id, {
      verification_state: 'VERIFIED_10_10',
      execution_state: 'AWAITING_ACCEPTANCE',
      active_revision_id: revision.revision_id,
    });
    updateMissionState(h.d, mission.mission_id, 'VERIFIED_10_10', { verified_at: nowIso() });

    const report = getMissionReport(h.d, mission.mission_id);
    expect(report).not.toBeNull();
    expect(report!.mission.awaitingHumanAcceptance).toBe(true);
    expect(report!.review.jobId).toBe(jobId);
    expect(report!.review.policy?.summary).toContain('ExcellenceGovernor only');
    expect(report!.review.policy?.reviewerA).toBe(false);
    expect(report!.review.policy?.reviewerB).toBe(false);
    expect(report!.review.policy?.governor).toBe(true);
    expect(report!.review.roles.some((role) => role.role === 'governor')).toBe(true);
    expect(report!.review.findings.length).toBeGreaterThan(0);
    expect(report!.tickets[0]!.reviewJobId).toBe(jobId);
    expect(report!.tickets[0]!.storyPoints).toBe(5);
    expect(report!.tickets[0]!.tshirtSize).toBe('L');
    expect(report!.tickets[0]!.sizingState).toBe('sized');

    // Explicit pricing: 1M input @ $3 + 0.5M output @ $15 = $10.50.
    h.d.db
      .query(`UPDATE agent_runs SET tokens_in=?, tokens_out=?, cost=NULL WHERE job_id=?`)
      .run(1_000_000, 500_000, jobId);
    const priced = getMissionReport(h.d, mission.mission_id, {
      pricing: { models: { 'fake-provider/fake-model': { inputPer1M: 3, outputPer1M: 15 } } },
      runner: 'fake',
    });
    expect(priced!.review.tokens).toMatchObject({ input: 1_000_000, output: 500_000, total: 1_500_000 });
    expect(priced!.review.tokens.cost).toBeCloseTo(10.5, 10);
    expect(priced!.review.roles.some((role) => role.cost != null && Math.abs(role.cost - 10.5) < 1e-9)).toBe(true);

    // Local/free model: a configured 0 is a real $0, not "not priced".
    const free = getMissionReport(h.d, mission.mission_id, {
      pricing: { models: { 'fake-provider/fake-model': { inputPer1M: 0, outputPer1M: 0 } } },
      runner: 'fake',
    });
    expect(free!.review.tokens.cost).toBe(0);
    expect(free!.review.tokens.costPartial).toBe(false);
    expect(free!.review.roles.every((role) => role.cost == null || role.cost === 0)).toBe(true);
    expect(free!.review.roles.some((role) => role.cost === 0)).toBe(true);

    recordMissionAcceptance(h.d, { missionId: mission.mission_id, decision: 'accepted', actor: 'operator' });
    const accepted = getMissionReport(h.d, mission.mission_id)!;
    expect(accepted.mission.awaitingHumanAcceptance).toBe(false);
    expect(accepted.mission.humanAcceptance).toBe('accepted');
    expect(accepted.tickets[0]!.executionState).toBe('CLOSED');
    expect(accepted.acceptanceHistory).toHaveLength(1);
  }, 30_000);
});
