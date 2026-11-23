/**
 * events-reconcile.ts — no-split-brain OBSERVABILITY projection from the control plane.
 *
 * The GUI "Observability" surface must show the REAL engine event stream (job
 * enqueued, report ready, reviews, mutations, repairs, verification), not the
 * empty local SqlStorage event table. This projects the control-plane journal
 * into the local ticket-event shape the Observability view renders (server-side
 * loopback proxy injects the token). Read-time projection only — no writes.
 *
 * Two facts matter for honesty:
 *   1. We ask for the NEWEST events (`?tail=N`), never the journal head. The
 *      cursor endpoint (`?after=0`) returns the oldest rows and made live work
 *      look days old.
 *   2. We preserve the engine's real event type (`mission.replanned`,
 *      `revision.rejected`, `job.requeued`, …). Collapsing them into a five-word
 *      ticket vocabulary erased the type breakdown and the failure signal.
 */
import { z } from 'zod';

// Local ticket-event shape the Observability view expects (matches the federated
// `DepartmentEvent`/`TicketEvent` type shim).
export interface TicketEvent {
  ticket_event_id: string;
  ticket_id: string;
  agent_id: string | null;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  workstation_id?: string | null;
  workstation_name?: string | null;
}

const SELF = `http://${process.env.HELLDESK_HOST ?? '127.0.0.1'}:${process.env.HELLDESK_PORT ?? '8790'}`;
const EventsDTO = z.object({
  events: z.array(
    z
      .object({
        seq: z.number().optional(),
        eventType: z.string(),
        jobId: z.string().nullable().optional(),
        // Payload is an opaque journal value; never drop an event because a
        // future emitter used a non-object shape.
        payload: z.unknown().optional(),
        createdAt: z.string(),
        missionId: z.string().nullable().optional(),
        ticketId: z.string().nullable().optional(),
        workspaceId: z.string().nullable().optional(),
        workspaceName: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
});

/**
 * Fetch the engine's newest events (the real observability stream).
 *
 * A ticket-scoped timeline scans deeper than the department feed: the global
 * tail is dominated by evidence captures, so a 200-row window can contain no
 * event for the ticket being viewed. Filtering happens after enrichment because
 * job events only reveal their ticket through the review-job → revision edge.
 */
export async function listEventsProjected(
  limit = 200,
  opts?: { ticketId?: string },
): Promise<TicketEvent[]> {
  const clamped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
  const fetchLimit = opts?.ticketId ? Math.min(Math.max(clamped, 1000), 2000) : clamped;
  let res: Response;
  try {
    // Server-side fetch via the local-live runtime's own proxy (/api/v1/events)
    // so the control-plane token is injected here, not by the browser. Direct
    // :4790/v1/events bypasses that token injection and returns empty.
    res = await fetch(`${SELF}/api/v1/events?tail=${fetchLimit}`, {
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    return [];
  }
  if (!res || !res.ok) return [];
  let parsed;
  try {
    parsed = EventsDTO.parse(await res.json());
  } catch {
    return [];
  }

  const projected = (parsed.events ?? []).map((e) => {
    const payload =
      e.payload && typeof e.payload === 'object' && !Array.isArray(e.payload)
        ? (e.payload as Record<string, unknown>)
        : {};
    const ticketId =
      e.ticketId ??
      (typeof payload.ticket_id === 'string' ? payload.ticket_id : undefined) ??
      (typeof payload.ticketId === 'string' ? payload.ticketId : undefined) ??
      e.jobId ??
      e.missionId ??
      `event:${e.seq ?? e.createdAt}`;
    return {
      ticket_event_id: `evt:${e.seq ?? e.createdAt}`,
      ticket_id: ticketId,
      agent_id: null,
      // Preserve the real engine vocabulary; the UI renders unknown types
      // generically instead of mislabelling them as ticket.created.
      event_type: e.eventType,
      old_value: null,
      new_value: e.eventType,
      metadata: {
        engine: true,
        seq: e.seq,
        jobId: e.jobId,
        missionId: e.missionId,
        ticketId: e.ticketId,
        payload: e.payload,
      },
      created_at: e.createdAt,
      workstation_id: e.workspaceId ?? null,
      workstation_name: e.workspaceName ?? null,
    };
  });
  if (!opts?.ticketId) return projected;
  // Keep only events attributed to this ticket, then the newest `limit`.
  return projected.filter((e) => e.ticket_id === opts.ticketId).slice(-clamped);
}
