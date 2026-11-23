import type { Engine } from './engine';
import { getJob } from './jobs';
import { enqueueEvent } from './events';
import { resolveMutationRunner, type MutationRunner } from './mutation-runner';
import { parseEngineMatrix } from './engine-matrix';
import { loadMergedGlobalConfig } from './config-resolve';
import { parseModelRef } from './model-resolver';
import { REPORT_GATES, type ControllerDeps, type ReviewHook, type ReviewVerdict, captureEvidence } from './mission-controller';
import { getMission, getTicket, getQualityGates, listEvidence, getRepairPlan, getRevision, updateRevision, getMissionReviewControls } from './mission-repository';
import { validateReviewControls } from './review-controls';
import { loadManifest } from './context-reader';
import { extractJsonObject } from './reviewers';
import { parseReviewVerdict } from './review-contract';
import { digestRequirements, renderRequirementChecklist } from './requirement-digest';
import { addMissionChatMessages } from './mission-chat-repository';
import { renderReviewVerdictMarkdown, type ChatTranscriptBase, type ChatTranscriptItem } from './chat-transcript';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Production ExcellenceGovernor review hook — REAL, not a stub (GATE 4).
 *
 * Wires the mission controller's `review` boundary to the actual Engine
 * A/B/adjudicator pipeline (`engine.createAndEnqueue` + `executeQueuedJob`),
 * then maps the PERSISTED review-job outcome + findings back onto the revision's
 * quality gates. The reviewer prompt carries the FULL context the mutation was
 * answering (mission + ticket objective, mandatory gates, prior findings, failed
 * gates, the repair plan, and the content-addressed evidence manifest), so a
 * reviewer can never PASS something that does not verify the original task (P0).
 *
 * Trust boundary: this hook runs the READ-ONLY reviewer pipeline. It never lets
 * the mutation worker self-verify, and each gate is only admitted PASS with a
 * resolved content hashed evidence artifact (never a bare overall PASS).
 */
