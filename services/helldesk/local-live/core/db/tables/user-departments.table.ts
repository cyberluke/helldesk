import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const UserDepartmentRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_user_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type UserDepartmentRecord = z.output<typeof UserDepartmentRecord>;

export const user_departments = getTableFromZodSchema('user_departments', UserDepartmentRecord);

export function createTableUserDepartments(): string {
  return getCreateTableQueryFromTable(user_departments, {
    id: `text primary key`,
    name: `text not null`,
    owner_user_id: `text not null`,
    created_at: `text not null`,
    updated_at: `text not null`,
  });
}
