import { z } from 'zod';
import { resolveConfigPath, loadConfig, type Config } from './config';
import {
  DaemonConfigSchema,
  ReviewPolicySchema,
  AutonomyConfigSchema,
  ContextConfigSchema,
  WorkspaceConfigSchema,
  LocalProviderConfigSchema,
  PricingConfigSchema,
  ReviewerModelSchema,
} from './config';
import { writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * HELLDESK Local — RUNTIME CONFIG STORE.
 *
 * The single source of truth for the daemon's *effective* configuration after
 * startup. The Engine, the scheduler pump, the TaskReconciler, the mission
 * controller and the HTTP API all read THIS store's live Config object (passed
 * by reference), so a `PATCH /v1/config` (or the plugin tool / CLI-set) takes
 * effect for subsequently-executed work WITHOUT a daemon restart.
 *
 * Every change is:
 *   1. validated against the existing per-section Zod schemas (no invented shape),
 *   2. applied live to the running Config object where the field is safe to
 *      change on a live process,
 *   3. persisted atomically to the authoritative config.json so the change
 *      survives a daemon restart.
 *
 * Restart-only fields (bind/port/token/stateDir/dataDir/logDir/dbPath) define the
 * daemon's own identity/binding and cannot be rebinding a live process's socket
 * or regenerating its auth token mid-flight. They are PERSISTED for the next
 * start and reported as `applies_on_restart`. Never silently dropped.
 */

/** Fields whose effect requires a process restart (can't re-bind/re-auth live). */
const RESTART_ONLY_DAEMON_FIELDS = new Set([
  'bind',
  'port',
  'token',
  'stateDir',
  'dataDir',
  'logDir',
  'dbPath',
]) as ReadonlySet<string>;

export interface ConfigFieldMeta {
  section: 'daemon' | 'policy' | 'autonomy' | 'context' | 'workspaces';
  /** 'live' = applies immediately to running work; 'restart' = persisted, applies on next start. */
  applies: 'live' | 'restart';
}

export interface RuntimeConfigView {
  config: Config;
  /** Per-section field applicability metadata for the UX (get exposes it so the
   *  surface can label controls "live" vs "applies on restart"). */
  meta: Record<string, unknown>;
  path: string;
}

export interface PatchResult {
  ok: boolean;
  /** Fields applied to the live process. */
  appliedLive: string[];
  /** Fields persisted for the next start (not effective until restart). */
  appliesOnRestart: string[];
  /** Fields that were rejected because the value shape was invalid. */
  rejected: Array<{ field: string; issues: string[] }>;
  path: string;
}

/** Whole-policy object is live-mutable (built per-job). */
function policyMeta(): Record<string, string> {
  return {
    runner: 'live',
    reviewerModel: 'live',
    reviewerModelA: 'live',
    reviewerModelB: 'live',
    adjudicatorModel: 'live',
    governorModel: 'live',
    sizingModel: 'live',
    pricing: 'live',
    strictCoverage: 'live',
    providers: 'live',
    kiloServerBin: 'live',
    productionCancelFake: 'live',
    verifyMode: 'live',
  };
}

export function newRuntimeConfigStore(opts?: { configPath?: string; config?: Config }): RuntimeConfigStore {
  const path = opts?.configPath ?? resolveConfigPath();
  const config = opts?.config ?? loadConfig(path);
  return new RuntimeConfigStore(config, path);
}

export class RuntimeConfigStore {
  /** Mutable effective config — the SAME object reference shared with the
   *  Engine and the daemon's loops, so a live patch is visible everywhere. */
  readonly config: Config;
  /** Absolute path to the authoritative config file to persist to. */
  readonly path: string;

  constructor(config: Config, configFilePath: string) {
    // Legacy/programmatic configs may predate the context section; normalize it
    // so live patches and every tier read site always see a complete object.
    if (!config.context) config.context = ContextConfigSchema.parse({});
    this.config = config;
    this.path = configFilePath;
  }

  /** The live effective config. Callers must treat it as read-only operational
   *  state; mutations belong to `patch()`. */
  get(): Config {
    return this.config;
  }

