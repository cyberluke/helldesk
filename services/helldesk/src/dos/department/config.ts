/**
 * Department configuration management.
 */

import {
  DepartmentConfigSchema,
  type DepartmentConfig,
  type DepartmentConfigUpdate,
  type MergeStrategy,
  type WorkstationOverrideConfig,
} from '../../types';
import { resolveGitHubTokenString } from './department-scm';

const CONFIG_KEY = 'department:config';
const NEW_DEPARTMENT_DEFAULTS_SEEDED_KEY = 'department:config:newDefaultsSeeded';

const DEPARTMENT_LOG = '[Department.do]';

/**
 * Defaults that were introduced for NEW departments in #2725 but that must NOT
 * be retroactively applied to existing persisted configs (doing so would
 * silently flip production behavior for every department that pre-dates the change).
 *
 * These are seeded exactly once per department, the first time a Department DO loads
 * its config and finds nothing persisted (fresh create) AND has not already
 * been seeded. Seeded state is tracked under a separate key so that legacy
 * departments which have _other_ config saved but never touched these fields do
 * not get silently rewritten on next load.
 */
const NEW_DEPARTMENT_CONFIG_DEFAULTS = {
  merge_strategy: 'pr' as const,
  staged_shifts_default: true,
  qualityAssurance: {
    gates: [] as string[],
    auto_merge: true,
    require_clean_merge: true,
    code_review: true,
    review_mode: 'comments' as const,
    auto_resolve_pr_feedback: true,
    auto_merge_delay_minutes: 5 as number | null,
  },
};

export async function getDepartmentConfig(storage: DurableObjectStorage): Promise<DepartmentConfig> {
  const raw = await storage.get<unknown>(CONFIG_KEY);
  if (!raw) {
    // Fresh department: seed the new-style defaults from #2725 and persist so they
    // become the department's actual config (rather than schema-injected defaults
    // on every read). This keeps new-department behavior modern while leaving
    // legacy departments — which already have a persisted row — untouched.
    const seeded = DepartmentConfigSchema.parse(NEW_DEPARTMENT_CONFIG_DEFAULTS);
    await storage.put(CONFIG_KEY, seeded);
    await storage.put(NEW_DEPARTMENT_DEFAULTS_SEEDED_KEY, true);
    return seeded;
  }
  return DepartmentConfigSchema.parse(raw);
}

export async function updateDepartmentConfig(
  storage: DurableObjectStorage,
  update: DepartmentConfigUpdate
): Promise<DepartmentConfig> {
  const current = await getDepartmentConfig(storage);

  // env_vars: full replacement semantics. Masked values (exactly "****" followed
  // by up to 4 reveal chars) from the server's masking layer are preserved to
  // avoid overwriting secrets.
  const MASKED_RE = /^\*{4}.{0,4}$/;
  let resolvedEnvVars = current.env_vars;
  if (update.env_vars) {
    resolvedEnvVars = {};
    for (const [key, value] of Object.entries(update.env_vars)) {
      resolvedEnvVars[key] = MASKED_RE.test(value) ? (current.env_vars[key] ?? value) : value;
    }
  }

  // git_auth: preserve masked token values (starting with "****") to avoid
  // overwriting real secrets when the UI round-trips masked config.
  let resolvedGitAuth = current.git_auth;
  if (update.git_auth) {
    resolvedGitAuth = { ...current.git_auth };
    for (const key of ['github_token', 'gitlab_token', 'gitlab_instance_url'] as const) {
      const incoming = update.git_auth[key];
      if (incoming === undefined) continue;
      resolvedGitAuth[key] = MASKED_RE.test(incoming)
        ? (current.git_auth[key] ?? incoming)
        : incoming;
    }
    // platform_integration_id is not masked — always take the update value
    if (update.git_auth.platform_integration_id !== undefined) {
      resolvedGitAuth.platform_integration_id = update.git_auth.platform_integration_id;
    }
  }

  // github_cli_pat: same mask-preservation as git_auth tokens
  const resolvedGithubCliPat =
    update.github_cli_pat !== undefined
      ? MASKED_RE.test(update.github_cli_pat)
        ? current.github_cli_pat
        : update.github_cli_pat
      : current.github_cli_pat;

  // Normalize empty-string model fields to undefined so resolveModel()'s
  // nullish-coalescing fallback works correctly when the user clears them.
  const resolvedDefaultModel =
    update.default_model !== undefined ? update.default_model || undefined : current.default_model;

  const merged: DepartmentConfig = {
    ...current,
    ...update,
    env_vars: resolvedEnvVars,
    git_auth: resolvedGitAuth,
    github_cli_pat: resolvedGithubCliPat,
    default_model: resolvedDefaultModel,
    qualityAssurance:
      update.qualityAssurance !== undefined
        ? {
            gates: update.qualityAssurance.gates ?? current.qualityAssurance?.gates ?? [],
            auto_merge: update.qualityAssurance.auto_merge ?? current.qualityAssurance?.auto_merge ?? true,
            require_clean_merge:
              update.qualityAssurance.require_clean_merge ?? current.qualityAssurance?.require_clean_merge ?? true,
            code_review: update.qualityAssurance.code_review ?? current.qualityAssurance?.code_review ?? true,
            review_mode: update.qualityAssurance.review_mode ?? current.qualityAssurance?.review_mode ?? 'rework',
            auto_resolve_pr_feedback:
              update.qualityAssurance.auto_resolve_pr_feedback ??
              current.qualityAssurance?.auto_resolve_pr_feedback ??
              false,
            auto_resolve_merge_conflicts:
              update.qualityAssurance.auto_resolve_merge_conflicts ??
              current.qualityAssurance?.auto_resolve_merge_conflicts ??
              true,
            auto_merge_delay_minutes:
              update.qualityAssurance.auto_merge_delay_minutes !== undefined
                ? update.qualityAssurance.auto_merge_delay_minutes
                : (current.qualityAssurance?.auto_merge_delay_minutes ?? null),
          }
        : current.qualityAssurance,
    container:
      update.container !== undefined
        ? {
            sleep_after_minutes:
              update.container.sleep_after_minutes ?? current.container?.sleep_after_minutes,
          }
        : current.container,
    custom_instructions:
      update.custom_instructions !== undefined
        ? {
            soul:
              'soul' in update.custom_instructions
                ? update.custom_instructions.soul
                : current.custom_instructions?.soul,
            qualityAssurance:
              'qualityAssurance' in update.custom_instructions
                ? update.custom_instructions.qualityAssurance
                : current.custom_instructions?.qualityAssurance,
            frontDesk:
              'frontDesk' in update.custom_instructions
                ? update.custom_instructions.frontDesk
                : current.custom_instructions?.frontDesk,
          }
        : current.custom_instructions,
  };

  const validated = DepartmentConfigSchema.parse(merged);
  await storage.put(CONFIG_KEY, validated);
  console.log(
    `${DEPARTMENT_LOG} updateDepartmentConfig: saved config with ${Object.keys(validated.env_vars).length} env vars`
  );
  return validated;
}

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * Resolve the primary model from department config, optionally applying a workstation override.
 * Priority: workstation override (role-specific) → workstation override (default) → department role-specific → department default → hardcoded default.
 */
