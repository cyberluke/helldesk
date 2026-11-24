import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { extractJsonObject } from './reviewers';
import { isUnsupportedStructuredOutput } from './review-contract';
import {
  profileRepo,
  renderRepoProfile,
  type RepoProfileSummary,
} from './repo-profile';

/**
 * Task Studio prompt enhancer.
 *
 * One model turn turns a terse operator brief into an implementation-ready
 * task spec. The model route and endpoint are supplied by the API from the
 * operator's effective Kilo configuration; this module never hardcodes a
 * provider/model and never touches LiteLLM.
 *
 * Design contracts:
 *  - the operator's intent, exclusions and named technologies are preserved;
 *  - repository analysis is READ-ONLY and bounded (never a workspace write);
 *  - the write target is resolved from the request, not trusted from the model:
 *    an empty outputRepo always forces `workspace` (in-place);
 *  - output is validated with Zod; one repair turn is allowed on invalid JSON.
 */

export const ENHANCE_TIMEOUT_MS = 120_000;
export const MAX_REPO_CONTEXT_CHARS = 40_000;

/**
 * Context budget handed to the enhancer/QA prompt builders. Resolved from the
 * same `resolveContextBudget` tiers as reviewers, so a 16K/32K route gets a
 * smaller repo context/spec instead of overflowing the model window.
 */
export interface EnhancePromptBudget {
  contextWindowTokens: number;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
  promptCharBudget: number;
}

export const DEFAULT_ENHANCE_PROMPT_BUDGET: EnhancePromptBudget = {
  contextWindowTokens: 131_072,
  inputBudgetTokens: 99_072,
  outputBudgetTokens: 32_000,
  promptCharBudget: 48_000,
};

/** Trim a user prompt to the tier-derived character budget. Optional context
 *  is sacrificed first; mandatory instructions stay at the head. */
function fitPromptToBudget(prompt: string, budget: number): string {
  if (!Number.isFinite(budget) || budget <= 0 || prompt.length <= budget) return prompt;
  // Trim optional context sections first, preserving the mandatory tail
  // (proof/instructions) after the section. Largest/optional content goes first.
  const sections = [
    '## Repository context (read-only)',
    '## Proposed spec (untrusted, authored by another agent)',
    '## Brief',
  ];
  for (const marker of sections) {
    const start = prompt.indexOf(marker);
    if (start < 0) continue;
    const rest = prompt.slice(start + marker.length);
    const next = rest.search(/\n## |\nReturn ONLY/);
    const end = next >= 0 ? start + marker.length + next : prompt.length;
    const head = prompt.slice(0, start);
    const after = prompt.slice(end);
    const room = Math.max(512, budget - head.length - after.length - 40);
    const trimmed = `${head}${prompt.slice(start, start + room)}${after}`;
    if (trimmed.length <= budget) return trimmed;
  }
  // Never lose the final "Return ONLY ..." instruction to a blind tail cut.
  const instructionMarker = '\nReturn ONLY';
  const instructionIndex = prompt.lastIndexOf(instructionMarker);
  const instruction = instructionIndex >= 0 ? prompt.slice(instructionIndex) : '';
  const body = instructionIndex >= 0 ? prompt.slice(0, instructionIndex) : prompt;
  const room = Math.max(512, budget - instruction.length - 40);
  return `${body.slice(0, room)}\n… [trimmed to the model context budget]${instruction}`;
}

export const EnhanceModeSchema = z.enum(['text', 'repos']);
export const TaskTypeSchema = z.enum(['engine', 'feature', 'bugfix', 'refactor', 'extraction']);
export const DeliverySchema = z.enum(['startup', 'production']);
export const WriteTargetSchema = z.enum(['workspace', 'output_repo']);

export type EnhanceMode = z.infer<typeof EnhanceModeSchema>;
export type TaskType = z.infer<typeof TaskTypeSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export type WriteTarget = z.infer<typeof WriteTargetSchema>;

export const EnhanceSourceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  path: z.string().trim().min(1).max(4096),
});

const EnhanceAttachmentSchema = z.object({
  attachment_id: z.string().trim().min(1).max(80),
  kind: z.enum(['image', 'pdf']),
  mode: z.enum(['inspiration', 'requirement']),
  filename: z.string().trim().min(1).max(255),
  mime: z.string().max(160).optional(),
  size: z.number().nonnegative().optional(),
  sha256: z.string().max(128).optional(),
  page_count: z.number().int().nonnegative().nullable().optional(),
  markdown: z.string().max(200_000).nullable().optional(),
  markdown_url: z.string().max(4096).nullable().optional(),
  markdown_path: z.string().max(4096).nullable().optional(),
  original_url: z.string().max(4096).optional(),
  original_path: z.string().max(4096).optional(),
  pages: z.array(z.object({
    page: z.number().int().min(1),
    url: z.string().max(4096).optional(),
    path: z.string().max(4096).optional(),
  })).max(40).optional(),
  created_at: z.string().max(80).optional(),
});

export const EnhanceRequestSchema = z.object({
  mode: EnhanceModeSchema,
  title: z.string().trim().min(1).max(400),
  spec: z.string().trim().min(1).max(60_000),
  workspace: z.string().trim().min(1).max(4096),
  /** Empty/absent means "no output repository": the write target is in-place. */
  outputRepo: z.string().trim().max(4096).optional(),
  writeTarget: WriteTargetSchema.optional(),
  taskType: TaskTypeSchema.optional(),
  delivery: DeliverySchema.optional(),
  sources: z.array(EnhanceSourceSchema).max(20).optional(),
  /** Images/PDFs from Task Studio. Mode decides inspiration vs pixel-parity. */
  attachments: z.array(EnhanceAttachmentSchema).max(8).optional(),
  /** Findings from the previous adversarial QA pass, used by Regenerate. */
  qaFindings: z.array(z.string().trim().min(1).max(2000)).max(12).optional(),
});

export type EnhanceRequest = z.infer<typeof EnhanceRequestSchema>;

export type EnhanceWorkspaceCheck =
  | { ok: true }
  | { ok: false; error: 'workspace_missing' | 'workspace_uninitialized'; message: string };

/**
 * The enhancer profiles the routed repos and runs the Kilo CLI with the
 * workspace as its `--dir`/cwd. A missing path — or a plain directory that was
 * never `git init`'d — makes that CLI hang on Windows (it sits on an empty,
 * non-repo workspace until the enhancer timeout), so reject it fast with an
 * actionable message. `Save repos` creates/initialises the workspace
 * (input = output when no output repo is configured).
 */
export function checkEnhanceWorkspace(workspace: string): EnhanceWorkspaceCheck {
  if (!existsSync(workspace)) {
    return {
      ok: false,
      error: 'workspace_missing',
      message: `Project workspace does not exist: ${workspace}`,
    };
  }
  if (!existsSync(join(workspace, '.git'))) {
    return {
      ok: false,
      error: 'workspace_uninitialized',
      message: `Project workspace is not a git repository yet: ${workspace}. Click Save repos to initialize it, then run Analyze again.`,
    };
  }
  return { ok: true };
}

export const MinimumProofItemSchema = z.object({
  claim: z.string().trim().min(1).max(2000),
  test: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().min(1).max(2000),
});

export type MinimumProofItem = z.infer<typeof MinimumProofItemSchema>;

/**
 * The model occasionally returns the spec as a structured object instead of a
 * markdown string. That is still a usable spec: serialize it rather than lose
 * the entire enhancement to a schema rejection.
 */
const MarkdownSpecSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value : value == null ? value : JSON.stringify(value, null, 2)),
  z.string().trim().min(1).max(200_000)
);

export const EnhancedTaskSchema = z.object({
  title: z.string().trim().min(1).max(400),
  taskType: TaskTypeSchema,
  writeTarget: WriteTargetSchema,
  delivery: DeliverySchema,
  spec: MarkdownSpecSchema,
  assumptions: z.array(z.string().trim().min(1).max(4000)).max(30),
  questions: z.array(z.string().trim().min(1).max(4000)).max(3),
  minimumProof: z.array(MinimumProofItemSchema).max(40),
  notDoneIf: z.array(z.string().trim().min(1).max(4000)).max(30),
  risks: z.array(z.string().trim().min(1).max(4000)).max(30),
});

