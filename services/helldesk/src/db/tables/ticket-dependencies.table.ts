import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const DependencyType = z.enum(['blocks', 'tracks', 'parent-child']);

export const TicketDependencyRecord = z.object({
  ticket_id: z.string(),
  depends_on_ticket_id: z.string(),
  dependency_type: DependencyType,
});

export type TicketDependencyRecord = z.output<typeof TicketDependencyRecord>;

export const ticket_dependencies = getTableFromZodSchema('ticket_dependencies', TicketDependencyRecord);

export function createTableTicketDependencies(): string {
  return getCreateTableQueryFromTable(ticket_dependencies, {
    ticket_id: `text not null references tickets(ticket_id)`,
    depends_on_ticket_id: `text not null references tickets(ticket_id)`,
    dependency_type: `text not null default 'blocks'`,
  });
}

export function getIndexesTicketDependencies(): string[] {
  return [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_deps_pk ON ${ticket_dependencies}(${ticket_dependencies.columns.ticket_id}, ${ticket_dependencies.columns.depends_on_ticket_id})`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_deps_depends_on ON ${ticket_dependencies}(${ticket_dependencies.columns.depends_on_ticket_id})`,
  ];
}
