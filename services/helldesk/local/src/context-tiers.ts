import type { ContextConfig } from './config';
import { resolveKiloModelLimits, type KiloModelLimits } from './config-resolve';

/**
 * HELLDESK CONTEXT TIERS — one resolver every agent boundary reads.
 *
 * A local AI-first install ranges from a 32K laptop model to a 1M local
 * frontier model. Hardcoding one window (the old `131072` model limit and the
 * `128 * 1024` diff slice) silently truncates big tiers and overflows small
 * ones. This module owns:
 *
 *  - the tier ladder (32K, 64K, 96K, 128K, 256K, 384K, 512K, 1M),
 *  - detection from the operator's kilo.jsonc
 *    (`provider.<id>.models.<model>.limit.context|input|output`),
 *  - explicit operator overrides (`ContextConfigSchema` in config.json),
 *  - derivation of token + character budgets used by reviewers, workers and
 *    the writable mutation session.
 *
 * `KILO_CONFIG_TRANSPORT_LIMIT_CHARS` is deliberately a separate constant: it
 * bounds the Windows `KILO_CONFIG_CONTENT` environment transport, NOT the
 * model's context window. Never conflate the two.
 */

export const CONTEXT_TIER_TOKENS = {
  '32k': 32_768,
  '64k': 65_536,
  '96k': 98_304,
  '128k': 131_072,
  '256k': 262_144,
  '384k': 393_216,
  '512k': 524_288,
  '1m': 1_048_576,
} as const;

export type ContextTierId = keyof typeof CONTEXT_TIER_TOKENS;
export type ContextTierSelection = ContextTierId | 'auto';

export const CONTEXT_TIER_IDS = Object.keys(CONTEXT_TIER_TOKENS) as ContextTierId[];
export const DEFAULT_CONTEXT_TIER: ContextTierId = '128k';
export const DEFAULT_CONTEXT_WINDOW_TOKENS = CONTEXT_TIER_TOKENS[DEFAULT_CONTEXT_TIER];
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const DEFAULT_PROMPT_UTILIZATION = 0.9;

/**
 * Fallback review-prompt budget when no context advice is supplied. Kept at
 * the historical 128K-char value so existing callers/tests stay stable; real
 * pipelines always pass a tier-derived budget.
 */
export const DEFAULT_REVIEW_PROMPT_CHAR_BUDGET = 128 * 1024;
/** Space reserved inside a prompt for requirements, file lists and framing. */
export const REVIEW_PROMPT_OVERHEAD_CHARS = 8 * 1024;

/** Windows environment-variable transport cap (`KILO_CONFIG_CONTENT`). */
export const KILO_CONFIG_CONTENT_ENV_LIMIT_CHARS = 32_767;
/** Safety margin used by the mutation-session config projection. */
export const KILO_CONFIG_TRANSPORT_LIMIT_CHARS = 28_000;

export const MIN_OUTPUT_TOKENS = 4_096;
/** Local frontier models (e.g. DeepSeek V4.1) declare up to 262,144 output tokens. */
export const MAX_OUTPUT_TOKENS = 262_144;

/** Token window for a concrete tier id. */
export function contextWindowForTier(tier: ContextTierId): number {
  return CONTEXT_TIER_TOKENS[tier];
}

/** Smallest tier that covers `tokens` (never returns a smaller window). */
export function tierForContextWindow(tokens: number): ContextTierId {
  if (!Number.isFinite(tokens) || tokens <= 0) return DEFAULT_CONTEXT_TIER;
  for (const id of CONTEXT_TIER_IDS) {
    if (tokens <= CONTEXT_TIER_TOKENS[id]) return id;
  }
  return '1m';
}

/**
 * Normalize an operator/tier value. Accepts `auto`, tier ids (`256K`), and
 * raw token counts (`262144`). Unknown values degrade to `auto` (detection),
 * never to a guessed explicit window.
 */
export function normalizeContextTier(value: unknown): ContextTierSelection {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return tierForContextWindow(value);
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase().replace(/[\s_]/g, '');
    if (v === '' || v === 'auto' || v === 'detect') return 'auto';
    const aliases: Record<string, ContextTierId> = {
      '32k': '32k', '32768': '32k', '32000': '32k',
      '64k': '64k', '65536': '64k',
      '96k': '96k', '98304': '96k',
      '128k': '128k', '131072': '128k',
      '256k': '256k', '262144': '256k',
      '384k': '384k', '393216': '384k',
      '512k': '512k', '524288': '512k',
      '1m': '1m', '1024k': '1m', '1048576': '1m', '1000000': '1m',
    };
    const hit = aliases[v];
    if (hit) return hit;
  }
  return 'auto';
}

