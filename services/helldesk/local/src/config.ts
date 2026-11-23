import { z } from 'zod';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * HELLDESK Local configuration.
 *
 * This is intentionally free of any Kilo Gateway assumption: providers and
 * models are plain `{ providerID, modelID }` pairs resolved against the
 * local Kilo config, or an explicit OpenAI-compatible endpoint for the
 * standalone (non VS Code) daemon path.
 *
 * Ported from the historical `services/helldesk` snapshot (commit 322138a19)
 * with all Cloudflare/Kilo Cloud coupling stripped at the module boundary.
 */

export const LocalProviderConfigSchema = z.object({
  kind: z.enum(['openai-compatible']),
  baseURL: z.string().url(),
  apiKey: z.string().optional().default(''),
  modelID: z.string(),
});

export const ReviewerModelSchema = z
  .object({
    providerID: z.string(),
    modelID: z.string(),
  })
  .describe('Explicit reviewer provider/model. Never routed through Kilo Gateway.');

export const WorkspaceConfigSchema = z.object({
  /** Filesystem root to watch / register. May lack .git (plain-folder mode). */
  path: z.string().min(1),
  /** Whether to treat this as a supported review subject. Default true. */
  enabled: z.boolean().optional().default(true),
  /** Restrict review to paths matching one of these gitignore-style globs. */
  include: z.array(z.string()).optional().default([]),
  /** Exclude paths (deeper wins). */
  exclude: z
    .array(z.string())
    .optional()
    .default([
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.kilo/**',
      '**/*.sqlite*',
    ]),
});

export const DaemonConfigSchema = z.object({
  bind: z.string().optional().default('127.0.0.1'),
  port: z.number().int().min(1024).max(65535).optional().default(4789),
  /** Per-user bearer token required for mutation endpoints. Defaults to a generated value persisted in state dir. */
  token: z.string().optional(),
  stateDir: z.string().optional(),
  dataDir: z.string().optional(),
  /** Log/telemetry output dir. */
  logDir: z.string().optional(),
  /** SQLite database path (defaults to <dataDir>/helldesk.db). */
  dbPath: z.string().optional(),
  debounceMs: z.number().int().min(0).optional().default(4000),
  /** Production daemon flag: when true + runner, fail closed on synthetic/fake
   *  inference and require a real inference runner. Test daemons keep this unset. */
  production: z.boolean().optional(),
  /** Run each review stage in independent detached bun worker processes (true,
   *  the control-plane default) vs the legacy in-process runner path. */
  detachedWorkers: z.boolean().optional(),
  /** Max concurrent jobs. One job = A + B reviewers in parallel + one adjudicator.
   *  Default 2 so a fresh daemon does not serialize single-workspace reviews on the
   *  shared worker pool; SOTA operator boards parallelize across independent jobs. */
  maxConcurrentJobs: z.number().int().min(1).optional().default(2),
  maxReviewersPerJob: z.number().int().min(1).max(4).optional().default(2),
  maxAttempts: z.number().int().min(1).optional().default(3),
  leaseSeconds: z.number().int().min(1).optional().default(120),
  requestTimeoutMs: z.number().int().min(1000).optional().default(120_000),
  retryBaseMs: z.number().int().min(100).optional().default(2_000),
  retryMaxMs: z.number().int().min(1000).optional().default(60_000),
  breakerThreshold: z.number().int().min(1).optional().default(3),
  breakerCooldownMs: z.number().int().min(1000).optional().default(30_000),
  /** Maximum bytes of snapshot content to retain per job (large-repo bound). */
  maxSnapshotBytes: z.number().int().min(1024).optional().default(64 * 1024 * 1024),
  /** Estimated max spend per review in model units; unknown => no hard cap by cost. */
  maxJobTokens: z.number().int().optional(),
  retentionDays: z.number().int().min(1).optional().default(30),
});

/**
 * Two ways to actually run reviewer inference:
 *  - "kilo": drive the local Kilo SDK/CLI (in plugin context) — uses the user's
 *    effective provider/model and inherits auth. The plugin wires this.
 *  - "openai": direct OpenAI-compatible HTTP (standalone daemon, tests, or a
 *    provider not wired into Kilo). Explicitly configured; never "auto".
 *  - "fake": deterministic canned reviewer (tests & fault injection only).
 */
export const RunnerKindSchema = z.enum(['kilo', 'openai', 'codex', 'fake']);

/** How the mission controller gates a completed revision:
 *  - `auto`     : review + verify EACH revision as it completes (HITL / CI discipline).
 *  - `deferred` : stamp EVIDENCE_CAPTURED and queue PENDING_VERIFY, keep the mission
 *                 advancing; a later `verify-pending` sweep runs the executable gates
 *                 (tsc/lint/unit/PolyGraph impact) across the batch. This is the
 *                 solo WAR-mode workflow: deliver-many, verify-as-a-checkpoint. */
export const VerifyModeSchema = z.enum(['auto', 'deferred']);