  /** Full snapshot for the API/UX including per-field applicability metadata. */
  view(): RuntimeConfigView {
    return {
      config: structuredClone(this.config),
      meta: {
        daemon: daemonMeta(),
        policy: policyMeta(),
        autonomy: autonomyMeta(),
        context: contextMeta(),
        workspaces: ['path', 'enabled', 'include', 'exclude'],
      },
      path: this.path,
    };
  }

  /**
   * Apply a validated partial config update. Accepts the same shape as
   * config.json: `{ daemon: {...}, policy: {...}, autonomy: {...}, workspaces: [...] }`,
   * plus aliases `{ policy: { reviewerModel: { providerID, modelID } } }` etc.
   * Returns what applied live, what persists-for-restart, and any rejections.
   */
  async patch(input: Record<string, unknown>): Promise<PatchResult> {
    const appliedLive: string[] = [];
    const appliesOnRestart: string[] = [];
    const rejected: Array<{ field: string; issues: string[] }> = [];

    const patchSection = <T>(
      sectionKey: 'daemon' | 'policy' | 'autonomy' | 'context',
      schema: z.ZodType<T>,
      target: Record<string, unknown>,
      applicability: (field: string) => 'live' | 'restart'
    ): void => {
      const raw = input[sectionKey];
      if (raw === undefined) return;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        rejected.push({ field: sectionKey, issues: [`${sectionKey} must be an object`] });
        return;
      }
      // Merge onto the live object field-by-field so each key is validated
      // independently and unknown keys surface as rejections instead of a tonal
      // whole-section parse failure.
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        // Context optional overrides can be CLEARED explicitly: JSON has no
        // `undefined`, and leaving a stale `contextWindow` behind would keep
        // overriding a newly selected lower tier. `null` removes the key.
        if (sectionKey === 'context' && value === null) {
          delete (target as Record<string, unknown>)[key];
          appliedLive.push(`${sectionKey}.${key}`);
          continue;
        }
        const probe = { ...target, [key]: value } as unknown;
        const parsed = schema.safeParse(probe);
        if (!parsed.success) {
          rejected.push({
            field: `${sectionKey}.${key}`,
            issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
          continue;
        }
        (target as Record<string, unknown>)[key] = value;
        const applies = applicability(key);
        if (applies === 'live') appliedLive.push(`${sectionKey}.${key}`);
        else appliesOnRestart.push(`${sectionKey}.${key}`);
      }
    };

    // ── daemon ──
    patchSection(
      'daemon',
      DaemonConfigSchema,
      this.config.daemon as unknown as Record<string, unknown>,
      (f) => (RESTART_ONLY_DAEMON_FIELDS.has(f) ? 'restart' : 'live')
    );

    // ── policy ──
    const rawPolicy = input.policy;
    if (rawPolicy !== undefined) {
      if (typeof rawPolicy !== 'object' || rawPolicy === null || Array.isArray(rawPolicy)) {
        rejected.push({ field: 'policy', issues: ['policy must be an object'] });
      } else {
        const p = rawPolicy as Record<string, unknown>;
        // providers is a whole-object swap — validate the entire nest.
        if (p.providers !== undefined) {
          const providersParsed = z.record(z.string(), LocalProviderConfigSchema).safeParse(p.providers);
          if (!providersParsed.success) {
            rejected.push({
              field: 'policy.providers',
              issues: providersParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          } else {
            this.config.policy.providers = providersParsed.data;
            appliedLive.push('policy.providers');
          }
        }
        for (const modelKey of ['reviewerModel', 'reviewerModelA', 'reviewerModelB', 'adjudicatorModel', 'governorModel', 'sizingModel'] as const) {
          if (p[modelKey] === null) {
            // Explicit clear: fall back to reviewerModel / inherited for this role.
            delete (this.config.policy as Record<string, unknown>)[modelKey];
            appliedLive.push(`policy.${modelKey}`);
            continue;
          }
          if (p[modelKey] !== undefined) {
            const parsed = ReviewerModelSchema.safeParse(p[modelKey]);
            if (!parsed.success) {
              rejected.push({
                field: `policy.${modelKey}`,
                issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
              });
            } else {
              this.config.policy[modelKey] = parsed.data;
              appliedLive.push(`policy.${modelKey}`);
            }
          }
        }
        if (p.pricing !== undefined) {
          const pricingParsed = PricingConfigSchema.safeParse(p.pricing);
          if (!pricingParsed.success) {
            rejected.push({
              field: 'policy.pricing',
              issues: pricingParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          } else {
            this.config.policy.pricing = pricingParsed.data;
            appliedLive.push('policy.pricing');
          }
        }
        for (const scalar of ['runner', 'strictCoverage', 'kiloServerBin', 'productionCancelFake', 'verifyMode'] as const) {
          if (p[scalar] !== undefined) {
            const probe = { ...this.config.policy, [scalar]: p[scalar] } as unknown;
            const parsed = ReviewPolicySchema.safeParse(probe);
            if (!parsed.success) {
              rejected.push({
                field: `policy.${scalar}`,
                issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
              });
            } else {
              (this.config.policy as Record<string, unknown>)[scalar] = p[scalar];
              appliedLive.push(`policy.${scalar}`);
            }
          }
        }
      }
    }

    // ── autonomy ──
    patchSection('autonomy', AutonomyConfigSchema, this.config.autonomy as unknown as Record<string, unknown>, () => 'live');

    // ── context (all live: resolved per job / per worker start) ──
    patchSection('context', ContextConfigSchema, this.config.context as unknown as Record<string, unknown>, () => 'live');

    // ── workspaces (whole-array replacement; validated item-by-item) ──
    if (input.workspaces !== undefined) {
      if (!Array.isArray(input.workspaces)) {
        rejected.push({ field: 'workspaces', issues: ['workspaces must be an array'] });
      } else {
        const parsed = z.array(WorkspaceConfigSchema).safeParse(input.workspaces);
        if (!parsed.success) {
          rejected.push({
            field: 'workspaces',
            issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          });
        } else {
          this.config.workspaces = parsed.data;
          appliedLive.push('workspaces');
        }
      }
    }

    // Persist any change (live or restart) so it survives restart.
    if (appliedLive.length || appliesOnRestart.length) {
      this.persist();
    }

    return { ok: rejected.length === 0, appliedLive, appliesOnRestart, rejected, path: this.path };
  }

  /** Rewrite the authoritative config.json atomically with the current config. */
  persist(): void {
    // A relative config path (the default `config.json`) has dirname '.';
    // mkdirSync('.', {recursive:true}) throws EEXIST on Windows, which made
    // every config PATCH fail. Only create a real parent directory.
    const dir = dirname(this.path);
    if (dir && dir !== '.' && dir !== this.path) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    const body = JSON.stringify(this.config, null, 2) + '\n';
    try {
      writeFileSync(tmp, body, 'utf-8');
      // Atomic rename so a crash mid-write can never leave a half-written config.
      renameSync(tmp, this.path);
    } catch {
      // Fall back to a direct write if the atomic rename path is unavailable
      // (e.g. cross-device or read-only mount). Also clean a leftover tmp.
      try { unlinkSync(tmp); } catch { /* best effort */ }
      writeFileSync(this.path, body, 'utf-8');
    }
  }
}

function daemonMeta(): Record<string, string> {
  // Compute applicability for every daemon field exported by the schema.
  const keys = [
    'bind', 'port', 'token', 'stateDir', 'dataDir', 'logDir', 'dbPath',
    'debounceMs', 'production', 'detachedWorkers', 'maxConcurrentJobs',
    'maxReviewersPerJob', 'maxAttempts', 'leaseSeconds', 'requestTimeoutMs',
    'retryBaseMs', 'retryMaxMs', 'breakerThreshold', 'breakerCooldownMs',
    'maxSnapshotBytes', 'maxJobTokens', 'retentionDays',
  ];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = RESTART_ONLY_DAEMON_FIELDS.has(k) ? 'restart' : 'live';
  return out;
}

function autonomyMeta(): Record<string, string> {
  return {
    enabled: 'live',
    mutationRunner: 'live',
    kiloBin: 'live',
    providerID: 'live',
    modelID: 'live',
    baseURL: 'live',
    apiKey: 'live',
    taskGates: 'live',
  };
}

function contextMeta(): Record<string, string> {
  return {
    tier: 'live',
    contextWindow: 'live',
    charsPerToken: 'live',
    promptUtilization: 'live',
    reservedOutputTokens: 'live',
  };
}