export type EnhancedTask = z.infer<typeof EnhancedTaskSchema>;

/** The independent adversarial product-owner QA pass over the proposed spec. */
export const QaSeveritySchema = z.enum(['blocker', 'major', 'minor']);
export const QaFindingSchema = z.object({
  severity: QaSeveritySchema,
  issue: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().max(2000).optional(),
  requiredChange: z.string().trim().max(2000).optional(),
});
/**
 * QA models vary in field names (`blocking` vs `blocker`, `detail` vs
 * `evidence`, `required_fix` vs `requiredChange`). Accept the aliases and
 * normalize; a schema rejection here would turn a useful review into
 * UNAVAILABLE.
 */
const QaRawFindingSchema = z.object({
  severity: z.unknown().optional(),
  issue: z.unknown().optional(),
  title: z.unknown().optional(),
  problem: z.unknown().optional(),
  evidence: z.unknown().optional(),
  detail: z.unknown().optional(),
  requiredChange: z.unknown().optional(),
  required_fix: z.unknown().optional(),
  requiredFix: z.unknown().optional(),
}).passthrough();

const QaModelReviewSchema = z.object({
  verdict: z.unknown().optional(),
  summary: z.unknown().optional(),
  findings: z.array(z.unknown()).max(24).optional(),
}).passthrough();
export type QaFinding = z.infer<typeof QaFindingSchema>;
export type QaVerdict = 'PASS' | 'REVISE' | 'REJECT' | 'UNAVAILABLE';
export interface QaReview {
  verdict: QaVerdict;
  summary: string;
  findings: QaFinding[];
}

function qaString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeQaSeverity(value: unknown): QaFinding['severity'] {
  const lower = qaString(value).toLowerCase();
  if (/(block|critical|fatal)/.test(lower)) return 'blocker';
  if (/(major|high|serious)/.test(lower)) return 'major';
  if (/(minor|low|info|suggest)/.test(lower)) return 'minor';
  return 'major';
}

function normalizeQaVerdict(value: unknown, findings: QaFinding[]): QaVerdict {
  const lower = qaString(value).toLowerCase();
  if (/(not|never|doesn'?t|does not)\s+(pass|approve)/.test(lower)) return 'REVISE';
  if (/(^|\b)(pass|ok|approve|approved)(\b|$)/.test(lower)) {
    return findings.some((finding) => finding.severity !== 'minor') ? 'REVISE' : 'PASS';
  }
  if (/(reject|fail|blocked)/.test(lower)) return 'REJECT';
  if (/(revise|revision|change|fix)/.test(lower)) return 'REVISE';
  return 'REVISE';
}

/**
 * Shape the MODEL is asked to return. `taskType`/`writeTarget`/`delivery` are
 * accepted when present but the request-resolved values always win in
 * `normalizeEnhanced` (the model cannot move work out of the workspace).
 */
const ModelOutputSchema = z.object({
  title: z.string().trim().min(1).max(400).optional(),
  taskType: z.unknown().optional(),
  writeTarget: z.unknown().optional(),
  delivery: z.unknown().optional(),
  spec: MarkdownSpecSchema,
  assumptions: z.array(z.string().trim().min(1).max(4000)).max(60).optional(),
  questions: z.array(z.string().trim().min(1).max(4000)).max(10).optional(),
  minimumProof: z.array(MinimumProofItemSchema).max(60).optional(),
  notDoneIf: z.array(z.string().trim().min(1).max(4000)).max(60).optional(),
  risks: z.array(z.string().trim().min(1).max(4000)).max(60).optional(),
});

type ModelOutput = z.infer<typeof ModelOutputSchema>;

/**
 * Strict JSON schema for OpenAI-compatible `response_format`. Derived from the
 * same Zod contract (single source of truth) and strictified: every object
 * disallows additional properties and lists all of its properties as required,
 * which is what strict structured-output endpoints demand.
 */
function strictifyJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictifyJsonSchema);
  if (!node || typeof node !== 'object') return node;
  const source = node as Record<string, unknown>;
  // Copy first, then OVERRIDE: Zod may emit its own `required` (only the
  // non-optional keys) AFTER `properties`, and strict structured-output
  // endpoints require every property listed as required.
  const out: Record<string, unknown> = { ...source };
  if (source.properties && typeof source.properties === 'object' && !Array.isArray(source.properties)) {
    const properties: Record<string, unknown> = {};
    for (const [propName, propSchema] of Object.entries(source.properties as Record<string, unknown>)) {
      properties[propName] = strictifyJsonSchema(propSchema);
    }
    out.properties = properties;
    out.additionalProperties = false;
    out.required = Object.keys(properties);
  }
  for (const key of ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf']) {
    if (source[key] !== undefined) out[key] = strictifyJsonSchema(source[key]);
  }
  return out;
}

export const ENHANCER_OUTPUT_JSON_SCHEMA = strictifyJsonSchema(
  z.toJSONSchema(ModelOutputSchema, { target: 'draft-7', io: 'input' })
) as Record<string, unknown>;

/** OpenAI-compatible response_format chain: strict schema → json_object → prompt. */
export function enhancerResponseFormatChain(): Array<Record<string, unknown> | undefined> {
  return [
    {
      type: 'json_schema',
      json_schema: {
        name: 'EnhancedTask',
        strict: true,
        schema: ENHANCER_OUTPUT_JSON_SCHEMA,
      },
    },
    { type: 'json_object' },
    undefined,
  ];
}

// ── model runner boundary ────────────────────────────────────────────────────

export interface EnhancerModelCall {
  system: string;
  user: string;
  /** Local image/page files the Kilo CLI attaches to this message (`--file`).
   *  Only files from the HELLDESK attachment store are allowed. */
  files?: string[];
}

export type EnhancerModelResult =
  | { ok: true; text: string }
  | { ok: false; text?: string; error: string };

export interface EnhancerModelRunner {
  run(call: EnhancerModelCall): Promise<EnhancerModelResult>;
}

const ChatContentSchema = z.union([
  z.string(),
  z.array(z.object({ text: z.string().optional() }).passthrough()),
]);

const ChatCompletionSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({ content: ChatContentSchema.nullable().optional() })
              .passthrough(),
          })
          .passthrough()
      )
      .default([]),
  })
  .passthrough();

