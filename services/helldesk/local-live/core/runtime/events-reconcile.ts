/**
 * events-reconcile.ts — no-split-brain OBSERVABILITY projection from the control plane.
 *
 * The GUI "Observability" surface must show the REAL engine event stream (job
 * enqueued, report ready, reviews, mutations), not the empty local SqlStorage
 * event table. This projects the control-plane /v1/events into the local ticket
 * event shape the Observability view renders (server-side loopback proxy injects
 * the token). Read-time projection only — no writes.
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

const SELF = 'http://127.0.0.1:8790';
const EventsDTO = z.object({ events: z.array(z.object({
  seq: z.number().optional(),
  eventType: z.string(),
  jobId: z.string().nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
})) });

/** A neutral event type that maps onto the local TicketEvent vocabulary. */
function mapEventType(t: string | undefined): string {
  const s = (t ?? '').toLowerCase();
  if (s.includes('enque') || s.includes('queu')) return 'queued';
  if (s.includes('report') || s.includes('review')) return 'reviewed';
  if (s.includes('completed') || s.includes('succeed')) return 'completed';
  if (s.includes('fail') || s.includes('error')) return 'failed';
  return 'ticket.created';
}

/** Fetch the engine's real event journal (the observability stream). */
export async function listEventsProjected(limit = 200): Promise<TicketEvent[]> {
  let res: Response;
  try {
    // Server-side fetch via the local-live runtime's own proxy (/api/v1/events)
    // so the control-plane token is injected here, not by the browser. Direct
    // :4790/v1/events bypasses that token injection and returns empty.
    res = await fetch(`${SELF}/api/v1/events`, { signal: AbortSignal.timeout(6000) });
  } catch { return []; }
  if (!res || !res.ok) return [];
  let parsed;
  try { parsed = EventsDTO.parse(await res.json()); } catch { return []; }

  return (parsed.events ?? [])
    .slice(0, limit)
    .map((e) => ({
      ticket_event_id: `evt:${e.seq ?? e.createdAt}`,
      ticket_id: e.jobId ?? `job:${e.seq ?? ''}`,
      agent_id: null,
      event_type: mapEventType(e.eventType),
      old_value: null,
      new_value: e.eventType,
      metadata: { engine: true, seq: e.seq, jobId: e.jobId, payload: e.payload },
      created_at: e.createdAt,
      workstation_id: null,
      workstation_name: null,
    }));
}