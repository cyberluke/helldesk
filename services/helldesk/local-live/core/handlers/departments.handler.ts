import type { Context } from 'hono';
import { z } from 'zod';
import { getHelldeskUserStub } from '../dos/HelldeskUser.do';
import { getDepartmentDOStub } from '../dos/Department.do';
import { resSuccess, resError } from '../util/res.util';
import { parseJsonBody } from '../util/parse-json-body.util';
import type { HelldeskEnv, HelldeskAppEnv } from '../helldesk.worker';

const DEPARTMENTS_LOG = '[departments.handler]';

const CreateDepartmentBody = z.object({
  name: z.string().min(1).max(64),
});

const CreateWorkstationBody = z.object({
  department_id: z.string().min(1),
  name: z.string().min(1).max(64),
  // Optional locally: Task Studio routes each task to a workspace path, so a
  // workstation can be created as a crew seat before any repo is wired.
  git_url: z.string().url().or(z.literal('')).optional().default(''),
  default_branch: z.string().min(1).default('main'),
  kilocode_token: z.string().min(1).optional(),
  platform_integration_id: z.string().min(1).optional(),
});

/**
 * Department DO instances are keyed by owner_user_id (the :userId path param)
 * so all of a user's departments live in a single DO instance.
 */

export async function handleCreateDepartment(c: Context<HelldeskAppEnv>, params: { userId: string }) {
  const parsed = CreateDepartmentBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }

  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const department = await departmentDO.createDepartment({ name: parsed.data.name, owner_user_id: params.userId });
  return c.json(resSuccess(department), 201);
}

export async function handleListDepartments(c: Context<HelldeskAppEnv>, params: { userId: string }) {
  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const departments = await departmentDO.listDepartments();
  return c.json(resSuccess(departments));
}

export async function handleGetDepartment(
  c: Context<HelldeskAppEnv>,
  params: { userId: string; departmentId: string }
) {
  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const department = await departmentDO.getDepartmentAsync(params.departmentId);
  if (!department) return c.json(resError('Department not found'), 404);
  return c.json(resSuccess(department));
}

export async function handleCreateWorkstation(c: Context<HelldeskAppEnv>, params: { userId: string }) {
  const parsed = CreateWorkstationBody.safeParse(await parseJsonBody(c));
  if (!parsed.success) {
    console.error(`${DEPARTMENTS_LOG} handleCreateWorkstation: invalid body`, parsed.error.issues);
    return c.json(
      { success: false, error: 'Invalid request body', issues: parsed.error.issues },
      400
    );
  }
  console.log(
    `${DEPARTMENTS_LOG} handleCreateWorkstation: userId=${params.userId} department_id=${parsed.data.department_id} name=${parsed.data.name} git_url=${parsed.data.git_url} hasKilocodeToken=${!!parsed.data.kilocode_token}`
  );

  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const workstation = await departmentDO.createWorkstation(parsed.data);
  console.log(`${DEPARTMENTS_LOG} handleCreateWorkstation: workstation created id=${workstation.id}, now configuring Workstation DO`);

  // If this fails, roll back the workstation creation to avoid an orphaned record.
  try {
    const departmentDOStub = getDepartmentDOStub(c.env, parsed.data.department_id);
    await departmentDOStub.configureWorkstation({
      workstationId: workstation.id,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
      userId: params.userId,
      kilocodeToken: parsed.data.kilocode_token,
      platformIntegrationId: parsed.data.platform_integration_id,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC stub returns Rpc.Promisified
    await departmentDOStub.addWorkstation({
      workstationId: workstation.id,
      name: parsed.data.name,
      gitUrl: parsed.data.git_url,
      defaultBranch: parsed.data.default_branch,
    });
    console.log(`${DEPARTMENTS_LOG} handleCreateWorkstation: Department DO configured and workstation registered`);
  } catch (err) {
    console.error(
      `${DEPARTMENTS_LOG} handleCreateWorkstation: Department DO configure FAILED for workstation ${workstation.id}, rolling back:`,
      err
    );
    await departmentDO.deleteWorkstation(workstation.id);
    return c.json(resError('Failed to configure workstation'), 500);
  }

  return c.json(resSuccess(workstation), 201);
}

export async function handleGetWorkstation(
  c: Context<HelldeskAppEnv>,
  params: { userId: string; workstationId: string }
) {
  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const workstation = await departmentDO.getWorkstationAsync(params.workstationId);
  if (!workstation) return c.json(resError('Workstation not found'), 404);
  return c.json(resSuccess(workstation));
}

export async function handleListWorkstations(
  c: Context<HelldeskAppEnv>,
  params: { userId: string; departmentId: string }
) {
  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const workstations = await departmentDO.listWorkstations(params.departmentId);
  return c.json(resSuccess(workstations));
}

export async function handleDeleteDepartment(
  c: Context<HelldeskAppEnv>,
  params: { userId: string; departmentId: string }
) {
  const departmentDO = getHelldeskUserStub(c.env, params.userId);
  const department = await departmentDO.getDepartmentAsync(params.departmentId);
  if (!department) return c.json(resError('Department not found'), 404);

  // Destroy the Department DO (handles all workstations, agents, and frontDesk cleanup)
  try {
    const departmentDOStub = getDepartmentDOStub(c.env, params.departmentId);
    await departmentDOStub.destroy();
    console.log(`${DEPARTMENTS_LOG} handleDeleteDepartment: Department DO destroyed for department ${params.departmentId}`);
  } catch (err) {
    console.error(`${DEPARTMENTS_LOG} handleDeleteDepartment: failed to destroy Department DO:`, err);
  }

  const deleted = await departmentDO.deleteDepartment(params.departmentId);
  if (!deleted) return c.json(resError('Department not found'), 404);
  return c.json(resSuccess({ deleted: true }));
}

export async function handleDeleteWorkstation(
  c: Context<HelldeskAppEnv>,
  params: { userId: string; workstationId: string }
) {
  const userDO = getHelldeskUserStub(c.env, params.userId);
  const workstation = await userDO.getWorkstationAsync(params.workstationId);
  if (!workstation) return c.json(resError('Workstation not found'), 404);

  const deleted = await userDO.deleteWorkstation(params.workstationId);
  if (!deleted) return c.json(resError('Workstation not found'), 404);

  try {
    const departmentDOStub = getDepartmentDOStub(c.env, workstation.department_id);
    await departmentDOStub.removeWorkstation(params.workstationId);
  } catch (err) {
    console.error(`${DEPARTMENTS_LOG} handleDeleteWorkstation: failed to remove workstation from Department DO:`, err);
  }

  return c.json(resSuccess({ deleted: true }));
}
