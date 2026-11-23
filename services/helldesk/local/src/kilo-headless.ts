import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKilo } from '@kilocode/sdk';
import { ensureHiddenChildSpawns } from './windows-spawn';
import { probeProvider } from './provider-preflight';

/**
 * Real headless Kilo inference for detached HELLDESK review workers.
 *
 * Each review worker boots its OWN Kilo runtime via the installed
 * `@kilocode/sdk` (createKilo -> the user's locally-installed `kilo serve`
 * headless server binary). It never touches the originating VS Code instance,
 * never uses the Kilo Gateway, GitHub or containers, and never shares a runtime
 * with other workers. The worker:
 *   1. loads the effective native provider config for the requested route,
 *   2. creates a read-only `helldesk-reviewer` agent (all write/shell/external
 *      tools denied; only the immutable evidence snapshot read tools allowed),
 *   3. creates an isolated session in its own scratch directory,
 *   4. sends the role-specific reviewer prompt,
 *   5. reads model identity, token usage, cost and inference errors,
 *   6. shuts its own runtime down.
 *
 * The provider resolver is FAIL-CLOSED: an unknown/misconfigured provider or a
 * missing model route never silently substitutes a model.
 */

export interface KiloWorkerConfig {
  /** providerID/modelID of the real model route (effective Kilo config or explicit override) */
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator' | 'governor' | 'enhancer' | 'sizer';
  providerID: string;
  modelID: string;
  /** OpenAI-compatible baseURL (no trailing slash semantics enforced). */
  baseURL: string;
  /** Optional bearer apiKey passed verbatim to the headless runtime (never logged). */
  apiKey?: string;
  /**
   * Optional full provider definition inherited from the operator's Kilo config.
   * Carrying it preserves auth headers/options that `provider.options.apiKey`
   * does not expose (the direct OpenAI-compatible 401 trap). The model table is
   * narrowed to `modelID` before transport.
   */
  providerConfig?: Record<string, unknown>;
  /**
   * Optional wire model reference. OpenAI-compatible providers want the bare
   * model ID; Kilo-hosted routes may want `provider/model`. Defaults to the
   * prefixed route to preserve reviewer behavior.
   */
  modelRef?: string;
  /** Absolute path to the `kilo` server binary (headless Kilo runtime). */
  kiloBin: string;
  /** Absolute path to the immutable snapshot store (read-only evidence tools). */
  snapshotStore: string;
  /** Role-specific system prompt (reviewer-correctness.md / adversarial / adjudicator). */
  system: string;
  /** User turn (frozen diff + requirements + changed files). */
  user: string;
  /** Tier-resolved context window (tokens). Defaults to 131072 for legacy callers. */
  contextWindowTokens?: number;
  /** Tier-resolved input budget (tokens). Derived from context-output when absent. */
  inputBudgetTokens?: number;
  /** Tier-resolved output reserve (tokens). Defaults to 32000 for legacy callers. */
  maxOutputTokens?: number;
  /** Optional input working directory for the session. */
  directory: string;
  /**
   * Optional native structured-output contract. Kilo's server registers a
   * `StructuredOutput` tool with this JSON Schema, forces `toolChoice:"required"`,
   * validates the tool arguments and retries (`retryCount`). The validated
   * payload is returned in `KiloInferenceResult.structured`.
   */
  format?: { type: 'json_schema'; schema: Record<string, unknown>; retryCount?: number };
  /**
   * Optional read-only agent identity override for non-review prompt roles
   * (currently the Task Studio enhancer). Defaults preserve reviewer behavior.
   */
  agentName?: string;
  agentPrompt?: string;
}

export interface KiloInferenceResult {
  ok: boolean;
  text: string;
  /** Tool-validated structured payload (present when a `format` was requested). */
  structured?: unknown;
  providerID: string;
  modelID: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  finish?: string;
  error?: string;
  tookMs: number;
}

function fail(message: string): never {
  throw new Error(`kilo-headless fail-closed: ${message}`);
}

