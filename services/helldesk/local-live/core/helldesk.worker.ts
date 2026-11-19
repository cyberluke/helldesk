/**
 * Local HELLDESK — `helldesk.worker` type shim.
 *
 * Handlers import `type { HelldeskEnv }` from `../helldesk.worker`. We export the
 * env shape the local runtime provides (DO namespaces + local dev secrets).
 * Type-only; no Cloudflare worker imports.
 */
import type { LocalEnv, LocalDoNamespaceLike } from './runtime/registry';
import type { HelldeskService } from './util/helldesk-service';

export type HelldeskEnv = LocalEnv & {
  /** Dev-only: no real JWT secret locally. */
  HELLDESK_JWT_SECRET?: string;
  ENVIRONMENT?: string | undefined;
  LEGACY_ADMIN_CLAIM_MODE?: 'honor' | 'observe' | 'reject' | undefined;
  HELLDESK_SERVICE: HelldeskService;
  department: LocalDoNamespaceLike;
  DEPARTMENT_CONTAINER: LocalDoNamespaceLike;
  AGENT: LocalDoNamespaceLike;
  AGENT_IDENTITY: LocalDoNamespaceLike;
  HELLDESK_USER: LocalDoNamespaceLike;
  HELLDESK_ORG: LocalDoNamespaceLike;
};

/**
 * Hono v4 types its bindings under `Env.Bindings`, not on the env object itself.
 * Handlers should type their context as `Context<HelldeskAppEnv>` so that
 * `c.env` is the real HelldeskEnv and `c.get('departmentId')`-style variables resolve.
 * The CF originals passed `Context<HelldeskEnv>` directly, which Hono rejects.
 */
export type HelldeskAppVariables = {
  departmentId: string;
  workstationId?: string;
  kiloUserId?: string;
  kiloIsAdmin?: boolean;
  kiloOrgMemberships?: Array<{ orgId: string; role: string }>;
};

export type HelldeskAppEnv = {
  Bindings: HelldeskEnv;
  Variables: HelldeskAppVariables & Record<string, unknown>;
};

/** Convenience factory: build a HelldeskEnv over a LocalRuntime. */
export function buildHelldeskEnv(runtime: { env: LocalEnv; dataRoot: string }): HelldeskEnv {
  return {
    ...runtime.env,
    HELLDESK_JWT_SECRET: 'local-dev-secret',
    ENVIRONMENT: 'development',
    LEGACY_ADMIN_CLAIM_MODE: 'observe',
    HELLDESK_SERVICE: {
      browseWantedBoard: async () => ({ wanted: [] }),
      claimWantedItem: async () => ({ ok: false, reason: 'helldesk disabled locally' }),
      postWantedItem: async () => ({ ok: false, reason: 'helldesk disabled locally' }),
      markWantedItemDone: async () => ({ ok: false, reason: 'helldesk disabled locally' }),
    },
  };
}

export type HelldeskServiceShim = HelldeskEnv['HELLDESK_SERVICE'];