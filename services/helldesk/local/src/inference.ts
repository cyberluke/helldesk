import { LocalProviderConfig } from './config';
import type { EvidenceCtx } from './context-reader';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveCodexBin } from './mutation-runner';
import {
  reviewListChangedFiles,
  reviewReadDiff,
  reviewReadFile,
  reviewSearch,
  reviewGetRequirements,
} from './context-reader';

/**
 * Model inference runner abstraction.
 *
 * Three implementations:
 *  - `fake`      : deterministic canned output (tests & fault injection).
 *  - `openai`    : direct OpenAI-compatible HTTP (standalone daemon path).
 *  - `kilo`      : driven by the in-process Kilo SDK/CLI in the plugin (inherit
 *                  provider auth, real model). Never the Kilo Gateway.
 */

export interface ReviewPrompt {
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
  system: string;
  user: string;
  providerID: string;
  modelID: string;
  /** Reviewer execution mode:
   *  - 'snapshot-tools'  : register the read-only review_* tools over the frozen
   *                        snapshot (best when the endpoint's tool calling is
   *                        reliable end-to-end).
   *  - 'frozen-evidence' : NO tools; the frozen diff/requirements are embedded in
   *                        the prompt. Reliable on endpoints whose tool calling
   *                        is flaky (e.g. some DeepSeek proxies). Default. */
  reviewMode?: 'snapshot-tools' | 'frozen-evidence';
  /** Frozen-snapshot evidence context (used only in snapshot-tools mode). */
  evidence?: import('./context-reader').EvidenceCtx;
}

export interface RunResult {
  ok: boolean;
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  error?: string;
  tookMs: number;
}

export interface InferenceRunner {
  readonly kind: 'fake' | 'openai' | 'codex' | 'kilo';
  run(prompt: ReviewPrompt): Promise<RunResult>;
}

const FAKE_DURATION_MS = 10;

/** Deterministic fake inference used only for tests / fault injection. */
export function createFakeRunner(opts?: {
  failWith?: string;
  canned?: Partial<Record<ReviewPrompt['role'], string>>;
}): InferenceRunner {
  return {
    kind: 'fake',
    async run(prompt) {
      const tookMs = FAKE_DURATION_MS;
      if (opts?.failWith) return { ok: false, text: '', error: opts.failWith, tookMs };
      const json = buildFakeJson(prompt.role);
      return { ok: true, text: prompt.role === 'adjudicator' ? json : json, tokensIn: 100, tokensOut: 40, cost: 0.0001, tookMs };
    },
  };
}

function buildFakeJson(role: ReviewPrompt['role']): string {
  const reviewerIds = role === 'reviewer-a' ? ['A'] : role === 'reviewer-b' ? ['B'] : ['A', 'B'];
  const findings =
    role === 'adjudicator'
      ? [
          {
            id: `fnd-fake-${role}-1`,
            severity: 'HIGH',
            confidence: 'VERIFIED',
            title: 'Adjudicated: disk write in read-only reviewer path',
            file: 'src/config.ts',
            lineStart: 20,
            lineEnd: 20,
            revision: 'snap',
            evidence: 'reviewer-config write observed at src/config.ts:20 in frozen snapshot',
            counterexample: 'a caller passing a path with traversal escapes the workspace root',
            requirement: 'reviewers must be structurally read-only',
            verification: 'confirm the snapshot blob does not route writes',
            reviewerIds: ['A', 'B'],
            adjudicated: true,
            adjudication: 'accepted',
          },
        ]
      : [
          {
            id: `fnd-fake-${role}-1`,
            severity: 'HIGH',
            confidence: 'VERIFIED',
            title: role === 'reviewer-a' ? 'Missing requirement: config validation bypass' : 'Race: unsynchronized daemon token write',
            file: 'src/config.ts',
            lineStart: 20,
            lineEnd: 20,
            revision: 'snap',
            evidence: 'requires field is unvalidated',
            counterexample: 'malformed input accepted',
            requirement: 'validate all IO with Zod',
            verification: 'run the validator',
            reviewerIds,
          },
        ];
  return JSON.stringify({
    result: findings.length > 0 ? 'FINDINGS' : 'PASS',
    coverage: { changedFiles: 1, inspectedFiles: 1, uncoveredPaths: [] },
    findings,
    models: [{ role, providerID: 'fake', modelID: 'deterministic' }],
  });
}

