import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

/**
 * Operator archive overlay (local-live only).
 *
 * Archiving hides a closed/cancelled card from the board WITHOUT deleting the
 * engine mission or its durable record. Projected mission ids (`mis_*`) and
 * local ticket ids both live here.
 */
export const TicketArchiveRecord = z.object({
  ticket_id: z.string(),
  archived_at: z.string(),
});

export type TicketArchiveRecord = z.output<typeof TicketArchiveRecord>;

export const ticket_archives = getTableFromZodSchema('ticket_archives', TicketArchiveRecord);

export function createTableTicketArchives(): string {
  return getCreateTableQueryFromTable(ticket_archives, {
    ticket_id: `text primary key`,
    archived_at: `text not null`,
  });
}
