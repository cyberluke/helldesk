import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WorkstationAgentEventRecord = z.object({
  id: z.number(),
  agent_id: z.string(),
  event_type: z.string(),
  data: z
    .string()
    .transform((v): unknown => JSON.parse(v) as unknown)
    .pipe(z.record(z.string(), z.unknown())),
  created_at: z.string(),
});

export type WorkstationAgentEventRecord = z.output<typeof WorkstationAgentEventRecord>;

export const workstation_agent_events = getTableFromZodSchema('workstation_agent_events', WorkstationAgentEventRecord);

export function createTableWorkstationAgentEvents(): string {
  return getCreateTableQueryFromTable(workstation_agent_events, {
    id: `integer primary key autoincrement`,
    agent_id: `text not null`,
    event_type: `text not null`,
    data: `text not null default '{}'`,
    created_at: `text not null`,
  });
}

export function getIndexesWorkstationAgentEvents(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_workstation_agent_events_agent_id ON ${workstation_agent_events}(${workstation_agent_events.columns.agent_id})`,
    `CREATE INDEX IF NOT EXISTS idx_workstation_agent_events_agent_created ON ${workstation_agent_events}(${workstation_agent_events.columns.agent_id}, ${workstation_agent_events.columns.id})`,
  ];
}