function textFromContent(content: z.infer<typeof ChatContentSchema> | null | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

/** Learned response-format capability per endpoint+model (one downgrade per endpoint). */
const responseFormatCache = new Map<string, number>();

/**
 * Direct OpenAI-compatible runner. ONE endpoint call per attempt; the
 * response_format chain is negotiated exactly like the reviewer runner so an
 * endpoint without json_schema support costs one rejected call, not one per
 * enhancement. Never logs the API key or the endpoint's raw error headers.
 */
export function createOpenAiEnhancerRunner(opts: {
  baseURL: string;
  apiKey?: string;
  modelID: string;
  timeoutMs?: number;
}): EnhancerModelRunner {
  const apiBase = opts.baseURL.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? ENHANCE_TIMEOUT_MS;
  const cacheKey = `${apiBase}|${opts.modelID}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  async function call(callInput: EnhancerModelCall): Promise<EnhancerModelResult> {
    const chain = enhancerResponseFormatChain();
    for (let index = responseFormatCache.get(cacheKey) ?? 0; index < chain.length; index += 1) {
      const responseFormat = chain[index];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${apiBase}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: opts.modelID,
            temperature: 0.2,
            messages: [
              { role: 'system', content: callInput.system },
              { role: 'user', content: callInput.user },
            ],
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const error = `enhance model HTTP ${response.status}: ${bodyText.slice(0, 300)}`;
          if (index + 1 < chain.length && isUnsupportedStructuredOutput(response.status, bodyText)) {
            continue;
          }
          return { ok: false, text: '', error };
        }
        responseFormatCache.set(cacheKey, index);
        const data: unknown = await response.json();
        const parsed = ChatCompletionSchema.safeParse(data);
        const text = parsed.success ? textFromContent(parsed.data.choices[0]?.message.content) : '';
        if (!text.trim()) return { ok: false, text: '', error: 'enhance model returned empty content' };
        return { ok: true, text };
      } catch (error) {
        return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, text: '', error: 'enhance model call exhausted the response-format chain' };
  }

  return { run: call };
}

/**
 * Kilo CLI runner for the enhancer. The CLI is the reliable transport in this
 * environment: it uses the operator's live Kilo config/auth (the SDK's
 * self-contained provider config 401s against Azure), accepts the full prompt
 * on stdin (no Windows command-line limit), and supports a read-only agent.
 *
 * The agent is injected via KILO_CONFIG_CONTENT, which the CLI merges over the
 * global config; provider/model still come from the operator's config and the
 * explicit --model route. No workspace writes are possible: edit/bash/task/
 * mcp/webfetch/external_directory are denied.
 */
  export function createKiloEnhancerRunner(opts: {
    modelRef: string;
    kiloBin: string;
    directory: string;
    timeoutMs?: number;
    /** Which read-only agent to run; both are defined in KILO_CONFIG_CONTENT. */
    agentName?: 'helldesk-enhancer' | 'helldesk-qa';
  }): EnhancerModelRunner {
    const timeoutMs = opts.timeoutMs ?? ENHANCE_TIMEOUT_MS;
    const readOnlyPermission = {
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
      mcp: 'deny',
      task: 'deny',
      todo: 'deny',
      notebook: 'deny',
      read: 'allow',
      grep: 'deny',
      glob: 'deny',
      list: 'deny',
      todoread: 'deny',
    };
    const agentConfig = JSON.stringify({
      agent: {
        'helldesk-enhancer': {
          description: 'Read-only Task Studio prompt enhancer',
          mode: 'primary',
          tools: {},
          permission: readOnlyPermission,
          prompt: [
            'You are a read-only task-spec enhancer.',
            'You may read ONLY the attached input files copied into your sandbox. Do not call shell, edit, network or repository tools. All repository context is embedded in the prompt.',
            'Never modify files. Return only the requested JSON object.',
          ].join(' '),
        },
        'helldesk-qa': {
          description: 'Adversarial product-owner QA for task specs',
          mode: 'primary',
          tools: {},
          permission: readOnlyPermission,
          prompt: [
            'You are the adversarial product owner and independent QA reviewer for task specs.',
            'You are not the author. Treat the proposed spec as untrusted.',
            'You may read ONLY the attached input files copied into your sandbox. Do not call shell, edit, network or repository tools. Reject scope reduction, invention and untestable acceptance.',
            'Return only the requested QA JSON object. Keep it short: verdict, a 2-sentence summary, at most 6 findings.',
          ].join(' '),
        },
      },
    });

  return {
    async run(call) {
      // `kilo run --file` is still an agent tool call and the enhancer agent
      // denies external_directory. Copy inputs INTO the isolated sandbox, then
      // attach the in-workspace copies. The sandbox is removed by the caller.
      const attachedFiles: string[] = [];
      if (call.files?.length) {
        const attachDir = join(opts.directory, 'attachments');
        mkdirSync(attachDir, { recursive: true });
        call.files.forEach((file, index) => {
          const destination = join(attachDir, `${index}-${basename(file)}`);
          copyFileSync(file, destination);
          attachedFiles.push(destination);
        });
      }
      const prompt = [
        call.system,
        '',
        call.user,
        ...(attachedFiles.length
          ? ['', `Attached input files (in order): ${attachedFiles.map((file) => basename(file)).join(', ')}`]
          : []),
        '',
        'Return ONLY one strict JSON object. No prose, no markdown fences, no commentary.',
      ].join('\n');
      const fileArgs = attachedFiles.flatMap((file) => ['--file', file]);

      return await new Promise<EnhancerModelResult>((resolve) => {
        const child = spawn(opts.kiloBin || 'kilo', [
          'run',
          '--pure',
          '--agent', opts.agentName ?? 'helldesk-enhancer',
          '--model', opts.modelRef,
          '--dir', opts.directory,
          ...fileArgs,
        ], {
          cwd: opts.directory,
          windowsHide: true,
          env: { ...process.env, KILO_CONFIG_CONTENT: agentConfig },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: EnhancerModelResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(result);
        };
        timer = setTimeout(() => {
          try { child.kill(); } catch { /* best effort */ }
          finish({ ok: false, text: stdout, error: `kilo enhancer timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (error) => {
          finish({ ok: false, text: stdout, error: `kilo enhancer spawn failed: ${error.message}` });
        });
        child.on('close', (code) => {
          if (code !== 0) {
            const detail = (stderr || stdout).trim().slice(0, 800);
            finish({ ok: false, text: stdout, error: `kilo enhancer exited ${code}${detail ? `: ${detail}` : ''}` });
            return;
          }
          finish({ ok: true, text: stdout });
        });
        child.stdin?.write(prompt);
        child.stdin?.end();
      });
    },
  };
}

// ── request resolution ──────────────────────────────────────────────────────

export type EngineKind = 'agnostic' | 'specific';

export interface ResolvedEnhanceSettings {
  taskType: TaskType;
  delivery: Delivery;
  writeTarget: WriteTarget;
  hasOutputRepo: boolean;
  /**
   * A game-agnostic engine/framework (templates, genre boundary, 3D if asked)
   * is a different product from a specific game/rules engine (Solitaire,
   * chess). The canonical engine proof must not leak into the latter.
   */
  engineKind: EngineKind;
  /** True when the brief actually asks for 3D; never inferred from taskType. */
  wants3d: boolean;
}

function inferEngineKind(text: string): EngineKind {
  const lower = text.toLowerCase();
  // "No game-agnostic framework" is a specific engine, not an agnostic one.
  if (/(?:no|not|without|non)\s+(?:a\s+)?(?:game|genre)[- ]agnostic/.test(lower)) return 'specific';
  return /game[- ]agnostic|genre[- ]agnostic|for any game|any game genre|any genre|reusable (?:game )?(?:engine|framework)|engine and framework/.test(lower)
    ? 'agnostic'
    : 'specific';
}

function inferWants3d(text: string): boolean {
  const lower = text.toLowerCase();
  // "No 3D rendering" is a 2D task; do not let the word 3D flip the proof.
  if (/(?:no|not|without|non)\s+(?:a\s+)?(?:3d|three\.js|webgl|webgpu|mesh|ray ?trac)/.test(lower)) return false;
  return /\b3d\b|three\.js|webgl|webgpu|\bmesh\b|ray ?trac/i.test(lower);
}

/** Extract a task type from the brief when the caller did not pin one. */
export function inferTaskType(text: string): TaskType {
  const lower = text.toLowerCase();
  if (/\bextract(?:ion|ing)?\b|\bcarve out\b|\bmove into (?:a )?(?:new|separate|reusable) (?:repo|engine|package)\b/.test(lower)) {
    return 'extraction';
  }
  if (/\bbug\b|\bfix\b|\bcrash\b|\bbroken\b|\bregression\b|\bfailure\b|\berror\b|\bthrows?\b/.test(lower)) {
    return 'bugfix';
  }
  if (/\brefactor\b|\brewrite\b|\bclean ?up\b/.test(lower)) return 'refactor';
  if (/\bengine\b|\bruntime\b|\brenderer\b|\bframework\b/.test(lower)) return 'engine';
  return 'feature';
}

/**
 * Resolve the effective defaults. An empty outputRepo ALWAYS forces the
 * workspace write target, even if the caller explicitly asked for output_repo.
 */
export function resolveEnhanceSettings(request: EnhanceRequest): ResolvedEnhanceSettings {
  const hasOutputRepo =
    typeof request.outputRepo === 'string' && request.outputRepo.trim().length > 0;
  const brief = `${request.title}\n${request.spec}`;
  return {
    taskType: request.taskType ?? inferTaskType(brief),
    delivery: request.delivery ?? 'startup',
    writeTarget: hasOutputRepo ? request.writeTarget ?? 'output_repo' : 'workspace',
    hasOutputRepo,
    engineKind: inferEngineKind(brief),
    wants3d: inferWants3d(brief),
  };
}

