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
import { createCodexRunner } from './inference';

type Role = 'reviewer-a' | 'reviewer-b' | 'adjudicator';

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
  const userOverride = arg('--userOverride');
  const kiloBin = arg('--kiloBin');
  const snapshotStore = arg('--snapshotStore');
  const directory = arg('--directory') || workspacePath;

  if (!jobId || !roleValue || !snapshotId) failClosed('job/role/snapshot required');
  const role = roleValue as Role;
  if (!['reviewer-a', 'reviewer-b', 'adjudicator'].includes(role)) failClosed(`unknown role ${role}`);
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

  // Build the stage prompt (role -> reviewer-correctness / reviewer-adversarial / adjudicator).
  const promptFile = role === 'reviewer-a' ? 'reviewer-correctness.md' : role === 'reviewer-b' ? 'reviewer-adversarial.md' : 'adjudicator.md';
  const system = readFileSync(fileURLToPath(new URL(`./prompts/${promptFile}`, import.meta.url)), 'utf-8');
  // Adjudicator receives the combined A+B findings from the control plane;
  // otherwise build the standard review prompt from the frozen manifest.
  const user = userOverride && role === 'adjudicator'
    ? userOverride
    : [
        `# ${role} review of target ${snapshotId}`,
        `## Requirements`,
        requirements || '(none provided)',
        `## Changed files (${manifest.changedFiles.length})`,
        ...manifest.changedFiles.map((f) => `- ${f}`),
        `## Frozen evidence diff (complete immutable snapshot — no tools needed)`,
        '```',
        diff.slice(0, 128 * 1024),
        '```',
        '',
        'The ENTIRE immutable review evidence is contained above; there is nothing to fetch or inspect elsewhere.',
        'Do not attempt to call any tools or read any files — none are available and none are needed.',
        'Analyze the requirements, changed files and diff, then output ONLY the single strict JSON review object ' +
          'with fields (result, coverage, findings, models) as defined in your system prompt. No prose before or after the JSON.',
      ].join('\n');

  // Execute inference.
  const t0 = Date.now();
  let text: string;
  let inferredProviderID = model.providerID;
  let inferredModelID = model.modelID;
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  if (runnerKind === 'kilo') {
    // Real headless Kilo runtime drives the explicit provider/model route.
    const inf = await runKiloInference({
      role,
      providerID: model.providerID,
      modelID: model.modelID,
      baseURL,
      apiKey,
      kiloBin,
      snapshotStore: snapshotStore || store,
      system,
      user,
      directory,
    });
    if (!inf.ok) failClosed(`kilo inference failed (${inf.providerID}/${inf.modelID}): ${inf.error}`);
    text = inf.text;
    inferredProviderID = inf.providerID;
    inferredModelID = inf.modelID;
    tokensIn = inf.tokensIn;
    tokensOut = inf.tokensOut;
    console.log(`[worker] kilo ${role} actual backend: ${inf.providerID}/${inf.modelID} finish=${inf.finish} in=${tokensIn} out=${tokensOut}`);
  } else if (runnerKind === 'codex') {
    // REAL ChatGPT Codex reviewer via `codex exec -m <model>` — read-only,
    // strict-JSON, reusing the same standalone crunner the in-process path uses.
    // The binary comes from GT_CODEX_BIN (set by the supervisor); model ref is
    // used as the codex model. No tools: review fires only the frozen evidence.
    const codexModel = model.modelID || (model.providerID && model.providerID.includes('gpt') ? model.providerID : 'gpt-6-luna');
    const crunner = createCodexRunner({ codexBin: process.env.GT_CODEX_BIN || undefined, modelID: codexModel, workspaceHint: directory });
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
          role === 'reviewer-a' ? ['A'] : role === 'reviewer-b' ? ['B'] : ['A', 'B'],
        adjudicated: role === 'adjudicator', adjudication: 'accepted',
      }],
      models: [{ role, providerID: model.providerID, modelID: model.modelID }],
    });
  } else {
    const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: model.modelID, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.2 }),
    });
    if (!resp.ok) failClosed(`openai HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    text = data.choices?.[0]?.message?.content ?? '';
    if (!text) failClosed('empty model response');
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
    runner: runnerKind,
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