/**
 * Controller-level event names emitted from HTTP/tRPC handlers.
 * Internal DO events (ticket lifecycle, agent dispatch) use `HelldeskInternalEventName`.
 */
export type HelldeskEventName =
  // DO-internal lifecycle events
  | 'ticket.created'
  | 'ticket.status_changed'
  | 'ticket.closed'
  | 'ticket.failed'
  | 'agent.spawned'
  | 'agent.exited'
  | 'agent.dispatch_failed'
  | 'review.submitted'
  | 'review.completed'
  | 'review.failed'
  | 'shift.created'
  | 'shift.landed'
  | 'escalation.created'
  | 'escalation.acknowledged'
  | 'nudge.queued'
  | 'nudge.delivered'
  | 'api.external_request'
  // Controller-level events (HTTP + tRPC) use string to avoid maintaining
  // a massive union — event names are derived from route patterns.
  | (string & {});

export type HelldeskDelivery = 'http' | 'trpc' | 'internal';

export type HelldeskEventData = {
  event: HelldeskEventName;
  delivery?: HelldeskDelivery;
  route?: string;
  error?: string;
  userId?: string;
  departmentId?: string;
  workstationId?: string;
  agentId?: string;
  ticketId?: string;
  shiftId?: string;
  role?: string; // 'soul' | 'qualityAssurance' | 'frontDesk'
  reason?: string; // dispatch failure reason, triage action, etc.
  ticketType?: string;
  durationMs?: number;
  value?: number;
  label?: string;
  // Container cold-start instrumentation fields.
  // Use durationMs for timing (event name disambiguates the metric).
  // Use error (absence = success) instead of a wasSuccess boolean.
  statusCode?: number;
  containerStartedAt?: string;
  // Cloudflare container identity (DepartmentContainerDO Durable Object id) — aids
  // correlation with Cloudflare support and the dashboard for container events.
  containerId?: string;
  // Additional doubles for reconciler_tick events (double3–double10).
  // Analytics Engine supports up to 20 doubles per data point.
  double3?: number;
  double4?: number;
  double5?: number;
  double6?: number;
  double7?: number;
  double8?: number;
  double9?: number;
  double10?: number;
};

/**
 * Write a single event to Cloudflare Analytics Engine.
 * Safe to call in development (where the binding is absent) — silently no-ops.
 */
export function writeEvent(
  env: { HELLDESK_AE?: AnalyticsEngineDataset },
  data: HelldeskEventData
): void {
  if (!env.HELLDESK_AE) return;
  try {
    env.HELLDESK_AE.writeDataPoint({
      blobs: [
        data.event, // blob1
        data.userId ?? '', // blob2
        data.delivery ?? '', // blob3
        data.route ?? '', // blob4
        data.error ?? '', // blob5
        data.departmentId ?? '', // blob6
        data.workstationId ?? '', // blob7
        data.agentId ?? '', // blob8
        data.ticketId ?? '', // blob9
        data.label ?? '', // blob10
        data.shiftId ?? '', // blob11
        data.role ?? '', // blob12
        data.ticketType ?? '', // blob13
        data.reason ?? '', // blob14
        data.containerStartedAt ?? '', // blob15
        data.containerId ?? '', // blob16
      ],
      doubles: [
        data.durationMs ?? 0, // double1
        data.value ?? 0, // double2
        data.double3 ?? 0, // double3
        data.double4 ?? 0, // double4
        data.double5 ?? 0, // double5
        data.double6 ?? 0, // double6
        data.double7 ?? 0, // double7
        data.double8 ?? 0, // double8
        data.double9 ?? 0, // double9
        data.double10 ?? 0, // double10
        data.statusCode ?? 0, // double11
      ],
      indexes: [data.event],
    });
  } catch {
    // Best-effort — never throw from analytics
  }
}