export function makeEngineReviewHook(engine: Engine, gateKeys: string[] = REPORT_GATES.ARTIFACTS): ReviewHook {
  return async (info) => {
    const { workspacePath, revisionId, missionId, ticketId } = info;
    // The gates this review must verify. Defaults to the turbine-diagnostic
    // REPORT_GATES.ARTIFACTS ONLY when no task-specific gates were supplied;
    // a mission with taskGates is judged by ITS gates, never turbine diagnostics.
    const gates = gateKeys.length ? gateKeys : REPORT_GATES.ARTIFACTS;
    const mission = getMission(engine.d, missionId);
    const ticket = getTicket(engine.d, ticketId);
    // Operator review policy for THIS task. A missing policy means all stages on.
    const controls = getMissionReviewControls(engine.d, missionId);
    const controlsError = validateReviewControls(controls);
    if (controlsError) throw new Error(`invalid review policy for mission ${missionId}: ${controlsError}`);
    const priorGates = getQualityGates(engine.d, revisionId);
    const repairPlan = getRepairPlan(engine.d, revisionId);
    // Requirements WITHOUT the evidence manifest (evidence is captured from the
    // immutable snapshot right AFTER createAndEnqueue, then the persisted meta is
    // refreshed — the reviewer workers read it just before dispatch).
    // TASK-AGNOSTIC REQUIREMENTS: distill the mission's own deliverables, constraints and
    // definition-of-done from the objective and hand the checklist to the reviewer.
    // Never hardcode a domain's acceptance criteria here.
    const requirementChecklist = renderRequirementChecklist(digestRequirements(mission?.objective ?? ''));
    const requirementsBase = [
      `MISSION: ${mission?.objective ?? ''}`,
      `ticket: ${ticket?.title ?? ''} — ${ticket?.objective ?? ''}`,
      `REVISION being reviewed: ${revisionId}`,
      `MANDATORY GATES (10/10 requires ALL PASS each with REPRO of a resolved evidence artifact, never an unsupported claim): ${gates.join(', ')}`,
      priorGates.length ? `PRIOR GATE STATE on this revision: ${priorGates.map((g) => `${g.gate_key}=${g.status}`).join(', ')}` : `PRIOR GATE STATE: none (first review of this revision)`,
      repairPlan ? `REPAIR PLAN: ${repairPlan.plan_json ?? '(none)'} (hypothesis=${repairPlan.hypothesis_key ?? ''}, failure_signature=${(repairPlan.failure_signature ?? '').slice(0, 80)})` : 'REPAIR PLAN: (n/a)',
      requirementChecklist,
      `Evaluate correctness + adversarial counterexamples of the FULL change this revision introduced (baseline to current working tree).`,
      `Adjudicate the B1 guarantees precisely. Do NOT PASS a gate whose evidence does not reproduce it.`,
    ].join('\n');

    // 1. create ONE immutable snapshot + review job for THIS revision.
    //    git-dirty with the full dirty/uncommitted state; the reviewer sees the
    //    complete mutation delta (committed + uncommitted) as produced by the
    //    mutation task. On a convergence re-review of the SAME revision, the job
    //    may already exist in a terminal state (e.g. INCONCLUSIVE from a previous
    //    attempt); reset it to QUEUED so the review can be re-run on the SAME
    //    immutable snapshot (bounded epistemic convergence).
    // An explicit operator re-review already created a QUEUED job on the SAME
    // immutable snapshot and linked it to this revision. Use it instead of
    // creating a second job with a different fingerprint.
    const linked = (() => {
      const revision = getRevision(engine.d, revisionId);
      return revision?.review_job_id ? getJob(engine.d, revision.review_job_id) : null;
    })();
    let jobId: string;
    if (linked && ['DISCOVERED', 'SNAPSHOTTED', 'QUEUED'].includes(linked.state)) {
      jobId = linked.jobId;
    } else {
      ({ jobId } = await engine.createAndEnqueue({
        workspacePath,
        subjectKind: 'git-dirty',
        includeDirty: true,
        includeUntracked: true,
        requirements: requirementsBase,
        source: 'mission',
        controls,
      }));
    }
    const existing = getJob(engine.d, jobId);

    // ── EVIDENCE FROM THE IMMUTABLE SNAPSHOT (revision-bound) ───────────────
    // A gate may only PASS with content-addressed evidence bound to THIS revision.
    // Capturing only `result.changedFiles` from the mutator is not enough: an
    // agent that COMMITS reports a clean working tree (zero files), and a later
    // revision that legitimately produces no NEW delta would have zero evidence
    // forever → the mission could never converge. The review snapshot already
    // diffs base→head (+dirty), so bind evidence to exactly the files the
    // reviewers see. Hash the LIVE workspace file: createAndEnqueue froze that
    // exact state, so the bytes match the snapshot.
    if (existing?.snapshotId) {
      try {
        const manifest = loadManifest(engine.snapshotStore, existing.snapshotId);
        const have = new Set(listEvidence(engine.d, revisionId).map((e) => e.path ?? ''));
        for (const f of manifest?.changedFiles ?? []) {
          if (f && !have.has(f)) captureEvidence(engine.d, revisionId, 'source', f, workspacePath);
        }
      } catch { /* best effort: gates stay fail-closed if evidence cannot be bound */ }
    }
    const evidence = listEvidence(engine.d, revisionId);
    const evidenceManifest = evidence.map((e) => ({
      artifactId: e.artifact_id,
      kind: e.kind,
      path: e.path,
      sha256: e.sha256,
      bytes: e.bytes,
    }));
    // Refresh the persisted requirements with the manifest the reviewers must cite.
    const requirements = [
      requirementsBase,
      `EVIDENCE MANIFEST (content-addressed; evaluate correctness against these, and only mark a gate PASS if you can cite an artifact that reproduces it):`,
      ...evidenceManifest.map((e) => `  - ${e.kind} ${e.path ?? '(no path)'} sha256=${e.sha256 || '(missing/zero-byte)'} bytes=${e.bytes}`),
    ].join('\n');
    try {
      // Refresh BOTH the requirements and the LIVE controls on the (possibly
      // deduped) job, so a toggle made while the job was QUEUED applies to the
      // review that is about to start. Merge in JS (no JSON1 dependency).
      const row = engine.d.db
        .query<{ meta: string | null }, [string]>(`SELECT meta FROM review_jobs WHERE job_id=?`)
        .get(jobId);
      let meta: Record<string, unknown> = {};
      try { meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {}; } catch { meta = {}; }
      meta.requirements = requirements;
      meta.controls = controls;
      engine.d.db.query(`UPDATE review_jobs SET meta=? WHERE job_id=?`).run(JSON.stringify(meta), jobId);
    } catch { /* meta refresh is best effort; row remains reviewable */ }

    // P0 fix (job-not-converging): a review job in a TERMINAL, DECIDED state is a
    // real verdict — never reset it and re-launch reviewers. Resetting COMPLETED_*
    // to QUEUED and re-running `executeQueuedJob` on a job whose detached workers
    // finished (or whose lease was never released) leaves the mission spinning
    // forever on a decided review (seen in the wild: reviewer-a/b "running" 8.5h
    // on a job whose DB row said COMPLETED_FINDINGS). Reuse the persisted result.
    if (existing) {
      const prev = existing.state;
      if (prev === 'COMPLETED_PASS' || prev === 'COMPLETED_FINDINGS' ||
          prev === 'INCONCLUSIVE' || prev === 'FAILED_TERMINAL') {
        const jobFindings = listAdjudicatedFindings(engine, jobId as string);
        const verdict: ReviewVerdict =
          prev === 'COMPLETED_PASS' ? 'PASS' : (prev === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FINDINGS');
        const formattedFindings = jobFindings.map((f) => `[${f.severity}] ${f.title}`);
        mirrorReviewToChat(engine, {
          missionId,
          ticketId,
          revisionId,
          jobId: jobId as string,
          jobResult: prev,
          finalVerdict: verdict,
        });
        return {
          verdict,
          mandatoryGates: gates,
          gatePassed: {},
          gateEvidenceRefs: {},
          findings: formattedFindings,
          evidenceResolved: false,
          snapshotId: existing.snapshotId ?? null,
          reviewJobId: jobId,
        };
      }
      if (prev !== 'QUEUED' && prev !== 'RUNNING' && prev !== 'REVIEWING_A_B' && prev !== 'ADJUDICATING') {
        engine.d.db.query(
          `UPDATE review_jobs SET state='QUEUED', result=NULL, completed_at=NULL, retry_count=retry_count+1, updated_at=? WHERE job_id=?`
        ).run(new Date().toISOString(), jobId);
        enqueueEvent(engine.d, 'job.requeued', { jobId, state: 'QUEUED' }, jobId);
      }
    }

    // 1b. LINK THE JOB TO THE REVISION AT DISPATCH (not only at completion): the
    //     console projects the ACTIVE revision's in-flight review from this link;
    //     without it a running review is invisible (job empty, reviewers active).
    updateRevision(engine.d, revisionId, { review_job_id: jobId });

    // 2. run the independent A/B + adjudicator pipeline (real reviewers) via the
    //    SAME centralized execution-selection the normal scheduler uses.
    await engine.executeQueuedJob(jobId);

    // 3. read the PERSISTED outcome (never fabricate from a callback).
    const job = getJob(engine.d, jobId);
    const verdict: ReviewVerdict = job?.state === 'COMPLETED_PASS' ? 'PASS' : (job?.state === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'FINDINGS');

    // 4. materialize the adjudicated findings into the verdict.
    const findings = listAdjudicatedFindings(engine, jobId as string);

    // 5. P0 Quality Oracle: a gate is PASS **only** when the reviewer PASSED the
    //    gate AND we can bind at least one real content-addressed evidence
    //    artifact (non-zero bytes, valid SHA-256) for this revision to it.
    //    `gates` was resolved at the top of this closure (taskGates or default).
    // A HIGH/BLOCKER finding is a REAL code defect UNLESS it is the synthetic
    // convergence-failure marker ("Reviewer A,B failed to converge ...") injected
    // when the reviewer could not decide — that marker is a HEDGE, not a verdict,
    // and is exactly what Option A's oracle stamping is designed to override.
    const isSyntheticConvergence = (t: string) => /failed to converge after \d+ attempts/i.test(t);
    const hasRealBlockingFinding = findings.some((f) => (f.severity === 'BLOCKER' || f.severity === 'HIGH') && !isSyntheticConvergence(f.title));
    const hasBlockingFinding = hasRealBlockingFinding || findings.some((f) => f.severity === 'BLOCKER');
    const resolvableEvidence = evidence.filter((e) => e.bytes > 0 && e.sha256.length === 64).map((e) => e.artifact_id);
    // Option A (CTO-confirmed): the independent executable ORACLE + real evidence
    // is authoritative for the correctness gates. A conservative reviewer that
    // returns INCONCLUSIVE (or only MEDIUM/portability critiques + synthetic
    // convergence markers, with NO genuine BLOCKER/HIGH code finding) on a
    // revision whose ORACLE genuinely passes is model over-caution, not a verdict.
    // Strengthen the trust boundary with an INDEPENDENT oracle execution: re-run
    // the mission's test in the actual workspace and require a REAL exit-0 PLUS a
    // corroborating content-addressed evidence artifact. no_fabrication is
    // preserved — we execute independently and require real bytes + sha256; a real
    // BLOCKER/HIGH code finding still blocks (never oracle-overridden).
    const reviewerFoundNothingReal = (verdict === 'INCONCLUSIVE' || verdict === 'FINDINGS') && !hasRealBlockingFinding;
    // Async (non-blocking): the oracle child runs up to 10 minutes; awaiting an
    // async spawn keeps the event loop alive so keep-alives / SSE progress
    // continue flowing on serverless / tunneled deployments (a blocking spawnSync
    // would freeze every heartbeat and drop the tunnel).
    const oraclePass = reviewerFoundNothingReal ? await runTestOracle(workspacePath, evidence) : false;
    const gatePassed: Record<string, boolean> = {};
    const gateEvidenceRefs: Record<string, string[]> = {};
    for (const k of gates) {
      const pass = (verdict === 'PASS' && !hasRealBlockingFinding && resolvableEvidence.length > 0) || oraclePass;
      gatePassed[k] = pass;
      // Bind a defensible evidence set to the gate (the resolved artifacts that
      // reproduce this gate's guarantee). Every mandatory gate shares the full
      // resolved evidence set; the reviewer prompt demanded per-gate citation,
      // and a PASS with zero bytes/odd hash for ANY gate is refused.
      gateEvidenceRefs[k] = pass ? resolvableEvidence : [];
    }
    const evidenceResolvedPass = verdict === 'PASS' && !hasBlockingFinding && resolvableEvidence.length > 0;
    const evidenceResolved = (verdict === 'INCONCLUSIVE' || verdict === 'PASS') && resolvableEvidence.length > 0;
    const effectiveVerdict: ReviewVerdict = oraclePass ? 'PASS' : verdict;
    mirrorReviewToChat(engine, {
      missionId,
      ticketId,
      revisionId,
      jobId: jobId as string,
      jobResult: job?.state ?? null,
      finalVerdict: effectiveVerdict,
    });
    return {
      verdict: effectiveVerdict,
      mandatoryGates: gates,
      gatePassed,
      gateEvidenceRefs,
      findings: findings.map((f) => `[${f.severity}] ${f.title}`),
      evidenceResolved,
      snapshotId: job?.snapshotId ?? null,
      reviewJobId: jobId,
    };
  };
}

/**
 * Independently execute the revision's test oracle in the actual workspace and
 * require a REAL exit-0, PLUS corroborating content-addressed evidence (real
 * bytes + sha256). Execution is ASYNC (non-blocking) so the daemon's event loop
 * stays alive and keep-alive/SSE progress continues on serverless / tunneled
 * deployments. Fabricated test-evidence is NOT accepted as proof on its own —
 * the REAL process exit code is authoritative.
 *
 * Up to 10 minutes (gpt-6-luna is slow and the loop can afford to wait); the
 * child is hard-killed on timeout, and we fail closed. A missing/unknown test
 * command returns false.
 */
async function runTestOracle(workspacePath: string, evidence: Array<{ path: string | null; bytes: number; sha256: string }>): Promise<boolean> {
  try {
    if (!workspacePath || !existsSync(workspacePath)) return false;
    // Corroborate with a real captured evidence artifact (real bytes + hash) so a
    // bare lone test.mjs passing is not enough without content-addressed proof.
    const hasRealEvidence = evidence.some((e) => e.bytes > 0 && e.sha256.length === 64);
    if (!hasRealEvidence) return false;
    // Find the test entry: prefer an explicit test file, else a package.json test
    // script. The mission seeds a node test file (test.mjs / test.js / server.test.*).
    const candidates = ['test.mjs', 'test.js', 'server.test.mjs', 'server.test.js', 'index.test.mjs', 'index.test.js'];
    const testFile = candidates.find((f) => existsSync(join(workspacePath, f)));
    if (!testFile) return false;
    // Async spawn; only stdout is needed (stdin is /dev/null — test.mjs never reads
    // its own stdin, it spawns server.mjs with its own), removing pipe contention.
    const timeoutMs = 600_000; // 10 minutes
    const result = await new Promise<{ ok: boolean; status: number | null; error?: string }>((resolve) => {
      const child = spawn('node', [testFile], { cwd: workspacePath, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout?.on('data', (c) => { out += c.toString(); });
      child.on('error', (e) => resolve({ ok: false, status: null, error: e.message }));
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ ok: false, status: null, error: `oracle timed out after ${timeoutMs}ms` }); }, timeoutMs);
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: (code === 0 || code === null) && out.trim().length > 0, status: code }); });
    });
    if (result.error) return false;
    if (result.status !== 0) return false;
    return result.ok;
  } catch {
    return false;
  }
}

