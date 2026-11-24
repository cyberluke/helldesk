#!/usr/bin/env bun
/**
 * Detached Local HELLDESK review worker.
 *
 * Runs as an INDEPENDENT process (not inside a VS Code window). It:
 *  - loads the frozen snapshot + explicit provider/model for a single review
 *    stage (reviewer-a | reviewer-b | adjudicator),
 *  - executes the review via the installed Kilo SDK OR a direct OpenAI-compatible
 *    endpoint (explicitly configured provider; never a guessed fallback),
 *  - persists the result blob and posts `worker.done` to the control plane,
 *  - is supervised by the control plane (heartbeat, lease, cancellation).
 *
 * Exactly one role per process. No developer session is touched. No Git
 * mutation. Read-only evidence interface only.
 *
 * CLI:
 *   bun run src/worker.ts --job <jobId> --attempt <attemptId> --role <role>
 *       --snapshot <snapshotId> --store <snapshotStore> --model prov/model
 *       --runner openai --baseURL <url> [--apiKey <...>] --token <cp> --control <url>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKiloInference } from './kilo-headless';
import { composeReviewUserPrompt, extractJsonObject, ReviewerParseSchema } from './reviewers';
import { createCodexRunner } from './inference';
import { loadConfig } from './config';
import {
  REVIEW_PROMPT_OVERHEAD_CHARS,
  normalizeContextTier,
  resolveContextBudget,
  type ContextBudget,
} from './context-tiers';
import {
  REVIEW_OUTPUT_FORMAT,
  isUnsupportedStructuredOutput,
  parseReviewVerdict,
  reviewResponseFormatChain,
} from './review-contract';

/**
 * What response_format this endpoint last accepted, keyed by baseURL|model.
 * A strict `json_schema` rejection is paid ONCE per endpoint, not per inference.
 */
const responseFormatCache = new Map<string, number>();

type Role = 'reviewer-a' | 'reviewer-b' | 'adjudicator' | 'governor';

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v ?? '';
}

function failClosed(msg: string): never {
  console.error('[worker] FAIL_CLOSED', msg);
  process.exit(42);
}

