/**
 * Container interaction: start agents, send messages, trigger merges, mint JWTs.
 * All container communication goes through the DepartmentContainerDO stub.
 */

import { z } from 'zod';
import { getDepartmentContainerStub } from '../DepartmentContainer.do';
import { signAgentJWT, signContainerJWT } from '../../util/jwt.util';
import { buildSoulSystemPrompt } from '../../prompts/soul-system.prompt';
import { buildFrontDeskSystemPrompt } from '../../prompts/front-desk-system.prompt';
import type { DepartmentConfig, WorkstationOverrideConfig } from '../../types';
import { buildContainerConfig, resolveModel, resolveSmallModel, resolveWorkstationConfig } from './config';
import { writeEvent } from '../../util/analytics.util';
import { resolveGitHubTokenString } from './department-scm';

const DEPARTMENT_LOG = '[Department.do]';

const ContainerStartError = z.object({
  error: z.string(),
  phase: z.string().optional(),
  status: z.number().optional(),
  error_type: z.string().optional(),
  action: z.string().optional(),
});

// Allowlist of git push flags that are safe to pass from workstation config.
// Flags that bypass hooks (--no-verify), rewrite history (--force,
// --force-with-lease), or alter remote refs in dangerous ways are
// explicitly excluded to prevent config-driven bypass of protections.
const ALLOWED_GIT_PUSH_FLAGS = new Set([
  '--atomic',
  '--follow-tags',
  '--signed',
  '--no-signed',
  '--progress',
  '--no-progress',
  '--verbose',
  '--quiet',
  '--tags',
  '--porcelain',
  '--ipv4',
  '--ipv6',
  '--recurse-submodules=check',
  '--recurse-submodules=on-demand',
  '--recurse-submodules=no',
]);

/**
 * Filter git push flags against the allowlist. Returns only the safe subset.
 * Logs a warning for any rejected flags.
 */
function filterGitPushFlags(raw: string): string | undefined {
  const flags = raw.trim().split(/\s+/).filter(Boolean);
  const allowed: string[] = [];
  for (const flag of flags) {
    if (ALLOWED_GIT_PUSH_FLAGS.has(flag)) {
      allowed.push(flag);
    } else {
      console.warn(`${DEPARTMENT_LOG} filterGitPushFlags: rejecting unsafe flag "${flag}"`);
    }
  }
  return allowed.length > 0 ? allowed.join(' ') : undefined;
}

// Module-level diagnostic: stores the last container start error so
// callers can surface it via the admin API. Reset on each call.
let lastStartError: string | null = null;
export function getLastStartError(): string | null {
  return lastStartError;
}

function formatContainerStartError(status: number, bodyText: string): string {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return `(${status}) ${bodyText.slice(0, 300)}`;
  }
  const parsed = ContainerStartError.safeParse(parsedJson);
  if (!parsed.success) return `(${status}) ${bodyText.slice(0, 300)}`;

  const failure = parsed.data;
  const details = [
    failure.phase ? `${failure.phase} failed` : 'container start failed',
    failure.error_type ?? null,
    failure.status ? `upstream ${failure.status}` : null,
  ].filter(value => value !== null);
  const action = failure.action ? ` Action: ${failure.action}` : '';
  return `(${status}) ${details.join(': ')}: ${failure.error}${action}`.slice(0, 500);
}

/**
 * Resolve the HELLDESK_JWT_SECRET binding to a string.
 */
