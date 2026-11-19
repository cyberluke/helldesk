import type { WorkerAdminAuthority, WorkerAdminDecision, KiloAuthVariables, KiloTokenPayload } from './index';
export { KiloAuthVariables, KiloTokenPayload };
export type { WorkerAdminAuthority, WorkerAdminDecision };
export const defaultWorkerAdminAuthority: WorkerAdminAuthority = { can: () => true };