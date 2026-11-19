/**
 * Post-process worker-configuration.d.ts after `wrangler types`.
 *
 * Wrangler emits an unparameterized `Service` for cross-worker RPC bindings
 * and cannot declare worker secrets. This script patches the generated output
 * so the rest of the codebase gets accurate types without manual edits.
 *
 * Patches applied:
 *  1. Service bindings → typed RPC surfaces
 *  2. Adds worker secrets omitted from Wrangler vars
 *  3. Widens the deployment-time billing flag for local test fixtures
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'worker-configuration.d.ts';

let src = readFileSync(FILE, 'utf8');

// 1. Replace untyped Service bindings with their RPC surfaces.
src = src.replaceAll(/GIT_TOKEN_SERVICE:\s*Service\b[^;]*/g, 'GIT_TOKEN_SERVICE: GitTokenService');
src = src.replaceAll(/HELLDESK_SERVICE:\s*Service\b[^;]*/g, 'HELLDESK_SERVICE: HelldeskService');
src = src.replaceAll(
  /CONTAINER_USAGE:\s*Service\b[^;]*/g,
  'CONTAINER_USAGE: ContainerUsageService'
);
src = src.replaceAll(
  'HELLDESK_BILLING_ENABLED: "true"',
  'HELLDESK_BILLING_ENABLED: "false" | "true"'
);
src = src.replaceAll(
  'LEGACY_ADMIN_CLAIM_MODE: "honor"',
  'LEGACY_ADMIN_CLAIM_MODE: "honor" | "observe" | "reject"'
);
src = src.replaceAll(
  'WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS: ""',
  'WORKER_ADMIN_CAPABILITY_PUBLIC_KEYS: string'
);

// 2. Add SENTRY_DSN worker secret to Cloudflare.Env (if not already present)
if (!src.includes('SENTRY_DSN')) {
  src = src.replace(
    'interface __BaseEnv_Env {',
    'interface __BaseEnv_Env {\n\tSENTRY_DSN?: string; // worker secret\n\tSENTRY_RELEASE?: string; // deploy-time --var'
  );
}

// 3. Prepend GitTokenService RPC types (before the Cloudflare namespace)
const RPC_TYPES = `\
// GIT_TOKEN_SERVICE RPC types (wrangler emits untyped \`Service\` for cross-worker bindings)
type GetTokenForRepoSuccess = {
\tsuccess: true;
\ttoken: string;
\tinstallationId: string;
\taccountLogin: string;
\tappType: 'standard' | 'lite';
};
type GetTokenForRepoFailure = {
\tsuccess: false;
\treason: 'database_not_configured' | 'invalid_repo_format' | 'no_installation_found' | 'invalid_org_id';
};
type GetTokenForRepoResult = GetTokenForRepoSuccess | GetTokenForRepoFailure;
type GitTokenService = {
\tgetTokenForRepo(params: { githubRepo: string; userId: string; orgId?: string }): Promise<GetTokenForRepoResult>;
\tgetToken(installationId: string, appType?: 'standard' | 'lite'): Promise<string>;
\tgetTokenForIntegration(params: { integrationId: string; userId: string; orgId?: string }): Promise<{ success: true; token: string } | { success: false; reason: 'unavailable' }>;
};
type HelldeskRpcSuccess<T> = { success: true; data: T };
type HelldeskRpcFailure = {
\tsuccess: false;
\tcode: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR';
\tmessage: string;
};
type HelldeskRpcResult<T> = HelldeskRpcSuccess<T> | HelldeskRpcFailure;
type HelldeskService = {
\tbrowseWantedBoard(params: {
\t\thelldeskId: string;
\t\tuserId: string;
\t\tstatus?: 'open' | 'claimed' | 'in_review' | 'completed' | 'validated' | 'withdrawn';
\t\tsearch?: string;
\t\tsort?: 'priority' | 'activity';
\t\tlimit?: number;
\t\tincludeForkBranches?: boolean;
\t}): Promise<HelldeskRpcResult<Array<Record<string, unknown>>>>;
\tclaimWantedItem(params: { helldeskId: string; userId: string; itemId: string }): Promise<HelldeskRpcResult<{ success: true; pr_url: string | null }>>;
\tpostWantedItem(params: {
\t\thelldeskId: string;
\t\tuserId: string;
\t\ttitle: string;
\t\tdescription: string;
\t\tpriority?: 'low' | 'medium' | 'high' | 'critical';
\t\ttype?: 'feature' | 'bug' | 'docs' | 'other';
\t\tpublish?: boolean;
\t}): Promise<HelldeskRpcResult<{ success: true; wantedId: string; pr_url: string | null }>>;
\tmarkWantedItemDone(params: { helldeskId: string; userId: string; itemId: string; evidence: string }): Promise<HelldeskRpcResult<{ success: true; pr_url: string | null }>>;
};
type ContainerUsageService = import("@kilocode/container-usage").ContainerUsageRpcMethods;
`;

if (!src.includes('type GitTokenService')) {
  src = src.replace('declare namespace Cloudflare', RPC_TYPES + 'declare namespace Cloudflare');
}

writeFileSync(FILE, src);
console.log('[patch-worker-types] patched', FILE);