export async function resolveJWTSecret(env: Env): Promise<string | null> {
  const binding = env.HELLDESK_JWT_SECRET;
  if (!binding) {
    console.error(`${DEPARTMENT_LOG} resolveJWTSecret: HELLDESK_JWT_SECRET binding is falsy`);
    return null;
  }
  if (typeof binding === 'string') return binding;
  try {
    const secret = await binding.get();
    if (!secret) {
      console.error(`${DEPARTMENT_LOG} resolveJWTSecret: binding.get() returned falsy value`);
      return null;
    }
    return secret ?? null;
  } catch (err) {
    console.error(
      `${DEPARTMENT_LOG} resolveJWTSecret: binding.get() threw:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Mint a short-lived agent JWT for the given agent to authenticate
 * API calls back to the helldesk worker.
 *
 * @deprecated Prefer container secrets (ensureContainerSecret) for new code.
 * Agent JWTs are retained for backwards compatibility during rollout.
 */
export async function mintAgentToken(
  env: Env,
  params: { agentId: string; workstationId: string; departmentId: string; userId: string }
): Promise<string | null> {
  const secret = await resolveJWTSecret(env);
  if (!secret) return null;

  // 8h expiry — long enough for typical agent sessions, short enough to limit blast radius
  return signAgentJWT(
    secret,
    { agentId: params.agentId, workstationId: params.workstationId, departmentId: params.departmentId, userId: params.userId },
    8 * 3600
  );
}

/**
 * Mint a container-scoped JWT and push it to the DepartmentContainerDO.
 * One JWT per container — shared by all agents in the department. Carries
 * { departmentId, userId, scope: 'container' } with 8h expiry.
 *
 * Pushes via both setEnvVar() (for next container boot) and
 * POST /refresh-token (for the running process). This ensures that
 * all code paths — existing agents, heartbeat, event persistence —
 * pick up the fresh token immediately.
 *
 * Returns the token so callers can also pass it as a per-agent env var.
 */
export async function ensureContainerToken(
  env: Env,
  departmentId: string,
  userId: string
): Promise<string | null> {
  const jwtSecret = await resolveJWTSecret(env);
  if (!jwtSecret) {
    console.error(`${DEPARTMENT_LOG} ensureContainerToken: no JWT secret available`);
    return null;
  }

  const token = signContainerJWT({ departmentId, userId }, jwtSecret);
  const container = getDepartmentContainerStub(env as never, departmentId);

  try {
    await container.setEnvVar('HELLDESK_CONTAINER_TOKEN', token);
    await container.setEnvVar('HELLDESK_DEPARTMENT_ID', departmentId);
  } catch (err) {
    console.warn(
      `${DEPARTMENT_LOG} ensureContainerToken: setEnvVar failed (container may not be running):`,
      err instanceof Error ? err.message : err
    );
  }

  // Throw on non-2xx so the alarm's throttle doesn't advance on failure.
  try {
    const resp = await container.fetch('http://container/refresh-token', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      throw new Error(`container returned ${resp.status}`);
    }
  } catch (err) {
    // If the container isn't running yet, the token will be in envVars
    // when it boots. But if it IS running and rejected the refresh,
    // propagate the error so the alarm retries on the next tick.
    const isContainerDown =
      err instanceof TypeError || (err instanceof Error && err.message.includes('fetch'));
    if (!isContainerDown) throw err;
  }

  return token;
}

/**
 * Alias for ensureContainerToken — both functions now push to the
 * running container process via POST /refresh-token. Kept as a
 * separate export for call-site readability (alarm code calls
 * "refresh", dispatch code calls "ensure").
 */
export const refreshContainerToken = ensureContainerToken;

/**
 * Force-refresh variant for manual user-triggered refreshes.
 *
 * Unlike ensureContainerToken (which tolerates a downed container
 * because the token is persisted in envVars for next boot), this
 * function throws on ANY failure to push the token to the running
 * container — including network errors. This ensures the UI reports
 * a real failure instead of a false success when the container
 * never actually received the fresh JWT.
 */
export async function forceRefreshContainerToken(
  env: Env,
  departmentId: string,
  userId: string
): Promise<string> {
  const jwtSecret = await resolveJWTSecret(env);
  if (!jwtSecret) {
    throw new Error('No JWT secret available — cannot mint container token');
  }

  const token = signContainerJWT({ departmentId, userId }, jwtSecret);
  const container = getDepartmentContainerStub(env as never, departmentId);

  // Store for next boot (best-effort — the critical step is the live push below)
  try {
    await container.setEnvVar('HELLDESK_CONTAINER_TOKEN', token);
    await container.setEnvVar('HELLDESK_DEPARTMENT_ID', departmentId);
  } catch (err) {
    console.warn(
      `${DEPARTMENT_LOG} forceRefreshContainerToken: setEnvVar failed:`,
      err instanceof Error ? err.message : err
    );
  }

  // Push to running container — propagate ALL errors so the caller
  // (and ultimately the UI) knows the refresh didn't land.
  const resp = await container.fetch('http://container/refresh-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `Container rejected token refresh (HTTP ${resp.status})${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }

  return token;
}

/** Build the initial prompt for an agent from its ticket. */
export function buildPrompt(params: {
  ticketTitle: string;
  ticketBody: string;
  checkpoint: unknown;
  conversationHistory?: string;
}): string {
  const parts: string[] = [];
  if (params.conversationHistory) {
    parts.push(params.conversationHistory);
  }
  parts.push(params.ticketTitle);
  if (params.ticketBody) parts.push(params.ticketBody);
  if (params.checkpoint) {
    parts.push(
      `Resume from checkpoint:\n${typeof params.checkpoint === 'string' ? params.checkpoint : JSON.stringify(params.checkpoint)}`
    );
  }
  return parts.join('\n\n');
}

/** Build the system prompt for an agent given its role and context. */
export function systemPromptForRole(params: {
  role: string;
  identity: string;
  agentName: string;
  workstationId: string;
  departmentId: string;
  gates: string[];
}): string {
  switch (params.role) {
    case 'soul':
      return buildSoulSystemPrompt({
        agentName: params.agentName,
        workstationId: params.workstationId,
        departmentId: params.departmentId,
        identity: params.identity,
        gates: params.gates,
      });
    case 'frontDesk':
      return buildFrontDeskSystemPrompt({
        identity: params.identity,
        departmentId: params.departmentId,
      });
    default: {
      const base = `You are ${params.identity}, a HELLDESK ${params.role} agent. Follow all instructions in the helldesk CONTEXT injected into this session.`;
      switch (params.role) {
        case 'qualityAssurance':
          return `${base} You review code quality and merge PRs. Check for correctness, style, and test coverage.`;
        default:
          return base;
      }
    }
  }
}

/**
 * Append per-role custom instructions to a system prompt.
 * Accepts either a DepartmentConfig (falls back to department-level instructions)
 * or a pre-resolved instructions string. Returns the prompt unchanged
 * when no custom instructions exist for the role.
 */
export function appendCustomInstructions(
  systemPrompt: string,
  role: string,
  departmentConfig: DepartmentConfig,
  resolvedInstructions?: string | null
): string {
  const roleKey = role as keyof NonNullable<DepartmentConfig['custom_instructions']>;
  const instructions = (resolvedInstructions ?? departmentConfig.custom_instructions?.[roleKey])?.trim();
  if (!instructions) return systemPrompt;
  return `${systemPrompt}\n\n## Custom Instructions (from department settings)\n\n${instructions}`;
}

/** Generate a branch name for an agent working on a specific ticket. */
export function branchForAgent(name: string, ticketId?: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  const ticketSuffix = ticketId ? `/${ticketId.slice(0, 8)}` : '';
  return `gt/${slug}${ticketSuffix}`;
}

/**
 * Generate a branch name for a shift ticket's agent.
 *
 * Agent branches are siblings of the shift feature branch's /head ref,
 * not children of it. Git refs are file-based: a ref at path X blocks
 * refs under X/. The shift feature branch ends with /head (a leaf),
 * and agent branches sit alongside it under the same shift prefix:
 *
 *   shift/<slug>/<id>/head             ← feature branch
 *   shift/<slug>/<id>/gt/<agent>/<ticket> ← agent branch (sibling)
 *
 * Both are entries within the <id>/ directory, so no ref conflict.
 */
export function branchForShiftAgent(
  shiftFeatureBranch: string,
  name: string,
  ticketId: string
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
  // Strip /head suffix to get the shift prefix, then place the agent branch as a sibling
  const shiftPrefix = shiftFeatureBranch.replace(/\/head$/, '');
  return `${shiftPrefix}/gt/${slug}/${ticketId.slice(0, 8)}`;
}

/**
 * Signal the container to start an agent process.
 * Attaches current department config via X-department-Config header.
 */
export async function startAgentInContainer(
  env: Env,
  storage: DurableObjectStorage,
  params: {
    departmentId: string;
    workstationId: string;
    userId: string;
    agentId: string;
    agentName: string;
    role: string;
    identity: string;
    ticketId: string;
    ticketTitle: string;
    ticketBody: string;
    checkpoint: unknown;
    /** Reconstructed conversation transcript for prompt injection on re-dispatch. */
    conversationHistory?: string;
    gitUrl: string;
    defaultBranch: string;
    kilocodeToken?: string;
    departmentConfig: DepartmentConfig;
    /** workstation-level config overrides. When present, merged on top of departmentConfig for model, custom_instructions, and git_push_flags. */
    workstationOverride?: WorkstationOverrideConfig | null;
    systemPromptOverride?: string;
    platformIntegrationId?: string;
    /** For shift tickets: the shift's feature branch to branch from instead of defaultBranch. */
    shiftFeatureBranch?: string;
    /** Skip repo clone — use a lightweight workspace (for reasoning-only agents like triage). */
    lightweight?: boolean;
    /** All workstations in the department (frontDesk only) — used to set up browse worktrees on fresh containers. */
    workstations?: Array<{
      workstationId: string;
      gitUrl: string;
      defaultBranch: string;
      platformIntegrationId?: string;
    }>;
  }
): Promise<{ started: boolean; containerFetchMs: number }> {
  lastStartError = null;
  console.log(
    `${DEPARTMENT_LOG} startAgentInContainer: agentId=${params.agentId} role=${params.role} name=${params.agentName}`
  );
  try {
    const containerToken = await ensureContainerToken(env, params.departmentId, params.userId);

    // Also mint a per-agent JWT as fallback during rollout.
    const agentToken = await mintAgentToken(env, {
      agentId: params.agentId,
      workstationId: params.workstationId,
      departmentId: params.departmentId,
      userId: params.userId,
    });

    if (!containerToken && !agentToken) {
      console.error(
        `${DEPARTMENT_LOG} startAgentInContainer: ABORTING — failed to mint any auth token for agent ${params.agentId}. ` +
          'The agent would start without credentials and be unable to call back to the worker.'
      );
      return { started: false, containerFetchMs: 0 };
    }

    const envVars: Record<string, string> = { ...(params.departmentConfig.env_vars ?? {}) };

    // Map git_auth tokens. Resolve GitHub token through resolveGitHubTokenString so
    // we mint a fresh installation token when a platform integration is
    // configured; otherwise we'd hand the agent a `git_auth.github_token`
    // value that may have been written hours ago and is well past its 1h
    // installation-token TTL. The resolved value is also what the agent's
    // `gh` CLI sees as `GH_TOKEN`.
    const githubToken = await resolveGitHubTokenString({
      env,
      departmentId: params.departmentId,
      getDepartmentConfig: () => Promise.resolve(params.departmentConfig),
      platformIntegrationId: params.platformIntegrationId,
    });
    if (githubToken) {
      envVars.GIT_TOKEN = githubToken;
    }
    if (params.departmentConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = params.departmentConfig.git_auth.gitlab_token;
    }
    if (params.departmentConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = params.departmentConfig.git_auth.gitlab_instance_url;
    }

    // GitHub CLI PAT — used exclusively for `gh` CLI operations (PRs, issues).
    // Separate from GIT_TOKEN which is used for git clone/push.
    if (params.departmentConfig.github_cli_pat) {
      envVars.GITHUB_CLI_PAT = params.departmentConfig.github_cli_pat;
    }

    if (params.departmentConfig.git_author_name) {
      envVars.HELLDESK_GIT_AUTHOR_NAME = params.departmentConfig.git_author_name;
    }
    if (params.departmentConfig.git_author_email) {
      envVars.HELLDESK_GIT_AUTHOR_EMAIL = params.departmentConfig.git_author_email;
    }
    if (params.departmentConfig.disable_ai_coauthor) {
      envVars.HELLDESK_DISABLE_AI_COAUTHOR = '1';
    }

    // Container token is preferred (shared by all agents, refreshed by alarm).
    // Legacy per-agent JWT kept as fallback during rollout.
    if (containerToken) envVars.HELLDESK_CONTAINER_TOKEN = containerToken;
    if (agentToken) envVars.HELLDESK_SESSION_TOKEN = agentToken;
    const kilocodeToken = params.kilocodeToken ?? params.departmentConfig.kilocode_token;
    if (kilocodeToken) envVars.KILOCODE_TOKEN = kilocodeToken;

    console.log(
      `${DEPARTMENT_LOG} startAgentInContainer: envVars built: keys=[${Object.keys(envVars).join(',')}] hasGitToken=${!!envVars.GIT_TOKEN} hasGitlabToken=${!!envVars.GITLAB_TOKEN} hasContainerToken=${!!containerToken} hasAgentJwt=${!!agentToken} hasKilocodeToken=${!!kilocodeToken} git_auth_keys=[${Object.keys(params.departmentConfig.git_auth ?? {}).join(',')}]`
    );

    const containerConfig = await buildContainerConfig(storage, env, params.departmentId);
    const container = getDepartmentContainerStub(env as never, params.departmentId);

    const workstationOverride = params.workstationOverride ?? null;
    const effectiveConfig = resolveWorkstationConfig(params.departmentConfig, workstationOverride);

    const fetchStart = Date.now();
    const response = await container.fetch('http://container/agents/start', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Content-Type': 'application/json',
        'X-department-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        agentId: params.agentId,
        workstationId: params.workstationId,
        departmentId: params.departmentId,
        role: params.role,
        name: params.agentName,
        identity: params.identity,
        prompt: buildPrompt({
          ticketTitle: params.ticketTitle,
          ticketBody: params.ticketBody,
          checkpoint: params.checkpoint,
          conversationHistory: params.conversationHistory,
        }),
        model: resolveModel(params.departmentConfig, workstationOverride, params.role),
        smallModel: resolveSmallModel(params.departmentConfig),
        systemPrompt: appendCustomInstructions(
          params.systemPromptOverride ??
            systemPromptForRole({
              role: params.role,
              identity: params.identity,
              agentName: params.agentName,
              workstationId: params.workstationId,
              departmentId: params.departmentId,
              gates: params.departmentConfig.qualityAssurance?.gates ?? [],
            }),
          params.role,
          params.departmentConfig,
          effectiveConfig.custom_instructions[
            params.role as keyof typeof effectiveConfig.custom_instructions
          ]
        ),
        ...(effectiveConfig.git_push_flags
          ? (() => {
              const safe = filterGitPushFlags(effectiveConfig.git_push_flags);
              return safe ? { gitPushFlags: safe } : {};
            })()
          : {}),
        gitUrl: params.gitUrl,
        branch: params.shiftFeatureBranch
          ? branchForShiftAgent(params.shiftFeatureBranch, params.agentName, params.ticketId)
          : branchForAgent(params.agentName, params.ticketId),
        // Always use the workstation's real default branch for the initial git clone.
        // The agent's working branch is created as a worktree from HEAD after
        // clone; for shift agents the startPoint below positions that worktree
        // at the shift's feature branch tip.
        defaultBranch: params.defaultBranch,
        envVars,
        platformIntegrationId: params.platformIntegrationId,
        // For shift agents, start from the shift's feature branch so the
        // worktree includes all previously merged shift work.
        startPoint: params.shiftFeatureBranch ? `origin/${params.shiftFeatureBranch}` : undefined,
        lightweight: params.lightweight,
        // Org-owned departments: pass the organization ID so agents bill to the correct team
        organizationId: params.departmentConfig.organization_id,
        workstations: params.workstations,
      }),
    });

    const durationMs = Date.now() - fetchStart;
    if (!response.ok) {
      const text = await response.text().catch(() => '(unreadable)');
      // "Already running" means a previous dispatch succeeded — the agent
      // IS alive in the container. Treat as success so the DO marks the
      // agent as working and stops retrying.
      if (response.status === 500 && text.includes('already running')) {
        console.log(
          `${DEPARTMENT_LOG} startAgentInContainer: agent ${params.agentId} already running — treating as success`
        );
        writeEvent(env, {
          event: 'container.agent_start_fetch',
          departmentId: params.departmentId,
          workstationId: params.workstationId,
          agentId: params.agentId,
          durationMs,
          statusCode: response.status,
        });
        return { started: true, containerFetchMs: durationMs };
      }
      const errorMsg = formatContainerStartError(response.status, text);
      console.error(
        `${DEPARTMENT_LOG} startAgentInContainer: error response for ` +
          `agent=${params.agentId} role=${params.role}: ${errorMsg}`
      );
      lastStartError = errorMsg;
      writeEvent(env, {
        event: 'container.agent_start_fetch',
        departmentId: params.departmentId,
        workstationId: params.workstationId,
        agentId: params.agentId,
        durationMs,
        statusCode: response.status,
        error: errorMsg,
      });
      return { started: false, containerFetchMs: durationMs };
    }
    writeEvent(env, {
      event: 'container.agent_start_fetch',
      departmentId: params.departmentId,
      workstationId: params.workstationId,
      agentId: params.agentId,
      durationMs,
      statusCode: response.status,
    });
    return { started: true, containerFetchMs: durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${DEPARTMENT_LOG} startAgentInContainer: EXCEPTION for agent ${params.agentId}:`, err);
    lastStartError = `EXCEPTION: ${message.slice(0, 300)}`;
    return { started: false, containerFetchMs: 0 };
  }
}

/**
 * Signal the container to run a deterministic merge.
 */
export async function startMergeInContainer(
  env: Env,
  storage: DurableObjectStorage,
  params: {
    departmentId: string;
    workstationId: string;
    agentId: string;
    entryId: string;
    ticketId: string;
    branch: string;
    targetBranch: string;
    gitUrl: string;
    kilocodeToken?: string;
    departmentConfig: DepartmentConfig;
  }
): Promise<boolean> {
  try {
    const userId = params.departmentConfig.owner_user_id ?? params.departmentId;
    if (!params.departmentConfig.owner_user_id) {
      console.warn(
        `${DEPARTMENT_LOG} startMergeInContainer: owner_user_id missing from department config for department ${params.departmentId}. ` +
          'Falling back to departmentId — this breaks session-ingest authorization and should not happen for properly provisioned departments.'
      );
    }
    const containerToken = await ensureContainerToken(env, params.departmentId, userId);
    const agentToken = await mintAgentToken(env, {
      agentId: params.agentId,
      workstationId: params.workstationId,
      departmentId: params.departmentId,
      userId,
    });

    if (!containerToken && !agentToken) {
      console.error(
        `${DEPARTMENT_LOG} startMergeInContainer: ABORTING — failed to mint any auth token for merge entry ${params.entryId}. ` +
          'The merge process would start without credentials and be unable to report results.'
      );
      return false;
    }

    const envVars: Record<string, string> = { ...(params.departmentConfig.env_vars ?? {}) };
    // Resolve GitHub token through resolveGitHubTokenString so a configured
    // platform integration mints a fresh installation token for the
    // merge process. See startAgentInContainer for the rationale.
    const mergeGithubToken = await resolveGitHubTokenString({
      env,
      departmentId: params.departmentId,
      getDepartmentConfig: () => Promise.resolve(params.departmentConfig),
    });
    if (mergeGithubToken) {
      envVars.GIT_TOKEN = mergeGithubToken;
    }
    if (params.departmentConfig.git_auth?.gitlab_token) {
      envVars.GITLAB_TOKEN = params.departmentConfig.git_auth.gitlab_token;
    }
    if (params.departmentConfig.git_auth?.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = params.departmentConfig.git_auth.gitlab_instance_url;
    }
    if (containerToken) envVars.HELLDESK_CONTAINER_TOKEN = containerToken;
    if (agentToken) envVars.HELLDESK_SESSION_TOKEN = agentToken;
    if (env.HELLDESK_API_URL) envVars.HELLDESK_API_URL = env.HELLDESK_API_URL;
    const mergeKilocodeToken = params.kilocodeToken ?? params.departmentConfig.kilocode_token;
    if (mergeKilocodeToken) envVars.KILOCODE_TOKEN = mergeKilocodeToken;

    const containerConfig = await buildContainerConfig(storage, env, params.departmentId);
    const container = getDepartmentContainerStub(env as never, params.departmentId);

    const response = await container.fetch('http://container/git/merge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-department-Config': JSON.stringify(containerConfig),
      },
      body: JSON.stringify({
        departmentId: params.departmentId,
        workstationId: params.workstationId,
        branch: params.branch,
        targetBranch: params.targetBranch,
        gitUrl: params.gitUrl,
        entryId: params.entryId,
        ticketId: params.ticketId,
        agentId: params.agentId,
        envVars,
      }),
    });

    if (!response.ok) {
      console.error(
        `${DEPARTMENT_LOG} startMergeInContainer: failed for entry ${params.entryId}: ${response.status}`
      );
    }
    return response.ok;
  } catch (err) {
    console.error(`${DEPARTMENT_LOG} startMergeInContainer: failed for entry ${params.entryId}:`, err);
    return false;
  }
}

/**
 * Check the container for an agent's process status.
 */
export async function checkAgentContainerStatus(
  env: Env,
  departmentId: string,
  agentId: string
): Promise<{ status: string; exitReason?: string; serverPort?: number; sessionId?: string }> {
  try {
    const container = getDepartmentContainerStub(env as never, departmentId);
    const response = await container.fetch(`http://container/agents/${agentId}/status`, {
      signal: AbortSignal.timeout(10_000),
    });
    // 404 means the container is running but has no record of this agent
    // (e.g. after container eviction). Report as 'not_found' so the
    // reconciler can immediately reset and redispatch the agent
    // instead of waiting for the 2-hour GUPP timeout.
    if (response.status === 404) return { status: 'not_found' };
    // Non-OK but not 404 — container is having issues but may still
    // have the agent running. Return 'unknown' so the reconciler doesn't
    // falsely reset a working agent.
    if (!response.ok) return { status: 'unknown' };
    const data: unknown = await response.json();
    if (typeof data === 'object' && data !== null && 'status' in data) {
      const status = (data as { status: unknown }).status;
      const exitReason =
        'exitReason' in data ? (data as { exitReason: unknown }).exitReason : undefined;
      const serverPort =
        'serverPort' in data ? (data as { serverPort: unknown }).serverPort : undefined;
      const sessionId =
        'sessionId' in data ? (data as { sessionId: unknown }).sessionId : undefined;
      return {
        status: typeof status === 'string' ? status : 'unknown',
        exitReason: typeof exitReason === 'string' ? exitReason : undefined,
        serverPort: typeof serverPort === 'number' ? serverPort : undefined,
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
      };
    }
    return { status: 'unknown' };
  } catch {
    // Timeout, network error, or container starting up — return
    // 'unknown' so the reconciler doesn't falsely reset working agents.
    // True zombies will be caught after repeated 'unknown' results
    // once the GIPP/heartbeat timeout expires.
    return { status: 'unknown' };
  }
}

