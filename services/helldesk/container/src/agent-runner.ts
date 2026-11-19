import type { Config } from '@kilocode/sdk';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { cloneRepo, createWorktree, setupWorkstationBrowseWorktree } from './git-manager';
import { startAgent } from './process-manager';
import { getCurrentDepartmentConfig } from './control-server';
import { log } from './logger';
import type { ManagedAgent, StartAgentRequest } from './types';
import { agentHomeDir, agentXdgDataDir, assertDurable, workstationCredentialsPath } from './durable';

/**
 * Resolve an env var: prefer the request-provided value, then the container's
 * inherited process env, then undefined (omitted from the child env so the
 * inherited value from process.env flows through naturally via mergedEnv).
 */
function resolveEnv(request: StartAgentRequest, key: string): string | undefined {
  return request.envVars?.[key] ?? process.env[key];
}

/** Prepend the kilo provider prefix to an OpenRouter-style model ID. */
export function kiloModel(openrouterModel: string): string {
  const trimmed = openrouterModel.trim();
  if (!trimmed) return 'kilo/kilo-auto/frontier';
  return trimmed.startsWith('kilo/') ? trimmed : `kilo/${trimmed}`;
}

const HEADLESS_PERMISSIONS = {
  edit: 'allow' as const,
  bash: 'allow' as const,
  webfetch: 'allow' as const,
  doom_loop: 'allow' as const,
  external_directory: 'allow' as const,
};

/**
 * Build KILO_CONFIG_CONTENT JSON so kilo serve can authenticate with
 * the Kilo LLM gateway. Both `model` and `smallModel` are OpenRouter-style
 * IDs (e.g. "anthropic/claude-sonnet-4.6") resolved from the department config.
 */
export function buildKiloConfigContent(
  kilocodeToken: string,
  model: string,
  smallModel: string,
  organizationId?: string
): string {
  const primaryModel = kiloModel(model);
  const smModel = kiloModel(smallModel);

  const providerOptions: Record<string, string> = {
    apiKey: kilocodeToken,
    kilocodeToken,
  };
  if (organizationId) {
    providerOptions.kilocodeOrganizationId = organizationId;
  }

  return JSON.stringify({
    provider: {
      kilo: {
        options: providerOptions,
        // Register models so the kilo server doesn't reject them before
        // routing to the gateway.
        models: {
          [primaryModel]: {},
          [smModel]: {},
        },
      },
    },
    // Override small_model (used for title generation). Without this, kilo
    // serve defaults to a model that doesn't exist in the kilo provider,
    // causing ProviderModelNotFoundError.
    small_model: smModel,
    model: primaryModel,
    agent: {
      code: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      general: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      plan: { model: primaryModel, permission: HEADLESS_PERMISSIONS },
      title: { model: smModel },
      explore: {
        small_model: smModel,
        model: primaryModel,
        permission: HEADLESS_PERMISSIONS,
      },
    },
    permission: HEADLESS_PERMISSIONS,
  } satisfies Config);
}

