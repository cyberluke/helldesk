import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const DepartmentEventType = z.enum([
  'agent_done',
  'agent_completed',
  'container_status',
  'container_eviction',
  'pr_status_changed',
  'ticket_created',
  'ticket_cancelled',
  'shift_started',
  'nudge_timeout',
  'pr_feedback_detected',
  'pr_auto_merge',
  'pr_conflict_detected',
]);

export type DepartmentEventType = z.output<typeof DepartmentEventType>;

export const DepartmentEventRecord = z.object({
  event_id: z.string(),
  event_type: DepartmentEventType,
  agent_id: z.string().nullable(),
  ticket_id: z.string().nullable(),
  payload: z
    .string()
    .transform((v, ctx): Record<string, unknown> => {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON in payload' });
        return {};
      }
    })
    .pipe(z.record(z.string(), z.unknown())),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

export type DepartmentEventRecord = z.output<typeof DepartmentEventRecord>;

export const department_events = getTableFromZodSchema('department_events', DepartmentEventRecord);

export function createTableDepartmentEvents(): string {
  return getCreateTableQueryFromTable(department_events, {
    event_id: `text primary key`,
    event_type: `text not null`,
    agent_id: `text`,
    ticket_id: `text`,
    payload: `text not null default '{}'`,
    created_at: `text not null`,
    processed_at: `text`,
  });
}

export function getIndexesDepartmentEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_department_events_pending ON ${department_events}(${department_events.columns.created_at}) WHERE ${department_events.columns.processed_at} IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_department_events_type ON ${department_events}(${department_events.columns.event_type})`,
  ];
}
