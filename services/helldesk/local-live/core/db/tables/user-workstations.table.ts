import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const UserWorkstationRecord = z.object({
  id: z.string(),
  department_id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  // nullable + optional: existing rows won't have this column at all (undefined),
  // new rows will have it as null or a string.
  platform_integration_id: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserWorkstationRecord = z.output<typeof UserWorkstationRecord>;

export const user_workstations = getTableFromZodSchema('user_workstations', UserWorkstationRecord);

export function createTableUserWorkstations(): string {
  return getCreateTableQueryFromTable(user_workstations, {
    id: `text primary key`,
    department_id: `text not null`,
    name: `text not null`,
    git_url: `text not null`,
    default_branch: `text not null default 'main'`,
    platform_integration_id: `text`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
