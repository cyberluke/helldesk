/**
 * HELLDESK tRPC router — served directly by the HELLDESK worker.
 *
 * This replaces the Next.js proxy layer (src/routers/helldesk-router.ts).
 * The worker validates Kilo JWTs directly, resolves user data from
 * Hyperdrive, and calls DO methods without an HTTP intermediary.
 */
/* eslint-disable @typescript-eslint/await-thenable -- DO RPC stubs return Rpc.Promisified which is thenable at runtime */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, helldeskProcedure, helldeskFlaggedProcedure, adminProcedure } from './init';
import { getDepartmentDOStub } from '../dos/Department.do';
import { getDepartmentContainerStub } from '../dos/DepartmentContainer.do';
import { getHelldeskUserStub } from '../dos/HelldeskUser.do';
import { getHelldeskOrgStub } from '../dos/HelldeskOrg.do';
import type { JwtOrgMembership } from '../middleware/auth.middleware';
import { generateKiloApiToken } from '../util/kilo-token.util';
import { resolveSecret } from '../util/secret.util';
import { DepartmentConfigSchema, DepartmentConfigUpdateSchema, WorkstationOverrideConfigSchema } from '../types';
import { resolveModel } from '../dos/department/config';
import type { UserWorkstationRecord } from '../db/tables/user-workstations.table';
import {
  RpcDepartmentOutput,
  RpcWorkstationOutput,
  RpcTicketOutput,
  RpcAgentOutput,
  RpcTicketEventOutput,
  RpcFrontDeskSendResultOutput,
  RpcFrontDeskStatusOutput,
  RpcBillingStatusOutput,
  RpcStreamTicketOutput,
  RpcPtySessionOutput,
  RpcSlingResultOutput,
  RpcWorkstationDetailOutput,
  RpcShiftDetailOutput,
  RpcAlarmStatusOutput,
  RpcOrgDepartmentOutput,
  RpcMergeQueueDataOutput,
} from './schemas';
import type { TRPCContext } from './init';
import { emitWorkerAdminDecision } from '../middleware/worker-admin.middleware';
import { ContainerBillingError } from '../billing/ContainerBilling.error';

// rpcSafe wrapper for DepartmentConfigSchema (imported from ../types, not ./schemas)
const RpcDepartmentConfigSchema = z.any().pipe(DepartmentConfigSchema);

/** Extract 'owner/repo' from a GitHub URL, or null if not a GitHub URL. */
function extractGithubRepo(gitUrl: string): string | null {
  const m = gitUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

/** Best-effort refresh of git credentials for a department via the git-token-service. */
async function refreshGitCredentials(
  env: Env,
  departmentId: string,
  gitUrl: string,
  userId: string,
  orgId?: string
): Promise<void> {
  if (!env.GIT_TOKEN_SERVICE) return;
  const githubRepo = extractGithubRepo(gitUrl);
  if (!githubRepo) return;

  const result = await env.GIT_TOKEN_SERVICE.getTokenForRepo({ githubRepo, userId, orgId });
  if (!result.success) {
    console.warn(`[helldesk-trpc] git credential refresh failed: ${result.reason}`);
    return;
  }

  const departmentStub = getDepartmentDOStub(env, departmentId);
  await departmentStub.updateDepartmentConfig({
    git_auth: {
      github_token: result.token,
      platform_integration_id: result.installationId,
    },
  });
}

/** Extract user identity fields from the tRPC context. */
function userFromCtx(ctx: TRPCContext): { id: string; api_token_pepper: string | null } {
  return { id: ctx.userId, api_token_pepper: ctx.apiTokenPepper };
}

function mapContainerBillingError(error: unknown): TRPCError | null {
  // Only classify errors we actually own. Matching on message substrings is
  // unreliable (the fallback message itself contains "billing"), so a
  // non-billing failure could be misreported as a billing error and mask the
  // real cause. Classify strictly on the ContainerBillingError code.
  if (!(error instanceof ContainerBillingError)) return null;

  switch (error.code) {
    case 'INSUFFICIENT_CREDITS':
    case 'CONTAINER_PAUSED':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
    case 'BILLING_UNAVAILABLE':
      return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: error.message, cause: error });
    case 'ACCESS_REVOKED':
      return new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
    default:
      return null;
  }
}

/** Look up a user's membership for a specific org from the JWT claims. */
function getOrgMembership(
  memberships: JwtOrgMembership[],
  orgId: string
): JwtOrgMembership | undefined {
  return memberships.find(m => m.orgId === orgId);
}

/** List org IDs where the user has a non-billing_manager role (from JWT). */
function listAccessibleOrgIds(memberships: JwtOrgMembership[]): string[] {
  return memberships.filter(m => m.role !== 'billing_manager').map(m => m.orgId);
}

type WorkerAdminTargetInput = {
  kind: 'department' | 'user' | 'helldesk' | 'service';
  id: string;
};

async function decideWorkerAdmin(ctx: TRPCContext, target: WorkerAdminTargetInput) {
  return ctx.workerAdmin.decide(`trpc:${ctx.procedurePath}`, target);
}

function reportWorkerAdminDecision(
  ctx: TRPCContext,
  target: WorkerAdminTargetInput,
  decision: Awaited<ReturnType<typeof decideWorkerAdmin>>
): void {
  if (!ctx.workerAdmin.takeDecisionReport(`trpc:${ctx.procedurePath}`, target)) return;
  emitWorkerAdminDecision(ctx.env, decision, {
    action: `trpc:${ctx.procedurePath}`,
    userId: ctx.userId || null,
    departmentId: target.kind === 'department' ? target.id : null,
    jti: decision.allowed ? decision.jti : null,
    delivery: 'trpc',
  });
}

async function workerAdminAllows(
  ctx: TRPCContext,
  target: WorkerAdminTargetInput
): Promise<boolean> {
  const decision = await decideWorkerAdmin(ctx, target);
  reportWorkerAdminDecision(ctx, target, decision);
  if (!decision.allowed && decision.status === 503) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Admin capability validation unavailable',
    });
  }
  return decision.allowed;
}

/**
 * Common interface for the workstation/department management methods shared by
 * HelldeskUserDO and HelldeskOrgDO stubs. Used to abstract over
 * personal vs org ownership in tRPC procedures.
 */
type WorkstationOwnerStub = {
  listWorkstations(departmentId: string): Promise<UserWorkstationRecord[]>;
  createWorkstation(input: {
    department_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    platform_integration_id?: string;
  }): Promise<UserWorkstationRecord>;
  getWorkstationAsync(workstationId: string): Promise<UserWorkstationRecord | null>;
  deleteWorkstation(workstationId: string): Promise<boolean>;
  deleteDepartment(departmentId: string): Promise<boolean>;
};