export function buildAgentEnv(request: StartAgentRequest): Record<string, string> {
  // Custom git identity: when HELLDESK_GIT_AUTHOR_NAME is set, the user becomes
  // the primary author and the AI agent name is used for co-authorship trailers.
  const customAuthorName = resolveEnv(request, 'HELLDESK_GIT_AUTHOR_NAME');
  const customAuthorEmail = resolveEnv(request, 'HELLDESK_GIT_AUTHOR_EMAIL');
  const authorName = customAuthorName ?? `${request.name} (helldesk)`;
  const authorEmail = customAuthorEmail ?? `${request.name}@helldesk.local`;

  const env: Record<string, string> = {
    HELLDESK_AGENT_ID: request.agentId,
    HELLDESK_WORKSTATION_ID: request.workstationId,
    HELLDESK_DEPARTMENT_ID: request.departmentId,
    HELLDESK_AGENT_ROLE: request.role,
    KILOCODE_FEATURE: 'helldesk',
    // Durable per-agent home (NOT /tmp) — kilo.db + session memory must survive
    // container evictions, GPU crashes and Windows restarts.
    KILO_TEST_HOME: agentHomeDir(request.agentId),
    // XDG_DATA_HOME controls where the kilo CLI writes kilo.db (via xdg-basedir).
    // Must match the path used by hydrateDbFromSnapshot/saveDbSnapshot in
    // process-manager.ts so snapshots round-trip correctly across evictions.
    XDG_DATA_HOME: agentXdgDataDir(request.agentId),

    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  // Hard guarantee: kilo.db / session home is never a temp path.
  assertDurable(env.KILO_TEST_HOME, 'KILO_TEST_HOME');

  // When custom author is set, provide the AI agent identity for co-authorship
  if (customAuthorName) {
    env.HELLDESK_AI_AGENT_NAME = `${request.name} (helldesk)`;
    env.HELLDESK_AI_AGENT_EMAIL = `${request.name}@helldesk.local`;
    if (resolveEnv(request, 'HELLDESK_DISABLE_AI_COAUTHOR') === '1') {
      env.HELLDESK_DISABLE_AI_COAUTHOR = '1';
    }
  }

  // Conditionally set config vars — only when a value is available from
  // the request or the container's own environment.
  // (KILO_API_URL and KILO_OPENROUTER_BASE are set at the container level
  // via DepartmentContainerDO.envVars and inherited through process.env.)
  const conditionalKeys = [
    'HELLDESK_API_URL',
    'HELLDESK_CONTAINER_TOKEN',
    'HELLDESK_SESSION_TOKEN',
    'KILOCODE_TOKEN',
  ];
  for (const key of conditionalKeys) {
    const value = resolveEnv(request, key);
    if (value) {
      env[key] = value;
    }
  }

  console.log(`HELLDESK_API_URL="${env.HELLDESK_API_URL}"
HELLDESK_SESSION_TOKEN=${env.HELLDESK_SESSION_TOKEN ? '(set)' : '(not set)'}
HELLDESK_AGENT_ID="${env.HELLDESK_AGENT_ID}"
HELLDESK_WORKSTATION_ID="${env.HELLDESK_WORKSTATION_ID}"
HELLDESK_DEPARTMENT_ID="${env.HELLDESK_DEPARTMENT_ID}"`);

  // Fall back to X-department-Config for KILOCODE_TOKEN if not in request or process.env
  if (!env.KILOCODE_TOKEN) {
    const departmentConfig = getCurrentDepartmentConfig();
    const tokenFromConfig =
      departmentConfig && typeof departmentConfig.kilocode_token === 'string'
        ? departmentConfig.kilocode_token
        : undefined;
    console.log(
      `[buildAgentEnv] KILOCODE_TOKEN fallback: departmentConfig=${departmentConfig ? 'present' : 'null'} hasToken=${!!tokenFromConfig} requestEnvKeys=${Object.keys(request.envVars ?? {}).join(',')}`
    );
    if (tokenFromConfig) {
      env.KILOCODE_TOKEN = tokenFromConfig;
    }
  }

  // Build KILO_CONFIG_CONTENT so kilo serve can authenticate LLM calls.
  // Must also set OPENCODE_CONFIG_CONTENT — kilo serve checks both names.
  const kilocodeToken = env.KILOCODE_TOKEN;
  if (kilocodeToken) {
    const configJson = buildKiloConfigContent(
      kilocodeToken,
      request.model,
      request.smallModel ?? 'anthropic/claude-haiku-4.5',
      request.organizationId
    );
    env.KILO_CONFIG_CONTENT = configJson;
    env.OPENCODE_CONFIG_CONTENT = configJson;
    console.log(
      `[buildAgentEnv] KILO_CONFIG_CONTENT set (model=${request.model}, smallModel=${request.smallModel ?? '(default)'})`
    );

    // Set KILO_AUTH_CONTENT so the kilo CLI's session-ingest path can
    // authenticate. The CLI's Auth.all() reads this env var before
    // falling back to the auth.json file. Without it, session deltas
    // get "session bootstrap skipped: no client" and never reach
    // cli_sessions_v2.
    env.KILO_AUTH_CONTENT = JSON.stringify({
      kilo: { type: 'api', key: kilocodeToken },
    });
  } else {
    console.warn('[buildAgentEnv] No KILOCODE_TOKEN available — KILO_CONFIG_CONTENT not set');
  }

  // Set KILO_PLATFORM so session-ingest writes created_on_platform =
  // 'helldesk'. The /cloud/sessions page has a "HELLDESK" filter that
  // matches this value.
  env.KILO_PLATFORM = 'helldesk';

  // Set KILO_ORG_ID so session-ingest populates organization_id for
  // org-scoped filtering. Falls back to the auth file's accountId
  // inside the CLI if not set.
  if (request.organizationId) {
    env.KILO_ORG_ID = request.organizationId;
  }

  // Authenticate the gh CLI via GH_TOKEN. Prefer the user's GitHub CLI PAT
  // (which makes PRs/issues appear under their identity) over the integration
  // token (which appears as the GitHub App bot).
  const ghCliPat = resolveEnv(request, 'GITHUB_CLI_PAT');
  const ghToken =
    ghCliPat ?? resolveEnv(request, 'GIT_TOKEN') ?? resolveEnv(request, 'GITHUB_TOKEN');
  if (ghToken) {
    env.GH_TOKEN = ghToken;
  }

  // department-level env vars. The `!(key in env)` guard means infra-set vars
  // (HELLDESK_*, KILO_*, GH_TOKEN, etc.) take precedence over user config.
  if (request.envVars) {
    for (const [key, value] of Object.entries(request.envVars)) {
      if (!(key in env)) {
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Configure a git credential helper in the agent's environment so that
 * git push/fetch from the worktree can authenticate without SSH or
 * an interactive prompt. Writes credentials to /tmp (outside the worktree)
 * to prevent accidental commit of tokens.
 */
async function configureGitCredentials(
  workdir: string,
  gitUrl: string,
  envVars?: Record<string, string>
): Promise<void> {
  const token = envVars?.GIT_TOKEN ?? envVars?.GITHUB_TOKEN;
  const gitlabToken = envVars?.GITLAB_TOKEN;
  if (!token && !gitlabToken) return;

  try {
    const url = new URL(gitUrl);
    const credentialLine =
      gitlabToken && (url.hostname.includes('gitlab') || envVars?.GITLAB_INSTANCE_URL)
        ? `https://oauth2:${gitlabToken}@${url.hostname}`
        : token
          ? `https://x-access-token:${token}@${url.hostname}`
          : null;

    if (!credentialLine) return;

    // Write credentials to the durable root — outside the worktree so they
    // can't be accidentally committed by `git add .` or `git add -A`, and
    // NOT /tmp so they survive GPU crashes / Windows restarts on this box.
    const uniqueSuffix = workdir.replace(/[^a-zA-Z0-9_-]/g, '-');
    const credFile = workstationCredentialsPath(uniqueSuffix);
    await writeFile(credFile, credentialLine + '\n', { mode: 0o600 });

    // Configure the worktree to use credential-store pointing at this file
    const proc = Bun.spawn(['git', 'config', 'credential.helper', `store --file=${credFile}`], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  } catch (err) {
    console.warn('Failed to configure git credentials:', err);
  }
}

/**
 * If no GIT_TOKEN/GITLAB_TOKEN is present in envVars but a platformIntegrationId
 * is available, call the Next.js server to resolve fresh credentials.
 * Returns the (potentially enriched) envVars.
 */
export async function resolveGitCredentials(params: {
  envVars?: Record<string, string>;
  platformIntegrationId?: string;
}): Promise<Record<string, string>> {
  const envVars = { ...(params.envVars ?? {}) };
  const hasToken = !!(envVars.GIT_TOKEN || envVars.GITHUB_TOKEN || envVars.GITLAB_TOKEN);

  if (hasToken) return envVars;

  const integrationId = params.platformIntegrationId;
  const kiloToken = envVars.KILOCODE_TOKEN;
  // The Next.js server URL — in dev it's localhost:3000, in prod it's the main app URL.
  // We derive it from KILO_API_URL (the gateway URL) or fall back to localhost.
  const apiBase = process.env.KILO_CLOUD_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3000';

  if (!integrationId) {
    console.warn(
      '[resolveGitCredentialsIfMissing] No git token and no platformIntegrationId — clone will likely fail'
    );
    return envVars;
  }

  if (!kiloToken) {
    console.warn(
      '[resolveGitCredentialsIfMissing] No KILOCODE_TOKEN — cannot authenticate to credential API'
    );
    return envVars;
  }

  console.log(
    `[resolveGitCredentialsIfMissing] Fetching fresh credentials for integration=${integrationId}`
  );

  try {
    const resp = await fetch(`${apiBase}/api/helldesk/git-credentials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${kiloToken}`,
      },
      body: JSON.stringify({ platform_integration_id: integrationId }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(
        `[resolveGitCredentialsIfMissing] API returned ${resp.status}: ${text.slice(0, 200)}`
      );
      return envVars;
    }

    const rawCreds: unknown = await resp.json();
    const creds = z
      .object({
        github_token: z.string().optional(),
        gitlab_token: z.string().optional(),
        gitlab_instance_url: z.string().optional(),
      })
      .parse(rawCreds);

    if (creds.github_token) {
      envVars.GIT_TOKEN = creds.github_token;
      console.log('[resolveGitCredentialsIfMissing] Got fresh GitHub token');
    }
    if (creds.gitlab_token) {
      envVars.GITLAB_TOKEN = creds.gitlab_token;
      console.log('[resolveGitCredentialsIfMissing] Got fresh GitLab token');
    }
    if (creds.gitlab_instance_url) {
      envVars.GITLAB_INSTANCE_URL = creds.gitlab_instance_url;
    }
  } catch (err) {
    console.error('[resolveGitCredentialsIfMissing] Failed to fetch credentials:', err);
  }

  return envVars;
}

/**
 * Pre-flight check: verify git credentials can authenticate against the remote.
 * Uses `git ls-remote` which tests auth without modifying anything.
 * Logs a clear warning on failure — the agent will still start, but push will fail.
 */
async function verifyGitCredentials(
  workdir: string,
  gitUrl: string,
  envVars?: Record<string, string>
): Promise<void> {
  const hasToken = !!(envVars?.GIT_TOKEN || envVars?.GITHUB_TOKEN || envVars?.GITLAB_TOKEN);
  if (!hasToken) {
    console.warn(
      `[verifyGitCredentials] No git token found in env vars (keys: ${Object.keys(envVars ?? {}).join(', ')}). ` +
        `Push will fail. Ensure git_auth is configured in department settings.`
    );
    return;
  }

  try {
    const proc = Bun.spawn(['git', 'ls-remote', '--exit-code', '--heads', 'origin'], {
      cwd: workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(
        `[verifyGitCredentials] FAILED for ${gitUrl}: exit=${exitCode} stderr=${stderr.slice(0, 300)}`
      );
    } else {
      console.log(`[verifyGitCredentials] OK for ${gitUrl}`);
    }
  } catch (err) {
    console.warn(`[verifyGitCredentials] Error testing credentials:`, err);
  }
}

/**
 * Create a minimal git-initialized workspace for a reasoning-only agent
 * (e.g. triage) that doesn't need a real repo clone.
 * kilo serve requires a git repo in the working directory, so we init
 * a bare local repo with an empty initial commit.
 */
export function frontDeskWorkdirForDepartment(departmentId: string): string {
  return `/workspace/workstations/front-desk-${departmentId}/front-desk-workspace`;
}

async function createLightweightWorkspace(label: string, workstationId: string): Promise<string> {
  const { mkdir: mkdirAsync } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const path = await import('node:path');
  // eslint-disable-next-line no-control-regex
  if (!workstationId || /\.\.[/\\]|[/\\]\.\.|^\.\.$/.test(workstationId) || /[\x00-\x1f]/.test(workstationId)) {
    throw new Error(`Invalid workstationId for lightweight workspace: ${workstationId}`);
  }
  const dir = path.resolve('/workspace/workstations', workstationId, `${label}-workspace`);
  await mkdirAsync(dir, { recursive: true });

  if (!existsSync(`${dir}/.git`)) {
    const init = Bun.spawn(['git', 'init'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    await init.exited;
    const commit = Bun.spawn(['git', 'commit', '--allow-empty', '-m', 'init'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await commit.exited;
    console.log(`Created ${label} workspace at ${dir}`);
  }

  return dir;
}

/**
 * Create a minimal git-initialized workspace for the frontDesk agent.
 * The frontDesk doesn't need a real repo clone — it's a conversational
 * orchestrator that delegates work via tools. But kilo serve requires
 * a git repo in the working directory.
 */
async function createFrontDeskWorkspace(workstationId: string): Promise<string> {
  return createLightweightWorkspace('frontDesk', workstationId);
}

/**
 * Ensure the frontDesk workdir exists on disk for a given department, creating
 * a lightweight git-initialized workspace if needed.
 *
 * Used by `prewarmFrontDeskSDK`, which runs before `runAgent` and so cannot
 * rely on `createFrontDeskWorkspace` having been called yet — without this,
 * `ensureSDKServer` would throw `ENOENT` from `process.chdir(workdir)`
 * and the prewarm benefit would never materialize on cold containers.
 */
export async function ensureFrontDeskWorkspaceForDepartment(departmentId: string): Promise<string> {
  return createFrontDeskWorkspace(`front-desk-${departmentId}`);
}

/**
 * Write the frontDesk's system prompt to AGENTS.md in the workspace.
 *
 * kilo/opencode reads AGENTS.md from the project root for ALL sessions,
 * including built-in sub-agents (explore, general). By writing the full
 * system prompt here instead of passing it via the session.prompt API,
 * the frontDesk and all its sub-agents share the exact same instructions.
 *
 * The system prompt comes from the DepartmentDO (buildFrontDeskSystemPrompt) and
 * is the single source of truth. When it changes (helldesk updates,
 * user customization), the DepartmentDO sends the updated prompt and we
 * rewrite this file.
 */
export async function writeFrontDeskSystemPromptToAgentsMd(
  workspaceDir: string,
  systemPrompt: string
): Promise<void> {
  const { writeFile, readdir, stat } = await import('node:fs/promises');
  const path = await import('node:path');

  // Append a dynamic section listing discovered browse worktrees so
  // sub-agents know where to find workstation codebases.
  const workstationsRoot = '/workspace/workstations';
  let workstationDirs: string[] = [];
  try {
    workstationDirs = await readdir(workstationsRoot);
  } catch {
    // No workstations directory yet
  }

  const browseEntries: string[] = [];
  for (const entry of workstationDirs) {
    if (entry.startsWith('front-desk-')) continue;
    const browseDir = path.join(workstationsRoot, entry, 'browse');
    try {
      const s = await stat(browseDir);
      if (s.isDirectory()) {
        browseEntries.push(`- **${entry}**: \`${browseDir}\``);
      }
    } catch {
      // No browse worktree yet
    }
  }

  const browseSuffix =
    browseEntries.length > 0
      ? `\n\n## Discovered Browse Worktrees\n\n${browseEntries.join('\n')}`
      : '';

  await writeFile(path.join(workspaceDir, 'AGENTS.md'), systemPrompt + browseSuffix);
}

/**
 * Run the full agent startup sequence:
 * 1. Clone/fetch the workstation's git repo (or create minimal workspace for frontDesk/triage)
 * 2. Create an isolated worktree for the agent's branch
 * 3. Configure git credentials for push/fetch
 * 4. Start a kilo serve instance for the worktree (or reuse existing)
 * 5. Create a session and send the initial prompt via HTTP API
 */
export async function runAgent(originalRequest: StartAgentRequest): Promise<ManagedAgent> {
  let request = originalRequest;
  let workdir: string;
  const t0 = Date.now();

  if (request.role === 'triage' || request.lightweight) {
    // Triage/lightweight agents are pure reasoning — no code changes, no git needed.
    // Use a lightweight workspace to avoid clone failures feeding the loop.
    workdir = await createLightweightWorkspace('triage', request.workstationId);
  } else if (request.role === 'frontDesk') {
    // FrontDesk doesn't need a repo clone — just a git-initialized directory
    workdir = await createFrontDeskWorkspace(request.workstationId);

    // On fresh containers the browse worktrees won't exist yet. Set them
    // up for all known workstations before writing AGENTS.md so the frontDesk (and its
    // sub-agents) can immediately browse codebases.
    if (request.workstations?.length) {
      // Resolve credentials per-workstation since each may use a different
      // GitHub App installation (platformIntegrationId).
      const baseEnvVars = request.envVars ?? {};
      const workstationSetupResults = await Promise.allSettled(
        request.workstations.map(async workstation => {
          const envVars = await resolveGitCredentials({
            envVars: baseEnvVars,
            platformIntegrationId: workstation.platformIntegrationId,
          });
          const hasGitToken = !!(envVars.GIT_TOKEN || envVars.GITHUB_TOKEN || envVars.GITLAB_TOKEN);
          console.log(
            `[runAgent] setting up browse worktree: workstation=${workstation.workstationId} gitUrl=${workstation.gitUrl} hasGitToken=${hasGitToken}`
          );
          await setupWorkstationBrowseWorktree({
            workstationId: workstation.workstationId,
            gitUrl: workstation.gitUrl,
            defaultBranch: workstation.defaultBranch,
            envVars,
          });
          return workstation.workstationId;
        })
      );

      const failures: Array<{ workstationId: string; error: unknown }> = [];
      for (let i = 0; i < workstationSetupResults.length; i++) {
        const r = workstationSetupResults[i];
        if (r.status === 'rejected') {
          const reason: unknown = r.reason;
          failures.push({ workstationId: request.workstations[i].workstationId, error: reason });
        }
      }

      if (failures.length > 0) {
        for (const f of failures) {
          const msg = f.error instanceof Error ? f.error.message : String(f.error);
          const stack = f.error instanceof Error ? f.error.stack : undefined;
          console.error(
            `[runAgent] browse worktree setup FAILED for workstation=${f.workstationId}: ${msg}`,
            stack ? `\n${stack}` : ''
          );
        }
        console.error(
          `[runAgent] frontDesk workstation setup: ${failures.length}/${request.workstations.length} workstations failed. ` +
            `FrontDesk will start but may not be able to browse these codebases.`
        );
      }
    }

    // Write the system prompt to AGENTS.md so the frontDesk AND its built-in
    // sub-agents (explore, general) all share the same instructions.
    // The system prompt is NOT passed via the session.prompt API — AGENTS.md
    // is the sole source of truth for the frontDesk's instructions.
    if (request.systemPrompt) {
      await writeFrontDeskSystemPromptToAgentsMd(workdir, request.systemPrompt);
    }
  } else {
    // Resolve git credentials if missing. When the department config doesn't have
    // a token (common on first dispatch after workstation creation), fetch one from
    // the Next.js server using the platform_integration_id.
    const envVars = await resolveGitCredentials(request);

    // Merge resolved credentials back into the request so buildAgentEnv
    // can propagate GIT_TOKEN/GH_TOKEN to the spawned kilo serve process.
    // Without this, workstations using platformIntegrationId would clone successfully
    // but the agent session itself would lack git push / gh credentials.
    request = { ...request, envVars };

    await cloneRepo({
      workstationId: request.workstationId,
      gitUrl: request.gitUrl,
      defaultBranch: request.defaultBranch,
      envVars,
    });

    workdir = await createWorktree({
      workstationId: request.workstationId,
      branch: request.branch,
      startPoint: request.startPoint,
      defaultBranch: request.defaultBranch,
      envVars,
      gitUrl: request.gitUrl,
    });

    await configureGitCredentials(workdir, request.gitUrl, envVars);

    await verifyGitCredentials(workdir, request.gitUrl, envVars);

    log.info('agent.startup_phase', {
      agentId: request.agentId,
      phase: 'git_done',
      elapsedMs: Date.now() - t0,
    });
  }

  const env = buildAgentEnv(request);

  // For the frontDesk, the system prompt lives in AGENTS.md (written above)
  // so all sessions — including sub-agents — share it. Don't also pass
  // it via the session.prompt API to avoid duplication. Setting to
  // undefined (not '') so the SDK omits it entirely and kilo serve
  // uses its default system prompt + AGENTS.md, rather than treating
  // an empty string as an explicit override.
  const startRequest = request.role === 'frontDesk' ? { ...request, systemPrompt: undefined } : request;

  return startAgent(startRequest, workdir, env);
}