export type ContextBudgetSource = 'config-window' | 'config-tier' | 'kilo-jsonc' | 'default';

export interface ContextBudgetInput {
  context?: Partial<ContextConfig> | null;
  providerID?: string;
  modelID?: string;
  /** Injected detected limits (tests or callers that already resolved them). */
  kiloLimits?: KiloModelLimits | null;
  /** Set false to skip kilo.jsonc detection (pure/offline callers). Default true. */
  detect?: boolean;
}

export interface ContextBudget {
  /** Configured selection (`auto` when the operator did not pin a tier). */
  selection: ContextTierSelection;
  /** Effective tier whose ladder step covers the resolved window. */
  tier: ContextTierId;
  source: ContextBudgetSource;
  contextWindow: number;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
  charsPerToken: number;
  promptUtilization: number;
  /** Character budget for a whole user prompt (reviewer/mutation). */
  userPromptCharBudget: number;
  /** Character budget for a diff after requirements/file-list overhead. */
  reviewDiffCharBudget: number;
  /** Independent Windows config-transport cap (not model context). */
  kiloConfigTransportLimitChars: number;
  detected: KiloModelLimits | null;
}

/**
 * Resolve the effective context budget for one model route.
 *
 * Precedence:
 *  1. explicit `contextWindow` tokens (operator override),
 *  2. explicit `tier` (32k … 1m),
 *  3. detected `limit.context` from kilo.jsonc,
 *  4. 128K default.
 *
 * Detected `limit.input` is honored only when it belongs to the same window
 * (guards against a stale/mismatched model entry). Output reserve is the
 * operator's `reservedOutputTokens`, else the detected `limit.output`, else
 * one eighth of the window clamped to 4K..128K.
 */
export function resolveContextBudget(input: ContextBudgetInput = {}): ContextBudget {
  const context = input.context ?? {};
  const selection = normalizeContextTier(context.tier);
  const detected: KiloModelLimits | null =
    input.kiloLimits !== undefined
      ? input.kiloLimits
      : input.detect === false
        ? null
        : input.providerID && input.modelID
          ? resolveKiloModelLimits(input.providerID, input.modelID)
          : null;

  const explicitWindow =
    typeof context.contextWindow === 'number' && Number.isFinite(context.contextWindow) && context.contextWindow > 0
      ? Math.trunc(context.contextWindow)
      : undefined;

  let contextWindow: number;
  let source: ContextBudgetSource;
  if (explicitWindow !== undefined) {
    contextWindow = explicitWindow;
    source = 'config-window';
  } else if (selection !== 'auto') {
    contextWindow = contextWindowForTier(selection);
    source = 'config-tier';
  } else if (detected?.context !== undefined) {
    contextWindow = detected.context;
    source = 'kilo-jsonc';
  } else {
    contextWindow = DEFAULT_CONTEXT_WINDOW_TOKENS;
    source = 'default';
  }

  const tier = tierForContextWindow(contextWindow);
  // A detected limit belongs to ITS OWN window. When an explicit tier/window
  // pins a different window, its input/output reserves must not leak across
  // (e.g. a 512K profile's 65,536 output making a 32K input budget negative).
  const detectionMatches = detected?.context === contextWindow;
  const derivedOutput = Math.round(contextWindow / 8);
  const requestedOutput = context.reservedOutputTokens ?? (detectionMatches ? detected?.output : undefined) ?? derivedOutput;
  const outputBudgetTokens = Math.min(
    Math.max(1_024, contextWindow - 1_024),
    Math.max(MIN_OUTPUT_TOKENS, Math.min(MAX_OUTPUT_TOKENS, requestedOutput))
  );
  // Trust detected `limit.input` only when it matches the effective window.
  const detectedInput =
    detected?.input !== undefined && detectionMatches ? detected.input : undefined;
  const inputBudgetTokens =
    detectedInput !== undefined
      ? Math.min(detectedInput, contextWindow)
      : Math.max(1_024, contextWindow - outputBudgetTokens);

  const charsPerToken = context.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  const promptUtilization = context.promptUtilization ?? DEFAULT_PROMPT_UTILIZATION;
  const userPromptCharBudget = Math.max(
    1_024,
    Math.floor(inputBudgetTokens * charsPerToken * promptUtilization)
  );
  const reviewDiffCharBudget = Math.max(0, userPromptCharBudget - REVIEW_PROMPT_OVERHEAD_CHARS);

  return {
    selection,
    tier,
    source,
    contextWindow,
    inputBudgetTokens,
    outputBudgetTokens,
    charsPerToken,
    promptUtilization,
    userPromptCharBudget,
    reviewDiffCharBudget,
    kiloConfigTransportLimitChars: KILO_CONFIG_TRANSPORT_LIMIT_CHARS,
    detected,
  };
}