// ── prompts ─────────────────────────────────────────────────────────────────

function taskTypeInstructions(settings: ResolvedEnhanceSettings): string[] {
  const lines: string[] = [];
  switch (settings.taskType) {
    case 'engine':
      lines.push('## Task type: engine');
      lines.push('- The spec MUST contain these sections, in this order: Objective, Source/Output, Surfaces, Non-goals, Done, Not done if, Milestones.');
      if (settings.engineKind === 'specific') {
        lines.push('- This is a specific game/rules engine (e.g. Solitaire), not a genre-agnostic framework.');
        lines.push('- Do NOT add template/genre boundary tests, template swaps, or 3D proof unless the brief explicitly asks for them. Never contradict the brief\'s own non-goals.');
        lines.push('- MINIMUM PROOF for this specific engine:');
        lines.push('  1. Primary user flow works end to end on the real product surface, not a static mock.');
        lines.push('  2. The named win/loss/terminal transition fires exactly once.');
        lines.push('  3. Visual frame of the actual product surface, including the named CTA state.');
        lines.push('  4. Build/typecheck.');
        lines.push('- notDoneIf must reject: a stub or static mock, an unexercised win path, a CTA that cannot be re-run, a skipped build.');
      } else {
        lines.push('- Describe the reusable engine boundary, the surfaces it exposes, and what it must never import or hardcode.');
        lines.push('- MINIMUM PROOF for a game-agnostic engine:');
        lines.push('  1. Boundary test: the engine builds and contains no template imports or genre vocabulary.');
        lines.push('  2. Swap test: two different templates run on the same engine build.');
        lines.push('  3. Manifest validation: the game/template manifest validates against its schema.');
        lines.push('  4. Build/typecheck: the package builds and typechecks.');
        lines.push(settings.wants3d
          ? '  5. Visual frame: one rendered frame per 3D template.'
          : '  5. Visual frame: one rendered frame of the actual product surface.');
        lines.push(settings.wants3d
          ? '- notDoneIf must reject: a template leaking into the engine, only one template exercised, an invalid manifest, a skipped build, or no rendered 3D frame.'
          : '- notDoneIf must reject: a template leaking into the engine, only one template exercised, an invalid manifest, a skipped build, or no rendered frame of the actual product.');
      }
      break;
    case 'extraction':
      lines.push('## Task type: extraction');
      lines.push('- The spec MUST contain these sections, in this order: Objective, Source/Output, Surfaces, Non-goals, Done, Not done if, Milestones.');
      lines.push('- Name the source location and the output location explicitly, and preserve observable behavior.');
      if (settings.writeTarget === 'output_repo') {
        lines.push('- The source repository is read-only reference and the output repository is the delivery target.');
      } else {
        lines.push('- There is no output repository. Extract in place inside the workspace; do not describe copying, migrating, or extracting files into a different repository.');
      }
      break;
    case 'bugfix':
      lines.push('## Task type: bugfix');
      lines.push(
        settings.writeTarget === 'output_repo'
          ? '- The fix is delivered in the output repository; the workspace is read-only reference.'
          : '- The fix is in-place in the workspace.'
      );
      lines.push('- The spec MUST include: reproduction, root-cause hypothesis, fix, one regression test, build.');
      lines.push('- Do not propose a broad rewrite; fix the root cause and keep the change minimal.');
      break;
    case 'feature':
      lines.push('## Task type: feature');
      lines.push(
        settings.writeTarget === 'output_repo'
          ? '- The feature is delivered in the output repository; the workspace is read-only reference.'
          : '- The feature is implemented in-place in the workspace.'
      );
      lines.push('- The spec MUST include: current behavior, target behavior, likely files, acceptance criteria, 1-2 tests.');
      break;
    case 'refactor':
      lines.push('## Task type: refactor');
      lines.push(
        settings.writeTarget === 'output_repo'
          ? '- The refactor is delivered in the output repository; the workspace is read-only reference.'
          : '- The refactor is in-place in the workspace.'
      );
      lines.push('- The spec MUST include: behavior that must survive, internal change, parity proof, build.');
      break;
  }
  return lines;
}

export function buildEnhancerSystemPrompt(settings: ResolvedEnhanceSettings): string {
  const lines: string[] = [];
  lines.push(
    'You are the HELLDESK task-spec enhancer. Turn the operator brief into an implementation-ready task specification without changing its intent, scope, or exclusions.'
  );
  lines.push('');
  lines.push('## Hard rules');
  lines.push('- Preserve every explicit requirement, platform, constraint, exclusion, and named technology from the brief.');
  lines.push('- Never invent features, integrations, providers, editors, runtimes, frameworks, or deliverables the brief does not ask for. If the brief excludes something (e.g. "no editor" or "no NAI Cards port"), never add it back.');
  lines.push('- Do not widen scope. Prefer the smallest coherent slice that satisfies the brief.');
  lines.push('- State safe defaults as assumptions instead of asking about them.');
  lines.push('- Write concrete, testable statements. Avoid generic advice and filler.');
  lines.push('- UI/animation/flow tasks: minimumProof MUST include post-completion interaction/liveness — after the terminal frame/step, Replay/Close/click/keyboard still work, focus is usable, and the app does not freeze. A final-frame screenshot/assertion is not proof.');
  lines.push('- Input attachments: a requirement image/PDF is a pixel-perfect visual target; minimumProof MUST include a screenshot comparison at each named state. An inspiration attachment is a style/mechanic reference only — never impose pixel parity. Cite PDF page numbers when using extracted text.');
  lines.push('- The spec must be Markdown.');
  lines.push('');

  if (settings.delivery === 'startup') {
    lines.push('## Delivery: startup');
    lines.push('- Implementation-first: describe the smallest coherent runnable slice that can be demonstrated now.');
    lines.push('- Minimum proof only. Do NOT produce an exhaustive test matrix.');
    lines.push('- minimumProof must contain only the checks needed to prove THIS slice.');
  } else {
    lines.push('## Delivery: production');
    lines.push('- Production-grade behavior: cover the real boundaries, error paths, and integration points the brief names.');
    lines.push('- Verification must stay proportional: targeted tests plus build/typecheck, never an exhaustive test matrix for its own sake.');
  }
  lines.push('');

  lines.push(...taskTypeInstructions(settings));
  lines.push('');

  lines.push('## Write target');
  if (settings.writeTarget === 'workspace') {
    lines.push('- writeTarget is workspace: all changes are made in place in the given workspace.');
    lines.push('- There is no output repository. Do not describe copying, migrating, or extracting files into a different repository.');
  } else {
    lines.push('- writeTarget is output_repo: the output repository is the delivery target and the workspace is read-only reference.');
  }
  lines.push('');

  lines.push('## Questions and assumptions');
  lines.push('- questions: 0 entries when the brief is clear; otherwise 2-3 plain-language questions only when a wrong guess would change product behavior. Never ask about facts the repository context or safe defaults already answer.');
  lines.push('- assumptions: include every safe default you applied (in-place vs output repo, read-only analysis, minimum-proof scope).');
  lines.push('');
  lines.push('## Not done if');
  lines.push('- notDoneIf must list the easy cheats a lazy implementation would use to claim success for THIS task type.');
  lines.push('');
  lines.push('## Output budget');
  lines.push('- Keep `spec` under 1,200 words (about 8,000 characters). Be dense; no repetition, no restating the brief.');
  lines.push('- assumptions: at most 5. questions: at most 3. minimumProof: at most 6. notDoneIf: at most 6. risks: at most 5.');
  lines.push('- `spec` is a Markdown STRING, never an object.');
  lines.push('');
  lines.push('## Output');
  lines.push('Return ONLY one JSON object with exactly these keys:');
  lines.push(
    '{"title":"string","taskType":"engine|feature|bugfix|refactor|extraction","writeTarget":"workspace|output_repo","delivery":"startup|production","spec":"markdown string","assumptions":["string"],"questions":["string"],"minimumProof":[{"claim":"string","test":"string","evidence":"string"}],"notDoneIf":["string"],"risks":["string"]}'
  );
  lines.push('No markdown code fences. No prose before or after the JSON.');
  return lines.join('\n');
}

