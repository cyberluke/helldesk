import { z } from 'zod';
import type { Db } from './db';
import { generateId } from './ids';
import { ReviewResultSchema, FindingSchema } from './schemas';
import { makeEvidenceCtx, verifyPathInSnapshot, verifyLineRange } from './context-reader';
import type { InferenceRunner, ReviewPrompt } from './inference';
import { buildReviewUserPrompt } from './inference';
import { readFileSync } from 'node:fs';

/**
 * Independent adversarial reviewers A/B + independent adjudicator.
 * Parses strict JSON output, cross-checks paths/line numbers against the
 * frozen snapshot, rejects fabricated VERIFIED findings, and bounds retries.
 */

const ReviewerParseSchema = z.object({
  result: ReviewResultSchema,
  coverage: z.object({
    changedFiles: z.number().int().min(0),
    inspectedFiles: z.number().int().min(0),
    uncoveredPaths: z.array(z.string()).default([]),
  }),
  findings: z.array(FindingSchema).default([]),
  models: z.array(z.unknown()).default([]),
});
/** Exported for negative tests that feed reviewer output through the schema. */
export type ReviewerParse = z.infer<typeof ReviewerParseSchema>;
export { ReviewerParseSchema };

/* Remove review_* tool-usage instructions from a reviewer system prompt so the
 * model reasons from the frozen diff embedded in the user message (the pipeline
 * runs FROZEN-EVIDENCE — no tools are registered). Tool-demanding prompts made
 * some endpoints (DeepSeek) return ZERO_COVERAGE or INCONCLUSIVE. */
/* Coerce a review-model line ref (which may be an int, "32", "40-60", or
 * "LIKELY 1-100") into the integer lineStart/lineEnd the schema expects, or
 * undefined if none is present. Prevents PARSE_FAILURE on string line refs. */
function toIntOrUndefined(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.max(1, Math.trunc(v)) : undefined;
  if (typeof v === 'string') {
    const m = v.match(/\d+/);
    if (m) { const n = Number(m[0]); return Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : undefined; }
  }
  return undefined;
}

