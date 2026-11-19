import type { Context } from 'hono';
import { z } from 'zod';
import { getHelldeskOrgStub } from '../dos/HelldeskOrg.do';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { HelldeskEnv } from '../helldesk.worker';

const ORG_DEPARTMENTS_LOG = '[org-departments.handler]';

const CreateOrgDepartmentBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateOrgWorkstationBody = z.object({
  department_id: z.string().min(1),
  name: z.string().min(1).max(64),
  git_url: z.string().url(),
  default_branch: z.string().min(1).default('main'),
  platform_integration_id: z.string().min(1).optional(),
});

export async function handleCreateOrgDepartment(c: Context<HelldeskEnv>, params: { orgId: string }) {
  const parsed = CreateOrgDepartmentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const department = await orgDO.createDepartment({
    name: parsed.data.name,
    owner_org_id: params.orgId,
    created_by_user_id: userId,
  });

  // Initialize the DepartmentDO config with org ownership metadata
  const departmentDOStub = getDepartmentDOStub(c.env, department.id);
  await departmentDOStub.setDepartmentId(department.id);
  await departmentDOStub.updateDepartmentConfig({
    owner_type: 'org',
    owner_id: params.orgId,
    owner_user_id: userId,
    organization_id: params.orgId,
    created_by_user_id: userId,
  });

  return c.json(resSuccess(department), 201);
}

export async function handleListOrgDepartments(c: Context<HelldeskEnv>, params: { orgId: string }) {
  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const departments = await orgDO.listDepartments();
  return c.json(resSuccess(departments));
}

export async function handleGetOrgDepartment(
  c: Context<HelldeskEnv>,
  params: { orgId: string; departmentId: string }
) {
  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const department = await orgDO.getDepartmentAsync(params.departmentId);
  if (!department) return c.json(resError('Department not found'), 404);
  return c.json(resSuccess(department));
}

export async function handleCreateOrgWorkstation(c: Context<HelldeskEnv>, params: { orgId: string }) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  const parsed = CreateOrgWorkstationBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${ORG_DEPARTMENTS_LOG} handleCreateOrgWorkstation: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${ORG_DEPARTMENTS_LOG} handleCreateOrgWorkstation: orgId=${params.orgId} department_id=${parsed.data.department_id} name=${parsed.data.name} git_url=${parsed.data.git_url}`
  );

  const orgDO = getHelldeskOrgStub(c.env, params.orgId);

  // Verify the department belongs to this org before creating the workstation
  const department = await orgDO.getDepartmentAsync(parsed.data.department_id);
  if (!department) return c.json(resError('Department not found in this org'), 404);

  const workstation = await orgDO.createWorkstation(parsed.data);
  console.log(
    `${ORG_DEPARTMENTS_LOG} handleCreateOrgWorkstation: workstation created id=${workstation.id}, now configuring Department DO`
  );

  // If this fails, roll back the workstation creation to avoid an orphaned record.
  try {
    const departmentDOStub = getDepartmentDOStub(c.env, parsed.data.department_id);
    await departmentDOStub.configureWorkstation({
      workstationId: workstation.id,
      departmentId: parsed.data.department_id,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
      userId,
      // Never trust caller-supplied kilocode tokens for org workstations — the
      // department's existing token (minted by the owner) is used instead.
      kilocodeToken: undefined,
      platformIntegrationId: parsed.data.platform_integration_id,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
    await departmentDOStub.addWorkstation({
      workstationId: workstation.id,
      name: parsed.data.name,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
    });
    console.log(`${ORG_DEPARTMENTS_LOG} handleCreateOrgWorkstation: Department DO configured and workstation registered`);
  } catch (err) {
    console.error(
      `${ORG_DEPARTMENTS_LOG} handleCreateOrgWorkstation: Department DO configure FAILED for workstation ${workstation.id}, rolling back:`,
      err
    );
    await orgDO.deleteWorkstation(workstation.id);
    return c.json(resError('Failed to configure workstation'), 500);
  }

  return c.json(resSuccess(workstation), 201);
}

export async function handleListOrgWorkstations(
  c: Context<HelldeskEnv>,
  params: { orgId: string; departmentId: string }
) {
  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const workstations = await orgDO.listWorkstations(params.departmentId);
  return c.json(resSuccess(workstations));
}

export async function handleGetOrgWorkstation(
  c: Context<HelldeskEnv>,
  params: { orgId: string; workstationId: string }
) {
  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const workstation = await orgDO.getWorkstationAsync(params.workstationId);
  if (!workstation) return c.json(resError('Workstation not found'), 404);
  return c.json(resSuccess(workstation));
}

export async function handleDeleteOrgDepartment(
  c: Context<HelldeskEnv>,
  params: { orgId: string; departmentId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete departments'), 403);
  }

  const orgDO = getHelldeskOrgStub(c.env, params.orgId);

  // Verify the department belongs to this org BEFORE destroying anything
  const department = await orgDO.getDepartmentAsync(params.departmentId);
  if (!department) return c.json(resError('Department not found'), 404);

  // Destroy the Department DO (handles all workstations, agents, and frontDesk cleanup)
  try {
    const departmentDOStub = getDepartmentDOStub(c.env, params.departmentId);
    await departmentDOStub.destroy();
    console.log(
      `${ORG_DEPARTMENTS_LOG} handleDeleteOrgDepartment: Department DO destroyed for department ${params.departmentId}`
    );
  } catch (err) {
    console.error(`${ORG_DEPARTMENTS_LOG} handleDeleteOrgDepartment: failed to destroy Department DO:`, err);
  }

  const deleted = await orgDO.deleteDepartment(params.departmentId);
  if (!deleted) return c.json(resError('Department not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteOrgWorkstation(
  c: Context<HelldeskEnv>,
  params: { orgId: string; workstationId: string }
) {
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  // Verify owner role via JWT claims (works in dev mode where orgAuthMiddleware is skipped)
  const memberships = c.get('kiloOrgMemberships') ?? [];
  const membership = memberships.find(m => m.orgId === params.orgId);
  if (!membership || membership.role !== 'owner') {
    return c.json(resError('Only org owners can delete workstations'), 403);
  }

  const orgDO = getHelldeskOrgStub(c.env, params.orgId);
  const workstation = await orgDO.getWorkstationAsync(params.workstationId);
  if (!workstation) return c.json(resError('Workstation not found'), 404);

  const deleted = await orgDO.deleteWorkstation(params.workstationId);
  if (!deleted) return c.json(resError('Workstation not found'), 404);

  try {
    const departmentDOStub = getDepartmentDOStub(c.env, workstation.department_id);
    await departmentDOStub.removeWorkstation(params.workstationId);
  } catch (err) {
    console.error(`${ORG_DEPARTMENTS_LOG} handleDeleteOrgWorkstation: failed to remove workstation from Department DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
