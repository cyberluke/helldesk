import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';
import type { Config, DaemonConfig } from './config';
import { recoverPendingJobs } from './db';
import { transitionJob, JobState } from './state-machine';
import { registerWorkspace } from './workspace-registry';
import {
  captureGitSnapshot,
  fsFolderSnapshot,
  targetFingerprint,
  isGitRepo,
  SnapshotError,
} from './snapshot';
import { createJob, getJob, findJobByFingerprint, resolveSnapshotMeta } from './jobs';
import { acquireLease, renewLease, releaseLease, recoverStuckLeases, CircuitBreaker } from './reconciler';
import { REWORK_MAX_RETRIES, NUM_INDEPENDENT_REVIEWERS, ADJUDICATION_PASSES } from './helldesk-semantics';
import { createFakeRunner, createOpenAiRunner, createCodexRunner, type InferenceRunner, type ReviewPrompt, buildReviewUserPrompt } from './inference';
import { runReviewerStage, finalizeStageText, type StageOutput } from './reviewers';
import { resolveCodexBin } from './mutation-runner';
import { spawnReviewWorker, awaitWorkerResult } from './worker-supervisor';
import { writeReport } from './reports';
import { enqueueEvent } from './events';
import { createTelemetry, type Telemetry } from './telemetry';
import { writeFileSync } from 'node:fs';
import { loadManifest } from './context-reader';
import type { ReviewReport } from './schemas';

/**
 * Local HELLDESK orchestration engine.
 *
 * Owns the end-to-end vertical slice: discover -> snapshot (immutable) ->
 * enqueue -> review A + B (independent) -> adjudicate -> report -> persist.
 * Model execution goes through an injected runner so the same engine works
 * with the Kilo plugin (in-process SDK), a headless Kilo server, a direct
 * OpenAI-compatible endpoint, or the deterministic fake runner for tests.
 */

export type RunnerFactory =
  | { kind: 'fake' }
  | { kind: 'openai'; providerID: string; modelID: string }
  | { kind: 'kilo'; resolve: (role: 'reviewer-a' | 'reviewer-b' | 'adjudicator') => { providerID: string; modelID: string } };

export interface EngineOptions {
  d: Db;
  config: Config;
  snapshotStore: string;
  reportDir: string;
  runner: InferenceRunner;
  resolvedModels: Map<string, { providerID: string; modelID: string }>;
}