export function stripModelToolUsage(system: string): string {
  return (system || '')
    .split('\n')
    .filter((p) => {
      const s = p.trim();
      if (/^#+\s*(evidence tools|tools|evaluation tooling|tool usage)/i.test(s)) return false;
      if (/^[-\u2022]\s*`?review_[a-z_]+`?/i.test(s)) return false;
      if (/^use only these functions/i.test(s)) return false;
      if (/^(no shell, edit, network|do not use .*tool|never .*tool|without .*tool)/i.test(s)) return false;
      if (/^review_[a-z_]+\(/i.test(s)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

export function extractJsonObject(text: string): unknown {
  // Strip surrounding prose: find the first '{' ... matching '}'
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in reviewer output');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        return JSON.parse(slice);
      }
    }
  }
  throw new Error('Unbalanced JSON object in reviewer output');
}

export interface StageOutput {
  result: z.infer<typeof ReviewerParseSchema> & { reviewerIds: string[] };
}

/**
 * Canonical finalization of a reviewer/A/B/adjudicator text response into
 * evidence-validated findings. Shared by the in-process path and the detached
 * worker path (which re-finalizes the worker's frozen text blob) so both use
 * exactly one validator. Never opens the target DB: `requirements` is taken
 * from the frozen snapshot manifest by the caller.
 */
/**
 * Normalize real reviewer-model JSON into the canonical ReviewerParseSchema.
 * Different review models emit near-equivalent but differently-keyed fields
 * (e.g. Reviewer B variant used `FAIL`, `coverage.overall/files`, and
 * finding `path`/`line`/`description`/`repro`/`verified`). We map the common
 * variants so genuine evidence is preserved and the adjudicator runs, without
 * inventing anything the model did not actually say.
 */
export function normalizeReviewerJson(input: unknown): unknown {
  const o = (input ?? {}) as Record<string, any>;
  if (typeof o !== 'object' || o === null) return input;

  const resultRaw = String(o.result ?? '').toUpperCase();
  const result =
    resultRaw === 'PASS'
      ? 'PASS'
      : resultRaw === 'INCONCLUSIVE' || resultRaw === 'INCONCLUSIVE/CONCLUSIVE-LIKE'
        ? 'INCONCLUSIVE'
        : (o.findings ?? []).length > 0 ? 'FINDINGS' : 'INCONCLUSIVE';

  // Coverage: accept {changedFiles,inspectedFiles,uncoveredPaths} or
  // {overall,files[]} from the alternative reviewer schema.
  let coverage: Record<string, unknown>;
  if (o.coverage && typeof o.coverage === 'object') {
    const c = o.coverage as Record<string, any>;
    if (typeof c.changedFiles === 'number') {
      coverage = {
        changedFiles: c.changedFiles,
        inspectedFiles: typeof c.inspectedFiles === 'number' ? c.inspectedFiles : 0,
        uncoveredPaths: Array.isArray(c.uncoveredPaths) ? c.uncoveredPaths : [],
      };
    } else {
      coverage = {
        changedFiles: Array.isArray(c.files) ? c.files.length : (Array.isArray(c?.changed_files) ? c.changed_files.length : 0),
        inspectedFiles: Array.isArray(c.files) ? c.files.length : 0,
        uncoveredPaths: [],
      };
    }
  } else {
    coverage = { changedFiles: 0, inspectedFiles: 0, uncoveredPaths: [] };
  }

  const findings = (Array.isArray(o.findings) ? o.findings : []).map((f: any) => {
    const fo = f ?? {};
    return {
      id: fo.id ?? fo.finding_id,
      severity: String(fo.severity ?? 'MEDIUM').toUpperCase(),
      confidence: ['VERIFIED', 'LIKELY', 'HYPOTHESIS'].includes(String(fo.confidence ?? '').toUpperCase())
        ? String(fo.confidence).toUpperCase()
        : (fo.verified === true || fo.verified === 'true' ? 'VERIFIED' : fo.verified === false ? 'HYPOTHESIS' : 'HYPOTHESIS'),
      title: fo.title ?? fo.description ?? fo?.summary ?? 'Finding',
      file: fo.file ?? fo.path,
      // Coerce line refs to integers. Models emit strings like "32", "40-60",
      // "LIKELY 1-100", or "1-100"; the schema requires integers (or absent).
      lineStart: toIntOrUndefined(typeof fo.lineStart === 'number' ? fo.lineStart : fo.line),
      lineEnd: toIntOrUndefined(typeof fo.lineEnd === 'number' ? fo.lineEnd : fo.line),
      revision: fo.revision ?? fo.rev ?? undefined,
      evidence: fo.evidence ?? fo.description ?? fo?.text ?? 'observed in provided diff',
      counterexample: fo.counterexample ?? fo.repro ?? fo?.counterExample ?? undefined,
      requirement: fo.requirement ?? fo?.requirement_ ?? undefined,
      verification: fo.verification ?? fo?.verify ?? undefined,
      reviewerIds: Array.isArray(fo?.reviewerIds) ? fo.reviewerIds.map((x: any) => String(x)) : [],
    };
  });

  return {
    result,
    coverage,
    findings,
    models: Array.isArray(o.models) ? o.models : [],
  };
}

export function finalizeStageText(opts: {
  store: string;
  snapshotId: string;
  workspacePath: string;
  targetId: string;
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
  reviewerIds: string[];
  requirements?: string;
  text: string;
}): StageOutput {
  const ctx = makeEvidenceCtx(opts.store, opts.snapshotId, opts.workspacePath);
  if (!ctx) throw new Error(`Cannot load snapshot manifest for ${opts.snapshotId}`);
  let parsed: z.infer<typeof ReviewerParseSchema> | null = null;
  try {
    const raw = extractJsonObject(opts.text);
    parsed = ReviewerParseSchema.parse(normalizeReviewerJson(raw));
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    return {
      result: {
        result: 'INCONCLUSIVE',
        coverage: { changedFiles: ctx.manifest.changedFiles.length, inspectedFiles: 0, uncoveredPaths: ctx.manifest.changedFiles },
        findings: [{
          id: generateId('fnd'),
          severity: 'HIGH',
          confidence: 'VERIFIED',
          title: `Reviewer ${opts.reviewerIds.join(',')} failed to produce parseable JSON`,
          evidence: `Raw inference error: ${lastError}`,
          reviewerIds: opts.reviewerIds,
        }],
        models: [],
        reviewerIds: opts.reviewerIds,
      },
    };
  }
  const merged = [...parsed.findings];
  const validFindings = merged.map((f) => {
    const out = { ...f };
    if (f.file && f.lineStart && f.confidence === 'VERIFIED') {
      const hasPath = verifyPathInSnapshot(ctx, f.file);
      const hasRange = verifyLineRange(ctx, f.file, f.lineStart, f.lineEnd ?? f.lineStart);
      if (!hasPath || !hasRange) {
        out.confidence = 'HYPOTHESIS';
        out.verification = (out.verification ? out.verification + ' ' : '') + '[adjudicator: reported path/line not found in frozen snapshot; downgraded from VERIFIED]';
      }
    }
    return out;
  });
  return {
    result: {
      result: parsed.result,
      coverage: parsed.coverage,
      findings: validFindings,
      models: parsed.models,
      reviewerIds: opts.reviewerIds,
    },
  };
}

/**
 * Run one reviewer stage. Returns parsed + evidence-validated findings.
 * Any finding claiming VERIFIED must point at a real snapshot path and valid
 * line range; otherwise its confidence is forced down to HYPOTHESIS.
 */
export async function runReviewerStage(opts: {
  d: Db;
  jobId: string;
  targetId: string;
  snapshotId: string;
  store: string;
  workspacePath: string;
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
  reviewerIds: string[];
  system: string;
  runner: InferenceRunner;
  providerID: string;
  modelID: string;
  /** Override the default user prompt (e.g. adjudicator receives A+B combined). */
  userPromptOverride?: string;
}): Promise<StageOutput> {
  const ctx = makeEvidenceCtx(opts.store, opts.snapshotId, opts.workspacePath);
  if (!ctx) throw new Error(`Cannot load snapshot manifest for ${opts.snapshotId}`);
  const requirements = ctx.manifest.requirements || readSqlRequirement(opts.d, opts.jobId) || '';
  // Diff text from the frozen snapshot store.
  let diffText = '';
  try { diffText = readFileSync(joinPaths(opts.store, `${opts.snapshotId}.diff`), 'utf-8'); } catch { diffText = ''; }

  const user = opts.userPromptOverride ?? buildReviewUserPrompt({
    role: opts.role,
    targetId: opts.targetId,
    requirements,
    diff: diffText,
    changedFiles: ctx.manifest.changedFiles,
    reviewMode: 'frozen-evidence',
  });

  const prompt: ReviewPrompt = {
    role: opts.role,
    // The pipeline runs FROZEN-EVIDENCE (no review_* tools are registered). The
    // reviewer system prompt ("Use ONLY these functions: review_*") must be
    // stripped so the model reasons from the embedded diff instead of expecting
    // tools it does not have (which made some endpoints return ZERO_COVERAGE or
    // INCONCLUSIVE). Applied uniformly for openai and codex runners.
    system: stripModelToolUsage(opts.system) + '\n\nSTRICT OUTPUT CONTRACT (mandatory):\nReturn ONLY a single JSON object with EXACTLY these keys:\n{\n  "result": "PASS|FINDINGS|INCONCLUSIVE",\n  "coverage": {"changedFiles": 0, "inspectedFiles": 0, "uncoveredPaths": []},\n  "findings": [],\n  "models": []\n}\nA PASS requires the change fully (as verified from the evidence) satisfies every requirement with no supported BLOCKER/HIGH/MEDIUM finding. The immutable diff/requirements are already embedded in the user message — there are NO tools; report inspectedFiles = the number of changed files you actually reasoned over (>=1 if any change present). Do not return anything but this object.',
    user,
    providerID: opts.providerID,
    modelID: opts.modelID,
    // DEFAULT to frozen-evidence for reliability on tool-flaky endpoints: the
    // diff/requirements are embedded in `user` (buildReviewUserPrompt) and NO
    // tools are registered. Set reviewMode='snapshot-tools' to attach the
    // read-only review_* tools over the frozen snapshot instead.
    reviewMode: 'frozen-evidence',
    evidence: ctx,
  };
  // This pipeline stage always runs FROZEN-EVIDENCE: the reviewer has NO tools and
  // reasons from the diff/requirements embedded in `user`. Therefore `inspectedFiles`
  // reflects how many changed files the model SAYS it reasoned over, NOT a literal
  // file read. A PASS must not be rejected as ZERO_COVERAGE merely because the model
  // reported inspectedFiles:0 in frozen mode (it cannot inspect files) as long as it
  // engaged with the change (changedFiles > 0) and returned a deterministic verdict.
  const FROZEN = true;

  // ── Bounded EPISTEMIC convergence ──────────────────────────────────────
  // Retry ONLY to rescue an *invalid* attempt (malformed JSON, empty response,
  // INCONCLUSIVE, inspectedFiles===0, transport/parse failure). A valid PASS or
  // valid FINDINGS is accepted IMMEDIATELY — we never retry for verdict shopping,
  // and a valid negative finding can never be erased by a later PASS (because we
  // accept the first VALID decision).
  const MAX_CONVERGENCE_ATTEMPTS = 3;
  // Attempt classification for persistence (Scientific Memory).
  function classify(res: { ok: boolean; text: string; error?: string }): {
    verdict: 'VALID_PASS' | 'VALID_FINDINGS' | 'INCONCLUSIVE' | 'INVALID';
    failureClass: string | null;
    parsed: z.infer<typeof ReviewerParseSchema> | null;
  } {
    if (!res.ok || !res.text) return { verdict: 'INVALID', failureClass: res.error || 'EMPTY_RESPONSE', parsed: null };
    let raw: unknown;
    try {
      raw = extractJsonObject(res.text);
    } catch (err) {
      return { verdict: 'INVALID', failureClass: 'INVALID_JSON', parsed: null };
    }
    let parsed: z.infer<typeof ReviewerParseSchema>;
    try {
      parsed = ReviewerParseSchema.parse(normalizeReviewerJson(raw));
    } catch (err) {
      return { verdict: 'INVALID', failureClass: 'PARSE_FAILURE', parsed: null };
    }
    // Epistemic validity: a PASS/INCONCLUSIVE cannot be accepted with zero
    // inspected files (the reviewer must actually inspect the frozen evidence).
    // In FROZEN-EVIDENCE mode there are no review tools — the model reasons from
    // the embedded diff, so `inspectedFiles` is its self-reported coverage and can
    // legitimately be 0 while still engaging with the change. Require the model to
    // have engaged (changedFiles > 0) rather than a literal file read. In
    // snapshot-tools mode (FROZEN=false) inspectedFiles must be >0 (real reads).
    const engaged = (parsed.coverage?.changedFiles ?? 0) > 0 || (parsed.coverage?.inspectedFiles ?? 0) > 0;
    if ((parsed.result === 'PASS' || parsed.result === 'INCONCLUSIVE') && (!engaged || (!FROZEN && (parsed.coverage?.inspectedFiles ?? 0) === 0))) {
      return { verdict: 'INVALID', failureClass: 'ZERO_COVERAGE', parsed };
    }
    // Robustness: a reviewer that returns supported findings MUST be a FINDINGS
    // verdict even if its `result` header says INCONCLUSIVE or PASS (some models
    // mislabel the header while the findings body is decisive). The findings are
    // the substance — accept them as a valid negative finding immediately, never
    // waste convergence retries on it, and never let a later PASS erase it.
    const supportedFindings = Array.isArray(parsed.findings) ? parsed.findings.filter((f) => f && (f.severity === 'BLOCKER' || f.severity === 'HIGH' || f.severity === 'MEDIUM')) : [];
    if (parsed.result === 'PASS' && supportedFindings.length > 0) {
      // Contradictory: header PASS but real findings -> FINDINGS wins (safety).
      return { verdict: 'VALID_FINDINGS', failureClass: null, parsed };
    }
    if (supportedFindings.length > 0) {
      return { verdict: 'VALID_FINDINGS', failureClass: null, parsed };
    }
    if (parsed.result === 'PASS') return { verdict: 'VALID_PASS', failureClass: null, parsed };
    // INCONCLUSIVE is epistemically invalid for the purpose of a verdict; allow
    // a bounded retry but never treat it as a final result.
    return { verdict: 'INCONCLUSIVE', failureClass: 'MODEL_INCONCLUSIVE', parsed };
  }

  function persistAttempt(attemptNo: number, decision: { failureClass: string | null }, inferred: { ok: boolean; text: string; error?: string; tokensIn?: number; tokensOut?: number }, startMs: number): void {
    try {
      const runId = `run_${opts.jobId}_${opts.role}_convergence_${attemptNo}`;
      opts.d.db.query(
        `INSERT OR REPLACE INTO agent_runs (run_id, job_id, role, provider_id, model_id, status, started_at, finished_at, duration_ms, tokens_in, tokens_out, error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        runId, opts.jobId, opts.role, opts.providerID, opts.modelID,
        inferred.ok ? 'succeeded' : 'failed',
        new Date(startMs).toISOString(), new Date().toISOString(),
        Date.now() - startMs, inferred.tokensIn ?? null, inferred.tokensOut ?? null,
        decision.failureClass ? `${decision.failureClass}${inferred.error ? ': ' + inferred.error.slice(0, 200) : ''}` : null
      );
    } catch { /* best effort persistence */ }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let lastDecision: { verdict: string; failureClass: string | null; parsed: z.infer<typeof ReviewerParseSchema> | null } | null = null;
  let confirmedText: string | null = null;

  for (let attemptNo = 1; attemptNo <= MAX_CONVERGENCE_ATTEMPTS; attemptNo++) {
    const startMs = Date.now();
    const res = await opts.runner.run(prompt);
    const decision = classify(res);
    persistAttempt(attemptNo, decision, res, startMs);
    lastDecision = decision;

    // Accept the first VALID decision immediately. This is the invariant:
    // a valid negative finding (FINDINGS) is accepted with ZERO retries and can
    // never be overwritten by a later PASS.
    if (decision.verdict === 'VALID_PASS') { confirmedText = res.text; break; }
    if (decision.verdict === 'VALID_FINDINGS') { confirmedText = res.text; break; }

    // Only INCONCLUSIVE / INVALID reaches the retry — with short backoff.
    if (attemptNo < MAX_CONVERGENCE_ATTEMPTS) {
      const delay = attemptNo === 1 ? 500 : 1500;
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delay + jitter);
    }
  }

  if (confirmedText !== null && lastDecision?.parsed) {
    // Evidence validity + confirmation run through the SAME canonical finalizer
    // used by the detached-worker path, so both agree on findings.
    return finalizeStageText({
      store: opts.store,
      snapshotId: opts.snapshotId,
      workspacePath: opts.workspacePath,
      targetId: opts.targetId,
      role: opts.role,
      reviewerIds: opts.reviewerIds,
      requirements,
      text: confirmedText,
    });
  }

  // Exhausted convergence — this is INCONCLUSIVE, never PASS.
  return {
    result: {
      result: 'INCONCLUSIVE',
      coverage: { changedFiles: ctx.manifest.changedFiles.length, inspectedFiles: 0, uncoveredPaths: ctx.manifest.changedFiles },
      findings: [{
        id: generateId('fnd'),
        severity: 'HIGH',
        confidence: 'VERIFIED',
        title: `Reviewer ${opts.reviewerIds.join(',')} failed to converge after ${MAX_CONVERGENCE_ATTEMPTS} attempts (last=${lastDecision?.failureClass ?? 'unknown'})`,
        evidence: `Reviewer ${opts.reviewerIds.join(',')} failed to converge: last attempt ${lastDecision?.failureClass ?? 'unknown'}`,
        reviewerIds: opts.reviewerIds,
      }],
      models: [],
      reviewerIds: opts.reviewerIds,
    },
  };
}

function joinPaths(a: string, b: string): string {
  return a.replace(/[\\/]+$/, '') + '/' + b;
}

function readSqlRequirement(d: Db, jobId: string): string | null {
  const row = d.db.query<{ meta: string | null }, [string]>(`SELECT meta FROM review_jobs WHERE job_id=?`).get(jobId);
  if (!row?.meta) return null;
  try {
    const meta = JSON.parse(row.meta) as { requirements?: string };
    return meta.requirements ?? null;
  } catch {
    return null;
  }
}