import { mkdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
import { createJob, getJob, findJobByFingerprint, resolveSnapshotMeta, getJobReviewControls } from './jobs';
import { describeReviewPolicy, effectiveReviewStages, reviewControlsFingerprint, type EffectiveReviewStages, type ReviewControls } from './review-controls';
import { computeTokenCost } from './pricing';
import {
  buildSizingUser,
  cacheTaskSize,
  cachedTaskSize,
  sizerSystem,
  sizeTask as runTaskSizer,
  TASK_SIZE_JSON_SCHEMA,
  TaskSizeSchema,
  taskSpecHash,
  TSHIRT_POINTS,
  unsizedTaskSize,
  type TaskSizeResult,
  type TaskSizeSpec,
} from './task-sizer';
import { extractJsonObject } from './json-extract';
import { acquireLease, renewLease, releaseLease, recoverStuckLeases, CircuitBreaker } from './reconciler';
import { REWORK_MAX_RETRIES, NUM_INDEPENDENT_REVIEWERS, ADJUDICATION_PASSES } from './helldesk-semantics';
import { createFakeRunner, createOpenAiRunner, createCodexRunner, type InferenceRunner, type ReviewPrompt, buildReviewUserPrompt } from './inference';
import { runReviewerStage, finalizeStageText, type StageOutput } from './reviewers';
import { resolveCodexBin } from './mutation-runner';
import { resolveKiloProviderOptions } from './config-resolve';
import { resolveKiloBinary } from './kilo-binary';
import { resolveContextBudget } from './context-tiers';
import { spawnReviewWorker, awaitWorkerResult } from './worker-supervisor';
import { writeReport } from './reports';
import { enqueueEvent } from './events';
import { REVIEW_MAX_ATTEMPTS } from './review-retry';
import { generateId } from './ids';
import { createTelemetry, type Telemetry } from './telemetry';
import { writeFileSync } from 'node:fs';
import { loadManifest } from './context-reader';
import type { ReviewReport, SubjectKind } from './schemas';

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
  | { kind: 'kilo'; resolve: (role: 'reviewer-a' | 'reviewer-b' | 'adjudicator' | 'governor') => { providerID: string; modelID: string } };

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

  onStartup(): { restarted: string[]; stuckLeases: number; mutationLeases: number } {
    // A control-plane restart orphans any worker it had spawned; their rows would
    // otherwise read 'running' forever and the crew/status would lie. They cannot
    // be tracked by this process, so close them honestly (a late result is fenced
    // as stale by acceptWorkerResult).
    this.d.db
      .query(
        `UPDATE workers SET status='terminated', finished_at=COALESCE(finished_at, ?), error=COALESCE(error, 'orphaned by control-plane restart') WHERE status IN ('running','launching')`
      )
      .run(new Date().toISOString());
    const rec = recoverPendingJobs(this.d);
    const stuckLeases = recoverStuckLeases(this.d);
    // The mutation writer lease is held by THIS process (advanceMission runs
    // in-process). After a restart the old holder is gone, so waiting for its
    // 10-minute TTL / 3-minute heartbeat only stalls the mission. The singleton
    // lock guarantees no other daemon owns it: clear it on startup.
    const mutationLeases = this.d.db
      .query(`DELETE FROM leases WHERE leasee='mutation-writer'`)
      .run().changes;
    for (const ws of this.config.workspaces) registerWorkspace(this.d, ws);
    return { restarted: rec.restarted, stuckLeases, mutationLeases };
  }

  /** Full create+pipeline entry used by tests and API. Returns job or existing dedupe. */
  async createAndEnqueue(input: {
    /** Per-task review policy: reviewerA/reviewerB/excellenceGovernor/agents. */
    controls?: ReviewControls;
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

    const policyVersion = this.reviewPolicyVersion();
    const fp = targetFingerprint({
      workspaceId: ws.workspaceId,
      kind: snap.kind,
      baseHash: snap.baseHash,
      headHash: snap.headHash,
      dirtyHash: snap.dirtyHash,
      untrackedHash: snap.untrackedHash,
      policyVersion,
      // A different review-role policy is a different review identity for the
      // SAME snapshot: a toggle must be able to produce a new verdict.
      reviewerConfigVersion: reviewControlsFingerprint(input.controls),
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
      controls: input.controls,
    });

    // 2b. DISCOVERED -> SNAPSHOTTED -> QUEUED
    transitionJob(this.d, job.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(this.d, job.jobId, 'SNAPSHOTTED', 'QUEUED');
    enqueueEvent(this.d, 'job.enqueued', { jobId: job.jobId, state: 'QUEUED' }, job.jobId);

    return { jobId: job.jobId, dedupeExisting: false };
  }

  /**
   * Explicit operator re-review of the SAME immutable snapshot with the CURRENT
   * review policy. A fresh job is created (the previous verdict/findings stay in
   * the audit trail); the caller links the revision to the new job.
   *
   * This is what the "Re-review now" button uses when the operator changes
   * Reviewer A/B/Governor mid-flight. It never invents a new snapshot.
   */
  /**
   * Small structured-JSON T-shirt sizing pass (task creation / backfill).
   * A timeout or provider error returns `unsized`; callers must never block a
   * task on it.
   */
  async sizeTask(spec: TaskSizeSpec, opts?: { timeoutMs?: number }): Promise<TaskSizeResult> {
    const cached = cachedTaskSize(this.d, spec);
    if (cached) return cached;
    const policy = this.config.policy;
    const model =
      policy.sizingModel ??
      policy.reviewerModel ??
      this.resolvedModels.get('inherited') ??
      null;
    const timeoutMs = opts?.timeoutMs ?? this.config.policy.sizingTimeoutMs ?? 8_000;
    if (this.runner.kind === 'kilo') {
      return this.sizeTaskDetached(spec, model, timeoutMs);
    }
    return runTaskSizer(this.d, this.runner, spec, {
      providerID: model?.providerID ?? null,
      modelID: model?.modelID ?? null,
      timeoutMs,
    });
  }

  /**
   * Kilo inference only works from a detached worker (the headless SDK owns the
   * provider auth). Spawn the tiny sizer worker with the same provider route and
   * enforce the operator-facing 8s cap. A timeout is reported as unsized.
   */
  private async sizeTaskDetached(
    spec: TaskSizeSpec,
    model: { providerID: string; modelID: string } | null,
    timeoutMs: number,
  ): Promise<TaskSizeResult> {
    if (!model?.providerID || !model.modelID) return unsizedTaskSize('no sizing model configured');
    const prov =
      this.config.policy.providers?.[model.providerID] ??
      resolveKiloProviderOptions(model.providerID) ??
      undefined;
    if (!prov) return unsizedTaskSize(`no provider endpoint for ${model.providerID}`);
    const kiloBin = this.config.policy.kiloServerBin || resolveKiloBinary()?.path || '';
    if (!kiloBin) return unsizedTaskSize('kilo binary not resolved');

    const dir = join(this.snapshotStore, '_sizing');
    mkdirSync(dir, { recursive: true });
    const hash = taskSpecHash(spec);
    const systemFile = join(dir, `${hash}.system.txt`);
    const userFile = join(dir, `${hash}.user.txt`);
    const schemaFile = join(dir, `${hash}.schema.json`);
    const resultFile = join(dir, `${hash}.result.json`);
    writeFileSync(systemFile, sizerSystem(), 'utf8');
    writeFileSync(userFile, buildSizingUser(spec), 'utf8');
    writeFileSync(schemaFile, JSON.stringify(TASK_SIZE_JSON_SCHEMA), 'utf8');
    try { unlinkSync(resultFile); } catch { /* no stale result */ }

    const budget = resolveContextBudget({
      context: this.config.context,
      providerID: model.providerID,
      modelID: model.modelID,
    });
    const args = [
      join(import.meta.dir, 'sizer-worker.ts'),
      '--model', `${model.providerID}/${model.modelID}`,
      '--baseURL', prov.baseURL ?? '',
      '--kiloBin', kiloBin,
      '--store', this.snapshotStore,
      '--directory', dir,
      '--systemFile', systemFile,
      '--userFile', userFile,
      '--schemaFile', schemaFile,
      '--resultFile', resultFile,
      '--contextWindow', String(budget.contextWindow),
      '--maxOutputTokens', String(Math.min(budget.outputBudgetTokens, 8_192)),
    ];
    // Never put a provider secret on argv (visible in the process list). The
    // child reads it from its own environment only.
    const childEnv = { ...process.env, ...(prov.apiKey ? { HELLDESK_SIZER_API_KEY: prov.apiKey } : {}) };

    const outcome = await new Promise<{ timedOut: boolean; code: number | null }>((resolve) => {
      const child = spawn('bun', args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, env: childEnv });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* best effort */ }
        resolve({ timedOut: true, code: null });
      }, timeoutMs);
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code: -1 });
      });
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, code });
      });
    });
    if (outcome.timedOut) return unsizedTaskSize(`sizing timed out after ${timeoutMs}ms`);
    if (!existsSync(resultFile)) return unsizedTaskSize(`sizer worker exited ${outcome.code} without a result`);
    let raw: { ok?: boolean; text?: string; structured?: unknown; error?: string };
    try {
      raw = JSON.parse(readFileSync(resultFile, 'utf8')) as typeof raw;
    } catch (error) {
      return unsizedTaskSize(`sizer worker result unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw.ok) return unsizedTaskSize(raw.error ?? 'sizer inference failed');
    let parsed: z.infer<typeof TaskSizeSchema>;
    try {
      parsed = TaskSizeSchema.parse(raw.structured ?? extractJsonObject(raw.text ?? ''));
    } catch (error) {
      return unsizedTaskSize(`invalid sizing JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const modelName = `${model.providerID}/${model.modelID}`;
    cacheTaskSize(this.d, spec, parsed, modelName);
    return {
      state: 'sized',
      tshirt: parsed.tshirt,
      points: TSHIRT_POINTS[parsed.tshirt],
      confidence: parsed.confidence,
      rationale: parsed.rationale,
      model: modelName,
      cached: false,
    };
  }

  async reReviewSnapshot(input: {
    jobId: string;
    controls: ReviewControls;
    source?: string;
  }): Promise<{ jobId: string; previousJobId: string }> {
    const previous = getJob(this.d, input.jobId);
    if (!previous) throw new Error(`job not found: ${input.jobId}`);
    const snap = this.d.db
      .query<
        {
          subject_kind: string;
          base_hash: string | null;
          head_hash: string | null;
          dirty_hash: string | null;
          untracked_hash: string | null;
        },
        [string]
      >(`SELECT subject_kind, base_hash, head_hash, dirty_hash, untracked_hash FROM snapshots WHERE snapshot_id=?`)
      .get(previous.snapshotId);
    if (!snap) throw new Error(`snapshot not found for job ${input.jobId}`);
    const metaRow = this.d.db.query<{ meta: string | null }, [string]>('SELECT meta FROM review_jobs WHERE job_id=?').get(input.jobId);
    let meta: Record<string, unknown> = {};
    try { meta = metaRow?.meta ? (JSON.parse(metaRow.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
    const policyVersion = this.reviewPolicyVersion();
    const fp = targetFingerprint({
      workspaceId: previous.workspaceId,
      kind: snap.subject_kind as SubjectKind,
      baseHash: snap.base_hash,
      headHash: snap.head_hash,
      dirtyHash: snap.dirty_hash,
      untrackedHash: snap.untracked_hash,
      policyVersion,
      // A re-review is a distinct attempt even under an identical policy.
      reviewerConfigVersion: `${reviewControlsFingerprint(input.controls)}|rr:${Date.now()}-${generateId().slice(0, 8)}`,
    });
    const job = createJob(this.d, {
      workspaceId: previous.workspaceId,
      snapshotId: previous.snapshotId,
      targetFingerprint: fp,
      subjectKind: snap.subject_kind as SubjectKind,
      policyVersion,
      source: input.source ?? 'mission-re-review',
      requirements: typeof meta.requirements === 'string' ? meta.requirements : undefined,
      baseHash: snap.base_hash,
      headHash: snap.head_hash,
      dirtyHash: snap.dirty_hash,
      untrackedHash: snap.untracked_hash,
      controls: input.controls,
    });
    transitionJob(this.d, job.jobId, 'DISCOVERED', 'SNAPSHOTTED');
    transitionJob(this.d, job.jobId, 'SNAPSHOTTED', 'QUEUED');
    enqueueEvent(this.d, 'job.enqueued', { jobId: job.jobId, state: 'QUEUED', reReviewOf: input.jobId }, job.jobId);
    return { jobId: job.jobId, previousJobId: input.jobId };
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

  /** Stop the retry loop at the budget. The job and its attempts stay visible
   *  in Observability; a terminal job is not silently requeued forever. */
  failRetryBudget(jobId: string): void {
    const now = new Date().toISOString();
    this.d.db
      .query(`UPDATE review_jobs SET state='FAILED_TERMINAL', result=?, completed_at=?, updated_at=? WHERE job_id=?`)
      .run(JSON.stringify({ error: 'review_retry_budget_exhausted', maxAttempts: REVIEW_MAX_ATTEMPTS }), now, now, jobId);
    enqueueEvent(this.d, 'job.retry_budget_exhausted', { jobId, maxAttempts: REVIEW_MAX_ATTEMPTS }, jobId);
  }

  /** Run the full A/B + adjudicate pipeline for a QUEUED job. */
  async runJob(jobId: string, signal?: AbortSignal): Promise<void> {
    const job = getJob(this.d, jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Own the job via a lease (fencing token).
    const lease = acquireLease(this.d, 'job', `job:${jobId}`, this.config.daemon.leaseSeconds * 1000);
    if (!lease) throw new Error(`Job ${jobId} already leased`);
    const leaseOwner = lease.owner;
    const leaseId = lease.leaseId;
    // Same stale-intermediate recovery as the detached path: once we hold the
    // lease no live attempt owns the job, so a crashed/timed-out REVIEWING_A_B or
    // ADJUDICATING job is requeued instead of throwing on a strict transition.
    if (job.state !== 'QUEUED') {
      this.d.db.query(`UPDATE review_jobs SET state='QUEUED', updated_at=? WHERE job_id=?`).run(new Date().toISOString(), jobId);
      enqueueEvent(this.d, 'job.requeued', { jobId, from: job.state, reason: 'stale-intermediate-recovery' }, jobId);
    }

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

      // Per-task review policy. A and B are independently toggleable; the
      // ExcellenceGovernor stage can run on top of them (adjudicator) or alone
      // (one independent governor review) when both A and B are disabled.
      const controls = effectiveReviewStages(getJobReviewControls(this.d, jobId));
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
        promptCharBudget: this.contextPromptBudget(roleModels.reviewerA),
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
        promptCharBudget: this.contextPromptBudget(roleModels.reviewerB),
      });
      // For the codex reviewer (each `codex exec` spins up its own Rust/sandbox
      // process), running A+B in parallel can exhaust memory (exit 9 OOM).
      // Serialize codex reviewers so only one heavy codex process is alive at a time.
      let a: StageOutput | null = null;
      let b: StageOutput | null = null;
      if (controls.reviewerA && controls.reviewerB) {
        [a, b] = this.runner.kind === 'codex'
          ? [await reviewA(), await reviewB()]
          : await Promise.all([reviewA(), reviewB()]);
      } else if (controls.reviewerA) {
        a = await reviewA();
      } else if (controls.reviewerB) {
        b = await reviewB();
      } else if (!controls.governor) {
        throw new Error('review policy disabled every review stage (validation must reject this before dispatch)');
      }

      if (signal?.aborted) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED');
        return;
      }

      const ran = [a, b].filter((s): s is StageOutput => s !== null);
      // runReviewerStage persists the ACTUAL attempt row (with tokens); a second
      // persistAgentRuns row would double-count usage and cost.

      // If either enabled reviewer failed to converge (INCONCLUSIVE after bounded
      // retries), fail closed: a reviewer never "wins a loss" by being absent.
      if (ran.some((s) => s.result.result === 'INCONCLUSIVE')) {
        const currentAttempt = (this.d.db
          .query<{ attempt_count: number }, [string]>(`SELECT attempt_count FROM review_jobs WHERE job_id=?`)
          .get(jobId)?.attempt_count) ?? 0;
        const exhausted = currentAttempt >= REWORK_MAX_RETRIES;
        const resolvedState: JobState = exhausted ? 'FAILED_TERMINAL' : 'INCONCLUSIVE';
        this.d.db.query(`UPDATE review_jobs SET result='INCONCLUSIVE', coverage=? WHERE job_id=?`).run(
          JSON.stringify({ changedFiles: ran[0]?.result.coverage?.changedFiles ?? 0, inspectedFiles: 0, uncoveredPaths: ran[0]?.result.coverage?.uncoveredPaths ?? [] }),
          jobId
        );
        transitionJob(this.d, jobId, 'REVIEWING_A_B', resolvedState);
        this.persistReportForState(jobId, resolvedState);
        return;
      }

      // ExcellenceGovernor only: one independent governor review, no A/B layer.
      if (ran.length === 0) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');
        const gov = await runReviewerStage({
          d: this.d,
          jobId,
          targetId: job.targetFingerprint,
          snapshotId,
          store,
          workspacePath,
          role: 'governor',
          reviewerIds: ['GOV'],
          system: readPrompt('governor.md'),
          runner: this.runner,
          providerID: roleModels.governor.providerID,
          modelID: roleModels.governor.modelID,
          promptCharBudget: this.contextPromptBudget(roleModels.governor),
        });
        const finalResult = gov.result.result;
        this.persistFindings(jobId, gov.result.findings ?? [], ['GOV'], true, 'governor-final');
        const state = reviewStateFor(finalResult);
        transitionJob(this.d, jobId, 'ADJUDICATING', state);
        this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
        this.persistReportForState(jobId, state);
        enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult, policy: 'governor-only' }, jobId);
        return;
      }

      const aResult = a?.result.result ?? 'NOT_RUN';
      const bResult = b?.result.result ?? 'NOT_RUN';
      const aFindings = a?.result.findings ?? [];
      const bFindings = b?.result.findings ?? [];
      const changedFiles = ran[0]?.result.coverage?.changedFiles ?? 0;

      if (controls.governor) {
        // The governor adjudicates the independent review(s) that actually ran.
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');
        const disabledReviewers = [
          ...(a ? [] : (['A'] as const)),
          ...(b ? [] : (['B'] as const)),
        ];
        const combinedUser = buildAdjudicationUser({
          aResult,
          bResult,
          aFindings: JSON.stringify(aFindings),
          bFindings: JSON.stringify(bFindings),
          changedFiles,
          disabledReviewers,
        });
        const adj = await runReviewerStage({
          d: this.d,
          jobId,
          targetId: job.targetFingerprint,
          snapshotId,
          store,
          workspacePath,
          role: 'adjudicator',
          reviewerIds: [...(a ? ['A'] : []), ...(b ? ['B'] : [])],
          system: readPrompt('adjudicator.md'),
          runner: this.runner,
          providerID: roleModels.adjudicator.providerID,
          modelID: roleModels.adjudicator.modelID,
          userPromptOverride: combinedUser,
          promptCharBudget: this.contextPromptBudget(roleModels.adjudicator),
        });
        const finalResult = adj.result.result;
        this.persistFindings(jobId, adj.result.findings ?? [], [...(a ? ['A'] : []), ...(b ? ['B'] : [])], true, 'accepted');
        const state = reviewStateFor(finalResult);
        transitionJob(this.d, jobId, 'ADJUDICATING', state);
        this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
        this.persistReportForState(jobId, state);
        enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult }, jobId);
        return;
      }

      // Governor disabled: the enabled reviewers' verdicts are FINAL. PASS only
      // when every enabled reviewer passed; any FINDINGS is a finding verdict.
      const finalResult = ran.some((s) => s.result.result === 'FINDINGS')
        ? 'FINDINGS'
        : ran.every((s) => s.result.result === 'PASS')
          ? 'PASS'
          : 'INCONCLUSIVE';
      this.persistFindings(
        jobId,
        ran.flatMap((s) => s.result.findings ?? []),
        [],
        true,
        'reviewer-final (governor disabled by operator policy)',
      );
      const state = reviewStateFor(finalResult);
      transitionJob(this.d, jobId, 'REVIEWING_A_B', state);
      this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
      this.persistReportForState(jobId, state);
      enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult, policy: 'reviewers-only' }, jobId);
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
      // RECOVERY: a previous attempt can die mid-pipeline (worker timeout or a
      // crashed worker process), leaving the job in REVIEWING_A_B/ADJUDICATING
      // with no live lease. Callers (the mission review hook, the scheduler)
      // re-invoke executeQueuedJob for that job; a strict QUEUED->REVIEWING_A_B
      // transition would then throw FOREVER ("Invalid review_job transition:
      // ADJUDICATING -> REVIEWING_A_B", observed as an infinite tick loop).
      // Because acquireLease above succeeded, no live attempt owns this job, so
      // it is safe to requeue and re-run the full A/B + adjudication pipeline.
      if (job.state !== 'QUEUED') {
        this.d.db.query(`UPDATE review_jobs SET state='QUEUED', updated_at=? WHERE job_id=?`).run(new Date().toISOString(), jobId);
        enqueueEvent(this.d, 'job.requeued', { jobId, from: job.state, reason: 'stale-intermediate-recovery' }, jobId);
      }
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

      // Per-task review policy (reviewerA / reviewerB / excellenceGovernor).
      const controls = effectiveReviewStages(getJobReviewControls(this.d, jobId));
      // REUSE ON RETRY: the job's snapshot is frozen, so a stage result that
      // already SUCCEEDED for THIS job is still valid. A retry after the other
      // reviewer timed out must re-run only the failed role, not both (observed:
      // duplicate A/B inferences after every timeout, doubling review latency).
      const reusableStage = (role: 'reviewer-a' | 'reviewer-b' | 'adjudicator' | 'governor'): StageOutput | null => {
        try {
          const run = this.d.db
            .query<{ raw_output_path: string | null }, [string, string]>(
              `SELECT raw_output_path FROM agent_runs WHERE job_id=? AND role=? AND status='succeeded' AND raw_output_path IS NOT NULL ORDER BY rowid DESC LIMIT 1`
            )
            .get(jobId, role);
          if (!run?.raw_output_path) return null;
          const text = (JSON.parse(readFileSync(run.raw_output_path, 'utf8')) as { text?: string }).text;
          if (!text?.trim()) return null;
          return finalizeStageText({
            store,
            snapshotId,
            workspacePath,
            targetId: jobId,
            role,
            reviewerIds: role === 'reviewer-a' ? ['A'] : role === 'reviewer-b' ? ['B'] : role === 'governor' ? ['GOV'] : ['A', 'B'],
            requirements: requirement,
            text,
          });
        } catch {
          return null;
        }
      };
      const reusedA = controls.reviewerA ? reusableStage('reviewer-a') : null;
      const reusedB = controls.reviewerB ? reusableStage('reviewer-b') : null;
      const dispatchReviewer = async (
        role: 'reviewer-a' | 'reviewer-b',
        attemptId: string,
        reviewerIds: string[],
        roleModel: { providerID: string; modelID: string },
        reused: StageOutput | null
      ): Promise<StageOutput> => {
        if (reused) return reused;
        const run = (id: string) =>
          this.dispatchWorkerStage({ jobId, attemptId: id, role, reviewerIds, store, snapshotId, workspacePath, requirement, roleModel, runnerKind });
        let out = await run(attemptId);
        if (out.result.result === 'INCONCLUSIVE') {
          // ONE bounded rescue attempt for the SAME independent role. A missing or
          // unparseable reviewer must not silently collapse to a single-reviewer
          // pass (observed: adjudicator noting "second independent review absent").
          out = await run(`${attemptId}-r2`);
        }
        return out;
      };
      let a: StageOutput | null = null;
      let b: StageOutput | null = null;
      if (controls.reviewerA && controls.reviewerB) {
        [a, b] = await Promise.all([
          dispatchReviewer('reviewer-a', attemptIds.a, ['A'], roleModels.reviewerA, reusedA),
          dispatchReviewer('reviewer-b', attemptIds.b, ['B'], roleModels.reviewerB, reusedB),
        ]);
      } else if (controls.reviewerA) {
        a = await dispatchReviewer('reviewer-a', attemptIds.a, ['A'], roleModels.reviewerA, reusedA);
      } else if (controls.reviewerB) {
        b = await dispatchReviewer('reviewer-b', attemptIds.b, ['B'], roleModels.reviewerB, reusedB);
      } else if (!controls.governor) {
        throw new Error('review policy disabled every review stage (validation must reject this before dispatch)');
      }

      if (signal?.aborted) { transitionJob(this.d, jobId, 'REVIEWING_A_B', 'CANCELLED'); return; }

      const ran = [a, b].filter((s): s is StageOutput => s !== null);
      // Detached workers persist their own agent_runs row (acceptWorkerResult),
      // including tokens. Do not insert a second duplicate row here.

      // INDEPENDENCE IS A HARD INVARIANT: never adjudicate with one valid reviewer.
      // A single inconclusive verdict fails the review closed (or re-dispatches
      // above), instead of passing with a LOW 'second review absent' finding.
      if (ran.some((s) => s.result.result === 'INCONCLUSIVE')) {
        const currentAttempt = (this.d.db.query<{ attempt_count: number }, [string]>(`SELECT attempt_count FROM review_jobs WHERE job_id=?`).get(jobId)?.attempt_count) ?? 0;
        const exhausted = currentAttempt >= REWORK_MAX_RETRIES;
        const resolvedState: JobState = exhausted ? 'FAILED_TERMINAL' : 'INCONCLUSIVE';
        this.d.db.query(`UPDATE review_jobs SET result='INCONCLUSIVE', coverage=? WHERE job_id=?`).run(
          JSON.stringify({ changedFiles: ran[0]?.result.coverage?.changedFiles ?? 0, inspectedFiles: 0, uncoveredPaths: ran[0]?.result.coverage?.uncoveredPaths ?? [] }),
          jobId
        );
        transitionJob(this.d, jobId, 'REVIEWING_A_B', resolvedState);
        this.persistReportForState(jobId, resolvedState);
        return;
      }

      // ExcellenceGovernor only: one independent governor review, no A/B layer.
      if (ran.length === 0) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');
        const reusedGov = reusableStage('governor');
        const gov = reusedGov ?? await this.dispatchWorkerStage({
          jobId,
          attemptId: attemptIds.adj,
          role: 'governor',
          reviewerIds: ['GOV'],
          store,
          snapshotId,
          workspacePath,
          requirement,
          roleModel: roleModels.governor,
          runnerKind,
        });
        const finalResult = gov.result.result;
        // acceptWorkerResult already recorded this run (with tokens).
        this.persistFindings(jobId, gov.result.findings ?? [], ['GOV'], true, 'governor-final');
        const state = reviewStateFor(finalResult);
        transitionJob(this.d, jobId, 'ADJUDICATING', state);
        this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
        this.persistReportForState(jobId, state);
        enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult, policy: 'governor-only' }, jobId);
        return;
      }

      const aResult = a?.result.result ?? 'NOT_RUN';
      const bResult = b?.result.result ?? 'NOT_RUN';
      const aFindings = a?.result.findings ?? [];
      const bFindings = b?.result.findings ?? [];
      const changedFiles = ran[0]?.result.coverage?.changedFiles ?? 0;

      if (controls.governor) {
        transitionJob(this.d, jobId, 'REVIEWING_A_B', 'ADJUDICATING');
        const disabledReviewers = [
          ...(a ? [] : (['A'] as const)),
          ...(b ? [] : (['B'] as const)),
        ];
        const combined = buildAdjudicationUser({
          aResult,
          bResult,
          aFindings: JSON.stringify(aFindings),
          bFindings: JSON.stringify(bFindings),
          changedFiles,
          disabledReviewers,
        });
        // Reuse the adjudicator only when every ENABLED reviewer input is the same
        // reused result; otherwise it must reason over the fresh verdicts.
        const reviewersReused = (a === null || reusedA !== null) && (b === null || reusedB !== null);
        const reusedAdj = reviewersReused ? reusableStage('adjudicator') : null;
        const adj = reusedAdj ?? await this.dispatchWorkerStage({
          jobId,
          attemptId: attemptIds.adj,
          role: 'adjudicator',
          reviewerIds: [...(a ? ['A'] : []), ...(b ? ['B'] : [])],
          store,
          snapshotId,
          workspacePath,
          requirement,
          roleModel: roleModels.adjudicator,
          runnerKind,
          combined,
        });
        const finalResult = adj.result.result;
        // acceptWorkerResult already recorded this run (with tokens).
        this.persistFindings(jobId, adj.result.findings ?? [], [...(a ? ['A'] : []), ...(b ? ['B'] : [])], true, 'accepted');
        const state = reviewStateFor(finalResult);
        transitionJob(this.d, jobId, 'ADJUDICATING', state);
        this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
        this.persistReportForState(jobId, state);
        enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult }, jobId);
        return;
      }

      // Governor disabled: the enabled reviewers' verdicts are FINAL.
      const finalResult = ran.some((s) => s.result.result === 'FINDINGS')
        ? 'FINDINGS'
        : ran.every((s) => s.result.result === 'PASS')
          ? 'PASS'
          : 'INCONCLUSIVE';
      this.persistFindings(
        jobId,
        ran.flatMap((s) => s.result.findings ?? []),
        [],
        true,
        'reviewer-final (governor disabled by operator policy)',
      );
      const state = reviewStateFor(finalResult);
      transitionJob(this.d, jobId, 'REVIEWING_A_B', state);
      this.d.db.query(`UPDATE review_jobs SET result=? WHERE job_id=?`).run(finalResult, jobId);
      this.persistReportForState(jobId, state);
      enqueueEvent(this.d, 'job.completed', { jobId, state, result: finalResult, policy: 'reviewers-only' }, jobId);
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
    role: 'reviewer-a' | 'reviewer-b' | 'adjudicator' | 'governor';
    reviewerIds: string[];
    store: string;
    snapshotId: string;
    workspacePath: string;
    requirement: string;
    roleModel: { providerID: string; modelID: string };
    runnerKind: 'openai' | 'fake' | 'kilo' | 'codex';
    /** Adjudicator only: combined reviewer prompt. */
    combined?: string;
  }): Promise<StageOutput> {
    const controlURL = this.controlBaseURL();
    const controlToken = this.controlToken();
    if (!controlURL || !controlToken) throw new Error(`control URL/token not configured (URL=${!!controlURL}, token=${!!controlToken})`);
    // Resolve the provider's baseURL/apiKey for real inference. `policy.providers`
    // wins; otherwise follow the operator's effective Kilo provider configuration
    // (e.g. a provider defined only in ~/.config/kilo/kilo.jsonc), so a global
    // provider/model switch does not require editing config.json.
    const prov = this.config.policy.providers?.[opts.roleModel.providerID]
      ?? resolveKiloProviderOptions(opts.roleModel.providerID)
      ?? undefined;
    if (opts.runnerKind !== 'fake' && opts.runnerKind !== 'codex' && !prov) throw new Error(`runner=${opts.runnerKind} requires an endpoint for provider ${opts.roleModel.providerID} (policy.providers or the effective Kilo provider config)`);
    // kilo uses the headless kilo binary; codex uses the Codex CLI (GT_CODEX_BIN).
    const kiloBin = opts.runnerKind === 'kilo'
      ? (this.config.policy.kiloServerBin || resolveKiloBinary()?.path || '')
      : opts.runnerKind === 'codex'
        ? resolveCodexBin()
        : undefined;
    const contextBudget = resolveContextBudget({
      context: this.config.context,
      providerID: opts.roleModel.providerID,
      modelID: opts.roleModel.modelID,
    });
    spawnReviewWorker({
      d: this.d,
      jobId: opts.jobId,
      attemptId: opts.attemptId,
      role: opts.role,
      snapshotId: opts.snapshotId,
      store: opts.store,
      model: opts.roleModel,
      contextBudget,
      runner: opts.runnerKind,
      baseURL: prov?.baseURL,
      apiKey: prov?.apiKey,
      kiloBin,
      controlURL,
      controlToken,
      workspace: opts.workspacePath,
      userOverride: opts.combined,
    });
    const workerResult = await awaitWorkerResult(
      opts.attemptId,
      // Role-aware bound. The adjudicator reasons over BOTH reviewer verdicts
      // plus the full evidence and legitimately runs longer than a single
      // reviewer; the old uniform 4-minute bound (lease+120s) timed it out and
      // left the job stuck in ADJUDICATING. Match the worker's own 10-minute
      // inference bound for the adjudicator, 5 minutes for reviewers.
      // The worker itself is allowed 10 minutes to infer (kilo-headless). A shorter
      // control-plane wait GUARANTEES a timeout on large diffs -> requeue -> new
      // attempt -> duplicate workers -> a review that never completes. Always wait
      // LONGER than the worker bound, with margin.
      opts.role === 'adjudicator' ? 30 * 60_000 : 25 * 60_000,
      { d: this.d },
    );
    return {
      ...finalizeStageText({
        store: opts.store,
        snapshotId: opts.snapshotId,
        workspacePath: opts.workspacePath,
        targetId: opts.jobId,
        role: opts.role,
        reviewerIds: opts.reviewerIds,
        requirements: opts.requirement,
        text: workerResult.text,
      }),
      tokensIn: workerResult.tokensIn,
      tokensOut: workerResult.tokensOut,
    };
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

  /** Tier-derived user-prompt budget for one resolved role model. */
  private contextPromptBudget(model: { providerID: string; modelID: string }): number {
    return resolveContextBudget({
      context: this.config.context,
      providerID: model.providerID,
      modelID: model.modelID,
    }).userPromptCharBudget;
  }

  /** Stable identity of the review-model matrix (role-specific models included). */
  private reviewPolicyVersion(): string {
    const p = this.config.policy;
    const models = [p.reviewerModel, p.reviewerModelA, p.reviewerModelB, p.adjudicatorModel, p.governorModel]
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .map((model) => `${model.providerID}/${model.modelID}`);
    return models.length ? models.join('|') : 'inherit';
  }

  private resolveRoleModels(kind: string): {
    reviewerA: { providerID: string; modelID: string };
    reviewerB: { providerID: string; modelID: string };
    adjudicator: { providerID: string; modelID: string };
    governor: { providerID: string; modelID: string };
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
    const gov = p.governorModel ? { providerID: p.governorModel.providerID, modelID: p.governorModel.modelID } : adj;
    return { reviewerA: a, reviewerB: b, adjudicator: adj, governor: gov };
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

  /**
   * Persist a stage's findings with an explicit adjudication status.
   * - governor-only / adjudicated reviews: adjudicated=1, adjudication='accepted'
   * - governor disabled: reviewer verdicts are final, adjudicated=1 with an
   *   honest `reviewer-final` annotation (never silently dropped).
   */
  private persistFindings(
    jobId: string,
    findings: Array<NonNullable<StageOutput['result']['findings']>[number]>,
    fallbackReviewerIds: string[],
    adjudicated: boolean,
    adjudication: string,
  ): void {
    for (const f of findings) {
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
          JSON.stringify(f.reviewerIds ?? fallbackReviewerIds),
          adjudicated ? 1 : 0,
          adjudication,
        );
    }
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
    const jobControls = getJobReviewControls(this.d, jobId);
    const stages = effectiveReviewStages(jobControls);
    // Cost at review time: use a runner-reported cost when present; otherwise
    // price the recorded tokens with the operator's USD/1M rules and persist
    // the calculated per-run cost so the audit trail is durable.
    const runRows = this.d.db
      .query<
        {
          run_id: string;
          provider_id: string | null;
          model_id: string | null;
          tokens_in: number | null;
          tokens_out: number | null;
          cost: number | null;
        },
        [string]
      >(
        `SELECT run_id, provider_id, model_id, tokens_in, tokens_out, cost FROM agent_runs WHERE job_id=?`
      )
      .all(jobId);
    let usageIn = 0;
    let usageOut = 0;
    let usageCost = 0;
    let costKnown = false;
    for (const run of runRows) {
      usageIn += run.tokens_in ?? 0;
      usageOut += run.tokens_out ?? 0;
      let cost = run.cost;
      if (cost == null) {
        const calculated = computeTokenCost(this.config.policy.pricing, {
          providerID: run.provider_id,
          modelID: run.model_id,
          runner: this.config.policy.runner,
          tokensIn: run.tokens_in,
          tokensOut: run.tokens_out,
        });
        if (calculated.cost != null) {
          cost = calculated.cost;
          this.d.db.query('UPDATE agent_runs SET cost=? WHERE run_id=?').run(cost, run.run_id);
        }
      }
      if (cost != null) {
        usageCost += cost;
        costKnown = true;
      }
    }
    const usage = {
      tokensIn: runRows.length ? usageIn : null,
      tokensOut: runRows.length ? usageOut : null,
      cost: costKnown ? usageCost : null,
    };
    const metaRow = this.d.db.query<{ meta: string | null }, [string]>('SELECT meta FROM review_jobs WHERE job_id=?').get(jobId);
    let jobMeta: Record<string, unknown> = {};
    try { jobMeta = metaRow?.meta ? (JSON.parse(metaRow.meta) as Record<string, unknown>) : {}; } catch { jobMeta = {}; }
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
      policy: {
        summary: describeReviewPolicy(jobControls),
        reviewerA: stages.reviewerA,
        reviewerB: stages.reviewerB,
        governor: stages.governor,
        controls: jobControls as Record<string, unknown>,
      },
    };
    const costMeta = {
      tokensIn: usage?.tokensIn ?? undefined,
      tokensOut: usage?.tokensOut ?? undefined,
      cost: usage?.cost ?? undefined,
    };
    writeReport({
      reportDir: this.reportDir,
      report: {
        ...report,
        cost: {
          tokensIn: usage?.tokensIn ?? null,
          tokensOut: usage?.tokensOut ?? null,
          cost: usage?.cost ?? null,
        },
      },
      snapshot: {
        baseHash: typeof jobMeta.baseHash === 'string' ? jobMeta.baseHash : null,
        headHash: typeof jobMeta.headHash === 'string' ? jobMeta.headHash : null,
        dirtyHash: typeof jobMeta.dirtyHash === 'string' ? jobMeta.dirtyHash : null,
      },
      providerMap: report.models,
      costMeta,
    });
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

function reviewStateFor(result: string): JobState {
  return result === 'PASS' ? 'COMPLETED_PASS' : result === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'COMPLETED_FINDINGS';
}

function buildAdjudicationUser(opts: {
  aResult: string;
  bResult: string;
  aFindings: string;
  bFindings: string;
  changedFiles: number;
  /** Reviewer stages switched off by the operator: their absence is POLICY, not failure. */
  disabledReviewers?: Array<'A' | 'B'>;
}): string {
  const disabled = opts.disabledReviewers ?? [];
  const policyLine = disabled.length
    ? `OPERATOR POLICY: Reviewer ${disabled.join(' and ')} disabled for this task. Adjudicate ONLY the independent review(s) that actually ran; do NOT treat a disabled reviewer as a missing/failed review.`
    : '';
  return [
    '# Adjudication',
    '',
    ...(policyLine ? [policyLine, ''] : []),
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
    return createCodexRunner({
      modelID: policy.reviewerModel?.modelID ?? 'gpt-6-luna',
      promptCharBudget: resolveContextBudget({
        context: cfg.context,
        providerID: policy.reviewerModel?.providerID,
        modelID: policy.reviewerModel?.modelID,
      }).userPromptCharBudget,
    });
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