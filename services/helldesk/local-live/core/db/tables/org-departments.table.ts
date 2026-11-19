import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const OrgDepartmentRecord = z.object({
  id: z.string(),
  name: z.string(),
  owner_org_id: z.string(),
  created_by_user_id: z.string(), // userId of the member who created it
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrgDepartmentRecord = z.output<typeof OrgDepartmentRecord>;

export const org_departments = getTableFromZodSchema('org_departments', OrgDepartmentRecord);

export function createTableOrgDepartments(): string {
  return getCreateTableQueryFromTable(org_departments, {
    id: 'text primary key',
    name: 'text not null',
    owner_org_id: 'text not null',
    created_by_user_id: 'text not null',
    created_at: 'text not null',
    updated_at: 'text not null',
  });
}