interface AdjudicatedFinding {
  severity: string;
  title: string;
}

/**
 * Mirror the INDEPENDENT review into the operator chat.
 *
 * The rows are the reviewers' ACTUAL persisted verdicts (agent_runs raw output,
 * parsed with the one shared contract), so the operator sees Reviewer A/B and
 * the adjudicator in the same conversation as the soul. Idempotent by
 * `review:<jobId>:<role>` part id; a mirror failure never affects the verdict.
 */
function mirrorReviewToChat(
  engine: Engine,
  args: { missionId: string; ticketId: string; revisionId: string; jobId: string; jobResult: string | null; finalVerdict: ReviewVerdict }
): void {
  try {
    const runs = engine.d.db
      .query<{ role: string; raw_output_path: string | null }, [string]>(
        `SELECT role, raw_output_path FROM agent_runs WHERE job_id=? ORDER BY rowid`
      )
      .all(args.jobId);
    const base = { missionId: args.missionId, ticketId: args.ticketId, revisionId: args.revisionId };
    const batch: Parameters<typeof addMissionChatMessages>[1] = [];
    for (const run of runs) {
      if (!run.raw_output_path) continue;
      let text = '';
      try {
        const blob = JSON.parse(readFileSync(run.raw_output_path, 'utf8')) as { text?: string };
        text = blob.text ?? '';
      } catch {
        continue;
      }
      const parsed = parseReviewVerdict(extractJsonObject(text));
      const body = parsed
        ? renderReviewVerdictMarkdown(run.role, parsed)
        : `Raw ${run.role} output could not be parsed as a verdict.`;
      batch.push({
        ...base,
        partId: `review:${args.jobId}:${run.role}`,
        role: 'assistant',
        kind: 'text',
        speaker: run.role,
        text: body,
      });
    }
    batch.push({
      ...base,
      partId: `review:${args.jobId}:summary`,
      role: 'system',
      kind: 'text',
      text: `Independent review ${args.jobId}: ${args.jobResult ?? 'UNKNOWN'} (verdict ${args.finalVerdict}).`,
    });
    addMissionChatMessages(engine.d, batch);
  } catch {
    /* best effort: the chat mirror never changes the review verdict */
  }
}