function appendAttachmentPromptLines(lines: string[], attachments: EnhanceRequest['attachments']): void {
  if (!attachments?.length) return;
  lines.push('');
  lines.push('## Input attachments');
  for (const attachment of attachments) {
    lines.push(`### ${attachment.filename} — ${attachment.kind} — ${attachment.mode}`);
    lines.push(
      attachment.mode === 'requirement'
        ? 'REQUIREMENT: pixel-perfect visual target. Proof MUST include a screenshot comparison at each named state; visual differences are findings.'
        : 'INSPIRATION: style/mechanic reference only. Do not impose pixel parity.',
    );
    if (attachment.page_count != null) lines.push(`Pages: ${attachment.page_count}`);
    if (attachment.original_path) {
      lines.push(`Original: ${attachment.original_path}${attachment.original_url ? ` (${attachment.original_url})` : ''}`);
    }
    if (attachment.markdown_path) {
      lines.push(`Extracted markdown: ${attachment.markdown_path}${attachment.markdown_url ? ` (${attachment.markdown_url})` : ''}`);
    }
    if (attachment.pages?.length) {
      lines.push(`Page images: ${attachment.pages.map((page) => `${page.page}:${page.path ?? page.url ?? ''}`).join(', ')}`);
    }
    if (attachment.markdown) {
      lines.push('', 'Extracted text (bounded):', attachment.markdown.slice(0, 8_000));
    }
  }
  lines.push('', 'A requirement attachment needs screenshot-comparison proof; an inspiration attachment must not become a pixel-parity requirement. PDF citations must use page references.');
}

export function buildEnhancerUserPrompt(
  request: EnhanceRequest,
  settings: ResolvedEnhanceSettings,
  repoContext: string,
  promptCharBudget: number = DEFAULT_ENHANCE_PROMPT_BUDGET.promptCharBudget
): string {
  const lines: string[] = [];
  lines.push('# Operator brief');
  lines.push(`Title: ${request.title}`);
  lines.push(`Mode: ${request.mode}`);
  lines.push(`Task type: ${settings.taskType}`);
  lines.push(`Delivery: ${settings.delivery}`);
  lines.push(`Write target: ${settings.writeTarget === 'workspace' ? 'workspace (in-place)' : 'output_repo'}`);
  lines.push(`Workspace: ${request.workspace}`);
  lines.push(`Output repo: ${settings.hasOutputRepo ? (request.outputRepo as string) : '(none — all work stays in the workspace)'}`);

  if (request.mode === 'repos' && request.sources?.length) {
    lines.push('');
    lines.push('## Source repositories (read-only)');
    for (const source of request.sources) lines.push(`- ${source.id}: ${source.path}`);
  }
  appendAttachmentPromptLines(lines, request.attachments);

  lines.push('');
  lines.push('## Brief');
  lines.push(request.spec);

  if (request.qaFindings?.length) {
    lines.push('');
    lines.push('## Adversarial QA findings to address');
    for (const finding of request.qaFindings) lines.push(`- ${finding}`);
    lines.push('Address every blocker/major finding without changing the operator intent.');
  }

  if (repoContext) {
    lines.push('');
    lines.push('## Repository context (read-only)');
    lines.push(repoContext);
  }

  lines.push('');
  lines.push('Return ONLY the enhancer JSON object. Preserve the brief intent exactly.');
  return fitPromptToBudget(lines.join('\n'), promptCharBudget);
}

/**
 * Independent adversarial product-owner QA. It sees the operator brief, the
 * selected shape, a bounded repo-evidence summary and the proposed spec. It
 * does NOT see the generator's reasoning, and it is explicitly instructed to
 * treat the spec as untrusted.
 */
export function buildQaSystemPrompt(): string {
  return [
    'You are the adversarial product owner and independent QA reviewer for a task-spec enhancer.',
    'You are NOT the author. Treat the proposed spec as untrusted and assume it may be a plausible-sounding scope reduction.',
    'Protect the operator intent and the product outcome. Reject specs that lose the named product, silently narrow scope, invent features, or accept a demo as the deliverable.',
    '',
    '## Required checks',
    '1. Intent preservation: every explicit product, exclusion, named technology, platform and constraint survives.',
    '2. No silent narrowing: a "slice" cannot replace the named product; a demo cannot replace the engine/framework; no editor or source-game port unless the brief asks for it.',
    '3. No invention: no features, providers, integrations, editors, runtimes or deliverables the brief did not request.',
    '4. Write target: no output repo means in-place workspace work; an output repo is the delivery target and the input workspace is read-only. Never invent a cross-repo move.',
    '5. Testability: acceptance has observable done and not-done clauses; minimum proof proves the core claim rather than file presence.',
    '6. Delivery profile: startup means implementation-first and minimum proof, not an exhaustive test matrix. Production may add proportional evidence but never a test matrix for its own sake.',
    '7. Task traps:',
    '   - engine: if the brief asks for a game-agnostic engine/framework, require reusable components, templates/generality, and the rendering target the brief names; never add 3D to a 2D brief. If the brief is a specific game/rules engine (e.g. Solitaire), require the actual rules, playable flow, win path and visual evidence; never impose genre-agnostic boundaries, templates or 3D on it.',
    '   - bugfix: reproduction, root cause, fix, one regression, build; no extraction language.',
    '   - feature: current behavior, target behavior, likely files, acceptance, 1-2 focused tests.',
    '   - refactor: behavior preserved, contract tests, build; no scope expansion.',
    '   - extraction: parity with the source, explicit output target, no whole-tree copy.',
    '8. Questions: only when a wrong guess changes product behavior; otherwise the spec must state safe defaults as assumptions.',
    '9. No contradiction: never require a technology or surface the brief excludes. If non-goals say no 3D, there is no 3D proof. If the brief is a specific game, there is no genre-agnostic boundary test.',
    '10. Post-completion liveness: for UI/animation/flow tasks, reject a spec whose minimum proof stops at the final frame. It must require post-completion interaction (Replay/Close/click/keyboard), usable focus and no main-thread freeze.',
    '11. Browser evidence: if a BrowserOS/browser-automation MCP is available, use it to exercise the real UI (post-completion clicks/keyboard/focus). If it is stale or unavailable, report that as an evidence limitation; never treat an unavailable browser as a PASS.',
    '12. Attachments: a requirement image/PDF must appear in minimumProof as screenshot-comparison proof; an inspiration reference must not become a pixel-parity requirement. PDF citations must use page references.',
    '',
    'A PASS requires every check to pass and no blocker/major finding to remain.',
    'Use REVISE for fixable gaps. Use REJECT for a wrong product, wrong scope, wrong write target, or an invented deliverable.',
    '',
    '## Output budget',
    '- summary: at most 2 sentences.',
    '- findings: at most 6; each issue and requiredChange one sentence.',
    '- No ids, scores, activity logs, or nested analysis.',
    '',
    'Return ONLY one JSON object with exactly these keys:',
    '{"verdict":"PASS|REVISE|REJECT","summary":"string","findings":[{"severity":"blocker|major|minor","issue":"string","evidence":"string?","requiredChange":"string?"}]}',
    'No prose, no markdown fences.',
  ].join('\n');
}