/** USD price per 1,000,000 tokens for one scope (model/provider/runner/default). */
export const TokenPriceSchema = z.object({
  inputPer1M: z.number().min(0).refine((value) => Number.isFinite(value), 'must be finite'),
  outputPer1M: z.number().min(0).refine((value) => Number.isFinite(value), 'must be finite'),
});

/**
 * Token pricing used to turn recorded usage into a USD cost. Resolution order:
 *   models["provider/model"] → providers["provider"] → runners["runner"] → default
 * Missing price = cost is reported as unknown, never invented.
 */
export const PricingConfigSchema = z.object({
  models: z.record(z.string(), TokenPriceSchema).optional(),
  providers: z.record(z.string(), TokenPriceSchema).optional(),
  runners: z.record(z.string(), TokenPriceSchema).optional(),
  default: TokenPriceSchema.nullable().optional(),
});

export const ReviewPolicySchema = z.object({
  runner: RunnerKindSchema.optional().default('kilo'),
  /** Authentic independent review is real inference: never 'fake' in production.
   *  'fake' is only honored on explicitly-testing paths (no --daemon flag). */
  productionCancelFake: z.boolean().optional(),
  /** When runner=openai/kilo, the explicit endpoint to use. Keep optional; default applied at use. */
  providers: z.record(z.string(), LocalProviderConfigSchema).optional(),
  /** Explicit reviewer model pair. When unset and runner=kilo, inherit the user's effective model. */
  reviewerModel: ReviewerModelSchema.optional(),
  /** Role-specific reviewer models (highest precedence). Never substituted silently. */
  reviewerModelA: ReviewerModelSchema.optional(),
  reviewerModelB: ReviewerModelSchema.optional(),
  adjudicatorModel: ReviewerModelSchema.optional(),
  /** The ExcellenceGovernor's own model. Defaults to adjudicatorModel when unset. */
  governorModel: ReviewerModelSchema.optional(),
  /** Small structured-JSON model for task T-shirt sizing. Defaults to reviewerModel/inherited. */
  sizingModel: ReviewerModelSchema.optional(),
  /** Bound for the synchronous creation-time size call; a timeout leaves the task unsized. */
  sizingTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  /** USD-per-1M token pricing; used for review/mission cost reporting. */
  pricing: PricingConfigSchema.optional(),
  /** Absolute path to the headless `kilo serve` server binary (runner=kilo). */
  kiloServerBin: z.string().optional(),
  strictCoverage: z.boolean().optional().default(true),
  /** WAR-mode verification policy. `auto` (default) preserves the current
   *  always-review behavior; `deferred` enables the batched verify checkpoint.
   *  Live-toggled via /v1/config. Undefined is treated as `auto` at read sites. */
  verifyMode: VerifyModeSchema.optional(),
});

/**
 * CONTEXT TIERS — the local AI-first ladder.
 *
 * HELLDESK must run on a 32K laptop model and a 1M local frontier model with
 * the same code path. A tier is the operator's declared context class; the
 * effective window is resolved per model route:
 *
 *   explicit `contextWindow` > explicit `tier` > kilo.jsonc model
 *   `limit.context` detection > 128K default.
 *
 * The tier affects prompt/diff char budgets and the `limit` projected into the
 * headless Kilo provider used by reviewers and the mutation agent. It does NOT
 * affect `KILO_CONFIG_CONTENT` (a Windows environment-variable transport cap,
 * not a model context window).
 */
export const CONTEXT_TIER_IDS = [
  'auto',
  '32k',
  '64k',
  '96k',
  '128k',
  '256k',
  '384k',
  '512k',
  '1m',
] as const;
export const ContextTierSchema = z.enum(CONTEXT_TIER_IDS);

export const ContextConfigSchema = z.object({
  /** `auto` detects the route's model limit from kilo.jsonc; a tier pins it. */
  tier: ContextTierSchema.optional().default('auto'),
  /** Explicit context window in tokens; wins over tier + detection. */
  contextWindow: z.number().int().min(16_384).max(4_194_304).optional(),
  /** Chars per token used for char budgets (4 is a conservative default). */
  charsPerToken: z.number().min(2).max(8).optional().default(4),
  /** Fraction of the input-token budget a user prompt may occupy (headroom for
   *  the system prompt, tool schemas and provider framing). */
  promptUtilization: z.number().min(0.25).max(1).optional().default(0.9),
  /** Explicit output/response reserve in tokens. Default: detected `limit.output`
   *  or one eighth of the context window (clamped to 4096..262144). */
  reservedOutputTokens: z.number().int().min(1_024).max(262_144).optional(),
});
export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/** Ender autonomy loop configuration (operator-gated, loaded from config.json).
 *
 *  `enabled` is the single switch: when false (default), the mission tick never
 *  fires mutations. `mutationRunner` selects the writable mutation actuator
 *  (default 'kilo' — the real KiloMutationRunner). The remaining fields identify
 *  the model route + headless binary for the mutation agent; they mirror the
 *  policy reviewer route but are consumed by the wrivable boundary. */