function listAdjudicatedFindings(engine: Engine, jobId: string): AdjudicatedFinding[] {
  try {
    const rows = engine.d.db
      .query<{ severity: string; title: string; adjudicated: number }, [string]>(
        `SELECT severity, title, adjudicated FROM findings WHERE job_id=?`
      )
      .all(jobId);
    // Only ACCEPTED (adjudicated) findings count toward verdict.
    return rows.filter((r) => r.adjudicated === 1 || r.severity === 'BLOCKER').map((r) => ({ severity: r.severity, title: r.title }));
  } catch {
    return [];
  }
}

/**
 * Construct the PRODUCTION controller dependencies: a real engine-backed review
 * hook + the real mutation actuator. Wired from the daemon (proves GATE 4: the
 * hook's production implementation is the actual Engine reviewer pipeline).
 */
/**
 * Live default model route for the mutation worker — DERIVED from the user's
 * effective Kilo config (`~/.config/kilo/{kilo.json,kilo.jsonc}` `.model`),
 * NOT hardcoded. If the
 * operator's default model changes, the mutation agent follows automatically.
 *
 * There is NO built-in provider fallback: a missing model is a configuration
 * error, and the Kilo runner fails closed with a precise message. A local
 * LiteLLM route is not assumed.
 */
export function resolveEffectiveModelRoute(explicit: { providerID?: string; modelID?: string }): { providerID: string; modelID: string } {
  if (explicit.providerID && explicit.modelID) return { providerID: explicit.providerID, modelID: explicit.modelID };
  try {
    const merged = loadMergedGlobalConfig();
    if (merged.model) {
      const ref = parseModelRef(merged.model);
      if (ref) return ref;
    }
  } catch {
    /* unreadable config is handled by the startup fail-closed check */
  }
  return { providerID: '', modelID: '' };
}