/** Build the SDK Config for one isolated read-only reviewer runtime. */
export function buildSdkConfig(cfg: KiloWorkerConfig): Record<string, unknown> {
  const modelRef = cfg.modelRef ?? `${cfg.providerID}/${cfg.modelID}`;
  const readOnlyPermission = {
    edit: 'deny',
    bash: 'deny',
    webfetch: 'deny',
    external_directory: 'deny',
    mcp: 'deny',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    read: 'allow',
    todoread: 'allow',
    todo: 'deny',
    task: 'deny',
    notebook_read: 'allow',
    notebook: 'deny',
    notebook_edit: 'deny',
    notebook_execute: 'deny',
  };
  const agentName = cfg.agentName ?? 'helldesk-reviewer';
  const agentPrompt = cfg.agentPrompt ?? [
    'You are an autonomous read-only code reviewer.',
    'You have NO write, shell, edit, mcp, webfetch, task-delegation or configuration-mutation capabilities and no tools.',
    'The complete immutable evidence snapshot (requirements, changed files, and the full diff) is embedded directly in the user message.',
    'Do NOT attempt to call or await any review tools — none are available and none are needed.',
    'Produce the strict JSON review object in your FIRST response, exactly as the user message specifies. Never defer to a later step, never return narrative instead of JSON.',
    'Never modify source, never run shell, never write files.',
  ].join('\n');
  const inheritedModels = cfg.providerConfig?.models;
  const inheritedModel = inheritedModels && typeof inheritedModels === 'object' && !Array.isArray(inheritedModels)
    ? (() => {
        const table = inheritedModels as Record<string, unknown>;
        const direct = table[cfg.modelID];
        if (direct !== undefined) return direct as Record<string, unknown>;
        const byId = Object.keys(table).find((key) => {
          const candidate = table[key];
          return !!candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === cfg.modelID;
        });
        return byId ? (table[byId] as Record<string, unknown>) : undefined;
      })()
    : undefined;
  const modelDef: Record<string, unknown> = {
    ...(inheritedModel ?? {}),
    id: cfg.modelID,
    name: (inheritedModel?.name as string | undefined) ?? cfg.modelID,
    tool_call: inheritedModel?.tool_call ?? true,
    reasoning: inheritedModel?.reasoning ?? true,
    // Tier-derived window: a hardcoded 131072 truncated 256K-1M local
    // models and overflowed 32K ones. The worker resolves the operator's
    // tier (config.json override or kilo.jsonc model limit) per route.
    limit: {
      context: cfg.contextWindowTokens ?? 131072,
      input:
        cfg.inputBudgetTokens ??
        Math.max(0, (cfg.contextWindowTokens ?? 131072) - (cfg.maxOutputTokens ?? 32000)),
      output: cfg.maxOutputTokens ?? 32000,
    },
    modalities: inheritedModel?.modalities ?? { input: ['text'], output: ['text'] },
  };
  const providerDef: Record<string, unknown> = cfg.providerConfig
    ? { ...cfg.providerConfig, models: { [cfg.modelID]: modelDef } }
    : {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: cfg.baseURL.replace(/\/+$/, ''),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        },
        models: { [cfg.modelID]: modelDef },
      };

  return {
    model: modelRef,
    ...(process.env.HELLDESK_KILO_DEBUG ? { logLevel: 'debug' } : {}),
    enabled_providers: [cfg.providerID],
    default_agent: agentName,
    agent: {
      [agentName]: {
        model: modelRef,
        // Read-only: no write/shell/edit loop. The enhancer uses the same
        // permission boundary because repository profiling is done locally.
        maxSteps: 6,
        tools: {},
        permission: readOnlyPermission,
        prompt: agentPrompt,
      },
    },
    provider: { [cfg.providerID]: providerDef },
  };
}

/** Total attempts per Kilo inference (first try + 3 retries). */
export const KILO_INFERENCE_MAX_ATTEMPTS = 4;
export const KILO_RETRY_BASE_MS = 2_000;
export const KILO_RETRY_MAX_MS = 30_000;

/**
 * Transient transport/provider failures: socket close, DNS, refused/reset,
 * 429/5xx. These are safe to retry — the network can simply be busy.
 * Auth, validation and structured-output failures are NOT retried; they need a
 * configuration/contract fix, not another attempt.
 */
export function isTransientKiloError(error: string | undefined): boolean {
  const text = (error ?? '').toLowerCase();
  if (!text) return false;
  if (text.includes('bound exceeded')) return false;
  if (text.includes('structured output')) return false;
  return /socket|econn(reset|refused|aborted)?|etimedout|enetunreach|eai_again|fetch failed|network|connection (reset|closed|refused|timed out)|closed unexpectedly|socket hang up|temporarily unavailable|unexpected server error|internal server error|\b(429|500|502|503|504)\b/.test(text);
}

/** Exponential retry delay with a hard cap (attempt 1 => base). */
export function kiloRetryDelayMs(attempt: number, base = KILO_RETRY_BASE_MS, max = KILO_RETRY_MAX_MS): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(max, base * Math.pow(3, n - 1));
}

