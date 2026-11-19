import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKilo } from '@kilocode/sdk';

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
  /** providerID/modelID of the real model route, e.g. litellm-edge/differential_sseproxy */
  role: 'reviewer-a' | 'reviewer-b' | 'adjudicator';
  providerID: string;
  modelID: string;
  /** OpenAI-compatible baseURL (no trailing slash semantics enforced). */
  baseURL: string;
  /** Optional bearer apiKey passed verbatim to the headless runtime (never logged). */
  apiKey?: string;
  /** Absolute path to the `kilo` server binary (headless Kilo runtime). */
  kiloBin: string;
  /** Absolute path to the immutable snapshot store (read-only evidence tools). */
  snapshotStore: string;
  /** Role-specific system prompt (reviewer-correctness.md / adversarial / adjudicator). */
  system: string;
  /** User turn (frozen diff + requirements + changed files). */
  user: string;
  /** Optional input working directory for the session. */
  directory: string;
}

export interface KiloInferenceResult {
  ok: boolean;
  text: string;
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
function buildSdkConfig(cfg: KiloWorkerConfig): Record<string, unknown> {
  const modelRef = `${cfg.providerID}/${cfg.modelID}`;
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
  return {
    model: modelRef,
    enabled_providers: [cfg.providerID],
    default_agent: 'helldesk-reviewer',
    agent: {
      'helldesk-reviewer': {
        model: modelRef,
        // Reviewer is text-only + read-only evidence tools; no agentic write loop.
        // Higher cap so a reasoning-heavy reviewer is never truncated mid-JSON.
        maxSteps: 6,
        tools: {},
        permission: readOnlyPermission,
        prompt: [
          'You are an autonomous read-only code reviewer.',
          'You have NO write, shell, edit, mcp, webfetch, task-delegation or configuration-mutation capabilities and no tools.',
          'The complete immutable evidence snapshot (requirements, changed files, and the full diff) is embedded directly in the user message.',
          'Do NOT attempt to call or await any review tools — none are available and none are needed.',
          'Produce the strict JSON review object in your FIRST response, exactly as the user message specifies. Never defer to a later step, never return narrative instead of JSON.',
          'Never modify source, never run shell, never write files.',
        ].join('\n'),
      },
    },
    provider: {
      [cfg.providerID]: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: cfg.baseURL.replace(/\/+$/, ''),
          ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        },
        models: {
          [cfg.modelID]: {
            id: cfg.modelID,
            name: cfg.modelID,
            tool_call: true,
            reasoning: true,
            limit: { context: 131072, output: 32000 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    },
  };
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

  try {
    // INFERENCE BOUND: a wedged createKilo boot or a model/session that never
    // resolves must fast-fail as FAILED_TRANSIENT instead of hanging the whole
    // mutation until the mission's watchdog (15 min) fires. 10 min is generous
    // for a real framework extraction, but short enough to recover from a dead
    // server/model quickly. On timeout the underlying controller's AbortSignal is
    // fired too, so the mutation replans promptly rather than stranding.
    const INFERENCE_BOUND_MS = 10 * 60_000;
    const result_ = await withTimeout(
      (signal: AbortSignal) => runOnce(cfg, config, t0, signal),
      INFERENCE_BOUND_MS,
    );
    return result_;
  } catch (err) {
    return {
      ok: false,
      text: '',
      providerID: cfg.providerID,
      modelID: cfg.modelID,
      error: err instanceof Error ? err.message : String(err),
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
  const created = await createKilo({ port: 0, config: config as never, signal });
  const client = created.client;
  try {
    const created_ = await client.session.create({ query: { directory: cfg.directory } });
    const sessionID = created_.data?.id;
    if (!sessionID) fail(`headless Kilo failed to create a session (role=${cfg.role})`);

    const res = await client.session.prompt({
      path: { id: sessionID },
      query: { directory: cfg.directory },
      body: {
        agent: 'helldesk-reviewer',
        model: { providerID: cfg.providerID, modelID: cfg.modelID },
        system: cfg.system,
        parts: [{ type: 'text', text: cfg.user }],
      },
    });

    type AnyResult = { [k: string]: any };
    const rr = res as unknown as AnyResult;
    const info = rr.data?.info ?? rr.info;
    const parts: Array<{ type?: string; text?: string }> = rr.data?.parts ?? rr.parts ?? [];
    const text = parts.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join('\n').trim();

    const tookMs = Date.now() - t0;
    if (info?.error) {
      return {
        ok: false,
        text,
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