/** Direct OpenAI-compatible HTTP runner for the standalone daemon path. */
export function createOpenAiRunner(provider: LocalProviderConfig, opts?: { timeoutMs?: number }): InferenceRunner {
  const timeoutMs = opts?.timeoutMs ?? 180_000; // reviewers on slow models regularly exceed 60s
  const apiBase = provider.baseURL.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  // OpenAI function-tool declarations for the frozen-snapshot review_* tools.
  // Registered ONLY when the prompt carries a resolved EvidenceCtx (snapshot-tools
  // mode). The prompt system text must therefore reference tools it actually has.
  const toolSpecs = [
    {
      type: 'function',
      function: {
        name: 'review_list_changed_files',
        description: 'List the files changed in the frozen target.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'review_read_diff',
        description: 'Read the frozen diff for the whole change, one file, or a line range.',
        parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'review_read_file',
        description: 'Read a file at its pinned revision from the frozen snapshot store (optionally a line range).',
        parameters: { type: 'object', properties: { path: { type: 'string' }, revision: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } }, required: ['path'], additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'review_search',
        description: 'Search the frozen snapshot files for a literal substring.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, pathGlob: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'review_get_requirements',
        description: 'Get the requirement statement for the frozen target.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  ];
  const toolsFor = (ctx: EvidenceCtx | undefined): Array<Record<string, unknown>> | undefined =>
    ctx ? (toolSpecs as unknown as Array<Record<string, unknown>>) : undefined;

  // Execute one tool call against the frozen snapshot. Read-only, structural
  // traversal guards live in context-reader; no shell/edit/write here.
  function callTool(ctx: EvidenceCtx, name: string, args: Record<string, unknown>): string {
    switch (name) {
      case 'review_list_changed_files':
        return JSON.stringify(reviewListChangedFiles(ctx));
      case 'review_read_diff':
        return reviewReadDiff(ctx, typeof args.path === 'string' ? args.path : undefined, {
          start: typeof args.start === 'number' ? args.start : undefined,
          end: typeof args.end === 'number' ? args.end : undefined,
        });
      case 'review_read_file':
        return reviewReadFile(ctx, typeof args.revision === 'string' ? args.revision : null, String(args.path ?? ''), {
          start: typeof args.start === 'number' ? args.start : undefined,
          end: typeof args.end === 'number' ? args.end : undefined,
        });
      case 'review_search':
        return reviewSearch(ctx, String(args.query ?? ''), typeof args.pathGlob === 'string' ? args.pathGlob : undefined, typeof args.limit === 'number' ? args.limit : 50);
      case 'review_get_requirements':
        return reviewGetRequirements(ctx);
      default:
        return `[unknown tool: ${name}]`;
    }
  }

  async function chatOnce(body: Record<string, unknown>): Promise<
    | { ok: true; choices: Array<{ message: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    | { ok: false; error: string; status?: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: provider.modelID, temperature: 0.2, ...body }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return { ok: false, error: `openai HTTP ${resp.status}: ${txt.slice(0, 300)}`, status: resp.status };
      }
      const data = (await resp.json()) as never;
      return { ok: true, choices: (data as any).choices ?? [], usage: (data as any).usage };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: 'openai',
    async run(prompt) {
      const t0 = Date.now();
      // Register tools ONLY in explicit snapshot-tools mode (reliable tool calling).
      const ctx = prompt.reviewMode === 'snapshot-tools' ? prompt.evidence : undefined;
      // Do NOT claim tools exist if none are attached (contract integrity).
      const tools = toolsFor(ctx);
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];
      try {
        let step = 0;
        const MAX_TOOL_STEPS = 12; // bounded tool traversal
        while (step < MAX_TOOL_STEPS) {
          step++;
          const body: Record<string, unknown> = { messages };
          if (tools) {
            // NEVER combine response_format:json_object with tools — tested: the
            // model then skips tool_calls and emits an empty JSON object. With
            // tools present we rely on the reviewer system prompt's "return only
            // JSON" + extractJsonObject's prose stripping for the final parse.
            body['tools'] = tools;
            body['tool_choice'] = 'auto';
          } else {
            // No tools: force strict JSON from the first turn (frozen-evidence mode).
            body['response_format'] = { type: 'json_object' };
          }
          const res = await chatOnce(body);
          if (!res.ok) return { ok: false, text: '', error: res.error, tookMs: Date.now() - t0 };

          const last = res.choices?.[0]?.message;
          const toolCalls = last?.tool_calls ?? [];
          if (toolCalls.length === 0) {
            // Final answer: return the model's content (must be strict JSON).
            return {
              ok: true,
              text: last?.content ?? '',
              tokensIn: res.usage?.prompt_tokens,
              tokensOut: res.usage?.completion_tokens,
              tookMs: Date.now() - t0,
            };
          }
          // Assistant tool-call turn -> execute tools -> feed results back.
          messages.push({ role: 'assistant', content: last?.content ?? null, tool_calls: toolCalls });
          for (const tc of toolCalls) {
            let result: string;
            try {
              const args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
              result = ctx ? callTool(ctx, tc.function.name, args) : `[no evidence context: cannot execute ${tc.function.name}]`;
            } catch (err) {
              result = `[tool error: ${err instanceof Error ? err.message : String(err)}]`;
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
        }
        return { ok: false, text: '', error: 'reviewer exceeded tool-call budget', tookMs: Date.now() - t0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, text: '', error: message, tookMs: Date.now() - t0 };
      }
    },
  };
}

/**
 * Reviewer runner backed by the REAL ChatGPT Codex CLI (`codex exec -m <model>`
 * in `read-only` sandbox). This is the P0 Phase 11 "gpt-6-luna + DeepSeek"
 * reviewer route: on endpoints (like some DeepSeek proxies) whose structured
 * output is unreliable, gpt-6-luna returns the strict reviewer JSON deterministically.
 *
 * The prompt is asserted to a single compact strict-JSON payload; the model's
 * first `agent_message` is parsed as the decision. No writable/stateful surface —
 * read-only sandbox, no file writes, no web.
 */
export function createCodexRunner(opts?: { codexBin?: string; modelID?: string; timeoutMs?: number; workspaceHint?: string }): InferenceRunner {
  const model = opts?.modelID || 'gpt-6-luna';
  return {
    kind: 'codex',
    async run(prompt) {
      const t0 = Date.now();
      const bin = resolveCodexBin(opts?.codexBin);
      const ws = opts?.workspaceHint || process.cwd();
      // The reviewer system prompt may instruct calling review_* snapshot tools.
      // The codex runner has NO tools (frozen-evidence): it must reason from the
      // diff/requirements embedded in `user`. Strip tool-usage sections and
      // assert the model inspects the embedded evidence (reporting inspected files
      // it actually reasoned over) rather than returning inspectedFiles:0 because
      // it "could not call tools", which would be a false ZERO_COVERAGE rejection.
      const toolFreeSystem = (prompt.system ?? '')
        .split('\n')
        .filter((p) => {
          const s = p.trim();
          if (/^#+\s*(evidence tools|tools|evaluation tooling)/i.test(s)) return false;
          if (/^-\s*`?review_[a-z_]+`?/i.test(s) && p.trim().startsWith('-')) return false;
          if (/^use only these functions/i.test(s)) return false;
          if (s.startsWith('review_list_changed_files') || s.startsWith('review_read_diff') || s.startsWith('review_read_file') || s.startsWith('review_search') || s.startsWith('review_get_requirements') || s.startsWith('review_get_test_evidence')) return false;
          return true;
        })
        .join('\n')
        .trim();
      // Force the model to emit ONLY the strict JSON; gpt-6-luna reliably returns
      // it as the single agent_message.
      const forced = [
        toolFreeSystem || 'You are an adversarial reviewer.',
        '',
        'The complete immutable diff and requirements are embedded in the USER message (frozen evidence). No tools are available.',
        prompt.user && prompt.user.trim() ? prompt.user.trim() : '',
        '',
        'Reports inspectedFiles = the number of distinct changed files you ACTUALLY reasoned over from the embedded diff (>=1 if any change present).',
        'STRICT OUTPUT CONTRACT (mandatory): Reply with ONLY a single JSON object with EXACTLY these keys:',
        '{"result":"PASS|FINDINGS|INCONCLUSIVE","coverage":{"changedFiles":<int>,"inspectedFiles":<int>,"uncoveredPaths":[]},"findings":[],"models":[]}',
        'No prose, no markdown fences, no commentary before or after the JSON.',
        'Verdict rule: if you inspected the embedded evidence (inspectedFiles>=1) and found NO supported BLOCKER/HIGH/MEDIUM finding, the result MUST be "PASS" — do NOT hedge to "INCONCLUSIVE" when the evidence is complete and clean. Use "INCONCLUSIVE" ONLY when you actually cannot determine correctness from the provided evidence. Use "FINDINGS" when you have a supported finding.',
      ].filter(Boolean).join('\n').slice(0, 24_000);

      const timeoutMs = (opts?.timeoutMs ?? 120_000) + 15_000;
      const outcome = await new Promise<{ ok: boolean; text: string; error?: string }>((resolve) => {
        const child = spawn(bin, ['exec', '-m', model, '-C', ws, '-s', 'read-only', '--json', '--skip-git-repo-check', forced], {
          cwd: ws,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let errBuf = '';
        let settled = false;
        // `finish` is the SINGLE resolver + settled-guard. Later event handlers
        // (close/timer) must NOT pre-set `settled`, or finish early-returns and
        // the promise never resolves (reviewer deadlock).
        const finish = (r: { ok: boolean; text: string; error?: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
        const timer = setTimeout(() => { if (settled) return; try { child.kill('SIGKILL'); } catch {} finish({ ok: false, text: '', error: `codex reviewer timed out after ${timeoutMs}ms` }); }, timeoutMs);
        child.stdout?.on('data', (c) => { out += c.toString(); });
        child.stderr?.on('data', (c) => { errBuf += c.toString(); });
        child.on('error', (e) => { finish({ ok: false, text: '', error: `codex reviewer spawn error: ${e.message}` }); });
        child.on('close', (code) => {
          if (settled) return;
          // do NOT set settled here — finish owns it
          for (const line of out.split(/\r?\n/)) {
            const t = line.trim();
            if (!t.startsWith('{')) continue;
            try {
              const ev = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
              if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string' && ev.item.text.trim() && ev.item.text.includes('result')) {
                finish({ ok: true, text: ev.item.text.trim() });
                return;
              }
            } catch { /* not an event line */ }
          }
          // A non-zero code (e.g. exit 9 = codex/rust memory crash under heavy load)
          // or missing JSON is a RETRYABLE transport failure, NOT an uncaught error.
          finish({ ok: false, text: '', error: `codex reviewer produced no strict JSON (exit ${code}): ${(errBuf || out).slice(-400)}` });
        });
      });
      if (!outcome.ok) return { ok: false, text: outcome.text, error: outcome.error, tookMs: Date.now() - t0 };
      return { ok: true, text: outcome.text, tookMs: Date.now() - t0 };
    },
  };
}

/** Structured prompt assembly for each review stage. */
export function buildReviewUserPrompt(opts: {
  role: ReviewPrompt['role'];
  targetId: string;
  requirements: string;
  diff: string;
  changedFiles: string[];
  /** Controls the tool-instruction tail: snapshot-tools vs frozen-evidence. */
  reviewMode?: 'snapshot-tools' | 'frozen-evidence';
}): string {
  const roleText =
    opts.role === 'reviewer-a'
      ? 'Correctness & scope'
      : opts.role === 'reviewer-b'
        ? 'Adversarial failure hunter'
        : 'Adjudicator';
  const modeLine =
    opts.reviewMode === 'snapshot-tools'
      ? 'Use the provided review_* evidence tools to inspect files at pinned revisions. Produce the strict JSON result object.'
      : 'No review tools are available; the complete immutable diff and requirements above ARE your frozen evidence. Inspect them carefully and produce the strict JSON result object.';
  return [
    `# ${roleText} review of target ${opts.targetId}`,
    '',
    `## Requirements`,
    opts.requirements || '(none provided)',
    '',
    `## Changed files (${opts.changedFiles.length})`,
    ...opts.changedFiles.map((f) => `- ${f}`),
    '',
    `## Diff`,
    '```',
    opts.diff.slice(0, 128 * 1024),
    '```',
    '',
    modeLine,
  ].join('\n');
}