async function main(): Promise<void> {
  const jobId = arg('--job');
  const attemptId = arg('--attempt');
  const roleValue = arg('--role');
  const snapshotId = arg('--snapshot');
  const store = arg('--store');
  const modelRef = arg('--model');          // "providerID/modelID"
  const runnerKind = arg('--runner');       // openai | fake | kilo
  const baseURL = arg('--baseURL');
  const apiKey = arg('--apiKey');
  const controlURL = arg('--control');
  const controlToken = arg('--token');
  const workspacePath = arg('--workspace');
  const userOverrideFile = arg('--userOverrideFile');
  const userOverride = userOverrideFile && existsSync(userOverrideFile)
    ? readFileSync(userOverrideFile, 'utf-8')
    : arg('--userOverride');

  const filesFile = arg('--filesFile');
  const attachedFiles = filesFile && existsSync(filesFile)
    ? (JSON.parse(readFileSync(filesFile, 'utf-8')) as unknown)
    : [];
  const files = Array.isArray(attachedFiles)
    ? attachedFiles.filter((file): file is string => typeof file === 'string' && file.length > 0)
    : [];
  const kiloBin = arg('--kiloBin');
  const snapshotStore = arg('--snapshotStore');
  const directory = arg('--directory') || workspacePath;

  if (!jobId || !roleValue || !snapshotId) failClosed('job/role/snapshot required');
  const role = roleValue as Role;
  if (!['reviewer-a', 'reviewer-b', 'adjudicator', 'governor'].includes(role)) failClosed(`unknown role ${role}`);
  // Real reviewers: kilo (headless Kilo SDK) or openai (direct OpenAI-compatible).
  // `fake` is a test/synthetic-only path and is rejected by the production daemon.
  if (runnerKind === 'kilo') {
    if (!kiloBin) failClosed('kilo worker requires --kiloBin');
    // provider/model default to the resolved role route; modelRef carries it.
  } else if (runnerKind === 'codex') {
    // codex reviewer needs the codex binary (resolved from GT_CODEX_BIN or PATH).
    if (process.env.GT_CODEX_BIN) {
      // provided by the supervisor; OK.
    }
  } else if (runnerKind !== 'openai' && runnerKind !== 'fake') {
    failClosed(`runner ${runnerKind} not supported for detached worker; use kilo/codex/openai/fake`);
  }
  if ((runnerKind === 'openai') && !baseURL) failClosed('openai worker requires --baseURL');
  const slash = modelRef.indexOf('/');
  const model = slash === -1
    ? { providerID: modelRef, modelID: modelRef }
    : { providerID: modelRef.slice(0, slash), modelID: modelRef.slice(slash + 1) };

  // Read frozen manifest + diff.
  const manifestPath = join(store, `${snapshotId}.manifest.json`);
  if (!existsSync(manifestPath)) failClosed(`snapshot manifest missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
    changedFiles: string[]; requirements?: string; headHash?: string | null; baseHash?: string | null;
  };
  const diffPath = join(store, `${snapshotId}.diff`);
  const diff = existsSync(diffPath) ? readFileSync(diffPath, 'utf-8') : '';
  const requirements: string = manifest.requirements ?? '';

  // Build the stage prompt (role -> reviewer-correctness / reviewer-adversarial / adjudicator / governor).
  const promptFile = role === 'reviewer-a'
    ? 'reviewer-correctness.md'
    : role === 'reviewer-b'
      ? 'reviewer-adversarial.md'
      : role === 'governor'
        ? 'governor.md'
        : 'adjudicator.md';
  const system = readFileSync(fileURLToPath(new URL(`./prompts/${promptFile}`, import.meta.url)), 'utf-8');

  // Tier budget: prefer the daemon's explicit args; fall back to the live config
  // + kilo.jsonc detection so a manually launched worker still honours the tier.
  const contextWindowArg = Number(arg('--contextWindow'));
  const maxOutputArg = Number(arg('--maxOutputTokens'));
  const promptBudgetArg = Number(arg('--promptCharBudget'));
  const hasContextWindow = Number.isFinite(contextWindowArg) && contextWindowArg > 0;
  const hasMaxOutput = Number.isFinite(maxOutputArg) && maxOutputArg > 0;
  let configContext: ReturnType<typeof loadConfig>['context'] | undefined;
  try { configContext = loadConfig().context; } catch { configContext = undefined; }
  const budget: ContextBudget = resolveContextBudget({
    context: {
      ...(configContext ?? {}),
      ...(hasContextWindow ? { contextWindow: Math.trunc(contextWindowArg) } : {}),
      ...(hasMaxOutput ? { reservedOutputTokens: Math.trunc(maxOutputArg) } : {}),
      ...(arg('--contextTier') ? { tier: normalizeContextTier(arg('--contextTier')) } : {}),
    },
    providerID: model.providerID,
    modelID: model.modelID,
    detect: !hasContextWindow,
  });
  const promptCharBudget = Number.isFinite(promptBudgetArg) && promptBudgetArg > 0
    ? Math.trunc(promptBudgetArg)
    : budget.userPromptCharBudget;

  const promptHead = [
    `# ${role} review of target ${snapshotId}`,
    `## Requirements`,
    requirements || '(none provided)',
    `## Changed files (${manifest.changedFiles.length})`,
    ...manifest.changedFiles.map((f) => `- ${f}`),
    `## Frozen evidence diff (complete immutable snapshot — no tools needed)`,
    '```',
  ].join('\n');
  const promptTail = [
    '```',
    '',
    'The ENTIRE immutable review evidence is contained above; there is nothing to fetch or inspect elsewhere.',
    'Do not attempt to call any tools or read any files — none are available and none are needed.',
    'Analyze the requirements, changed files and diff, then output ONLY the single strict JSON review object ' +
      'with fields (result, coverage, findings, models) as defined in your system prompt. No prose before or after the JSON.',
  ].join('\n');
  // Adjudicator receives the combined A+B findings from the control plane;
  // otherwise build the standard review prompt from the frozen manifest.
  const diffBudget = Math.max(0, promptCharBudget - promptHead.length - promptTail.length - REVIEW_PROMPT_OVERHEAD_CHARS);
  const diffBody = diff.length > diffBudget
    ? `${diff.slice(0, diffBudget)}\n\n[diff truncated: showing ${diffBudget} of ${diff.length} chars — context tier ${budget.tier} (${budget.contextWindow} tokens). Report uncovered evidence honestly.]`
    : diff;
  const evidence = [promptHead, diffBody, promptTail].join('\n');
  // The adjudicator's A/B preamble is a PREAMBLE, not a replacement: it must
  // still receive the requirements, changed-file list and frozen diff. Dropping
  // them produced `coverage: {changedFiles:0}` and a permanent INCONCLUSIVE
  // (M6 run I).
  const user = role === 'adjudicator'
    ? composeReviewUserPrompt(evidence, userOverride)
    : evidence;

  // Execute inference.
  const t0 = Date.now();
  // STRUCTURED-FIRST CONTRACT: every runner is asked for the verdict through its
  // native structured-output channel (Kilo StructuredOutput tool / OpenAI
  // json_schema / Codex --output-schema). A prose reply is only a FALLBACK, and
  // an invalid one gets a bounded repair retry — never persisted as a verdict.
  const MAX_JSON_ATTEMPTS = 3;
  const repairNote = (n: number) =>
    `\n\n[Convergence repair ${n}/${MAX_JSON_ATTEMPTS}] Your previous reply was NOT accepted: it must be ONE strict JSON object matching the schema EXACTLY. ` +
    `Required shape: {"result":"PASS"|"FINDINGS"|"INCONCLUSIVE","coverage":{"changedFiles":<integer>,"inspectedFiles":<integer>,"uncoveredPaths":[<string>]},` +
    `"findings":[{...}],"models":[...]}. Do not rename or omit coverage.changedFiles / coverage.inspectedFiles / coverage.uncoveredPaths. ` +
    `Return ONLY the JSON object with every brace and bracket closed — no prose, no markdown fences, no commentary.`;
  /** Canonicalize a validated verdict so downstream sees ONE exact shape. */
  const verdictText = (structured: unknown, fallback: string): string => {
    if (structured === undefined) return fallback;
    const verdict = parseReviewVerdict(structured);
    return verdict ? JSON.stringify(verdict) : fallback;
  };
  const inferenceAccepted = (r: { ok: boolean; text: string; structured?: unknown }): boolean => {
    if (!r.ok) return false;
    if (r.structured !== undefined) return parseReviewVerdict(r.structured) !== null;
    try {
      // The control plane re-validates with the SAME schema in finalizeStageText;
      // an object that only LOOKS like JSON (renamed coverage fields) is still
      // rejected there, so the worker must retry on the real contract.
      return ReviewerParseSchema.safeParse(extractJsonObject(r.text)).success;
    } catch {
      return false;
    }
  };
  let text = '';
  let inferredProviderID = model.providerID;
  let inferredModelID = model.modelID;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  let structuredUsed = false;
  if (runnerKind === 'kilo') {
    // Real headless Kilo runtime drives the explicit provider/model route. The
    // server registers a StructuredOutput tool from REVIEW_VERDICT_JSON_SCHEMA,
    // forces toolChoice:"required" and retries server-side (retryCount).
    const call = (attemptUser: string, withFormat: boolean) => runKiloInference({
      role,
      providerID: model.providerID,
      modelID: model.modelID,
      baseURL,
      apiKey,
      kiloBin,
      snapshotStore: snapshotStore || store,
      system,
      user: attemptUser,
      directory,
      contextWindowTokens: budget.contextWindow,
      inputBudgetTokens: budget.inputBudgetTokens,
      maxOutputTokens: budget.outputBudgetTokens,
      files,
      format: withFormat ? REVIEW_OUTPUT_FORMAT : undefined,
    });
    let inf = await call(user, true);
    // PORTABILITY: a provider that cannot honour a forced tool call surfaces a
    // StructuredOutputError. That is NOT a review failure — fall back to the
    // strict-JSON text contract (which still gets schema validation + repair).
    if (!inf.ok && /structured/i.test(inf.error ?? '')) {
      console.log(`[worker] kilo ${role} structured output unavailable (${inf.error}); falling back to strict-JSON text`);
      inf = await call(user, false);
    }
    for (let attempt = 2; attempt <= MAX_JSON_ATTEMPTS && inf.ok && !inferenceAccepted(inf); attempt++) {
      console.log(`[worker] kilo ${role} returned no valid structured verdict; repair ${attempt}/${MAX_JSON_ATTEMPTS}`);
      inf = await call(user + repairNote(attempt), inf.structured !== undefined);
    }
    if (!inf.ok) failClosed(`kilo inference failed (${inf.providerID}/${inf.modelID}): ${inf.error}`);
    structuredUsed = inf.structured !== undefined;
    text = verdictText(inf.structured, inf.text);
    inferredProviderID = inf.providerID;
    inferredModelID = inf.modelID;
    tokensIn = inf.tokensIn;
    tokensOut = inf.tokensOut;
    console.log(`[worker] kilo ${role} backend: ${inf.providerID}/${inf.modelID} structured=${inf.structured !== undefined} finish=${inf.finish} in=${tokensIn} out=${tokensOut}`);
  } else if (runnerKind === 'codex') {
    // REAL ChatGPT Codex reviewer via `codex exec -m <model>` — read-only.
    // createCodexRunner negotiates --output-schema when the installed CLI supports
    // it and otherwise falls back to its strict-JSON prompt contract.
    const codexModel = model.modelID || (model.providerID && model.providerID.includes('gpt') ? model.providerID : 'gpt-6-luna');
    const crunner = createCodexRunner({
      codexBin: process.env.GT_CODEX_BIN || undefined,
      modelID: codexModel,
      workspaceHint: directory,
      promptCharBudget,
    });
    const res = await crunner.run({ role, providerID: model.providerID, modelID: codexModel, system, user });
    if (!res.ok) failClosed(`codex inference failed (${model.providerID}/${codexModel}): ${res.error}`);
    text = res.text ?? '';
    inferredProviderID = model.providerID;
    inferredModelID = codexModel;
    tokensIn = res.tokensIn;
    tokensOut = res.tokensOut;
    console.log(`[worker] codex ${role} actual backend codex/${codexModel} in=${tokensIn} out=${tokensOut}`);
  } else if (runnerKind === 'fake') {
    text = JSON.stringify({
      result: 'FINDINGS',
      coverage: { changedFiles: manifest.changedFiles.length, inspectedFiles: 1, uncoveredPaths: [] },
      findings: [{
        id: 'worker-fake-1', severity: 'HIGH', confidence: 'VERIFIED', title: 'detached worker canned finding',
        file: manifest.changedFiles[0] ?? undefined, lineStart: 1, lineEnd: 1, revision: manifest.headHash ?? undefined,
        evidence: 'detached worker (independent process) produced this finding', reviewerIds:
          role === 'reviewer-a' ? ['A'] : role === 'reviewer-b' ? ['B'] : role === 'governor' ? ['GOV'] : ['A', 'B'],
        adjudicated: role === 'adjudicator', adjudication: 'accepted',
      }],
      models: [{ role, providerID: model.providerID, modelID: model.modelID }],
    });
  } else {
    // Direct OpenAI-compatible endpoint: negotiate response_format from strict
    // json_schema → json_object → prompt-only, remembering what this endpoint
    // accepted so a downgrade is paid ONCE, not per inference.
    const chain = reviewResponseFormatChain();
    const cacheKey = `${baseURL.replace(/\/+$/, '')}|${model.modelID}`;
    let formatIndex = responseFormatCache.get(cacheKey) ?? 0;
    for (let attempt = 1; attempt <= MAX_JSON_ATTEMPTS; attempt++) {
      let content = '';
      let accepted = false;
      for (let i = formatIndex; i < chain.length; i++) {
        const responseFormat = chain[i];
        const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({
            model: model.modelID,
            messages: [{ role: 'system', content: system }, { role: 'user', content: attempt === 1 ? user : user + repairNote(attempt) }],
            temperature: 0.2,
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
        });
        const raw = await resp.text().catch(() => '');
        if (!resp.ok) {
          if (isUnsupportedStructuredOutput(resp.status, raw) && i + 1 < chain.length) continue;
          failClosed(`openai HTTP ${resp.status}: ${raw.slice(0, 200)}`);
        }
        responseFormatCache.set(cacheKey, i);
        formatIndex = i;
        content = (JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? '';
        accepted = true;
        break;
      }
      if (!accepted) failClosed('openai endpoint rejected every response_format mode');
      text = content;
      if (!text) failClosed('empty model response');
      if (inferenceAccepted({ ok: true, text }) || attempt === MAX_JSON_ATTEMPTS) break;
    }
  }
  const tookMs = Date.now() - t0;

  // Persist result blob with REAL model provenance (actual inferred backend).
  const blobDir = join(store, snapshotId, 'results');
  mkdirSync(blobDir, { recursive: true });
  const resultPath = join(blobDir, `${attemptId}.json`);
  writeFileSync(resultPath, JSON.stringify({
    jobId,
    attemptId,
    role,
    text,
    tookMs,
    providerID: model.providerID,
    modelID: model.modelID,
    inferredProviderID,
    inferredModelID,
    tokensIn,
    tokensOut,
    structured: structuredUsed,
    runner: runnerKind,
    contextTier: budget.tier,
    contextWindow: budget.contextWindow,
    contextSource: budget.source,
    promptCharBudget,
    outputTokenBudget: budget.outputBudgetTokens,
  }, null, 2));

  // Report to the control plane (fire, non-blocking completion — worker exits).
  const payload = { attemptId, role, jobId, resultPath, providerID: inferredProviderID, modelID: inferredModelID, tokensIn, tokensOut };
  if (controlURL && controlToken) {
    await fetch(`${controlURL}/v1/workers/${attemptId}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlToken}` },
      body: JSON.stringify(payload),
    }).catch((e) => { console.error('[worker] result post failed', e.message); });
  }
  console.log(`[worker] ${role} done (${tookMs}ms, ${inferredProviderID}/${inferredModelID}) -> ${resultPath}`);
  process.exit(0);
}

main().catch((e) => { console.error('[worker] fatal', e?.message ?? e); process.exit(1); });