/** Run ONE review stage through a real headless Kilo runtime. Fail-closed. */
export async function runKiloInference(cfg: KiloWorkerConfig): Promise<KiloInferenceResult> {
  const t0 = Date.now();
  if (!cfg.providerID || !cfg.modelID) fail(`provider/model required (role=${cfg.role})`);
  if (!cfg.baseURL) fail(`baseURL required for provider ${cfg.providerID}`);
  if (!cfg.kiloBin) fail(`kiloBin (headless Kilo server binary) required`);

  // The SDK spawns `kilo` from PATH; prepend our resolved binary dir so a
  // non-configured environment still finds the local headless runtime.
  const binDir = cfg.kiloBin.slice(0, Math.max(cfg.kiloBin.lastIndexOf('/'), cfg.kiloBin.lastIndexOf('\\')));
  const priorPath = process.env.PATH ?? '';
  if (binDir && !priorPath.split(';').includes(binDir)) process.env.PATH = `${binDir};${priorPath}`;

  // Isolated scratch/runtime data dir for THIS worker only.
  const scratch = mkdtempSync(join(tmpdir(), 'helldesk-worker-'));
  const config = buildSdkConfig(cfg);
  // The Kilo VSIX exports its own KILO_CONFIG_CONTENT into every child shell.
  // @kilocode/sdk MERGES process.env.KILO_CONFIG_CONTENT into the spawned server
  // config; the operator config is ~380 KB, Windows truncates a >32K env var into
  // invalid JSON, and the server then skips ALL config (no provider registered).
  // The reviewer config below is self-contained, so drop the inherited blob.
  delete process.env.KILO_CONFIG_CONTENT;

  try {
    // Preflight the provider endpoint BEFORE booting a Kilo runtime. A dead
    // gateway used to burn one worker (and one review attempt) per socket
    // refusal. One explicit, cached probe makes that a single visible attempt.
    const providerProbe = await probeProvider(cfg.baseURL);
    if (!providerProbe.ok) {
      return {
        ok: false,
        text: '',
        providerID: cfg.providerID,
        modelID: cfg.modelID,
        error: providerProbe.error ?? `provider_unreachable: ${cfg.baseURL}`,
        tookMs: Date.now() - t0,
      };
    }
    // INFERENCE BOUND: a wedged createKilo boot or a model/session that never
    // resolves must fast-fail instead of hanging the review forever. This path is
    // used by the READ-ONLY reviewer/adjudicator workers (the mutation runner has
    // its own watchdog), so the bound only guards against a dead session.
    // Reviews see the FULL frozen diff + requirements; a six-file slice legitimately
    // needs >10 min on a reasoning model (observed: bound exceeded at 10 min). The
    // bound exists only to recover from a wedged session, not to cap real work.
    const INFERENCE_BOUND_MS = 20 * 60_000;
    const deadline = t0 + INFERENCE_BOUND_MS;
    let lastFailure: KiloInferenceResult | null = null;

    // A busy network/provider closes sockets transiently. Failing closed on the
    // FIRST socket close turned a recoverable blip into a 100+ attempt review
    // loop. Bounded exponential retry (2s/6s/18s, capped) fixes that; the whole
    // retry budget stays inside the existing inference bound.
    for (let attempt = 1; attempt <= KILO_INFERENCE_MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let result: KiloInferenceResult;
      try {
        result = await withTimeout((signal: AbortSignal) => runOnce(cfg, config, t0, signal), remaining);
      } catch (err) {
        result = {
          ok: false,
          text: '',
          providerID: cfg.providerID,
          modelID: cfg.modelID,
          error: err instanceof Error ? err.message : String(err),
          tookMs: Date.now() - t0,
        };
      }
      if (result.ok) return result;
      lastFailure = result;
      if (attempt >= KILO_INFERENCE_MAX_ATTEMPTS || !isTransientKiloError(result.error)) {
        return result;
      }
      const delay = kiloRetryDelayMs(attempt) + Math.floor(Math.random() * 400);
      if (Date.now() + delay >= deadline) return result;
      console.log(
        `[kilo] ${cfg.role} transient inference failure (attempt ${attempt}/${KILO_INFERENCE_MAX_ATTEMPTS}); retrying in ${delay}ms: ${String(result.error ?? '').slice(0, 200)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return lastFailure ?? {
      ok: false,
      text: '',
      providerID: cfg.providerID,
      modelID: cfg.modelID,
      error: 'kilo inference budget exhausted',
      tookMs: Date.now() - t0,
    };
  } finally {
    // Scratch is genuinely ephemeral (one-shot worker). Clean it up so every
    // inference doesn't leak a temp dir that only a GPU crash/restart clears.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Runs the createKilo + session.create + session.prompt pipeline once, abortable. */
async function runOnce(
  cfg: KiloWorkerConfig,
  config: ReturnType<typeof buildSdkConfig>,
  t0: number,
  signal: AbortSignal,
) {
  // SDK default server boot timeout is 5s. A 7.8.31 `kilo serve` boot plus MCP
  // server startup regularly takes 2.5-4s and can exceed 5s under load —
  // observed as flaky `createKilo boot failed: Timeout waiting for server to
  // start` that burned real revisions. 30s is a safe boot bound (the inference
  // itself is bounded separately).
  ensureHiddenChildSpawns();
  const created = await createKilo({ port: 0, config: config as never, signal, timeout: 30_000 });
  const client = created.client;
  try {
    const created_ = await client.session.create({ query: { directory: cfg.directory } });
    const sessionID = created_.data?.id;
    if (!sessionID) fail(`headless Kilo failed to create a session (role=${cfg.role})`);

    // `format` is Kilo's native structured-output contract (OutputFormatJsonSchema).
    // The bundled SDK types (7.4.x) predate it, but the 7.8.x server accepts the
    // field and returns the tool-validated payload on the assistant message as
    // `info.structured`. Send it whenever a contract is configured.
    const body: Record<string, unknown> = {
      agent: cfg.agentName ?? 'helldesk-reviewer',
      model: { providerID: cfg.providerID, modelID: cfg.modelID },
      system: cfg.system,
      parts: [{ type: 'text', text: cfg.user }],
      ...(cfg.format ? { format: cfg.format } : {}),
    };
    const res = await client.session.prompt({
      path: { id: sessionID },
      query: { directory: cfg.directory },
      body: body as never,
    });
    if (cfg.role === 'sizer' && process.env.HELLDESK_KILO_DEBUG) {
      try {
        const dir = join(cfg.snapshotStore, '_sizing');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'last-response.json'), JSON.stringify(res, null, 2), 'utf8');
      } catch { /* diagnostics only */ }
    }

    type AnyResult = { [k: string]: any };
    const rr = res as unknown as AnyResult;
    // The SDK can return a transport/server error envelope (`{error:{...}}`)
    // instead of a prompt result. Treat it as a failed inference; otherwise an
    // empty `parts` array masquerades as a successful empty model response.
    if (rr.error) {
      const err = rr.error;
      const message =
        (typeof err === 'string' ? err : err?.data?.message ?? err?.message) ??
        'Kilo prompt failed';
      const ref = typeof err === 'object' && err?.data?.ref ? ` (ref ${err.data.ref})` : '';
      return {
        ok: false,
        text: '',
        providerID: cfg.providerID,
        modelID: cfg.modelID,
        error: `${message}${ref}`,
        tookMs: Date.now() - t0,
      };
    }
    const info = rr.data?.info ?? rr.info;
    const parts: Array<{ type?: string; text?: string }> = rr.data?.parts ?? rr.parts ?? [];
    const text = parts.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('\n').trim();
    const structured = structuredFromPromptResponse(res);

    const tookMs = Date.now() - t0;
    if (info?.error) {
      return {
        ok: false,
        text,
        structured,
        providerID: info.providerID ?? cfg.providerID,
        modelID: info.modelID ?? cfg.modelID,
        tokensIn: info.tokens?.input,
        tokensOut: info.tokens?.output,
        cost: info.cost,
        finish: info.finish,
        error: typeof info.error === 'string' ? info.error : JSON.stringify(info.error),
        tookMs,
      };
    }
    return {
      ok: true,
      text,
      structured,
      providerID: info?.providerID ?? cfg.providerID,
      modelID: info?.modelID ?? cfg.modelID,
      tokensIn: info?.tokens?.input,
      tokensOut: info?.tokens?.output,
      cost: info?.cost,
      finish: info?.finish,
      tookMs,
    };
  } finally {
    try { created.server.close(); } catch { /* best effort */ }
  }
}

/** Resolve fn(Signal) or reject with a timeout error. Fires the passed-in signal on timeout. */
function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`kilo inference bound exceeded (${Math.round(ms / 60000)} min)`));
    }, ms);
  });
  return Promise.race([fn(controller.signal), timeout]).finally(() => clearTimeout(timer!));
}

export const headlessKiloActive = true;

/**
 * Read the native structured-output payload from a Kilo prompt response.
 * The 7.8.x server stores it on the assistant message (info.structured); older
 * shapes (data.structured) are tolerated so the helper is transport-stable and
 * trivially unit-testable.
 */
export function structuredFromPromptResponse(res: unknown): unknown {
  const rr = res as {
    data?: { info?: { structured?: unknown }; structured?: unknown };
    info?: { structured?: unknown };
    structured?: unknown;
  };
  return rr?.data?.info?.structured ?? rr?.data?.structured ?? rr?.info?.structured ?? rr?.structured;
}