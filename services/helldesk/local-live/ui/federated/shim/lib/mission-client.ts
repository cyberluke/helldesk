/**
 * Browser boundary for the mission completion/acceptance/re-review APIs.
 *
 * The concrete implementation lives in ui/src/lib/engine.ts (shared with the
 * standalone operator views); this shim exposes it at the `@/lib/...` alias
 * used by the federated components. All calls go through local-live's
 * `/api/v1/*` proxy, which injects the daemon token.
 */
export {
  getMissionReport,
  requestMissionReReview,
  requestTaskSizingBackfill,
  submitMissionAcceptance,
  updateMissionTicketSize,
} from '../../../src/lib/engine';
export type {
  MissionReport,
  MissionReportFinding,
  MissionReportRole,
} from '../../../src/lib/engine';
