import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const TicketEventType = z.enum([
  'created',
  'assigned',
  'hooked',
  'unhooked',
  'status_changed',
  'closed',
  'escalated',
  'notification_failed',
  'memo_sent',
  'review_submitted',
  'review_completed',
  'agent_spawned',
  'agent_exited',
  'pr_created',
  'pr_creation_failed',
  'agent_status',
  'triage_resolved',
  'fields_updated',
  'review_queue_depth_alert',
  'escalation_rate_spike',
  'agent_restart_loop',
  'rework_requested',
]);

export type TicketEventType = z.infer<typeof TicketEventType>;

export const TicketEventRecord = z.object({
  ticket_event_id: z.string().default(() => crypto.randomUUID()),
  ticket_id: z.string(),
  agent_id: z.string().nullable(),
  event_type: TicketEventType,
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  metadata: z.string().transform((v, ctx): Record<string, unknown> => {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in metadata' });
      return {};
    }
  }),
  created_at: z.string(),
});

export type TicketEventRecord = z.output<typeof TicketEventRecord>;

export const ticket_events = getTableFromZodSchema('ticket_events', TicketEventRecord);

export function createTableTicketEvents(): string {
  return getCreateTableQueryFromTable(ticket_events, {
    ticket_event_id: `text primary key`,
    ticket_id: `text not null`,
    agent_id: `text`,
    event_type: `text not null`,
    old_value: `text`,
    new_value: `text`,
    metadata: `text default '{}'`,
    created_at: `text not null`,
  });
}

export function getIndexesTicketEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_ticket_events_Ticket ON ${ticket_events}(${ticket_events.columns.ticket_id})`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_events_created ON ${ticket_events}(${ticket_events.columns.created_at})`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_events_type ON ${ticket_events}(${ticket_events.columns.event_type})`,
  ];
}