function renderAnalysisForQa(analysis: EnhanceAnalysis | undefined, maxChars = 6_000): string {
  if (!analysis) return '(text mode — no repository profiling was run)';
  const lines: string[] = [];
  const render = (label: string, profile: RepoProfileSummary) => {
    lines.push(`### ${label}`);
    lines.push(`- path: ${profile.path}`);
    lines.push(`- kind: ${profile.kind}`);
    if (profile.head) lines.push(`- head: ${profile.head.slice(0, 12)}`);
    if (profile.branch) lines.push(`- branch: ${profile.branch}`);
    if (profile.frameworks.length) lines.push(`- frameworks: ${profile.frameworks.join(', ')}`);
    if (profile.docs.length) lines.push(`- docs: ${profile.docs.join(', ')}`);
    if (profile.topLevel.length) lines.push(`- top-level: ${profile.topLevel.slice(0, 16).join(', ')}`);
    if (profile.dirs.length) {
      lines.push(`- dirs: ${profile.dirs.slice(0, 12).map((dir) => `${dir.path}(${dir.files})`).join(', ')}`);
    }
    if (profile.notes.length) lines.push(`- notes: ${profile.notes.slice(0, 5).join('; ')}`);
  };
  render('Workspace', analysis.workspace);
  if (analysis.output) render('Output repository', analysis.output);
  const joined = lines.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n… [analysis summary truncated]` : joined;
}

export function buildQaUserPrompt(
  request: EnhanceRequest,
  settings: ResolvedEnhanceSettings,
  enhanced: EnhancedTask,
  analysis: EnhanceAnalysis | undefined,
  promptCharBudget: number = DEFAULT_ENHANCE_PROMPT_BUDGET.promptCharBudget
): string {
  const specCap = Math.max(2_000, Math.floor(promptCharBudget * 0.55));
  const analysisCap = Math.max(1_000, Math.floor(promptCharBudget * 0.15));
  const lines: string[] = [];
  lines.push('# Operator brief');
  lines.push(`Title: ${request.title}`);
  lines.push(`Mode: ${request.mode}`);
  lines.push(`Task type: ${settings.taskType}`);
  lines.push(`Delivery: ${settings.delivery}`);
  lines.push(`Write target: ${settings.writeTarget === 'workspace' ? 'workspace (in-place)' : 'output_repo'}`);
  lines.push(`Workspace: ${request.workspace}`);
  lines.push(`Output repo: ${settings.hasOutputRepo ? (request.outputRepo as string) : '(none — all work stays in the workspace)'}`);
  if (request.mode === 'repos' && request.sources?.length) {
    lines.push('');
    lines.push('## Source repositories (read-only)');
    for (const source of request.sources) lines.push(`- ${source.id}: ${source.path}`);
  }
  appendAttachmentPromptLines(lines, request.attachments);
  lines.push('');
  lines.push('## Brief (verbatim)');
  lines.push(request.spec);
  lines.push('');
  lines.push('## Proposed spec (untrusted, authored by another agent)');
  lines.push(enhanced.spec.slice(0, specCap));
  if (enhanced.spec.length > specCap) lines.push(`… [spec truncated for review at ${specCap} chars]`);
  lines.push('');
  lines.push('## Proposed minimum proof');
  for (const item of enhanced.minimumProof) lines.push(`- ${item.claim} | ${item.test} | ${item.evidence}`);
  lines.push('');
  lines.push('## Proposed not-done clauses');
  for (const item of enhanced.notDoneIf) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Repository evidence summary');
  lines.push(renderAnalysisForQa(analysis, analysisCap));
  lines.push('');
  lines.push('Return ONLY the QA JSON object. Apply the system prompt checklist adversarially.');
  return fitPromptToBudget(lines.join('\n'), promptCharBudget);
}

type QaParseResult = { ok: true; value: QaReview } | { ok: false; error: string };

function parseQaReview(text: string): QaParseResult {
  try {
    const raw = extractJsonObject(text);
    const parsed = QaModelReviewSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') };
    }
    const findings: QaFinding[] = [];
    for (const item of parsed.data.findings ?? []) {
      const finding = QaRawFindingSchema.safeParse(item);
      if (!finding.success) continue;
      const issue = qaString(finding.data.issue)
        || qaString(finding.data.title)
        || qaString(finding.data.problem)
        || qaString(finding.data.detail);
      if (!issue) continue;
      const evidence = qaString(finding.data.evidence) || qaString(finding.data.detail);
      const requiredChange = qaString(finding.data.requiredChange)
        || qaString(finding.data.required_fix)
        || qaString(finding.data.requiredFix);
      findings.push({
        severity: normalizeQaSeverity(finding.data.severity),
        issue: issue.slice(0, 2000),
        ...(evidence ? { evidence: evidence.slice(0, 2000) } : {}),
        ...(requiredChange ? { requiredChange: requiredChange.slice(0, 2000) } : {}),
      });
      if (findings.length >= 12) break;
    }
    const verdict = normalizeQaVerdict(parsed.data.verdict, findings);
    const summary = qaString(parsed.data.summary) || findings[0]?.issue || 'QA reviewed the spec.';
    return { ok: true, value: { verdict, summary: summary.slice(0, 2000), findings } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildQaRepairPrompt(user: string, previous: string, error: string): string {
  return [
    user,
    '',
    `[QA repair] Your previous reply was not accepted: ${error}`,
    `Previous reply (truncated): ${previous.slice(0, 2_000)}`,
    'Return exactly one strict JSON object with verdict, summary and findings. No prose, no fences.',
  ].join('\n');
}

function isTransientQaError(error: string): boolean {
  return /connection reset|econnreset|socket hang up|temporarily unavailable|network error|fetch failed/i.test(error);
}

async function runQaReview(
  deps: EnhanceDeps,
  request: EnhanceRequest,
  settings: ResolvedEnhanceSettings,
  enhanced: EnhancedTask,
  analysis: EnhanceAnalysis | undefined
): Promise<QaReview> {
  const runner = deps.qaRunner ?? deps.runner;
  const qaPromptBudget = deps.qaBudget?.promptCharBudget
    ?? deps.enhancerBudget?.promptCharBudget
    ?? DEFAULT_ENHANCE_PROMPT_BUDGET.promptCharBudget;
  const system = buildQaSystemPrompt();
  const userBudget = Math.max(2_000, qaPromptBudget - system.length);
  const user = buildQaUserPrompt(request, settings, enhanced, analysis, userBudget);
  const attachmentFiles = collectAttachmentFiles(request.attachments);
  const withFiles = attachmentFiles.length ? { files: attachmentFiles } : {};
  const startedAt = Date.now();
  let first = await runner.run({ system, user, ...withFiles });
  // A dropped provider socket is not a QA verdict. Retry once, but never
  // double a timeout (that would blow the operator's approval budget).
  if (!first.ok && isTransientQaError(first.error ?? '') && Date.now() - startedAt < 90_000) {
    first = await runner.run({ system, user, ...withFiles });
  }
  if (!first.ok) {
    return {
      verdict: 'UNAVAILABLE',
      summary: `Adversarial QA could not run: ${first.error}`,
      findings: [],
    };
  }
  const firstParsed = parseQaReview(first.text);
  if (firstParsed.ok) return firstParsed.value;
  const repairUser = fitPromptToBudget(buildQaRepairPrompt(user, first.text, firstParsed.error), userBudget);
  const repaired = await runner.run({ system, user: repairUser, ...withFiles });
  if (!repaired.ok) {
    return {
      verdict: 'UNAVAILABLE',
      summary: `Adversarial QA could not run: ${repaired.error}`,
      findings: [],
    };
  }
  const secondParsed = parseQaReview(repaired.text);
  if (secondParsed.ok) return secondParsed.value;
  return {
    verdict: 'UNAVAILABLE',
    summary: `Adversarial QA returned invalid JSON after one repair: ${secondParsed.error}`,
    findings: [],
  };
}

function buildRepoContext(
  request: EnhanceRequest,
  workspaceProfile: RepoProfileSummary,
  outputProfile: RepoProfileSummary | undefined,
  charBudget: number = MAX_REPO_CONTEXT_CHARS
): string {
  const parts: string[] = [];
  parts.push(`### Workspace\n${renderRepoProfile(workspaceProfile)}`);
  if (outputProfile) parts.push(`### Output repository\n${renderRepoProfile(outputProfile)}`);
  for (const source of request.sources ?? []) {
    parts.push(`### Source: ${source.id}\n${renderRepoProfile(profileRepo(source.path))}`);
  }
  const joined = parts.join('\n\n');
  const cap = Math.max(2_000, Math.min(MAX_REPO_CONTEXT_CHARS, charBudget));
  if (joined.length <= cap) return joined;
  const marker = `\n\n… [repository context truncated at ${cap} chars]`;
  return joined.slice(0, Math.max(0, cap - marker.length)) + marker;
}