type DepartmentOwnershipResult =
  | {
      type: 'user';
      stub: WorkstationOwnerStub;
      department: {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
        updated_at: string;
      };
    }
  | { type: 'org'; stub: WorkstationOwnerStub; orgId: string }
  | { type: 'admin' };

/**
 * Core ownership resolution shared by resolveWorkstationOwnerStub and verifyDepartmentOwnership.
 * Returns the owning DO stub and, for personal departments, the department record.
 *
 * Admins bypass ownership checks entirely — they can access any department for
 * support/debugging purposes. The caller is responsible for restricting
 * destructive mutations (delete, billing config) when the result type is 'admin'.
 */
async function resolveDepartmentOwnership(
  env: Env,
  ctx: TRPCContext,
  departmentId: string
): Promise<DepartmentOwnershipResult> {
  const { userId, orgMemberships: memberships } = ctx;

  // Fast path: personal department lookup
  const userStub = getHelldeskUserStub(env, userId);
  const personalDepartment = await userStub.getDepartmentAsync(departmentId);
  if (personalDepartment) {
    if (personaldepartment.owner_user_id !== userId) {
      // Admin bypass: allow access without ownership
      if (await workerAdminAllows(ctx, { kind: 'department', id: departmentId })) {
        return { type: 'admin' };
      }
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your department' });
    }
    return { type: 'user', stub: userStub, department: personalDepartment };
  }

  // Check DepartmentDO config for org ownership, verify via JWT claims
  const departmentStub = getDepartmentDOStub(env, departmentId);
  let config;
  try {
    config = await departmentStub.getDepartmentConfig();
  } catch {
    // Department config failed to load — the department is deleted or invalid.
    // Don't return admin bypass here; the department genuinely doesn't exist.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });
  }

  if (config.owner_type === 'org' && config.organization_id) {
    const membership = getOrgMembership(memberships, config.organization_id);
    if (!membership || membership.role === 'billing_manager') {
      // Admin bypass: allow access without org membership
      if (await workerAdminAllows(ctx, { kind: 'department', id: departmentId })) {
        return { type: 'admin' };
      }
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not an org member' });
    }
    return {
      type: 'org',
      stub: getHelldeskOrgStub(env, config.organization_id),
      orgId: config.organization_id,
    };
  }

  // No owner found — admins can still access the department for debugging
  if (await workerAdminAllows(ctx, { kind: 'department', id: departmentId })) {
    return { type: 'admin' };
  }
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });
}

/** Resolve the DO stub that owns workstations/departments. Verifies access via JWT claims. */
async function resolveWorkstationOwnerStub(
  env: Env,
  ctx: TRPCContext,
  departmentId: string
): Promise<WorkstationOwnerStub> {
  const result = await resolveDepartmentOwnership(env, ctx, departmentId);
  if (result.type === 'admin') {
    // Admin doesn't own the department — resolve the real owner from DepartmentDO config
    // so we can still read workstations/departments from the correct DO.
    const departmentStub = getDepartmentDOStub(env, departmentId);
    const config = await departmentStub.getDepartmentConfig();
    if (config.owner_type === 'org' && config.organization_id) {
      return getHelldeskOrgStub(env, config.organization_id);
    }
    if (config.owner_user_id) {
      return getHelldeskUserStub(env, config.owner_user_id);
    }
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Department owner not found' });
  }
  return result.stub;
}

/**
 * Verify that a user has access to a department and return a record matching
 * RpcDepartmentOutput (used by the getDepartment procedure).
 */
async function verifyDepartmentOwnership(env: Env, ctx: TRPCContext, departmentId: string) {
  const result = await resolveDepartmentOwnership(env, ctx, departmentId);
  if (result.type === 'user') return result.department;

  if (result.type === 'admin') {
    // Admin bypass: resolve department metadata from DepartmentDO config and the owner's DO
    const departmentStub = getDepartmentDOStub(env, departmentId);
    const config = await departmentStub.getDepartmentConfig();

    // Try to look up the department name from the owner's DO
    let name = departmentId;
    if (config.owner_type === 'org' && config.organization_id) {
      const orgStub = getHelldeskOrgStub(env, config.organization_id);
      const orgDepartment = await orgStub.getDepartmentAsync(departmentId);
      if (orgDepartment) name = orgDepartment.name;
    } else if (config.owner_user_id) {
      const userStub = getHelldeskUserStub(env, config.owner_user_id);
      const userDepartment = await userStub.getDepartmentAsync(departmentId);
      if (userDepartment) name = userDepartment.name;
    }

    return {
      id: departmentId,
      name,
      owner_user_id: config.owner_user_id ?? ctx.userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  // Fetch the org department record for name/timestamps
  const orgStub = getHelldeskOrgStub(env, result.orgId);
  const orgDepartment = await orgStub.getDepartmentAsync(departmentId);
  return {
    id: departmentId,
    name: orgDepartment?.name ?? departmentId,
    owner_user_id: orgDepartment?.created_by_user_id ?? ctx.userId,
    created_at: orgDepartment?.created_at ?? new Date().toISOString(),
    updated_at: orgDepartment?.updated_at ?? new Date().toISOString(),
  };
}

/**
 * Verify that a user has access to a workstation — either through their personal DO
 * or through an org that owns the workstation's department (checked via JWT claims).
 *
 * For admins viewing another user's department, pass `departmentIdHint` so the function
 * can resolve the real owner from DepartmentDO config and look up the workstation in
 * their DO.
 */
async function verifyWorkstationOwnership(env: Env, ctx: TRPCContext, workstationId: string, departmentIdHint?: string) {
  const { userId, orgMemberships: memberships } = ctx;

  // Fast path: personal workstation lookup
  const userStub = getHelldeskUserStub(env, userId);
  const personalWorkstation = await userStub.getWorkstationAsync(workstationId);
  if (personalWorkstation) return personalWorkstation;

  // Check org DOs in parallel (billing_manager excluded)
  const orgIds = listAccessibleOrgIds(memberships);
  if (orgIds.length > 0) {
    const results = await Promise.all(
      orgIds.map(orgId => getHelldeskOrgStub(env, orgId).getWorkstationAsync(workstationId))
    );
    const orgWorkstation = results.find(r => r !== null);
    if (orgWorkstation) return orgWorkstation;
  }

  // Admin bypass: resolve the real owner from DepartmentDO config so we can
  // look up the workstation in their DO.
  const adminTarget = departmentIdHint ? { kind: 'department' as const, id: departmentIdHint } : null;
  const adminDecision = adminTarget ? await decideWorkerAdmin(ctx, adminTarget) : null;
  if (adminDecision && !adminDecision.allowed && adminDecision.status === 503) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Admin capability validation unavailable',
    });
  }
  if (departmentIdHint && adminTarget && adminDecision?.allowed) {
    const departmentStub = getDepartmentDOStub(env, departmentIdHint);
    let config;
    try {
      config = await departmentStub.getDepartmentConfig();
    } catch {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });
    }

    const ownerWorkstation =
      config.owner_type === 'org' && config.organization_id
        ? await getHelldeskOrgStub(env, config.organization_id).getWorkstationAsync(workstationId)
        : config.owner_user_id
          ? await getHelldeskUserStub(env, config.owner_user_id).getWorkstationAsync(workstationId)
          : null;
    if (ownerWorkstation) {
      // The bypass names one department; a workstation from another department of the same owner
      // must not become reachable through it.
      if (ownerworkstation.department_id !== departmentIdHint) {
        reportWorkerAdminDecision(ctx, adminTarget, {
          allowed: false,
          source: adminDecision.source,
          status: 403,
          reason: 'target_mismatch',
        });
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Workstation not found' });
      }
      reportWorkerAdminDecision(ctx, adminTarget, adminDecision);
      return ownerWorkstation;
    }
  }

  if (adminTarget && adminDecision && !adminDecision.allowed) {
    reportWorkerAdminDecision(ctx, adminTarget, adminDecision);
  }

  throw new TRPCError({ code: 'NOT_FOUND', message: 'Workstation not found' });
}

