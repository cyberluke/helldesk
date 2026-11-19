import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { AgentMetadataRecord } from './agent-metadata.table';
import { ReviewMetadataRecord } from './review-metadata.table';
import { EscalationMetadataRecord } from './escalation-metadata.table';
import { ShiftMetadataRecord } from './shift-metadata.table';

export const TicketType = z.enum([
  'issue',
  'message',
  'escalation',
  'merge_request',
  'shift',
  'TicketCase',
  'agent',
]);

export const TicketStatus = z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']);
export const TicketPriority = z.enum(['low', 'medium', 'high', 'critical']);

export const TicketRecord = z.object({
  ticket_id: z.string(),
  type: TicketType,
  status: TicketStatus,
  title: z.string(),
  body: z.string().nullable(),
  workstation_id: z.string().nullable(),
  parent_ticket_id: z.string().nullable(),
  assignee_agent_ticket_id: z.string().nullable(),
  priority: TicketPriority,
  labels: z
    .string()
    .transform((v, ctx): string[] => {
      try {
        return JSON.parse(v) as string[];
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in labels' });
        return [];
      }
    })
    .pipe(z.array(z.string())),
  metadata: z
    .string()
    .transform((v, ctx): Record<string, unknown> => {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in metadata' });
        return {};
      }
    })
    .pipe(z.record(z.string(), z.any())), // z.any() needed for Rpc.Serializable compatibility
  dispatch_attempts: z.number().default(0),
  last_dispatch_attempt_at: z.string().nullable().default(null),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
});

export type TicketRecord = z.output<typeof TicketRecord>;

// Each narrows the `type` discriminant to a literal and extends with
// the satellite metadata columns. Use these to parse JOIN query results.

export const IssueTicketRecord = TicketRecord.extend({ type: z.literal('issue') });
export type IssueTicketRecord = z.output<typeof IssueTicketRecord>;

export const MessageTicketRecord = TicketRecord.extend({ type: z.literal('message') });
export type MessageTicketRecord = z.output<typeof MessageTicketRecord>;

export const TicketCaseTicketRecord = TicketRecord.extend({ type: z.literal('TicketCase') });
export type TicketCaseTicketRecord = z.output<typeof TicketCaseTicketRecord>;

export const AgentTicketRecord = TicketRecord.extend({
  type: z.literal('agent'),
  ...AgentMetadataRecord.shape,
});
export type AgentTicketRecord = z.output<typeof AgentTicketRecord>;

export const MergeRequestTicketRecord = TicketRecord.extend({
  type: z.literal('merge_request'),
  ...ReviewMetadataRecord.shape,
});
export type MergeRequestTicketRecord = z.output<typeof MergeRequestTicketRecord>;

export const EscalationTicketRecord = TicketRecord.extend({
  type: z.literal('escalation'),
  ...EscalationMetadataRecord.shape,
});
export type EscalationTicketRecord = z.output<typeof EscalationTicketRecord>;

export const ShiftTicketRecord = TicketRecord.extend({
  type: z.literal('shift'),
  ...ShiftMetadataRecord.shape,
});
export type ShiftTicketRecord = z.output<typeof ShiftTicketRecord>;

export const TicketRecordWithMetadata = z.discriminatedUnion('type', [
  IssueTicketRecord,
  MessageTicketRecord,
  TicketCaseTicketRecord,
  AgentTicketRecord,
  MergeRequestTicketRecord,
  EscalationTicketRecord,
  ShiftTicketRecord,
]);
export type TicketRecordWithMetadata = z.output<typeof TicketRecordWithMetadata>;

export const tickets = getTableFromZodSchema('tickets', TicketRecord);

// CHECK constraints are intentionally omitted — Cloudflare DO SQLite
// provides no way to alter CHECK constraints on existing tables, and
// Zod validates all values at the application layer. See #442.
export function createTableTickets(): string {
  return getCreateTableQueryFromTable(tickets, {
    ticket_id: `text primary key`,
    type: `text not null`,
    status: `text not null default 'open'`,
    title: `text not null`,
    body: `text`,
    workstation_id: `text`,
    parent_ticket_id: `text references tickets(ticket_id)`,
    assignee_agent_ticket_id: `text`,
    priority: `text default 'medium'`,
    labels: `text default '[]'`,
    metadata: `text default '{}'`,
    dispatch_attempts: `integer not null default 0`,
    last_dispatch_attempt_at: `text`,
    created_by: `text`,
    created_at: `text not null`,
    updated_at: `text not null`,
    closed_at: `text`,
  });
}

export function migrateTickets(): string[] {
  return [
    `ALTER TABLE tickets ADD COLUMN dispatch_attempts integer not null default 0`,
    `ALTER TABLE tickets ADD COLUMN last_dispatch_attempt_at text`,
  ];
}

export function getIndexesTickets(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_tickets_type_status ON ${tickets}(${tickets.columns.type}, ${tickets.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_parent ON ${tickets}(${tickets.columns.parent_ticket_id})`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_workstation_status ON ${tickets}(${tickets.columns.workstation_id}, ${tickets.columns.status})`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON ${tickets}(${tickets.columns.assignee_agent_ticket_id}, ${tickets.columns.type}, ${tickets.columns.status})`,
  ];
}