export function resolveModel(
  departmentConfig: DepartmentConfig,
  workstationOverride: WorkstationOverrideConfig | null | undefined,
  role: string
): string {
  const base = workstationOverride?.default_model ?? departmentConfig.default_model;
  if (role === 'frontDesk')
    return departmentConfig.role_models?.frontDesk ?? departmentConfig.default_model ?? DEFAULT_MODEL;
  if (role === 'soul')
    return (
      workstationOverride?.role_models?.soul ?? departmentConfig.role_models?.soul ?? base ?? DEFAULT_MODEL
    );
  if (role === 'qualityAssurance')
    return (
      workstationOverride?.role_models?.qualityAssurance ??
      departmentConfig.role_models?.qualityAssurance ??
      base ??
      DEFAULT_MODEL
    );
  return base ?? DEFAULT_MODEL;
}

/**
 * Resolve the small (lightweight) model from department config.
 * Used for title generation, explore subagent, etc.
 */
export function resolveSmallModel(departmentConfig: DepartmentConfig): string {
  return departmentConfig.small_model ?? 'anthropic/claude-haiku-4.5';
}

/**
 * Resolve the effective merge strategy for a workstation.
 * Priority: workstation-level override → department-level default → 'direct'.
 */
export function resolveMergeStrategy(
  departmentConfig: DepartmentConfig,
  workstationMergeStrategy: MergeStrategy | undefined
): MergeStrategy {
  return workstationMergeStrategy ?? departmentConfig.merge_strategy;
}

/**
 * The fully-resolved configuration for a workstation dispatch.
 * All fields have concrete values (no optional/undefined) except where
 * a null value is meaningful (e.g. auto_merge_delay_minutes: null = disabled).
 */
export type EffectiveConfig = {
  default_model: string | undefined;
  role_models: {
    soul: string | undefined;
    qualityAssurance: string | undefined;
    frontDesk: string | undefined;
  };
  review_mode: 'rework' | 'comments';
  code_review: boolean;
  auto_resolve_pr_feedback: boolean;
  auto_resolve_merge_conflicts: boolean;
  auto_merge_delay_minutes: number | null;
  merge_strategy: MergeStrategy;
  shift_merge_mode: 'review-then-land' | 'review-and-merge';
  custom_instructions: {
    soul: string | undefined;
    qualityAssurance: string | undefined;
    frontDesk: string | undefined;
  };
  git_push_flags: string | undefined;
  max_concurrent_polecats: number | undefined;
  max_dispatch_attempts: number | undefined;
};

