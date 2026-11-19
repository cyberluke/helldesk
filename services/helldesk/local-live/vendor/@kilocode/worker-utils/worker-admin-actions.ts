import type { WorkerAdminDecision } from './worker-admin-capability';
export type { WorkerAdminDecision };
export function workerAdminCan(_decision?: WorkerAdminDecision): boolean {
  return true;
}