async function mintKilocodeToken(env: Env, user: { id: string; api_token_pepper: string | null }) {
  if (!env.NEXTAUTH_SECRET) {
    console.error('[mintKilocodeToken] NEXTAUTH_SECRET not configured');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  }
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) {
    console.error('[mintKilocodeToken] failed to resolve NEXTAUTH_SECRET from Secrets Store');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  }
  return generateKiloApiToken(user, secret);
}

export const helldeskRouter = router({
  createDepartment: helldeskFlaggedProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .output(RpcDepartmentOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const userStub = getHelldeskUserStub(ctx.env, user.id);
      const department = await userStub.createDepartment({ name: input.name, owner_user_id: user.id });

      // Store kilocode token so agents can auth with the Kilo LLM gateway
      const kilocodeToken = await mintKilocodeToken(ctx.env, user);
      const departmentStub = getDepartmentDOStub(ctx.env, department.id);
      await departmentStub.setDepartmentId(department.id);
      await departmentStub.updateDepartmentConfig({
        kilocode_token: kilocodeToken,
        owner_user_id: user.id,
      });

      return department;
    }),

  listDepartments: helldeskProcedure.output(z.array(RpcDepartmentOutput)).query(async ({ ctx }) => {
    const userStub = getHelldeskUserStub(ctx.env, ctx.userId);
    return userStub.listDepartments();
  }),

  getDepartment: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcDepartmentOutput)
    .query(async ({ ctx, input }) => {
      return verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
    }),

  getDrainStatus: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(z.object({ draining: z.boolean(), drainStartedAt: z.string().nullable() }))
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const department = getDepartmentDOStub(ctx.env, input.departmentId);
      const [draining, startedAt] = await Promise.all([
        department.isDraining() as Promise<boolean>,
        department.getDrainStartedAt() as Promise<number | null>,
      ]);
      return {
        draining,
        drainStartedAt: startedAt ? new Date(startedAt).toISOString() : null,
      };
    }),

  /**
   * Check whether the current user is an admin viewing a department they don't own.
   * Used by the frontend to show an admin banner.
   */
  checkAdminAccess: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(
      z.object({
        isAdminViewing: z.boolean(),
        ownerUserId: z.string().nullable(),
        ownerOrgId: z.string().nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        // Admin is viewing a department they don't own — resolve the real owner
        const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
        const config = await departmentStub.getDepartmentConfig();
        return {
          isAdminViewing: true,
          ownerUserId: config.owner_user_id ?? null,
          ownerOrgId: config.organization_id ?? null,
        };
      }
      return { isAdminViewing: false, ownerUserId: null, ownerOrgId: null };
    }),

  deleteDepartment: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only org owners can delete departments' });
        }
      }
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot delete departments they do not own',
        });
      }
      const ownerStub = ownership.stub;

      // Destroy the Department DO (agents, container, alarms, storage).
      // Let failures propagate — if cleanup fails, don't delete the
      // user record (that's the only reference for recovering the
      // leaked resources).
      const departmentDOStub = getDepartmentDOStub(ctx.env, input.departmentId);
      await departmentDOStub.destroy();

      await ownerStub.deleteDepartment(input.departmentId);
    }),

  createWorkstation: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
        platformIntegrationId: z.string().uuid().optional(),
      })
    )
    .output(RpcWorkstationOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot create workstations on departments they do not own',
        });
      }
      const ownerStub = ownership.stub;

      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);

      // For org departments, use the department owner's identity for credentials;
      // for personal departments the caller is always the owner.
      const departmentConfig = await departmentStub.getDepartmentConfig();
      const credentialUserId = departmentConfig.owner_user_id ?? user.id;

      // Only re-mint kilocode token if the caller is the owner (they
      // have their own api_token_pepper in ctx). For org departments where
      // a non-owner member adds a workstation, keep the existing department token.
      let kilocodeToken: string | undefined;
      if (credentialUserId === user.id) {
        kilocodeToken = await mintKilocodeToken(ctx.env, user);
        await departmentStub.updateDepartmentConfig({ kilocode_token: kilocodeToken });
      }

      // Resolve git credentials using the department owner's identity
      try {
        await refreshGitCredentials(
          ctx.env,
          input.departmentId,
          input.gitUrl,
          credentialUserId,
          departmentConfig.organization_id
        );
      } catch (err) {
        console.warn('[helldesk-trpc] createWorkstation: git credential refresh failed', err);
      }

      const workstation = await ownerStub.createWorkstation({
        department_id: input.departmentId,
        name: input.name,
        git_url: input.gitUrl,
        default_branch: input.defaultBranch,
        platform_integration_id: input.platformIntegrationId,
      });

      // Configure the Department DO with workstation metadata so dispatchAgent can find it.
      // If this fails, roll back the workstation creation to avoid an orphaned record.
      try {
        await departmentStub.configureWorkstation({
          workstationId: workstation.id,
          departmentId: input.departmentId,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
          userId: credentialUserId,
          kilocodeToken,
          platformIntegrationId: input.platformIntegrationId,
        });
        await departmentStub.addWorkstation({
          workstationId: workstation.id,
          name: input.name,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
        });
      } catch (err) {
        console.error(
          `[helldesk-trpc] createWorkstation: Department DO configure FAILED for workstation ${workstation.id}, rolling back:`,
          err
        );
        try {
          await ownerStub.deleteWorkstation(workstation.id);
        } catch {
          /* best effort rollback */
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to configure workstation' });
      }

      return workstation;
    }),

  listWorkstations: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(z.array(RpcWorkstationOutput))
    .query(async ({ ctx, input }) => {
      const ownerStub = await resolveWorkstationOwnerStub(ctx.env, ctx, input.departmentId);
      return ownerStub.listWorkstations(input.departmentId);
    }),

  getWorkstation: helldeskProcedure
    .input(z.object({ workstationId: z.string().uuid(), departmentId: z.string().uuid().optional() }))
    .output(RpcWorkstationDetailOutput)
    .query(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      // Sequential to avoid "excessively deep" type inference with Rpc.Promisified DO stubs.
      const agentList = await departmentStub.listAgents({ workstation_id: workstation.id });
      const ticketList = await departmentStub.listTickets({ workstation_id: workstation.id, status: 'in_progress' });
      const departmentWorkstation = await departmentStub.getWorkstationAsync(workstation.id);
      return { ...workstation, agents: agentList, tickets: ticketList, config: departmentWorkstation?.config };
    }),

  deleteWorkstation: helldeskProcedure
    .input(z.object({ workstationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId);
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, workstation.department_id);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot delete workstations on departments they do not own',
        });
      }
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only org owners can delete workstations' });
        }
      }
      // Remove from Department DO first so the name is freed before the owner
      // record is deleted. If this fails the owner record is still intact
      // and the user can retry.
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      await departmentStub.removeWorkstation(input.workstationId);
      const ownerStub = ownership.stub;
      await ownerStub.deleteWorkstation(input.workstationId);
    }),

  updateWorkstationConfig: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid().optional(),
        workstationId: z.string().uuid(),
        config: WorkstationOverrideConfigSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, workstation.department_id);

      // Admins cannot modify workstation config for departments they do not own
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot modify workstation configuration for workstations they do not own',
        });
      }

      // For org departments, only owners or the department creator can update workstation config
      if (ownership.type === 'org') {
        const departmentStubForCheck = getDepartmentDOStub(ctx.env, workstation.department_id);
        const departmentConfig = await departmentStubForCheck.getDepartmentConfig();
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === departmentConfig.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only department creators and org owners can update workstation config',
          });
        }
      }

      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      await departmentStub.updateWorkstationConfig(input.workstationId, input.config);
      const updatedWorkstation = await departmentStub.getWorkstationAsync(input.workstationId);
      return updatedWorkstation;
    }),

  listTickets: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
        status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']).optional(),
      })
    )
    .output(z.array(RpcTicketOutput))
    .query(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      return departmentStub.listTickets({ workstation_id: workstation.id, status: input.status });
    }),

  deleteTicket: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        ticketId: z.union([z.string().uuid(), z.array(z.string().uuid())]),
        departmentId: z.string().uuid().optional(),
      })
    )
    .output(z.object({ deleted: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      const ids = Array.isArray(input.ticketId) ? input.ticketId : [input.ticketId];
      // Pass input.workstationId so the DO filters to tickets that actually belong
      // to this workstation — prevents cross-workstation deletion when the caller has only
      // authorized one workstation.
      if (ids.length === 1) {
        const deleted = await departmentStub.deleteTicket(ids[0], input.workstationId);
        return { deleted: deleted ? 1 : 0 };
      }
      const count = await departmentStub.deleteTickets(ids, input.workstationId);
      return { deleted: count };
    }),

  updateTicket: helldeskProcedure
    .input(
      z
        .object({
          workstationId: z.string().uuid(),
          ticketId: z.string().uuid(),
          departmentId: z.string().uuid().optional(),
          title: z.string().min(1).optional(),
          body: z.string().nullable().optional(),
          status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']).optional(),
          priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          labels: z.array(z.string()).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          workstation_id: z.string().min(1).nullable().optional(),
          parent_ticket_id: z.string().min(1).nullable().optional(),
          depends_on: z.array(z.string().uuid()).optional(),
        })
        .refine(
          data =>
            data.title !== undefined ||
            data.body !== undefined ||
            data.status !== undefined ||
            data.priority !== undefined ||
            data.labels !== undefined ||
            data.metadata !== undefined ||
            data.workstation_id !== undefined ||
            data.parent_ticket_id !== undefined ||
            data.depends_on !== undefined,
          { message: 'At least one field to update must be provided' }
        )
    )
    .output(RpcTicketOutput)
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);

      const existing = await departmentStub.getTicketAsync(input.ticketId);
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found' });
      }
      if (existing.workstation_id !== input.workstationId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Ticket does not belong to this workstation' });
      }

      const { workstationId: _workstationId, ticketId, departmentId: _departmentId, ...fields } = input;
      return departmentStub.updateTicket(ticketId, fields, ctx.userId);
    }),

  shiftAddTicket: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        shiftId: z.string().uuid(),
        ticketId: z.string().uuid(),
        depends_on: z.array(z.string().uuid()).optional(),
      })
    )
    .output(z.object({ total_tickets: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.shiftAddTicket(input.shiftId, input.ticketId, input.depends_on);
    }),

  shiftRemoveTicket: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        shiftId: z.string().uuid(),
        ticketId: z.string().uuid(),
      })
    )
    .output(z.object({ total_tickets: z.number() }))
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.shiftRemoveTicket(input.shiftId, input.ticketId);
    }),

  deleteTicketsByStatus: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
        type: z
          .enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent'])
          .optional(),
        departmentId: z.string().uuid().optional(),
      })
    )
    .output(z.object({ deleted: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      const count = await departmentStub.deleteTicketsByStatus(input.status, input.type, workstation.id);
      return { deleted: count };
    }),

  listAgents: helldeskProcedure
    .input(z.object({ workstationId: z.string().uuid(), departmentId: z.string().uuid().optional() }))
    .output(z.array(RpcAgentOutput))
    .query(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      return departmentStub.listAgents({ workstation_id: workstation.id });
    }),

  deleteAgent: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        agentId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      await departmentStub.deleteAgent(input.agentId);
    }),

  resetAgentDispatchAttempts: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        agentId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      await departmentStub.resetAgentDispatchAttempts(input.agentId, workstation.id);
    }),

  sling: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        title: z.string().min(1),
        body: z.string().optional(),
        model: z.string().default('kilo/kilo-auto/frontier'),
        labels: z.array(z.string()).optional(),
      })
    )
    .output(RpcSlingResultOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId);

      // Best-effort: refresh git credentials using the department owner's identity
      const departmentConfig = await getDepartmentDOStub(ctx.env, workstation.department_id).getDepartmentConfig();
      const credentialUserId = departmentConfig.owner_user_id ?? user.id;
      try {
        await refreshGitCredentials(
          ctx.env,
          workstation.department_id,
          workstation.git_url,
          credentialUserId,
          departmentConfig.organization_id
        );
      } catch (err) {
        console.warn('[helldesk-trpc] sling: git credential refresh failed', err);
      }

      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      return departmentStub.slingTicket({
        workstationId: workstation.id,
        title: input.title,
        body: input.body,
        labels: input.labels,
        metadata: { model: input.model, slung_by: user.id },
      });
    }),

  createTicket: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        title: z.string().min(1),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        startImmediately: z.boolean().default(false),
        departmentId: z.string().uuid().optional(),
      })
    )
    .output(RpcTicketOutput)
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);

      const labels = input.startImmediately
        ? (input.labels ?? [])
        : ['gt:held', ...(input.labels ?? [])];

      const ticket = await departmentStub.createHeldTicket({
        workstationId: workstation.id,
        title: input.title,
        body: input.body,
        labels,
      });

      if (input.startImmediately) {
        // Return the post-start ticket so callers see the removed gt:held label
        // and any status changes from dispatch.
        return departmentStub.startHeldTicket(ticket.ticket_id, workstation.id);
      }

      // FrontDesk notification can start a container — use waitUntil so the Worker
      // stays alive until the RPC completes without blocking the HTTP response.
      ctx.executionCtx.waitUntil(
        departmentStub
          .notifyFrontDeskOfNewTicket(ticket.ticket_id, workstation.id, input.title, input.body)
          .catch(err => console.warn('[helldesk-trpc] createTicket: frontDesk notification failed', err))
      );

      return ticket;
    }),

  startTicket: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        ticketId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
      })
    )
    .output(RpcTicketOutput)
    .mutation(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      return departmentStub.startHeldTicket(input.ticketId, workstation.id);
    }),

  enrichTicket: helldeskProcedure
    .input(
      z.object({
        body: z.string().min(10),
        departmentId: z.string().uuid(),
      })
    )
    .output(
      z
        .object({
          title: z.string(),
          labels: z.array(z.string()),
        })
        .nullable()
    )
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);

      const result = await ctx.env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        prompt: `You are a software project assistant. Given this task description, suggest a concise title (max 8 words) and 1-3 relevant labels from: [bug, feature, refactor, docs, test, chore, performance, security, ui, backend, infrastructure].\n\nTask description:\n${input.body}\n\nRespond with JSON only: { "title": "...", "labels": ["..."] }`,
        max_tokens: 100,
      });

      const responseValue =
        result && typeof result === 'object' && 'response' in result
          ? (result as Record<'response', unknown>).response
          : undefined;
      const responseText = typeof responseValue === 'string' ? responseValue : null;

      if (!responseText) return null;

      try {
        // Strip markdown code fences if present
        const cleaned = responseText
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```\s*$/, '')
          .trim();
        const parsed = JSON.parse(cleaned) as unknown;
        const schema = z.object({
          title: z.string(),
          labels: z.array(z.string()),
        });
        return schema.parse(parsed);
      } catch {
        return null;
      }
    }),

  sendMessage: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        message: z.string().min(1),
        model: z.string().default('anthropic/claude-sonnet-4.6'),
        workstationId: z.string().uuid().optional(),
        uiContext: z.string().max(10_000).optional(),
      })
    )
    .output(RpcFrontDeskSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);

      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      try {
        return await departmentStub.sendFrontDeskMessage(
          input.message,
          input.model,
          input.uiContext,
          ctx.userId
        );
      } catch (error) {
        throw mapContainerBillingError(error) ?? error;
      }
    }),

  getFrontDeskStatus: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcFrontDeskStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getFrontDeskStatus();
    }),

  getAlarmStatus: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcAlarmStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getAlarmStatus();
    }),

  getBillingStatus: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcBillingStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      return getDepartmentDOStub(ctx.env, input.departmentId).getBillingStatus();
    }),

  setContainerRunPolicy: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        policy: z.enum(['automatic', 'paused_by_user']),
      })
    )
    .output(RpcBillingStatusOutput)
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot pause containers for departments they do not own',
        });
      }

      const department = getDepartmentDOStub(ctx.env, input.departmentId);
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const departmentConfig = await department.getDepartmentConfig();
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === departmentConfig.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only department creators and org owners can change automatic starts',
          });
        }
      }

      return department.setContainerRunPolicy(input.policy);
    }),

  ensureFrontDesk: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcFrontDeskSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      const ownerStub = await resolveWorkstationOwnerStub(ctx.env, ctx, input.departmentId);

      // Best-effort: refresh git credentials using the department owner's identity
      const departmentConfig = await getDepartmentDOStub(ctx.env, input.departmentId).getDepartmentConfig();
      const credentialUserId = departmentConfig.owner_user_id ?? ctx.userId;
      try {
        const workstationList = await ownerStub.listWorkstations(input.departmentId);
        for (const workstation of workstationList) {
          if (extractGithubRepo(workstation.git_url)) {
            await refreshGitCredentials(
              ctx.env,
              input.departmentId,
              workstation.git_url,
              credentialUserId,
              departmentConfig.organization_id
            );
            break;
          }
        }
      } catch (err) {
        console.warn('[helldesk-trpc] ensureFrontDesk: git credential refresh failed', err);
      }

      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      try {
        return await departmentStub.ensureFrontDesk(ctx.userId);
      } catch (error) {
        throw mapContainerBillingError(error) ?? error;
      }
    }),

  getAgentStreamUrl: helldeskProcedure
    .input(z.object({ agentId: z.string().uuid(), departmentId: z.string().uuid() }))
    .output(RpcStreamTicketOutput)
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);

      // Proxy to container control server to get a stream ticket
      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      const response = await containerStub.fetch(
        `http://container/agents/${input.agentId}/stream-ticket`,
        { method: 'POST' }
      );
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
      const raw: unknown = await response.json();
      const ticketData = z.object({ ticket: z.string() }).parse(raw);

      // Return a relative path — the frontend constructs the full WS URL
      // using its known HELLDESK_URL (avoids Docker-internal vs browser URL mismatch).
      const url = `/api/departments/${input.departmentId}/container/agents/${input.agentId}/stream`;

      return { url, ticket: ticketData.ticket };
    }),

  createPtySession: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid(), agentId: z.string().uuid() }))
    .output(RpcPtySessionOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);

      // Proxy to container control server to create a PTY session
      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      const response = await containerStub.fetch(`http://container/agents/${input.agentId}/pty`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
      const pty: unknown = await response.json();
      const ptyData = z.object({ id: z.string() }).passthrough().parse(pty);

      // Return a relative path — the frontend constructs the full WS URL
      // using its known HELLDESK_URL (avoids Docker-internal vs browser URL mismatch).
      const wsUrl = `/api/departments/${input.departmentId}/container/agents/${input.agentId}/pty/${ptyData.id}/connect`;

      return { pty: ptyData, wsUrl };
    }),

  resizePtySession: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        agentId: z.string().uuid(),
        ptyId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid ptyId'),
        cols: z.number().int().min(1).max(500),
        rows: z.number().int().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);

      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      const response = await containerStub.fetch(
        `http://container/agents/${input.agentId}/pty/${input.ptyId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ size: { cols: input.cols, rows: input.rows } }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
    }),

  getDepartmentConfig: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcDepartmentConfigSchema)
    .query(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      const config = await departmentStub.getDepartmentConfig();

      // Admins see masked secrets (read-only access, no secret exposure)
      if (ownership.type === 'admin') {
        const mask = (s?: string) => (s ? '****' + s.slice(-4) : undefined);
        return {
          ...config,
          kilocode_token: mask(config.kilocode_token),
          github_cli_pat: mask(config.github_cli_pat),
          git_auth: {
            ...config.git_auth,
            github_token: mask(config.git_auth?.github_token),
            gitlab_token: mask(config.git_auth?.gitlab_token),
          },
          env_vars: Object.fromEntries(
            Object.entries(config.env_vars).map(([k, v]) => [k, '****' + v.slice(-4)])
          ),
        };
      }

      // Mask secrets for non-owner, non-creator org members
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === config.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          const mask = (s?: string) => (s ? '****' + s.slice(-4) : undefined);
          return {
            ...config,
            kilocode_token: mask(config.kilocode_token),
            github_cli_pat: mask(config.github_cli_pat),
            git_auth: {
              ...config.git_auth,
              github_token: mask(config.git_auth?.github_token),
              gitlab_token: mask(config.git_auth?.gitlab_token),
            },
            env_vars: Object.fromEntries(
              Object.entries(config.env_vars).map(([k, v]) => [k, '****' + v.slice(-4)])
            ),
          };
        }
      }

      return config;
    }),

  updateDepartmentConfig: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        config: DepartmentConfigUpdateSchema,
      })
    )
    .output(RpcDepartmentConfigSchema)
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);

      // Admins cannot modify department config via this endpoint (read-only access)
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot modify department configuration for departments they do not own',
        });
      }

      // Strip ownership fields — only the system (createDepartment flows) should set these
      const {
        owner_user_id: _a,
        owner_type: _b,
        owner_id: _c,
        organization_id: _d,
        created_by_user_id: _e,
        ...safeConfig
      } = input.config;

      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      const existingConfig = await departmentStub.getDepartmentConfig();

      // For org departments, only owners or the department creator can update config
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === existingConfig.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only department creators and org owners can update department config',
          });
        }
      }
      const result = await departmentStub.updateDepartmentConfig(safeConfig);

      // Push updated env vars to the running container so changes
      // take effect without a container restart
      try {
        await departmentStub.syncConfigToContainer();
      } catch (err) {
        console.warn('[helldesk-trpc] updateDepartmentConfig: syncConfigToContainer failed:', err);
      }

      // Rewrite the frontDesk's AGENTS.md when custom instructions change so the
      // running frontDesk picks them up on its next session restart.
      const frontDeskInstructionsChanged =
        result.custom_instructions?.frontDesk !== existingConfig.custom_instructions?.frontDesk;
      if (frontDeskInstructionsChanged) {
        try {
          await departmentStub.updateFrontDeskSystemPrompt();
        } catch (err) {
          console.warn('[helldesk-trpc] updateDepartmentConfig: updateFrontDeskSystemPrompt failed:', err);
        }
      }

      // Hot-update the running frontDesk session when the effective model or
      // auth-relevant config changed. The SDK server is a child process
      // that captures env at spawn time, so it must be restarted to pick
      // up rotated tokens or cleared credentials.
      const oldFrontDeskModel = resolveModel(existingConfig, null, 'frontDesk');
      const newFrontDeskModel = resolveModel(result, null, 'frontDesk');
      const frontDeskModelChanged =
        newFrontDeskModel !== oldFrontDeskModel || result.small_model !== existingConfig.small_model;
      const authConfigChanged =
        result.github_cli_pat !== existingConfig.github_cli_pat ||
        result.git_auth?.github_token !== existingConfig.git_auth?.github_token ||
        result.git_auth?.gitlab_token !== existingConfig.git_auth?.gitlab_token ||
        result.git_auth?.gitlab_instance_url !== existingConfig.git_auth?.gitlab_instance_url;
      if (frontDeskModelChanged || authConfigChanged) {
        try {
          await departmentStub.updateFrontDeskModel(newFrontDeskModel, result.small_model ?? undefined);
        } catch (err) {
          console.warn('[helldesk-trpc] updateDepartmentConfig: updateFrontDeskModel failed:', err);
        }
      }

      return result;
    }),

  refreshContainerToken: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot refresh container tokens for departments they do not own',
        });
      }
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      await departmentStub.forceRefreshContainerToken();

      // Also remint and push KILOCODE_TOKEN — this is what actually
      // authenticates GT tool calls and is the main reason users hit 401s.
      // For personal departments the caller IS the owner; for org departments we must
      // use the department owner's identity (not the caller's) so that
      // git-credentials and other owner-scoped APIs continue to work.
      let tokenUser: { id: string; api_token_pepper: string | null };
      if (ownership.type === 'user') {
        tokenUser = userFromCtx(ctx);
      } else {
        // Org department: resolve the owner from the department config
        const config = await departmentStub.getDepartmentConfig();
        const ownerId = config.owner_user_id ?? config.created_by_user_id;
        if (ownerId && ownerId === ctx.userId) {
          // Caller happens to be the owner — use their live context
          tokenUser = userFromCtx(ctx);
        } else if (ownerId) {
          // Different org member — look up the owner's pepper from the DB
          if (!ctx.env.HYPERDRIVE) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'HYPERDRIVE binding not configured — cannot resolve department owner',
            });
          }
          const { findUserById } = await import('../util/user-db.util');
          const ownerUser = await findUserById(ctx.env.HYPERDRIVE.connectionString, ownerId);
          if (!ownerUser) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Department owner not found — cannot refresh KILOCODE_TOKEN',
            });
          }
          tokenUser = { id: ownerUser.id, api_token_pepper: ownerUser.api_token_pepper };
        } else {
          // No owner recorded — fall back to caller
          tokenUser = userFromCtx(ctx);
        }
      }
      const newKilocodeToken = await mintKilocodeToken(ctx.env, tokenUser);
      await departmentStub.updateDepartmentConfig({ kilocode_token: newKilocodeToken });
      await departmentStub.syncConfigToContainer();
    }),

  forceRestartContainer: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot restart containers for departments they do not own',
        });
      }
      if (ownership.type === 'org') {
        const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
        const config = await departmentStub.getDepartmentConfig();
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === config.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only department creators and org owners can restart containers',
          });
        }
      }
      // stop() sends SIGTERM so the container's drain handler can run
      // drainAll() — nudging agents to commit/push WIP before exiting.
      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      await containerStub.stop();
    }),

  destroyContainer: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot destroy containers for departments they do not own',
        });
      }
      if (ownership.type === 'org') {
        const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
        const config = await departmentStub.getDepartmentConfig();
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        const isOrgOwner = membership?.role === 'owner';
        const isDepartmentCreator = ctx.userId === config.created_by_user_id;
        if (!isOrgOwner && !isDepartmentCreator) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only department creators and org owners can destroy containers',
          });
        }
      }
      // destroy() sends SIGKILL — the container dies immediately with
      // no graceful drain. Use when the container is stuck or unresponsive.
      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      await containerStub.destroy();
    }),

  getTicketEvents: helldeskProcedure
    .input(
      z.object({
        workstationId: z.string().uuid(),
        departmentId: z.string().uuid().optional(),
        ticketId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcTicketEventOutput))
    .query(async ({ ctx, input }) => {
      const workstation = await verifyWorkstationOwnership(ctx.env, ctx, input.workstationId, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, workstation.department_id);
      return departmentStub.listTicketEvents({
        ticketId: input.ticketId,
        since: input.since,
        limit: input.limit,
      });
    }),

  getDepartmentEvents: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcTicketEventOutput))
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.listTicketEvents({
        since: input.since,
        limit: input.limit,
      });
    }),

  getMergeQueueData: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        workstationId: z.string().uuid().optional(),
        limit: z.number().int().positive().max(500).default(50),
        since: z.string().optional(),
      })
    )
    .output(RpcMergeQueueDataOutput)
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getMergeQueueData({
        workstationId: input.workstationId,
        limit: input.limit,
        since: input.since,
      });
    }),

  listShifts: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
      })
    )
    .output(z.array(RpcShiftDetailOutput))
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.listShiftsDetailed();
    }),

  getShift: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        shiftId: z.string().uuid(),
      })
    )
    .output(RpcShiftDetailOutput.nullable())
    .query(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getShiftStatus(input.shiftId);
    }),

  closeShift: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        shiftId: z.string().uuid(),
      })
    )
    .output(RpcShiftDetailOutput.nullable())
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      const shift = await departmentStub.closeShift(input.shiftId);
      if (!shift) return null;
      const status = await departmentStub.getShiftStatus(input.shiftId);
      return status ?? { ...shift, tickets: [] };
    }),

  startShift: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        shiftId: z.string().uuid(),
      })
    )
    .output(RpcShiftDetailOutput.nullable())
    .mutation(async ({ ctx, input }) => {
      await verifyDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      await departmentStub.startShift(input.shiftId);
      const status = await departmentStub.getShiftStatus(input.shiftId);
      return status ?? null;
    }),

  listOrgDepartments: helldeskProcedure
    .input(z.object({ organizationId: z.string().uuid() }))
    .output(z.array(RpcOrgDepartmentOutput))
    .query(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getHelldeskOrgStub(ctx.env, input.organizationId);
      return stub.listDepartments();
    }),

  createOrgDepartment: helldeskFlaggedProcedure
    .input(z.object({ organizationId: z.string().uuid(), name: z.string().min(1).max(64) }))
    .output(RpcOrgDepartmentOutput)
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });

      const stub = getHelldeskOrgStub(ctx.env, input.organizationId);
      const department = await stub.createDepartment({
        name: input.name,
        owner_org_id: input.organizationId,
        created_by_user_id: ctx.userId,
      });

      // Mint kilocode token so the frontDesk can start without waiting for workstation creation
      const user = userFromCtx(ctx);
      const kilocodeToken = await mintKilocodeToken(ctx.env, user);

      const departmentStub = getDepartmentDOStub(ctx.env, department.id);
      await departmentStub.setDepartmentId(department.id);
      await departmentStub.updateDepartmentConfig({
        kilocode_token: kilocodeToken,
        owner_type: 'org',
        owner_id: input.organizationId,
        owner_user_id: ctx.userId,
        organization_id: input.organizationId,
        created_by_user_id: ctx.userId,
      });

      return department;
    }),

  deleteOrgDepartment: helldeskProcedure
    .input(z.object({ organizationId: z.string().uuid(), departmentId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getHelldeskOrgStub(ctx.env, input.organizationId);
      const department = await stub.getDepartmentAsync(input.departmentId);
      if (!department) throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });

      // Destroy the Department DO (handles all workstations, agents, and frontDesk cleanup)
      try {
        const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
        await departmentStub.destroy();
      } catch (err) {
        console.error(
          `[helldesk-trpc] deleteOrgDepartment: failed to destroy Department DO for ${input.departmentId}:`,
          err
        );
      }

      await stub.deleteDepartment(input.departmentId);
    }),

  listOrgWorkstations: helldeskProcedure
    .input(z.object({ organizationId: z.string().uuid(), departmentId: z.string().uuid() }))
    .output(z.array(RpcWorkstationOutput))
    .query(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getHelldeskOrgStub(ctx.env, input.organizationId);
      const department = await stub.getDepartmentAsync(input.departmentId);
      if (!department) throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });
      return stub.listWorkstations(input.departmentId);
    }),

  createOrgWorkstation: helldeskProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        departmentId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
        platformIntegrationId: z.string().uuid().optional(),
      })
    )
    .output(RpcWorkstationOutput)
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });

      const orgStub = getHelldeskOrgStub(ctx.env, input.organizationId);
      const department = await orgStub.getDepartmentAsync(input.departmentId);
      if (!department) throw new TRPCError({ code: 'NOT_FOUND', message: 'Department not found' });

      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      // Use the department owner's identity for credentials. Only re-mint the
      // kilocode token if the caller is the owner (they have their pepper
      // in ctx). For non-owner members, keep the existing department token.
      const departmentConfig = await departmentStub.getDepartmentConfig();
      const credentialUserId = departmentConfig.owner_user_id ?? ctx.userId;
      let kilocodeToken: string | undefined;
      if (credentialUserId === ctx.userId) {
        kilocodeToken = await mintKilocodeToken(ctx.env, userFromCtx(ctx));
        await departmentStub.updateDepartmentConfig({ kilocode_token: kilocodeToken });
      }

      // Resolve git credentials using the department owner's identity
      try {
        await refreshGitCredentials(
          ctx.env,
          input.departmentId,
          input.gitUrl,
          credentialUserId,
          departmentConfig.organization_id
        );
      } catch (err) {
        console.warn('[helldesk-trpc] createOrgWorkstation: git credential refresh failed', err);
      }

      const workstation = await orgStub.createWorkstation({
        department_id: input.departmentId,
        name: input.name,
        git_url: input.gitUrl,
        default_branch: input.defaultBranch,
        platform_integration_id: input.platformIntegrationId,
      });

      try {
        await departmentStub.configureWorkstation({
          workstationId: workstation.id,
          departmentId: input.departmentId,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
          userId: credentialUserId,
          kilocodeToken,
          platformIntegrationId: input.platformIntegrationId,
        });
        await departmentStub.addWorkstation({
          workstationId: workstation.id,
          name: input.name,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
        });
      } catch (err) {
        console.error(
          `[helldesk-trpc] createOrgWorkstation: Department DO configure FAILED for workstation ${workstation.id}, rolling back:`,
          err
        );
        try {
          await orgStub.deleteWorkstation(workstation.id);
        } catch {
          /* best effort rollback */
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to configure workstation' });
      }

      return workstation;
    }),

  getDepartmentHelldeskConnection: helldeskProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(
      z
        .object({
          connection_id: z.string(),
          helldesk_id: z.string(),
          upstream: z.string(),
          workstation_handle: z.string(),
          dolthub_org: z.string(),
          connected_at: z.string(),
          status: z.enum(['active', 'disconnecting']),
        })
        .nullable()
    )
    .query(async ({ ctx, input }) => {
      await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getHelldeskConnection();
    }),

  connectDepartmentToHELLDESK: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        helldeskId: z.string().uuid(),
        upstream: z.string().min(1),
        workstationHandle: z.string().min(1),
        dolthubOrg: z.string().min(1),
      })
    )
    .output(
      z.object({
        connection_id: z.string(),
        helldesk_id: z.string(),
        upstream: z.string(),
        workstation_handle: z.string(),
        dolthub_org: z.string(),
        connected_at: z.string(),
        status: z.enum(['active', 'disconnecting']),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot connect helldesks on departments they do not own',
        });
      }
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.connectHELLDESK({
        connectionId: crypto.randomUUID(),
        helldeskId: input.helldeskId,
        upstream: input.upstream,
        workstationHandle: input.workstationHandle,
        dolthubOrg: input.dolthubOrg,
      });
    }),

  disconnectDepartmentFromHELLDESK: helldeskProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        helldeskId: z.string().uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveDepartmentOwnership(ctx.env, ctx, input.departmentId);
      if (ownership.type === 'admin') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admins cannot disconnect helldesks on departments they do not own',
        });
      }
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      await departmentStub.disconnectHELLDESK(input.helldeskId);
      return { success: true };
    }),

  adminListTickets: adminProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'failed']).optional(),
        type: z
          .enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent'])
          .optional(),
        limit: z.number().int().positive().max(500).default(200),
      })
    )
    .output(z.array(RpcTicketOutput))
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.listTickets({
        status: input.status,
        type: input.type,
        limit: input.limit,
      });
    }),

  adminListAgents: adminProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(z.array(RpcAgentOutput))
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.listAgents({});
    }),

  adminForceRestartContainer: adminProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const containerStub = getDepartmentContainerStub(ctx.env, input.departmentId);
      await containerStub.destroy();
    }),

  adminForceResetAgent: adminProcedure
    .input(z.object({ departmentId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      await departmentStub.unhookTicket(input.agentId);
      await departmentStub.updateAgentStatus(input.agentId, 'idle');
    }),

  adminForceCloseTicket: adminProcedure
    .input(z.object({ departmentId: z.string().uuid(), ticketId: z.string().uuid() }))
    .output(RpcTicketOutput)
    .mutation(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.closeTicket(input.ticketId, 'admin');
    }),

  adminForceFailTicket: adminProcedure
    .input(z.object({ departmentId: z.string().uuid(), ticketId: z.string().uuid() }))
    .output(RpcTicketOutput)
    .mutation(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.updateTicketStatus(input.ticketId, 'failed', 'admin', {
        code: 'admin_force_fail',
        message: 'Manually failed by admin',
        source: 'admin',
      });
    }),

  adminGetAlarmStatus: adminProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .output(RpcAlarmStatusOutput)
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getAlarmStatus();
    }),

  adminGetDepartmentEvents: adminProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        ticketId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcTicketEventOutput))
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.listTicketEvents({
        ticketId: input.ticketId,
        since: input.since,
        limit: input.limit,
      });
    }),

  adminGetTicket: adminProcedure
    .input(z.object({ departmentId: z.string().uuid(), ticketId: z.string().uuid() }))
    .output(RpcTicketOutput.nullable())
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.getTicketAsync(input.ticketId);
    }),

  adminBulkDeleteTickets: adminProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        ticketIds: z.array(z.string().uuid()),
      })
    )
    .output(z.object({ deleted: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      const count = await departmentStub.deleteTickets(input.ticketIds);
      return { deleted: count };
    }),

  adminDeleteTicketsByStatus: adminProcedure
    .input(
      z.object({
        departmentId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']),
        type: z
          .enum(['issue', 'message', 'escalation', 'merge_request', 'shift', 'TicketCase', 'agent'])
          .optional(),
      })
    )
    .output(z.object({ deleted: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      const count = await departmentStub.deleteTicketsByStatus(input.status, input.type);
      return { deleted: count };
    }),

  debugAgentMetadata: adminProcedure
    .input(z.object({ departmentId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const departmentStub = getDepartmentDOStub(ctx.env, input.departmentId);
      return departmentStub.debugAgentMetadata();
    }),
});

export type HelldeskRouter = typeof helldeskRouter;

/**
 * Wrapped router that nests helldeskRouter under a `helldesk` key.
 * This preserves the `trpc.helldesk.X` call pattern on the frontend,
 * matching the existing RootRouter shape so components don't need
 * to change their procedure paths.
 */
export const wrappedHelldeskRouter = router({ helldesk: helldeskRouter });
export type WrappedHelldeskRouter = typeof wrappedHelldeskRouter;