export const AutonomyConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  mutationRunner: z.enum(['kilo', 'openai', 'codex']).optional().default('kilo'),
  kiloBin: z.string().optional().default(''),
  providerID: z.string().optional().default(''),
  modelID: z.string().optional().default(''),
  baseURL: z.string().optional().default(''),
  apiKey: z.string().optional().default(''),
  /** Task-specific acceptance gates the mission's revisions must PASS. When
   *  present, they override the turbine-diagnostic default REPORT_GATES.ARTIFACTS
   *  for BOTH the mutation acceptance constraints and the reviewer verdict. */
  taskGates: z.array(z.string()).optional(),
  /** LONG-HORIZON GOVERNORS: a mission is parked (BLOCKED_EXTERNAL) on breach. */
  maxMissionWallClockMs: z.number().int().positive().optional(),
  maxMissionRevisions: z.number().int().positive().optional(),
  maxMissionReviewTokens: z.number().int().positive().optional(),
  /** Mutation watchdog (per-pass abort bound). Higher = fewer truncations. */
  mutationWatchdogMs: z.number().int().positive().optional(),
});

export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

export type Config = {
  version: 1;
  daemon: z.infer<typeof DaemonConfigSchema>;
  policy: z.infer<typeof ReviewPolicySchema>;
  autonomy: AutonomyConfig;
  context: ContextConfig;
  workspaces: z.infer<typeof WorkspaceConfigSchema>[];
};
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type LocalProviderConfig = z.infer<typeof LocalProviderConfigSchema>;
export type ReviewerModel = z.infer<typeof ReviewerModelSchema>;
export type TokenPrice = z.infer<typeof TokenPriceSchema>;
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

/** Default state directories scoped to the user profile (no admin rights). */
export function defaultDataDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'HELLDESK', 'LocalDepartment');
}

/** Default SQLite path. */
export function defaultDbPath(dataDir: string): string {
  return join(dataDir, 'helldesk.db');
}

/** Read + validate config file; fall back to an in-memory default when absent.
 *
 * Config resolution is deterministic: an explicit path wins, else the HELLDESK
 * package's own config.json (this module's directory -> <pkg>), then the
 * process cwd and the default state dir. The package path is authoritative so
 * the daemon AND the Kilo plugin (which runs inside `kilo.exe` with an arbitrary
 * cwd, e.g. the extension dir) always resolve the SAME config — this is what
 * keeps the plugin bridge pointed at the daemon's actual port/token. */
/** Resolve the authoritative config file path using the same deterministic
 *  precedence as `loadConfig` (explicit path wins; else the package config.json,
 *  then process cwd, then the default state dir). This is the file the runtime
 *  config store persists live changes to, so a daemon restart survives them. */
export function resolveConfigPath(path?: string): string {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // <pkg>/src -> <pkg>
  const candidates = path
    ? [path]
    : [
        join(pkgRoot, 'config.json'),
        join(process.cwd(), 'config.json'),
        join(defaultDataDir(), 'config.json'),
        existsSync(join(pkgRoot, 'config.example.json'))
          ? join(pkgRoot, 'config.example.json')
          : undefined,
      ].filter((p): p is string => typeof p === 'string');
  const existing = candidates.find((p) => existsSync(p));
  if (existing) return existing;
  // No existing config — persist to the package config.json (the authoritative
  // location that both the daemon and the Kilo plugin resolve to).
  return candidates[0] ?? join(pkgRoot, 'config.json');
}

export function loadConfig(path?: string): Config {
  const candidatesPath = resolveConfigPath(path);
  const candidates = [candidatesPath];

  let raw: unknown;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        // Strip a UTF-8 BOM that PowerShell `Set-Content -Encoding utf8`
        // may have written; JSON.parse rejects a leading BOM byte.
        const text = readFileSync(candidate, 'utf-8').replace(/^\uFEFF/, '');
        raw = JSON.parse(text);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid config JSON at ${candidate}: ${message}`);
      }
    }
  }

  const input = (raw ?? {}) as {
    version?: number;
    daemon?: unknown;
    policy?: unknown;
    autonomy?: unknown;
    context?: unknown;
    workspaces?: unknown;
  };
  const daemon = DaemonConfigSchema.safeParse(input.daemon ?? {});
  if (!daemon.success) throw new Error(`Invalid daemon config: ${daemon.error.message}`);
  const policy = ReviewPolicySchema.safeParse(input.policy ?? { runner: 'fake' });
  if (!policy.success) throw new Error(`Invalid policy config: ${policy.error.message}`);
  const autonomy = AutonomyConfigSchema.safeParse(input.autonomy ?? {});
  if (!autonomy.success) throw new Error(`Invalid autonomy config: ${autonomy.error.message}`);
  const context = ContextConfigSchema.safeParse(input.context ?? {});
  if (!context.success) throw new Error(`Invalid context config: ${context.error.message}`);
  const workspaces = Array.isArray(input.workspaces)
    ? (input.workspaces as unknown[]).map((w) => WorkspaceConfigSchema.parse(w))
    : [];

  return {
    version: 1 as const,
    daemon: daemon.data,
    policy: policy.data,
    autonomy: autonomy.data,
    context: context.data,
    workspaces,
  };
}