/**
 * Best-effort stop of an agent in the container.
 */
export async function stopAgentInContainer(
  env: Env,
  departmentId: string,
  agentId: string
): Promise<void> {
  try {
    const container = getDepartmentContainerStub(env as never, departmentId);
    await container.fetch(`http://container/agents/${agentId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch {
    // Best-effort
  }
}

/**
 * Push the latest dashboard context XML to the running container.
 * Best-effort — silently ignores failures if the container is down.
 */
export async function pushDashboardContext(
  env: Env,
  departmentId: string,
  context: string
): Promise<void> {
  const container = getDepartmentContainerStub(env as never, departmentId);
  try {
    const resp = await container.fetch('http://container/dashboard-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    if (!resp.ok) {
      console.warn(`${DEPARTMENT_LOG} pushDashboardContext: container returned ${resp.status}`);
    }
  } catch {
    // Container not running — context will be pushed on next navigation
  }
}

/**
 * Send a follow-up message to an existing agent in the container.
 */
export async function sendMessageToAgent(
  env: Env,
  departmentId: string,
  agentId: string,
  message: string
): Promise<boolean> {
  try {
    const container = getDepartmentContainerStub(env as never, departmentId);
    const response = await container.fetch(`http://container/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: message }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Rewrite the frontDesk's AGENTS.md with an updated system prompt.
 * Called when custom instructions change so the running frontDesk picks them up.
 */
export async function updateFrontDeskSystemPromptInContainer(
  env: Env,
  departmentId: string,
  agentId: string,
  systemPrompt: string
): Promise<boolean> {
  try {
    const container = getDepartmentContainerStub(env as never, departmentId);
    const response = await container.fetch(`http://container/agents/${agentId}/system-prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Hot-update the model for a running agent without restarting the session.
 * Best-effort — returns false if the container is down or the agent is not running.
 */
export async function updateAgentModelInContainer(
  env: Env,
  departmentId: string,
  agentId: string,
  model: string,
  smallModel?: string,
  conversationHistory?: string,
  containerConfig?: Record<string, unknown>,
  organizationId?: string
): Promise<boolean> {
  try {
    const container = getDepartmentContainerStub(env as never, departmentId);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (containerConfig) {
      headers['X-department-Config'] = JSON.stringify(containerConfig);
    }
    const response = await container.fetch(`http://container/agents/${agentId}/model`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        model,
        ...(smallModel ? { smallModel } : {}),
        ...(conversationHistory ? { conversationHistory } : {}),
        ...(organizationId ? { organizationId } : {}),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