function buildRepairUserPrompt(originalUser: string, previousText: string, error: string): string {
  return [
    originalUser,
    '',
    '## Repair required',
    'Your previous response did not parse as the required enhancer JSON.',
    `Validation error: ${error.slice(0, 1200)}`,
    'Previous response (truncated):',
    previousText.slice(0, 4000),
    '',
    'Return ONLY one JSON object matching the contract. No markdown fences, no prose.',
  ].join('\n');
}

// ── normalization ───────────────────────────────────────────────────────────

const ENGINE_MINIMUM_PROOF: ReadonlyArray<MinimumProofItem> = [
  {
    claim: 'Boundary test: the engine builds and contains no template imports or genre vocabulary.',
    test: 'Grep the engine package for template/genre identifiers and run the engine unit suite.',
    evidence: 'Engine suite exit 0 plus a grep/command transcript showing zero template or genre references in engine sources.',
  },
  {
    claim: 'Swap test: two different templates run on the same engine build.',
    test: 'Run template A and template B against one unmodified engine build.',
    evidence: 'Both template runs produce their own output from the same engine artifact digest.',
  },
  {
    claim: 'Manifest validation: the game/template manifest validates against its schema.',
    test: 'Validate every template manifest used by the slice with the framework schema validator.',
    evidence: 'Validator exit 0 for every manifest used in the slice.',
  },
  {
    claim: 'Build/typecheck: the package builds and typechecks.',
    test: 'Run the package build and the typecheck command.',
    evidence: 'Build and typecheck exit 0 with the exact commands recorded.',
  },
  {
    claim: 'Visual frame: one rendered frame per 3D template.',
    test: 'Render each 3D template once and capture a frame.',
    evidence: 'One captured frame artifact per 3D template, bound to the build digest.',
  },
];

/**
 * A specific game/rules engine (e.g. Solitaire) is not a genre-agnostic
 * framework. Its proof is the real game flow, not template/3D boundaries.
 */
const SPECIFIC_ENGINE_MINIMUM_PROOF: ReadonlyArray<MinimumProofItem> = [
  {
    claim: 'Primary user flow works end to end on the real product surface.',
    test: 'Drive the actual board through the primary flow (deal → play → finish) in a real browser or deterministic headless run.',
    evidence: 'A run/recording that exercises the real surface, not a static mock.',
  },
  {
    claim: 'The named win/loss/terminal transition fires exactly once.',
    test: 'Drive the real transition and assert a single handoff to the terminal state.',
    evidence: 'Test output showing exactly one transition.',
  },
  {
    claim: 'Visual frame of the actual product surface, including the named CTA state.',
    test: 'Capture the real board and the CTA-triggered state once.',
    evidence: 'Screenshots bound to the build digest.',
  },
  {
    claim: 'Build/typecheck.',
    test: 'Run the package build and typecheck commands.',
    evidence: 'Both commands exit 0 with the exact commands recorded.',
  },
];

const TASK_NOT_DONE: Readonly<Record<TaskType, readonly string[]>> = {
  engine: [],
  bugfix: [
    'Do not claim done without a regression test that fails before the fix and passes after it.',
    'Do not claim done if the original reproduction still fails.',
    'Do not claim done if only the symptom was masked instead of the root cause fixed.',
  ],
  feature: [
    'Do not claim done if the acceptance behavior was never exercised.',
    'Do not claim done if only documentation, comments, or scaffolding changed.',
  ],
  refactor: [
    'Do not claim done if public behavior changed unintentionally.',
    'Do not claim done if tests were weakened, skipped, or removed to make the refactor pass.',
  ],
  extraction: [
    'Do not claim done if observable source behavior changed.',
    'Do not claim done without before/after parity evidence.',
    'Do not claim done if the old and new code paths both remain wired.',
  ],
};

const PRODUCTION_CHEAT_REJECTION = 'Do not claim done if only a happy path was exercised.';

