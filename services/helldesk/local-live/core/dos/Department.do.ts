/**
 * Local HELLDESK — `Department.do` shim.
 *
 * The federated handlers import `getDepartmentDOStub` from `../dos/Department.do`. Instead
 * of the 5918-line Cloudflare Durable Object class (which imports billing,
 * @sentry/cloudflare, @kilocode/worker-utils, and extends `DurableObject`),
 * we export the same stub helper backed by the local runtime registry.
 */
import type { LocalEnv } from '../runtime/registry';
import type { LocalDepartment } from '../runtime/LocalDepartment';

export function getDepartmentDOStub(env: LocalEnv, departmentId: string): LocalDepartment {
  return env.department.get(env.department.idFromName(departmentId)) as LocalDepartment;
}

export type DepartmentDO = LocalDepartment;
export type { LocalDepartment as LocalDepartmentDO };