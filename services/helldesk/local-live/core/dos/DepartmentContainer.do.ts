import type { LocalEnv } from '../runtime/registry';

export function getDepartmentContainerStub(env: LocalEnv, departmentId: string) {
  return env.DEPARTMENT_CONTAINER.get(env.DEPARTMENT_CONTAINER.idFromName(departmentId));
}
export function getDepartmentContainerDoId(env: LocalEnv, departmentId: string): string {
  return env.DEPARTMENT_CONTAINER.idFromName(departmentId).toString();
}