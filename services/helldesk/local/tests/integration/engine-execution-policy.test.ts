import { describe, it, expect, beforeEach } from 'bun:test';
import { Engine } from '../../src/engine';
import { makeTestDb, makeGitFixture } from '../helpers';
import { makeEngineReviewHook } from '../../src/engine-review-hook';
import { createFakeRunner } from '../../src/inference';

/**
 * GATE 15 — PRODUCTION review-execution selection (regression).
 *
 * Defect fixed: the mission-controller review hook hardcoded `engine.runJob()`,
 * which bypassed the scheduler's centralized `detachedWorkers` selection. Under
 * the production config (`policy.runner='kilo'`, `daemon.detachedWorkers=true`)
 * `runJob()` invokes `makeRunner()`'s in-process GUARD and fails with
 * `runner=kilo only supports detached-worker review`. The normal scheduler used
 * `detachedWorkers ? runJobWithWorkers : runJob` at main.ts — two independent
 * decision points that could diverge.
 *
 * Centralized: `executeQueuedJob()` is now the SINGLE selection point; both the
 * mission review hook and the normal scheduler call it. These tests prove that,
 * under production-like config, the mission review hook reaches the detached
 * path (`runJobWithWorkers`) and does NOT hit the kilo in-process guard.
 *
 * We intentionally do NOT spawn real detached worker processes here (that would
 * require a live Kilo worker binary + model). Instead we spy on the execution
 * methods: routing to `runJobWithWorkers` under detachedWorkers=true is exactly
 * what proves the hook avoids the in-process kilo guard. The earlier
 * vertical-slice pass (GATE 14) used a `fixture` review+runner; this suite
 * proves routing on the REAL Engine path with REAL git snapshots, so the green
 * can no longer be attributed to fake-inference-only routing.
 */
describe('GATE 15 — centralized review-execution policy (production-like config)', () => {
  let h: ReturnType<typeof makeTestDb>;
  let engine: Engine;

  beforeEach(() => {
    h = makeTestDb(); // baseline config runner 'fake'
    // Force production-like config on the parsed Config object.
    (h.cfg as { policy: { runner: string } }).policy.runner = 'kilo';
    (h.cfg as { daemon: { detachedWorkers?: boolean } }).daemon.detachedWorkers = true;
    engine = new Engine({
      d: h.d,
      config: h.cfg,
      snapshotStore: h.snapshotStore,
      reportDir: h.reportDir,
      runner: createFakeRunner(),
      resolvedModels: new Map([['inherited', { providerID: 'openai-compatible', modelID: 'demo-model' }]]),
    });
    engine.onStartup();
  });

  it('executeQueuedJob routes to runJobWithWorkers (detached) when daemon.detachedWorkers=true, NOT the in-process runJob / kilo guard', async () => {
    try {
      let runJobCalls = 0;
      let runJobWithWorkersCalls = 0;
      const origRunJob = engine.runJob.bind(engine);
      const origRunJobWithWorkers = engine.runJobWithWorkers.bind(engine);
      engine.runJob = async (jobId, signal) => { runJobCalls += 1; return origRunJob(jobId, signal); };
      engine.runJobWithWorkers = async (jobId, signal) => { runJobWithWorkersCalls += 1; return origRunJobWithWorkers(jobId, signal); };

      // Non-existent job: both paths hit a throw/early return, so only
      // SELECTION is exercised — exactly what we are proving.
      await engine.executeQueuedJob('job_g15_missing').catch(() => {});
      expect(runJobWithWorkersCalls).toBe(1); // detached path selected under detachedWorkers=true
      expect(runJobCalls).toBe(0);            // in-process runJob (the kilo guard path) NOT touched

      // Flip to legacy in-process config: selection flips too.
      (engine.config as { daemon: { detachedWorkers?: boolean } }).daemon.detachedWorkers = false;
      await engine.executeQueuedJob('job_g15_missing2').catch(() => {});
      expect(runJobCalls).toBe(1);
      expect(runJobWithWorkersCalls).toBe(1);
    } finally { h.close(); }
  });

  it('mission review hook routes through executeQueuedJob → runJobWithWorkers on a REAL git snapshot, never touches direct runJob (kilo guard unreachable)', async () => {
    const g = makeGitFixture();
    try {
      let executeCalls = 0;
      let runJobWithWorkersCalls = 0;
      // Do NOT invoke the real detached path (needs a live Kilo worker + model);
      // we only need to prove ROUTING — that the hook reaches runJobWithWorkers.
      const origExecute = engine.executeQueuedJob.bind(engine);
      engine.executeQueuedJob = async (jobId, _signal) => { executeCalls += 1; return origExecute(jobId, _signal); };
      engine.runJobWithWorkers = async () => { runJobWithWorkersCalls += 1; /* routed; stub execution */ };
      engine.runJob = async () => { throw new Error('DIRECT runJob must never be called from the review hook (in-process kilo guard)'); };

      const hook = makeEngineReviewHook(engine);
      // SubjectKind 'git-dirty' on a real git repo produces a real immutable
      // snapshot + QUEUED job, then the hook must delegate to executeQueuedJob.
      await hook({ workspacePath: g.dir, missionId: 'm_g15', ticketId: 'b_g15', revisionId: 'rev_g15' }).catch(() => {});

      expect(executeCalls).toBe(1); // the hook delegated to the centralized executor
      expect(runJobWithWorkersCalls).toBe(1); // ...which selected detached workers (runner=kilo, detachedWorkers=true)
      // The throw-on-runJob guard was never triggered: direct runJob is unreachable from the hook.
    } finally { h.close(); }
  });
});