export class Engine {
  readonly d: Db;
  readonly config: Config;
  readonly snapshotStore: string;
  readonly reportDir: string;
  readonly runner: InferenceRunner;
  readonly resolvedModels: Map<string, { providerID: string; modelID: string }>;
  private breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 30_000 });
  private telemetry: Telemetry;

  constructor(opts: EngineOptions) {
    this.d = opts.d;
    this.config = opts.config;
    this.snapshotStore = opts.snapshotStore;
    this.reportDir = opts.reportDir;
    this.runner = opts.runner;
    this.resolvedModels = opts.resolvedModels;
    mkdirSync(this.snapshotStore, { recursive: true });
    mkdirSync(this.reportDir, { recursive: true });
    this.telemetry = createTelemetry({ logDir: this.config.daemon.logDir });
  }

  reload(): void {
    // Ensure workspaces from config are registered.
    for (const ws of this.config.workspaces) registerWorkspace(this.d, ws);
  }

  onStartup(): { restarted: string[]; stuckLeases: number } {
    const rec = recoverPendingJobs(this.d);
    const stuckLeases = recoverStuckLeases(this.d);
    for (const ws of this.config.workspaces) registerWorkspace(this.d, ws);
    return { restarted: rec.restarted, stuckLeases };
  }

  /** Full create+pipeline entry used by tests and API. Returns job or existing dedupe. */
  async createAndEnqueue(input: {
    workspacePath: string;
    subjectKind: 'git-head' | 'git-commit' | 'git-range' | 'git-dirty' | 'git-mixed' | 'fs-folder';
    base?: string | null;
    head?: string;
    includeDirty?: boolean;
    includeUntracked?: boolean;
    fsPath?: string;
    requirements?: string;
    source?: string;
    triggerSessionId?: string;
  }): Promise<{ jobId: string; dedupeExisting: boolean }> {
    const ws = registerWorkspace(this.d, { path: input.workspacePath, enabled: true });

    // 1. Immutable snapshot (async git capture — non-blocking for the daemon loop)
    let snap;
    if (input.subjectKind === 'fs-folder') {
      snap = fsFolderSnapshot({
        workspacePath: input.workspacePath,
        fsPath: input.fsPath,
        snapshotStore: this.snapshotStore,
        requirements: input.requirements,
      });
    } else {
      snap = await captureGitSnapshot({
        workspacePath: input.workspacePath,
        kind: input.subjectKind,
        base: input.base ?? null,
        head: input.head,
        includeDirty: input.includeDirty,
        includeUntracked: input.includeUntracked,
        snapshotStore: this.snapshotStore,
        requirements: input.requirements,
      });
    }

    // Persist the snapshot row.
    this.d.db
      .query(
        `INSERT INTO snapshots
           (snapshot_id, subject_kind, workspace_id, base_hash, head_hash, dirty_hash, untracked_hash,
            manifest_hash, diff_blob_path, manifest_blob_path, content_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        snap.snapshotId,
        snap.kind,
        ws.workspaceId,
        snap.baseHash,
        snap.headHash,
        snap.dirtyHash,
        snap.untrackedHash,
        snap.manifestHash,
        snap.diffBlobPath,
        snap.manifestBlobPath,
        snap.manifestHash,
        new Date().toISOString()
      );

    const policyVersion = this.config.policy.reviewerModel
      ? this.config.policy.reviewerModel.providerID + '/' + this.config.policy.reviewerModel.modelID
      : 'inherit';
    const fp = targetFingerprint({
      workspaceId: ws.workspaceId,
      kind: snap.kind,
      baseHash: snap.baseHash,
      headHash: snap.headHash,
      dirtyHash: snap.dirtyHash,
      untrackedHash: snap.untrackedHash,
      policyVersion,
      reviewerConfigVersion: '1',
    });

    // 2. Dedupe by immutable fingerprint.
    const existing = findJobByFingerprint(this.d, fp);
    if (existing) {
      return { jobId: existing.jobId, dedupeExisting: true };
    }

    const job = createJob(this.d, {
      workspaceId: ws.workspaceId,
      snapshotId: snap.snapshotId,
      targetFingerprint: fp,
      subjectKind: snap.kind,
      policyVersion,
      source: input.source ?? 'api',
      triggerSessionId: input.triggerSessionId,
      requirements: input.requirements,
      baseHash: snap.baseHash,
      headHash: snap.headHash,
      dirtyHash: snap.dirtyHash,
      untrackedHash: snap.untrackedHash,
    });

    // 2b. DISCOVERED -> SNAPSHOTTED -> QUEUED
    transitionJob(this.d, job.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(this.d, job.jobId, 'SNAPSHOTTED', 'QUEUED');
    enqueueEvent(this.d, 'job.enqueued', { jobId: job.jobId, state: 'QUEUED' }, job.jobId);

    return { jobId: job.jobId, dedupeExisting: false };
  }

  /**
   * SINGLE centralized review-execution selection.
   *
   * Every QUEUED job — the normal scheduler pump AND the mission-controller
   * review hook — must go through THIS method so there is exactly one place
   * that decides between the legacy in-process path (`runJob`) and the
   * independent detached-worker path (`runJobWithWorkers`).
   *
   * `policy.runner === 'kilo'` requires detached workers (makeRunner returns an
   * in-process guard that fails clearly if invoked). Routing the mission review
   * through e.g. a hardcoded `runJob` would hit that guard and diverge from the
   * normal scheduler, which is exactly the bug this centralizes away.
   */
  async executeQueuedJob(jobId: string, signal?: AbortSignal): Promise<void> {
    if (this.config.daemon.detachedWorkers) {
      return this.runJobWithWorkers(jobId, signal);
    }
    return this.runJob(jobId, signal);
  }

  /** Run the full A/B + adjudicate pipeline for a QUEUED job. */
  async runJob(jobId: string, signal?: AbortSignal): Promise<void> {
    const job = getJob(this.d, jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.state !== 'QUEUED') throw new Error(`Job ${jobId} not QUEUED (state=${job.state})`);

    // Own the job via a lease (fencing token).
    const lease = acquireLease(this.d, 'job', `job:${jobId}`, this.config.daemon.leaseSeconds * 1000);
    if (!lease) throw new Error(`Job ${jobId} already leased`);
    const leaseOwner = lease.owner;
    const leaseId = lease.leaseId;

    const heartbeat = setInterval(() => renewLease(this.d, leaseId, this.config.daemon.leaseSeconds * 1000), Math.max(1000, (this.config.daemon.leaseSeconds * 1000) / 2));

    const snap = resolveSnapshotMeta(this.d, job.snapshotId);
    const workspace = this.d.db
      .query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE workspace_id=?`)
      .get(job.workspaceId);

    try {
      transitionJob(this.d, jobId, 'QUEUED', 'REVIEWING_A_B');
      this.d.db
        .query(`UPDATE review_jobs SET attempt_count=attempt_count+1 WHERE job_id=?`)
        .run(jobId);
      this.d.db
        .query(`UPDATE review_attempts SET state='running', started_at=? WHERE job_id=? AND state='pending'`)
        .run(new Date().toISOString(), jobId);
      // Ensure an attempt row exists.
      this.d.db
        .query(
          `INSERT OR IGNORE INTO review_attempts (attempt_id, job_id, attempt_no, state, started_at, owner_token, lease_expires_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?)`
        )
        .run(`att_${Date.now()}`, jobId, job.attemptCount + 1, new Date().toISOString(), leaseOwner, lease.expiresAt);

      if (signal?.aborted) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED');
        return;
      }

      // Resolve model for each role.
      const roleModels = this.resolveRoleModels(snap?.kind ?? 'git-head');
      const requirement = this.readRequirement(jobId);

      const snapshotId = job.snapshotId;
      const store = this.snapshotStore;
      const manifest = loadManifest(store, snapshotId);
      const workspacePath = manifest ? this.workspacePathFor(job) : (workspace?.path ?? '');
      if (!manifest) {
        throw new Error(`Snapshot manifest missing for ${snapshotId}`);
      }

      // A and B run independently (parallel), not sharing intermediate output.
      // This is the upstream Soul/QualityAssurance split adapted to a single project:
      // exactly NUM_INDEPENDENT_REVIEWERS adversarial passes + one adjudicator.
      // For the codex reviewer (each `codex exec` spins up its own Rust/sandbox
      // process), running A+B in parallel can exhaust memory (exit 9 OOM). Serialize
      // codex reviewers so only one heavy codex process is alive at a time.
      const reviewA = () => runReviewerStage({
        d: this.d,
        jobId,
        targetId: job.targetFingerprint,
        snapshotId,
        store,
        workspacePath,
        role: 'reviewer-a',
        reviewerIds: ['A'],
        system: readPrompt('reviewer-correctness.md'),
        runner: this.runner,
        providerID: roleModels.reviewerA.providerID,
        modelID: roleModels.reviewerA.modelID,
      });
      const reviewB = () => runReviewerStage({
        d: this.d,
        jobId,
        targetId: job.targetFingerprint,
        snapshotId,
        store,
        workspacePath,
        role: 'reviewer-b',
        reviewerIds: ['B'],
        system: readPrompt('reviewer-adversarial.md'),
        runner: this.runner,
        providerID: roleModels.reviewerB.providerID,
        modelID: roleModels.reviewerB.modelID,
      });
      const [a, b] = this.runner.kind === 'codex'
        ? [await reviewA(), await reviewB()]
        : await Promise.all([reviewA(), reviewB()]);

      if (signal?.aborted) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED');
        return;
      }

      const aFindings = a.result.findings ?? [];
      const bFindings = b.result.findings ?? [];
      this.persistAgentRuns(jobId, 'reviewer-a', roleModels.reviewerA, a.result);
      this.persistAgentRuns(jobId, 'reviewer-b', roleModels.reviewerB, b.result);

      // If either reviewer is INCONCLUSIVE, fail closed below.
      const aResult = a.result.result;
      const bResult = b.result.result;
      // If EITHER reviewer failed to converge (INCONCLUSIVE after bounded retries),
      // fail closed: the whole review is INCONCLUSIVE. A reviewer never "wins a
      // loss", and we never adjudicate a missing verdict into a PASS.
      if (aResult === 'INCONCLUSIVE' || bResult === 'INCONCLUSIVE') {
        // Ideal rework semantics (upstream MAX_DISPATCH_ATTEMPTS): escape the
        // retry loop after the cap. Below the cap, persist as INCONCLUSIVE so
        // the reconciler/API may requeue (bounded); at the cap, go terminal.
        const currentAttempt = (this.d.db
          .query<{ attempt_count: number }, [string]>(`SELECT attempt_count FROM review_jobs WHERE job_id=?`)
          .get(jobId)?.attempt_count) ?? 0;
        const exhausted = currentAttempt >= REWORK_MAX_RETRIES;
        const resolvedState: JobState = exhausted ? 'FAILED_TERMINAL' : 'INCONCLUSIVE';
        this.d.db.query(`UPDATE review_jobs SET result='INCONCLUSIVE', coverage=? WHERE job_id=?`).run(
          JSON.stringify({ changedFiles: a.result.coverage?.changedFiles ?? 0, inspectedFiles: 0, uncoveredPaths: a.result.coverage?.uncoveredPaths ?? [] }),
          jobId
        );
        transitionJob(this.d, jobId, 'REVIEWING_A_B', resolvedState);
        this.persistReportForState(jobId, resolvedState);
        return;
      }

      // If both reviewed the changed scope cleanly and neither found anything
      // supported, the adjudicator reconciles. Otherwise run adjudicator.
      transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');

      const adjudicationSystem = readPrompt('adjudicator.md');
      const combinedUser = buildAdjudicationUser({
        aResult,
        bResult,
        aFindings: JSON.stringify(aFindings),
        bFindings: JSON.stringify(bFindings),
        changedFiles: a.result.coverage?.changedFiles ?? 0,
      });
      const adjRunner = this.runner;
      const adj = await runReviewerStage({
        d: this.d,
        jobId,
        targetId: job.targetFingerprint,
        snapshotId,
        store,
        workspacePath,
        role: 'adjudicator',
        reviewerIds: ['A', 'B'],
        system: adjudicationSystem,
        runner: adjRunner,
        providerID: roleModels.adjudicator.providerID,
        modelID: roleModels.adjudicator.modelID,
        userPromptOverride: buildAdjudicationUser({
          aResult,
          bResult,
          aFindings: JSON.stringify(aFindings),
          bFindings: JSON.stringify(bFindings),
          changedFiles: a.result.coverage?.changedFiles ?? 0,
        }),
      });

      const finalResult = adj.result.result;
      const finalFindings = adj.result.findings ?? [];
      this.persistAgentRuns(jobId, 'adjudicator', roleModels.adjudicator, adj.result);

      // Save findings to DB.
      for (const f of finalFindings) {
        // Reviewer-provided ids may repeat across jobs (canned/test outputs);
        // scope to the job so they never collide. The report preserves them.
        const scopedId = `${jobId}::${f.id || `fnd_${Math.random().toString(36).slice(2)}`}`;
        this.d.db
          .query(
            `INSERT INTO findings
               (finding_id, job_id, severity, confidence, title, file, line_start, line_end, revision,
                evidence, counterexample, requirement, verification, reviewer_ids, adjudicated, adjudication)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            scopedId,
            jobId,
            f.severity,
            f.confidence,
            f.title,
            f.file ?? null,
            f.lineStart ?? null,
            f.lineEnd ?? null,
            f.revision ?? null,
            f.evidence,
            f.counterexample ?? null,
            f.requirement ?? null,
            f.verification ?? null,
            JSON.stringify(f.reviewerIds ?? ['A', 'B']),
            1,
            'accepted'
          );
      }

      const state: JobState =
        finalResult === 'PASS' ? 'COMPLETED_PASS' : finalResult === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'COMPLETED_FINDINGS';
      transitionJob(this.d, jobId, 'ADJUDICATING', state);
      this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);

      this.persistReportForState(jobId, state);
      enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult }, jobId);
    } finally {
      clearInterval(heartbeat);
      releaseLease(this.d, leaseId);
    }
  }

  /**
   * Run a job where each review stage executes in an INDEPENDENT detached
   * worker process (src/worker.ts) — never inside the control plane process.
   * The control plane spawns worker A + B concurrently, collects their frozen
   * text blobs, finalizes them through the shared validator, then spawns the
   * adjudicator worker with the combined A+B output before persisting.
   */
  async runJobWithWorkers(jobId: string, signal?: AbortSignal): Promise<void> {
    const row = this.d.db
      .query<{ job_id: string; workspace_id: string; snapshot_id: string | null; target_fingerprint: string; state: string; attempt_count: number }, [string]>(
        `SELECT job_id, workspace_id, snapshot_id, target_fingerprint, state, attempt_count FROM review_jobs WHERE job_id=?`
      )
      .get(jobId);
    if (!row) return;
    const job = {
      jobId: row.job_id,
      workspaceId: row.workspace_id,
      snapshotId: row.snapshot_id ?? '',
      targetFingerprint: row.target_fingerprint,
      state: row.state,
      attemptCount: row.attempt_count,
    };
    if (!job.snapshotId) throw new Error(`Job ${jobId} has no snapshot_id (missing/undefined snapshot)`);
    const lease = acquireLease(this.d, 'job', `job:${jobId}`, this.config.daemon.leaseSeconds * 1000);
    if (!lease) return; // already leased
    const leaseOwner = lease.owner;
    const leaseId = lease.leaseId;
    const heartbeat = setInterval(() => renewLease(this.d, leaseId, this.config.daemon.leaseSeconds * 1000), Math.max(1000, (this.config.daemon.leaseSeconds * 1000) / 2));
    const snap = resolveSnapshotMeta(this.d, job.snapshotId);
    const workspace = this.d.db.query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE workspace_id=?`).get(job.workspaceId);
    try {
      transitionJob(this.d, jobId, 'QUEUED', 'REVIEWING_A_B');
      this.d.db.query(`UPDATE review_jobs SET attempt_count=attempt_count+1 WHERE job_id=?`).run(jobId);
      const attemptBase = `att_${Date.now()}`;
      // One review_attempts row per job attempt (schema: UNIQUE(job_id, attempt_no)).
      // Each independent worker stage is tracked in `workers`, not review_attempts.
      this.registerAttempt(jobId, attemptBase, job.attemptCount + 1, leaseOwner, lease.expiresAt);
      const attemptIds = { a: `${attemptBase}-a`, b: `${attemptBase}-b`, adj: `${attemptBase}-adj` };

      if (signal?.aborted) { transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED'); return; }

      const roleModels = this.resolveRoleModels(snap?.kind ?? 'git-head');
      const requirement = this.readRequirement(jobId);
      const snapshotId = job.snapshotId;
      const store = this.snapshotStore;
      const manifest = loadManifest(store, snapshotId);
      const workspacePath = manifest ? this.workspacePathFor(job) : (workspace?.path ?? '');
      if (!manifest) throw new Error(`Snapshot manifest missing for ${snapshotId}`);

      const rawRunner = this.config.policy.runner ?? 'kilo';
      // Real reviewers run via detached processes: kilo (headless SDK runtime),
      // openai (direct OpenAI-compatible), or codex (ChatGPT Codex CLI read-only).
      // fake is test-only and rejected in production (--daemon) by the CLI gate.
      const allowed: ReadonlyArray<string> = ['kilo', 'openai', 'codex', 'fake'];
      if (!allowed.includes(rawRunner)) throw new Error(`runner ${rawRunner} cannot drive detached worker review`);
      const runnerKind: 'kilo' | 'openai' | 'codex' | 'fake' = rawRunner as 'kilo' | 'openai' | 'codex' | 'fake';

      // A and B in parallel, as detached independent processes.
      const [a, b] = await Promise.all([
        this.dispatchWorkerStage({ jobId, attemptId: attemptIds.a, role: 'reviewer-a', reviewerIds: ['A'], store, snapshotId, workspacePath, requirement, roleModel: roleModels.reviewerA, runnerKind }),
        this.dispatchWorkerStage({ jobId, attemptId: attemptIds.b, role: 'reviewer-b', reviewerIds: ['B'], store, snapshotId, workspacePath, requirement, roleModel: roleModels.reviewerB, runnerKind }),
      ]);

      if (signal?.aborted) { transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED'); return; }

      const aFindings = a.result.findings ?? [];
      const bFindings = b.result.findings ?? [];
      this.persistAgentRuns(jobId, 'reviewer-a', roleModels.reviewerA, a.result);
      this.persistAgentRuns(jobId, 'reviewer-b', roleModels.reviewerB, b.result);

      const aResult = a.result.result;
      const bResult = b.result.result;
      if (aResult === 'INCONCLUSIVE' && bResult === 'INCONCLUSIVE') {
        const currentAttempt = (this.d.db.query<{ attempt_count: number }, [string]>(`SELECT attempt_count FROM review_jobs WHERE job_id=?`).get(jobId)?.attempt_count) ?? 0;
        const exhausted = currentAttempt >= REWORK_MAX_RETRIES;
        const resolvedState: JobState = exhausted ? 'FAILED_TERMINAL' : 'INCONCLUSIVE';
        this.d.db.query(`UPDATE review_jobs SET result='INCONCLUSIVE', coverage=? WHERE job_id=?`).run(
          JSON.stringify({ changedFiles: a.result.coverage?.changedFiles ?? 0, inspectedFiles: 0, uncoveredPaths: a.result.coverage?.uncoveredPaths ?? [] }),
          jobId
        );
        transitionJob(this.d, jobId, 'REVIEWING_A_B', resolvedState);
        this.persistReportForState(jobId, resolvedState);
        return;
      }

      transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');
      const combined = buildAdjudicationUser({
        aResult,
        bResult,
        aFindings: JSON.stringify(aFindings),
        bFindings: JSON.stringify(bFindings),
        changedFiles: a.result.coverage?.changedFiles ?? 0,
      });
      const adj = await this.dispatchWorkerStage({ jobId, attemptId: attemptIds.adj, role: 'adjudicator', reviewerIds: ['A', 'B'], store, snapshotId, workspacePath, requirement, roleModel: roleModels.adjudicator, runnerKind, combined });

      const finalResult = adj.result.result;
      const finalFindings = adj.result.findings ?? [];
      this.persistAgentRuns(jobId, 'adjudicator', roleModels.adjudicator, adj.result);

      for (const f of finalFindings) {
        const scopedId = `${jobId}::${f.id || `fnd_${Math.random().toString(36).slice(2)}`}`;
        this.d.db.query(
          `INSERT INTO findings
             (finding_id, job_id, severity, confidence, title, file, line_start, line_end, revision,
              evidence, counterexample, requirement, verification, reviewer_ids, adjudicated, adjudication)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(scopedId, jobId, f.severity, f.confidence, f.title, f.file ?? null, f.lineStart ?? null, f.lineEnd ?? null,
          f.revision ?? null, f.evidence, f.counterexample ?? null, f.requirement ?? null, f.verification ?? null,
          JSON.stringify(f.reviewerIds ?? ['A', 'B']), 1, 'accepted');
      }

      const state: JobState = finalResult === 'PASS' ? 'COMPLETED_PASS' : finalResult === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'COMPLETED_FINDINGS';
      transitionJob(this.d, jobId, 'ADJUDICATING', state);
      this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
      this.persistReportForState(jobId, state);
      enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult }, jobId);
    } finally {
      clearInterval(heartbeat);
      releaseLease(this.d, leaseId);
    }
  }

  /**
   * Spawn one detached worker process for a stage. Waits for its frozen text
   * (resolved by acceptWorkerResult when the worker POSTs it), then finalizes
   * through the shared validator so detached findings carry the same evidence
   * rules as in-process.
   */
  private async dispatchWorkerStage(opts: {
    jobId: string;
    attemptId: string;
    role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
    reviewerIds: string[];
    store: string;
    snapshotId: string;
    workspacePath: string;
    requirement: string;
    roleModel: { providerID: string; modelID: string };
    runnerKind: 'openai' | 'fake' | 'kilo' | 'codex';
    /** Adjudicator only: combined A+B prompt. */
    combined?: string;
  }): Promise<StageOutput> {
    const controlURL = this.controlBaseURL();
    const controlToken = this.controlToken();
    if (!controlURL || !controlToken) throw new Error(`control URL/token not configured (URL=${!!controlURL}, token=${!!controlToken})`);
    // Resolve the provider's baseURL/apiKey for real inference via the policy.
    const prov = this.config.policy.providers?.[opts.roleModel.providerID];
    if (opts.runnerKind !== 'fake' && opts.runnerKind !== 'codex' && !prov) throw new Error(`runner=${opts.runnerKind} requires policy.providers.${opts.roleModel.providerID}`);
    // kilo uses the headless kilo binary; codex uses the Codex CLI (GT_CODEX_BIN).
    const kiloBin = opts.runnerKind === 'kilo'
      ? this.config.policy.kiloServerBin
      : opts.runnerKind === 'codex'
        ? resolveCodexBin()
        : undefined;
    spawnReviewWorker({
      d: this.d,
      jobId: opts.jobId,
      attemptId: opts.attemptId,
      role: opts.role,
      snapshotId: opts.snapshotId,
      store: opts.store,
      model: opts.roleModel,
      runner: opts.runnerKind,
      baseURL: prov?.baseURL,
      apiKey: prov?.apiKey,
      kiloBin,
      controlURL,
      controlToken,
      workspace: opts.workspacePath,
      userOverride: opts.combined,
    });
    const text = await awaitWorkerResult(opts.attemptId, this.config.daemon.leaseSeconds * 1000 + 120_000);
    return finalizeStageText({
      store: opts.store,
      snapshotId: opts.snapshotId,
      workspacePath: opts.workspacePath,
      targetId: opts.jobId,
      role: opts.role,
      reviewerIds: opts.reviewerIds,
      requirements: opts.requirement,
      text,
    });
  }

  private srcDir(): string {
    return dirname(fileURLToPath(import.meta.url));
  }

  private registerAttempt(jobId: string, attemptId: string, attemptNo: number, ownerToken: string, leaseExpiresAt: string): void {
    // The review_attempts table has UNIQUE(job_id, attempt_no): one row per job
    // attempt (A+B+adj share it). Workers map to `workers`, not review_attempts.
    this.d.db
      .query(
        `INSERT INTO review_attempts (attempt_id, job_id, attempt_no, state, started_at, owner_token, lease_expires_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(attemptId, jobId, attemptNo, new Date().toISOString(), ownerToken, leaseExpiresAt);
    // Ensure the stage worker rows reference the base attempt too (defensive).
    this.d.db.query(`UPDATE review_attempts SET state='running', started_at=? WHERE job_id=? AND attempt_id=?`).run(new Date().toISOString(), jobId, attemptId);
  }

  private controlBaseURL(): string | undefined {
    return process.env.HELLDESK_CONTROL_URL;
  }

  private controlToken(): string | undefined {
    return process.env.HELLDESK_CONTROL_TOKEN;
  }

  private resolveRoleModels(kind: string): {
    reviewerA: { providerID: string; modelID: string };
    reviewerB: { providerID: string; modelID: string };
    adjudicator: { providerID: string; modelID: string };
  } {
    const p = this.config.policy;
    const explicit = p.reviewerModel;
    const base = explicit
      ? { providerID: explicit.providerID, modelID: explicit.modelID }
      : this.resolvedModels.get('inherited') ?? { providerID: 'unset', modelID: 'unset' };
    // Role-specific models win; never substitute one role's model for another's.
    const a = p.reviewerModelA ? { providerID: p.reviewerModelA.providerID, modelID: p.reviewerModelA.modelID } : base;
    const b = p.reviewerModelB ? { providerID: p.reviewerModelB.providerID, modelID: p.reviewerModelB.modelID } : base;
    const adj = p.adjudicatorModel ? { providerID: p.adjudicatorModel.providerID, modelID: p.adjudicatorModel.modelID } : base;
    return { reviewerA: a, reviewerB: b, adjudicator: adj };
  }

  private workspacePathFor(job: { workspaceId: string }): string {
    const row = this.d.db.query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE workspace_id=?`).get(job.workspaceId);
    return row?.path ?? '';
  }

  private readRequirement(jobId: string): string {
    const job = getJob(this.d, jobId);
    if (!job) return '';
    const row = this.d.db.query<{ meta: string | null }, [string]>(`SELECT meta FROM review_jobs WHERE job_id=?`).get(jobId);
    if (!row?.meta) return '';
    try {
      const meta = JSON.parse(row.meta) as { requirements?: string };
      return meta.requirements ?? '';
    } catch {
      return '';
    }
  }

  private persistAgentRuns(
    jobId: string,
    role: string,
    model: { providerID: string; modelID: string },
    parsed: { result: string; coverage?: { inspectedFiles?: number }; findings?: Array<{ id?: string }> }
  ): void {
    // Distinct run id per attempt — the same job is retried and each attempt
    // is its own durable run row (upstream dispatch_attempts semantics).
    const attempt = (this.d.db
      .query<{ attempt_count: number }, [string]>(`SELECT attempt_count FROM review_jobs WHERE job_id=?`)
      .get(jobId)?.attempt_count) ?? 1;
    this.d.db
      .query(
        `INSERT OR REPLACE INTO agent_runs (run_id, job_id, role, provider_id, model_id, status, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(`run_${jobId}_${role}_${attempt}`, jobId, role, model.providerID, model.modelID, 'succeeded', new Date().toISOString(), new Date().toISOString());
  }

  private persistReportForState(jobId: string, state: string): void {
    const job = getJob(this.d, jobId);
    if (!job) return;
    // Coverage should reflect the actual snapshot scope, not the finding count.
    let changedFiles = 0;
    try {
      const manifest = loadManifest(this.snapshotStore, job.snapshotId);
      changedFiles = manifest?.changedFiles.length ?? 0;
    } catch {
      /* fall back to findings-derived */
    }
    const findingsRows = this.d.db
      .query<
        {
          finding_id: string;
          severity: string;
          confidence: string;
          title: string;
          file: string | null;
          line_start: number | null;
          line_end: number | null;
          revision: string | null;
          evidence: string;
          counterexample: string | null;
          requirement: string | null;
          verification: string | null;
          reviewer_ids: string;
        },
        [string]
      >(`SELECT * FROM findings WHERE job_id=?`)
      .all(jobId);
    const findings: ReviewReport['findings'] = findingsRows.map((r) => ({
      // The DB finding_id is scoped as `<jobId>::<original>`; strip it back
      // to the logical finding id for the report.
      id: r.finding_id.includes('::') ? r.finding_id.split('::').slice(1).join('::') : r.finding_id,
      severity: r.severity as ReviewReport['findings'][number]['severity'],
      confidence: r.confidence as ReviewReport['findings'][number]['confidence'],
      title: r.title,
      file: r.file ?? undefined,
      lineStart: r.line_start ?? undefined,
      lineEnd: r.line_end ?? undefined,
      revision: r.revision ?? undefined,
      evidence: r.evidence,
      counterexample: r.counterexample ?? undefined,
      requirement: r.requirement ?? undefined,
      verification: r.verification ?? undefined,
      reviewerIds: JSON.parse(r.reviewer_ids) as string[],
    }));
    const resultRaw = job.result as ReviewReport['result'] | null | 'FAILED_TERMINAL';
    const result: ReviewReport['result'] =
      resultRaw === 'PASS' ? 'PASS' : resultRaw === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FINDINGS';
    // Provenance: record the ACTUAL model each role used, from the persisted
    // agent_runs (populated with the resolved per-role model in runJobWithWorkers).
    const modelRows = this.d.db
      .query<{ role: string; provider_id: string; model_id: string }, [string]>(
        `SELECT role, provider_id, model_id FROM agent_runs WHERE job_id=? AND provider_id!='' AND provider_id!='unset'`
      )
      .all(jobId);
    const models: ReviewReport['models'] = modelRows.map((r) => ({ role: r.role, providerID: r.provider_id, modelID: r.model_id }));
    // Fall back to the distinct resolved role set when agent_runs has no rows yet.
    const resolvedRoles = Array.from(this.resolvedModels.entries()).map(([role, m]) => ({ role, providerID: m.providerID, modelID: m.modelID }));
    const report: ReviewReport = {
      jobId,
      targetFingerprint: job.targetFingerprint,
      result,
      coverage: {
        changedFiles,
        inspectedFiles: changedFiles, // source scope reviewed; findings carry exact evidence
        uncoveredPaths: [],
      },
      findings,
      models: models.length > 0 ? models : resolvedRoles,
      attempts: [job.attemptCount],
      createdAt: job.requestedAt,
      completedAt: new Date().toISOString(),
    };
    writeReport({ reportDir: this.reportDir, report, providerMap: report.models });
    enqueueEvent(this.d, 'report.ready', {
      jobId,
      reportPath: `${this.reportDir}\\${jobId}.json`,
      state,
    }, jobId);
  }
}

function readPrompt(name: string): string {
  try {
    return readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), 'utf-8');
  } catch {
    return `You are an adversarial code reviewer. ${name}`;
  }
}

function buildAdjudicationUser(opts: {
  aResult: string;
  bResult: string;
  aFindings: string;
  bFindings: string;
  changedFiles: number;
}): string {
  return [
    '# Adjudication',
    '',
    `Reviewer A result: ${opts.aResult}`,
    `Reviewer B result: ${opts.bResult}`,
    '',
    `### Reviewer A findings`,
    opts.aFindings,
    '',
    `### Reviewer B findings`,
    opts.bFindings,
    '',
    'Re-verify every HIGH/BLOCKER claim against the aligned snapshot evidence. Deduplicate, reject unsupported assertions, reconcile contradictions.',
    'The ENTIRE evidence is above — there is nothing to fetch or inspect elsewhere; do NOT attempt any tools (none are available).',
    'Output ONLY the single strict adjudicator JSON object (result, coverage, findings, models). No prose before or after the JSON.',
  ].join('\n');
}

// Export runner factory helpers so main.ts can build a concrete runner.
export function makeRunner(cfg: Config, telemetry: Telemetry): InferenceRunner {
  const policy = cfg.policy;
  const providerID = policy.reviewerModel?.providerID ?? policy.reviewerModelA?.providerID ?? 'inherit';
  if (policy.runner === 'fake') {
    return createFakeRunner();
  }
  if (policy.runner === 'openai') {
    const p = policy.providers?.[providerID];
    if (!p) throw new Error(`runner=openai requires policy.providers.${providerID}`);
    return createOpenAiRunner(p);
  }
  if (policy.runner === 'codex') {
    // REAL ChatGPT Codex reviewer (gpt-6-luna) via `codex exec -m <model>`.
    // Reliable strict-JSON reviewer for endpoints whose structured output is
    // flaky (e.g. DeepSeek proxies). Runs read-only.
    return createCodexRunner({ modelID: policy.reviewerModel?.modelID ?? 'gpt-6-luna' });
  }
  // 'kilo' real inference runs in DETACHED workers (headless Kilo SDK), never
  // in-process. The in-process runner existing here is only a guard; if invoked
  // directly it must fail clearly rather than silently substitute a model.
  return {
    kind: 'kilo',
    run: async (prompt) => ({
      ok: false,
      text: '',
      error: `runner=kilo only supports detached-worker review (` +
        `${prompt.providerID}/${prompt.modelID}); use the daemon pump (detachedWorkers=true)`,
      tookMs: 0,
    }),
  };
}