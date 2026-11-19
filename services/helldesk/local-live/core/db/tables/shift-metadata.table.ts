import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const ShiftMergeMode = z.enum(['review-then-land', 'review-and-merge']);
export type ShiftMergeMode = z.output<typeof ShiftMergeMode>;

export const ShiftMetadataRecord = z.object({
  ticket_id: z.string(),
  total_tickets: z.number(),
  closed_tickets: z.number(),
  landed_at: z.string().nullable(),
  /** The long-lived feature branch for this shift. Sub-tickets branch from and merge into this. */
  feature_branch: z.string().nullable(),
  /**
   * Controls how the qualityAssurance handles ticket completions within a shift:
   * - 'review-then-land': QualityAssurance reviews each ticket on the feature branch; only at the
   *   end of the shift does a PR or merge into main occur. (Default)
   * - 'review-and-merge': QualityAssurance reviews AND merges/creates PR for each ticket
   *   individually, like standalone tickets.
   */
  merge_mode: ShiftMergeMode.nullable(),
  /** 1 = staged (planned, agents not dispatched), 0 = active (SQLite boolean) */
  staged: z.number().int().default(0),
});

export type ShiftMetadataRecord = z.output<typeof ShiftMetadataRecord>;

export const shift_metadata = getTableFromZodSchema('shift_metadata', ShiftMetadataRecord);

export function createTableShiftMetadata(): string {
  return getCreateTableQueryFromTable(shift_metadata, {
    ticket_id: `text primary key references tickets(ticket_id)`,
    total_tickets: `integer not null default 0`,
    closed_tickets: `integer not null default 0`,
    landed_at: `text`,
    feature_branch: `text`,
    merge_mode: `text check(merge_mode in ('review-then-land', 'review-and-merge'))`,
    staged: `integer not null default 0`,
  });
}

/** Idempotent ALTER statements for existing databases. */
export function migrateShiftMetadata(): string[] {
  return [
    `ALTER TABLE shift_metadata ADD COLUMN feature_branch text`,
    `ALTER TABLE shift_metadata ADD COLUMN merge_mode text check(merge_mode in ('review-then-land', 'review-and-merge'))`,
    `ALTER TABLE shift_metadata ADD COLUMN staged integer not null default 0`,
  ];
}
