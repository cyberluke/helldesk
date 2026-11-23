import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../../src/engine';
import { makeGitFixture, makeTestDb } from '../helpers';
import { createFakeRunner } from '../../src/inference';
import { getJob, getJobReviewControls } from '../../src/jobs';
import {
  createMissionRequest,
  createRevision,
  getMissionReviewControls,
  setMissionReviewControls,
  updateRevision,
} from '../../src/mission-repository';
import type { ReviewControls } from '../../src/review-controls';

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

function rolesFor(jobId: string): string[] {
  return h.d.db
    .query<{ role: string }, [string]>(`SELECT DISTINCT role FROM agent_runs WHERE job_id=? ORDER BY role`)
    .all(jobId)
    .map((row) => row.role);
}

async function runWithControls(controls: ReviewControls): Promise<{ jobId: string; state: string; result: string | null; roles: string[] }> {
  const g = makeGitFixture();
  const { jobId } = await engine.createAndEnqueue({
    workspacePath: g.dir,
    subjectKind: 'git-head',
    source: 'test',
    controls,
  });
  await engine.runJob(jobId);
  const job = getJob(h.d, jobId)!;
  return { jobId, state: job.state, result: job.result, roles: rolesFor(jobId) };
}

describe('engine review-role gating (per-task controls)', () => {
  it('default policy still runs Reviewer A + Reviewer B + Adjudicator', { timeout: 30_000 }, async () => {
    const run = await runWithControls({});
    expect(run.roles).toContain('reviewer-a');
    expect(run.roles).toContain('reviewer-b');
    expect(run.roles).toContain('adjudicator');
    expect(run.roles).not.toContain('governor');
  });

  it('ExcellenceGovernor only: no Reviewer A/B, one governor pass', { timeout: 30_000 }, async () => {
    const run = await runWithControls({
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
    expect(run.roles).toEqual(['governor']);
    expect(run.state).toBe('COMPLETED_FINDINGS');
    // The fake governor is a real independent pass and its findings are final.
    const findings = h.d.db
      .query<{ adjudicated: number; adjudication: string }, [string]>(`SELECT adjudicated, adjudication FROM findings WHERE job_id=?`)
      .all(run.jobId);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.adjudicated === 1)).toBe(true);
    expect(findings[0]?.adjudication).toBe('governor-final');
    // The immutable review report must carry the policy that actually ran.
    const report = JSON.parse(readFileSync(join(h.reportDir, `${run.jobId}.json`), 'utf8')) as {
      policy?: { summary?: string };
      cost?: unknown;
    };
    expect(report.policy?.summary).toContain('ExcellenceGovernor only');
    expect(report.cost).toBeDefined();
  });

  it('Reviewer B off: only Reviewer A + Governor adjudication run', { timeout: 30_000 }, async () => {
    const run = await runWithControls({ reviewerB: false });
    expect(run.roles).toContain('reviewer-a');
    expect(run.roles).not.toContain('reviewer-b');
    expect(run.roles).toContain('adjudicator');
    expect(run.roles).not.toContain('governor');
  });

  it('Reviewer A off: only Reviewer B + Governor adjudication run', { timeout: 30_000 }, async () => {
    const run = await runWithControls({ reviewerA: false });
    expect(run.roles).not.toContain('reviewer-a');
    expect(run.roles).toContain('reviewer-b');
    expect(run.roles).toContain('adjudicator');
  });

  it('Governor off: the enabled reviewer verdict is final (no adjudicator)', { timeout: 30_000 }, async () => {
    const run = await runWithControls({ reviewerB: false, excellenceGovernor: false });
    expect(run.roles).toEqual(['reviewer-a']);
    expect(run.state).toBe('COMPLETED_FINDINGS');
    const findings = h.d.db
      .query<{ adjudicated: number; adjudication: string }, [string]>(`SELECT adjudicated, adjudication FROM findings WHERE job_id=?`)
      .all(run.jobId);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.adjudicated === 1)).toBe(true);
    expect(findings[0]?.adjudication).toContain('reviewer-final');
  });

  it('a changed review policy is a NEW review identity for the same snapshot', async () => {
    const g = makeGitFixture();
    const base = await engine.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'test' });
    const governed = await engine.createAndEnqueue({
      workspacePath: g.dir,
      subjectKind: 'git-head',
      source: 'test',
      controls: { reviewer: false, reviewerA: false, reviewerB: false, excellenceGovernor: true },
    });
    expect(governed.dedupeExisting).toBe(false);
    expect(governed.jobId).not.toBe(base.jobId);
    // The default policy keeps the legacy fingerprint, so a repeated default
    // enqueue still dedupes (no duplicate inference).
    const again = await engine.createAndEnqueue({ workspacePath: g.dir, subjectKind: 'git-head', source: 'test' });
    expect(again.jobId).toBe(base.jobId);
    expect(again.dedupeExisting).toBe(true);
  });

  it('persists mission controls and propagates them to a QUEUED review job', async () => {
    const g = makeGitFixture();
    const { jobId } = await engine.createAndEnqueue({
      workspacePath: g.dir,
      subjectKind: 'git-head',
      source: 'test',
      controls: { reviewerB: false },
    });
    const workspaceId = h.d.db
      .query<{ workspace_id: string }, []>(`SELECT workspace_id FROM workspaces LIMIT 1`)
      .get()!.workspace_id;
    const created = createMissionRequest(h.d, {
      workspaceId,
      objective: 'review-controls mission',
      taskGates: ['gate_a'],
      tickets: [{ title: 'task', objective: 'review-controls mission', dependsOn: [] }],
      controls: { excellenceGovernor: true, reviewerA: true, reviewerB: false },
    });
    expect(created.conflict).toBe(false);
    if (created.conflict) return;
    const revision = createRevision(h.d, { ticket_id: created.ticketIds[0]!, hypothesis_key: 'h' });
    updateRevision(h.d, revision.revision_id, { review_job_id: jobId });

    expect(getMissionReviewControls(h.d, created.missionId)).toMatchObject({
      reviewerA: true,
      reviewerB: false,
      excellenceGovernor: true,
    });

    setMissionReviewControls(h.d, created.missionId, {
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
    expect(getMissionReviewControls(h.d, created.missionId)).toMatchObject({
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
    expect(getJobReviewControls(h.d, jobId)).toMatchObject({
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
  });
});