/**
 * Merge a workstation's override config on top of department config, returning a fully
 * resolved EffectiveConfig for dispatch. When workstationOverride is null/undefined,
 * all values fall back to department-level defaults (behavior identical to today).
 */
export function resolveWorkstationConfig(
  departmentConfig: DepartmentConfig,
  workstationOverride: WorkstationOverrideConfig | null | undefined
): EffectiveConfig {
  return {
    default_model: workstationOverride?.default_model ?? departmentConfig.default_model,
    role_models: {
      soul: workstationOverride?.role_models?.soul ?? departmentConfig.role_models?.soul,
      qualityAssurance: workstationOverride?.role_models?.qualityAssurance ?? departmentConfig.role_models?.qualityAssurance,
      // frontDesk is always department-level — workstations cannot override frontDesk model
      frontDesk: departmentConfig.role_models?.frontDesk,
    },
    review_mode: workstationOverride?.review_mode ?? departmentConfig.qualityAssurance?.review_mode ?? 'rework',
    code_review: workstationOverride?.code_review ?? departmentConfig.qualityAssurance?.code_review ?? true,
    auto_resolve_pr_feedback:
      workstationOverride?.auto_resolve_pr_feedback ??
      departmentConfig.qualityAssurance?.auto_resolve_pr_feedback ??
      false,
    auto_resolve_merge_conflicts:
      workstationOverride?.auto_resolve_merge_conflicts ??
      departmentConfig.qualityAssurance?.auto_resolve_merge_conflicts ??
      true,
    auto_merge_delay_minutes:
      workstationOverride?.auto_merge_delay_minutes !== undefined
        ? workstationOverride.auto_merge_delay_minutes
        : (departmentConfig.qualityAssurance?.auto_merge_delay_minutes ?? null),
    merge_strategy: workstationOverride?.merge_strategy ?? departmentConfig.merge_strategy ?? 'direct',
    shift_merge_mode:
      workstationOverride?.shift_merge_mode ?? departmentConfig.shift_merge_mode ?? 'review-then-land',
    custom_instructions: {
      soul: workstationOverride?.custom_instructions?.soul ?? departmentConfig.custom_instructions?.soul,
      qualityAssurance:
        workstationOverride?.custom_instructions?.qualityAssurance ?? departmentConfig.custom_instructions?.qualityAssurance,
      // frontDesk is always department-level
      frontDesk: departmentConfig.custom_instructions?.frontDesk,
    },
    git_push_flags: workstationOverride?.git_push_flags,
    max_concurrent_polecats:
      workstationOverride?.max_concurrent_polecats ?? departmentConfig.max_polecats_per_workstation,
    max_dispatch_attempts: workstationOverride?.max_dispatch_attempts,
  };
}

/**
 * Build the ContainerConfig payload for X-department-Config header.
 * Sent with every fetch() to the container.
 *
 * The container's `syncDepartmentConfigToProcessEnv` reads `git_auth.github_token`
 * from this payload on every request and writes it to `process.env.GIT_TOKEN`,
 * which the SDK server's `gh` CLI inherits via `GH_TOKEN`. To prevent serving
 * an expired installation token (TTL ~1h) we resolve through `resolveGitHubToken`
 * so a configured platform integration always returns a fresh value.
 *
 * `departmentId` is required so we can always perform the integration lookup.
 * Making it optional was a foot-gun — a forgotten arg silently re-introduces
 * the stale-token bug this function exists to prevent.
 */
export async function buildContainerConfig(
  storage: DurableObjectStorage,
  env: Env,
  departmentId: string
): Promise<Record<string, unknown>> {
  const config = await getDepartmentConfig(storage);

  let resolvedGithubToken = config.git_auth?.github_token;
  try {
    const fresh = await resolveGitHubTokenString({
      env,
      departmentId,
      getDepartmentConfig: () => Promise.resolve(config),
    });
    if (fresh) resolvedGithubToken = fresh;
  } catch (err) {
    console.warn(
      `${DEPARTMENT_LOG} buildContainerConfig: resolveGitHubTokenString failed; falling back to stored token`,
      err
    );
  }

  return {
    env_vars: config.env_vars,
    default_model: resolveModel(config, null, ''),
    small_model: resolveSmallModel(config),
    git_auth: {
      ...config.git_auth,
      github_token: resolvedGithubToken,
    },
    kilocode_token: config.kilocode_token,
    github_cli_pat: config.github_cli_pat,
    git_author_name: config.git_author_name,
    git_author_email: config.git_author_email,
    disable_ai_coauthor: config.disable_ai_coauthor,
    kilo_api_url: env.KILO_API_URL ?? '',
    helldesk_api_url: env.HELLDESK_API_URL ?? '',
    organization_id: config.organization_id,
  };
}