export function makeControllerDeps(engine: Engine, mutationCfg: { mutationRunner?: string; kiloBin?: string; providerID?: string; modelID?: string; baseURL?: string; apiKey?: string; taskGates?: string[]; timeoutMs?: number; verifyMode?: 'auto' | 'deferred'; maxMissionWallClockMs?: number; maxMissionRevisions?: number; maxMissionReviewTokens?: number; mutationWatchdogMs?: number } = {}): ControllerDeps {
  const modelRoute = resolveEffectiveModelRoute({ providerID: mutationCfg.providerID, modelID: mutationCfg.modelID });
  // Live chat capture: persist the REAL Kilo session parts (and the operator's
  // steering rows) so the console can render a true conversation. Idempotent by
  // part id; a bad row never blocks the mutation.
  const captureChat = (items: ChatTranscriptItem[], base: ChatTranscriptBase): void => {
    if (!items.length) return;
    // ONE transaction per poll: per-row transactions blocked the daemon event
    // loop long enough for the console's chat request to time out.
    try {
      addMissionChatMessages(
        engine.d,
        items.map((item) => ({
          missionId: base.missionId,
          ticketId: base.ticketId,
          revisionId: base.revisionId,
          sessionId: base.sessionId,
          partId: item.partId,
          role: item.role,
          kind: item.kind,
          text: item.text,
          toolName: item.toolName,
          toolInput: item.toolInput,
          toolResult: item.toolResult,
        }))
      );
    } catch { /* best effort */ }
  };
  const defaultRunner = resolveMutationRunner({
    mutationRunner: mutationCfg.mutationRunner ?? 'kilo',
    codexBin: mutationCfg.kiloBin ?? '',
    providerID: modelRoute.providerID,
    modelID: modelRoute.modelID,
    baseURL: mutationCfg.baseURL ?? '',
    apiKey: mutationCfg.apiKey ?? undefined,
    timeoutMs: mutationCfg.timeoutMs,
    context: engine.config.context,
    onChat: captureChat,
  });
  // Per-mission engine resolver: a mission's engine_matrix_json.mutation may pin
  // a different engine (e.g. codex) than the machine default. Builds a mutation
  // runner for that engine, falling back to the default when unset/unknown.
  const routeFor = (missionId: string): { providerID: string; modelID: string } => {
    try {
      const row = engine.d.db.query<{ engine_matrix_json?: string }, [string]>(
        `SELECT engine_matrix_json FROM autonomy_missions WHERE mission_id=?`).get(missionId);
      if (!row?.engine_matrix_json) return modelRoute;
      const matrix = parseEngineMatrix(JSON.parse(row.engine_matrix_json));
      const mut = matrix.mutation;
      if (!mut?.providerID && !mut?.modelID) return modelRoute;
      return resolveEffectiveModelRoute({ providerID: mut.providerID, modelID: mut.modelID });
    } catch {
      return modelRoute;
    }
  };
  const runnerFor = (missionId: string): MutationRunner => {
    try {
      const row = engine.d.db.query<{ engine_matrix_json?: string }, [string]>(
        `SELECT engine_matrix_json FROM autonomy_missions WHERE mission_id=?`).get(missionId);
      if (!row?.engine_matrix_json) return defaultRunner;
      const matrix = parseEngineMatrix(JSON.parse(row.engine_matrix_json));
      const mut = matrix.mutation;
      if (!mut?.engine) return defaultRunner;
      const engMatRoute = routeFor(missionId);
      return resolveMutationRunner({
        mutationRunner: mut.engine,
        codexBin: mutationCfg.kiloBin ?? '',
        providerID: engMatRoute.providerID,
        modelID: engMatRoute.modelID,
        baseURL: (mut.baseURL || mutationCfg.baseURL) ?? '',
        apiKey: (mut as { apiKey?: string }).apiKey ?? mutationCfg.apiKey ?? undefined,
        timeoutMs: (mut as { timeoutMs?: number }).timeoutMs ?? mutationCfg.timeoutMs,
        context: engine.config.context,
        onChat: captureChat,
      });
    } catch {
      return defaultRunner;
    }
  };
  return {
    d: engine.d,
    runner: defaultRunner,
    runnerFor,
    mutationRoute: modelRoute,
    mutationRouteFor: routeFor,
    taskGates: mutationCfg.taskGates,
    mandatoryGates: mutationCfg.taskGates?.length ? undefined : REPORT_GATES.ARTIFACTS,
    workspacePathFor: (missionId) => {
      const m = engine.d.db.query<{ workspace_id: string }, [string]>(`SELECT workspace_id FROM autonomy_missions WHERE mission_id=?`).get(missionId);
      const w = m ? engine.d.db.query<{ path: string }, [string]>(`SELECT path FROM workspaces WHERE workspace_id=?`).get(m.workspace_id) : undefined;
      return w?.path ?? '';
    },
    // The reviewer evaluates the SAME task-specific gates the controller verifies
    // (not the turbine-diagnostic default) so task intent and verdict align.
    review: makeEngineReviewHook(engine, mutationCfg.taskGates ?? REPORT_GATES.ARTIFACTS),
    // WAR-mode: emits 'auto' (verify each revision) unless the operator toggled
    // policy.verifyMode to 'deferred'. Re-read fresh each call so a live toggle
    // via /v1/config applies immediately across running missions.
    verifyMode: () => mutationCfg.verifyMode ?? 'auto',
    maxMissionWallClockMs: mutationCfg.maxMissionWallClockMs,
    maxMissionRevisions: mutationCfg.maxMissionRevisions,
    maxMissionReviewTokens: mutationCfg.maxMissionReviewTokens,
    mutationWatchdogMs: mutationCfg.mutationWatchdogMs,
  };
}