function uniqueStrings(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function mergeStrings(base: readonly string[], extra: readonly string[], max: number): string[] {
  return uniqueStrings([...base, ...extra], max);
}

function defaultAssumptions(request: EnhanceRequest, settings: ResolvedEnhanceSettings): string[] {
  const assumptions: string[] = [];
  assumptions.push(
    settings.writeTarget === 'workspace'
      ? 'All changes stay in the current workspace (in-place); no output repository is used.'
      : 'The output repository is the only delivery target; the workspace is read-only reference.'
  );
  if (request.mode === 'repos') {
    assumptions.push('Repository analysis is read-only and bounded (git metadata, manifests, and excerpted docs only).');
  }
  if (settings.delivery === 'startup') {
    assumptions.push('Delivery is startup-focused: the smallest coherent slice with minimum proof only.');
  }
  return assumptions;
}

function agnosticEngineProof(settings: ResolvedEnhanceSettings): MinimumProofItem[] {
  const proof = ENGINE_MINIMUM_PROOF
    .filter((item) => settings.wants3d || !/3D/i.test(`${item.claim} ${item.test} ${item.evidence}`))
    .map((item) => ({ ...item }));
  if (!settings.wants3d) {
    proof.push({
      claim: 'Visual frame: one rendered frame of the actual product surface.',
      test: 'Render the main 2D surface once and capture a frame.',
      evidence: 'One captured frame bound to the build digest.',
    });
  }
  return proof;
}

function minimumProofText(item: MinimumProofItem): string {
  return `${item.claim} ${item.test} ${item.evidence}`;
}

/** A model that copied the genre-agnostic engine template into a specific
 *  game brief leaks boundary/swap/3D proof. Repair it deterministically. */
function looksLikeCanonicalGameEngineProof(proof: readonly MinimumProofItem[]): boolean {
  return proof.some((item) => /boundary test/i.test(item.claim))
    && proof.some((item) => /swap test/i.test(item.claim))
    && proof.some((item) => /3D template/i.test(minimumProofText(item)));
}

function engineNotDone(settings: ResolvedEnhanceSettings): string[] {
  if (settings.engineKind === 'specific') {
    return [
      'Do not claim done if the primary flow is a stub or static mock instead of the real product surface.',
      'Do not claim done if the named win/loss/terminal transition is not exercised exactly once.',
      'Do not claim done if the named CTA cannot be triggered and re-run from a fresh or mid-game state.',
      'Do not claim done if the build or typecheck was skipped or fails.',
    ];
  }
  const lines = [
    'Do not claim done if any template or genre vocabulary is imported by the engine.',
    'Do not claim done if only one template was exercised; the swap test needs two templates on the same engine build.',
    'Do not claim done if a manifest fails schema validation.',
    'Do not claim done if the build or typecheck was skipped or fails.',
  ];
  lines.push(settings.wants3d
    ? 'Do not claim done if no 3D template produced a rendered frame.'
    : 'Do not claim done if no rendered frame of the actual product surface exists.');
  return lines;
}

function fallbackProof(settings: ResolvedEnhanceSettings): MinimumProofItem[] {
  switch (settings.taskType) {
    case 'engine':
      return settings.engineKind === 'specific'
        ? SPECIFIC_ENGINE_MINIMUM_PROOF.map((item) => ({ ...item }))
        : agnosticEngineProof(settings);
    case 'bugfix':
      return [
        {
          claim: 'Regression test covers the reported failure.',
          test: 'Run the new regression test against the pre-fix state and the fixed state.',
          evidence: 'Pre-fix failure and post-fix pass for the same test.',
        },
        {
          claim: 'The package still builds after the fix.',
          test: 'Run the package build/typecheck command.',
          evidence: 'Build/typecheck exit 0.',
        },
      ];
    case 'feature':
      return [
        {
          claim: 'Target behavior is exercised.',
          test: 'Run 1-2 targeted tests for the new behavior.',
          evidence: 'Targeted test run exit 0.',
        },
        {
          claim: 'The package builds.',
          test: 'Run the package build/typecheck command.',
          evidence: 'Build/typecheck exit 0.',
        },
      ];
    case 'refactor':
      return [
        {
          claim: 'Behavior that must survive is unchanged.',
          test: 'Run the existing behavior/contract tests.',
          evidence: 'Exit 0 on the surviving behavior suite.',
        },
        {
          claim: 'The package builds.',
          test: 'Run the package build/typecheck command.',
          evidence: 'Build/typecheck exit 0.',
        },
      ];
    case 'extraction':
      return [
        {
          claim: 'Extracted behavior matches the source behavior.',
          test: 'Run before/after parity checks on the same inputs.',
          evidence: 'Identical outputs for the parity cases.',
        },
        {
          claim: 'The package builds.',
          test: 'Run the package build/typecheck command.',
          evidence: 'Build/typecheck exit 0.',
        },
      ];
  }
}

function normalizeEnhanced(
  model: ModelOutput,
  request: EnhanceRequest,
  settings: ResolvedEnhanceSettings
): EnhancedTask {
  // The model's proof wins, but a model that copied the genre-agnostic engine
  // template into a specific game brief is repaired. A "No 3D" brief must
  // never ship a 3D proof, even if the model hallucinated one.
  const modelProof = model.minimumProof?.length ? model.minimumProof.slice(0, 40) : [];
  const canonicalLeak =
    settings.taskType === 'engine'
    && settings.engineKind === 'specific'
    && modelProof.length > 0
    && looksLikeCanonicalGameEngineProof(modelProof);

  const minimumProof = (() => {
    if (canonicalLeak) return SPECIFIC_ENGINE_MINIMUM_PROOF.map((item) => ({ ...item }));
    if (!modelProof.length) return fallbackProof(settings);
    if (settings.taskType === 'engine' && !settings.wants3d) {
      const filtered = modelProof.filter((item) => !/\b3D\b|webgl|webgpu/i.test(minimumProofText(item)));
      if (!filtered.some((item) => /visual frame|rendered frame|screenshot|captured frame/i.test(item.claim))) {
        filtered.push({
          claim: 'Visual frame: one rendered frame of the actual product surface.',
          test: 'Render the main 2D surface once and capture a frame.',
          evidence: 'One captured frame bound to the build digest.',
        });
      }
      return filtered.length ? filtered : fallbackProof(settings);
    }
    return modelProof;
  })();

  const modelNotDone = canonicalLeak
    ? []
    : (model.notDoneIf ?? []).filter((clause) => {
        if (settings.taskType === 'engine' && !settings.wants3d) {
          return !/(?:no|without|missing)\s+(?:a\s+)?3D template|3D template produced|rendered 3D frame/i.test(clause);
        }
        return true;
      });

  const notDoneIf = mergeStrings(
    modelNotDone,
    [
      ...(settings.taskType === 'engine' ? engineNotDone(settings) : TASK_NOT_DONE[settings.taskType]),
      ...(settings.delivery === 'production' ? [PRODUCTION_CHEAT_REJECTION] : []),
    ],
    30
  );

  return EnhancedTaskSchema.parse({
    title: model.title?.trim() || request.title.trim(),
    taskType: settings.taskType,
    writeTarget: settings.writeTarget,
    delivery: settings.delivery,
    spec: model.spec.trim(),
    assumptions: mergeStrings(model.assumptions ?? [], defaultAssumptions(request, settings), 30),
    questions: uniqueStrings(model.questions ?? [], 3),
    minimumProof,
    notDoneIf,
    risks: uniqueStrings(model.risks ?? [], 30),
  });
}

// ── orchestration ───────────────────────────────────────────────────────────

export interface EnhanceAnalysis {
  workspace: RepoProfileSummary;
  output?: RepoProfileSummary;
}

export interface EnhanceResult {
  enhanced: EnhancedTask;
  analysis?: EnhanceAnalysis;
  /** Independent adversarial product-owner verdict; never auto-applied. */
  qa: QaReview;
  tookMs: number;
}

export interface EnhanceDeps {
  runner: EnhancerModelRunner;
  /**
   * Separate runner for the adversarial product-owner QA pass. When absent,
   * the generator runner is reused (tests only); production supplies a
   * distinct read-only QA agent/model.
   */
  qaRunner?: EnhancerModelRunner;
  /** Tier-derived budget for the generator prompt; defaults to 48K chars. */
  enhancerBudget?: EnhancePromptBudget;
  /** Tier-derived budget for the QA prompt; defaults to the enhancer budget. */
  qaBudget?: EnhancePromptBudget;
}

type ParseResult = { ok: true; value: ModelOutput } | { ok: false; error: string };

function parseModelOutput(text: string): ParseResult {
  try {
    const raw = extractJsonObject(text);
    const parsed = ModelOutputSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return { ok: false, error: issues.slice(0, 1200) };
    }
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Enhance one brief. Performs read-only repo profiling in `repos` mode, makes
 * one structured model call (plus at most ONE repair call), validates with Zod
 * and normalizes request-resolved fields.
 *
 * Throws on model failure or irreparable invalid output; the HTTP layer maps
 * that to 502. Never writes to any repository.
 */
/**
 * Local image/page files from the HELLDESK attachment store that a vision
 * enhancer/QA call may attach. Strictly bounded: store paths only, real files,
 * ≤8MB each, at most four files (images or PDF page renders).
 */
export function collectAttachmentFiles(attachments: EnhanceRequest['attachments']): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments ?? []) {
    const candidates =
      attachment.kind === 'pdf'
        ? (attachment.pages ?? []).slice(0, 3).map((page) => page.path)
        : [attachment.original_path];
    for (const filePath of candidates) {
      if (!filePath || seen.has(filePath)) continue;
      if (!/[\\/]attachments[\\/]att_[A-Za-z0-9]+[\\/]/i.test(filePath)) continue;
      if (!existsSync(filePath)) continue;
      try {
        const size = statSync(filePath).size;
        if (size <= 0 || size > 8 * 1024 * 1024) continue;
      } catch {
        continue;
      }
      seen.add(filePath);
      files.push(filePath);
      if (files.length >= 4) return files;
    }
  }
  return files;
}

export async function enhanceTask(request: EnhanceRequest, deps: EnhanceDeps): Promise<EnhanceResult> {
  const startedAt = Date.now();
  const settings = resolveEnhanceSettings(request);
  const attachmentFiles = collectAttachmentFiles(request.attachments);
  const withFiles = attachmentFiles.length ? { files: attachmentFiles } : {};

  const enhancerPromptBudget = deps.enhancerBudget?.promptCharBudget ?? DEFAULT_ENHANCE_PROMPT_BUDGET.promptCharBudget;
  const system = buildEnhancerSystemPrompt(settings);
  // The tier budget is for the user prompt; keep the system prompt inside the
  // same envelope so a 16K/32K route never overflows.
  const userBudget = Math.max(2_000, enhancerPromptBudget - system.length);

  let analysis: EnhanceAnalysis | undefined;
  let repoContext = '';
  if (request.mode === 'repos') {
    const workspace = profileRepo(request.workspace);
    const output = settings.hasOutputRepo ? profileRepo(request.outputRepo as string) : undefined;
    analysis = { workspace, ...(output ? { output } : {}) };
    repoContext = buildRepoContext(request, workspace, output, Math.max(2_000, userBudget - 6_000));
  }

  const user = buildEnhancerUserPrompt(request, settings, repoContext, userBudget);

  const first = await deps.runner.run({ system, user, ...withFiles });
  if (!first.ok) throw new Error(`model call failed: ${first.error}`);
  const firstParsed = parseModelOutput(first.text);

  let modelOutput: ModelOutput;
  if (firstParsed.ok) {
    modelOutput = firstParsed.value;
  } else {
    const repaired = await deps.runner.run({
      system,
        user: fitPromptToBudget(buildRepairUserPrompt(user, first.text, firstParsed.error), userBudget),
        ...withFiles,
    });
    if (!repaired.ok) throw new Error(`model repair call failed: ${repaired.error}`);
    const secondParsed = parseModelOutput(repaired.text);
    if (!secondParsed.ok) {
      throw new Error(`model returned invalid enhancer JSON after one repair: ${secondParsed.error}`);
    }
    modelOutput = secondParsed.value;
  }

  const enhanced = normalizeEnhanced(modelOutput, request, settings);
  const qa = await runQaReview(deps, request, settings, enhanced, analysis);
  return {
    enhanced,
    ...(analysis ? { analysis } : {}),
    qa,
    tookMs: Date.now() - startedAt,
  };
}
