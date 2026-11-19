import { DurableObject } from 'cloudflare:workers';
import { createTableOrgDepartments, org_departments, OrgDepartmentRecord } from '../db/tables/org-departments.table';
import { createTableUserWorkstations, user_workstations, UserWorkstationRecord } from '../db/tables/user-workstations.table';
import { query } from '../util/query.util';
import { generateId, now } from '../util/id.util';
import { getDepartmentDOStub } from './Department.do';

const ORG_LOG = '[HelldeskOrg.do]';

/** Health watchdog interval — check department alarms every 5 minutes */
const WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * HelldeskOrgDO — per-org control-plane metadata for departments and workstations.
 *
 * Keying: one DO instance per org (keyed by `orgId`). A single
 * instance stores all departments an org owns plus their workstations.
 *
 * Mirrors HelldeskUserDO but for org ownership. Departments are created by
 * a specific org member (recorded in created_by_user_id) but owned
 * by the org.
 */
export class HelldeskOrgDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    void ctx.blockConcurrencyWhile(async () => {
      await this.ensureInitialized();
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    await this.initPromise;
  }

  private async initializeDatabase(): Promise<void> {
    query(this.sql, createTableOrgDepartments(), []);
    query(this.sql, createTableUserWorkstations(), []);
    // Arm the watchdog on every initialization so existing orgs (who
    // created departments before the watchdog was added) get health checks.
    await this.armWatchdogIfNeeded();
  }

  // ── Departments ─────────────────────────────────────────────────────────────

  async createDepartment(input: {
    name: string;
    owner_org_id: string;
    created_by_user_id: string;
  }): Promise<OrgDepartmentRecord> {
    await this.ensureInitialized();
    const id = generateId();
    const timestamp = now();
    console.log(
      `${ORG_LOG} createDepartment: id=${id} name=${input.name} owner_org=${input.owner_org_id} created_by=${input.created_by_user_id}`
    );

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${org_departments} (
          ${org_departments.columns.id},
          ${org_departments.columns.name},
          ${org_departments.columns.owner_org_id},
          ${org_departments.columns.created_by_user_id},
          ${org_departments.columns.created_at},
          ${org_departments.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [id, input.name, input.owner_org_id, input.created_by_user_id, timestamp, timestamp]
    );

    const department = this.getDepartment(id);
    if (!department) throw new Error('Failed to create department');
    console.log(`${ORG_LOG} createDepartment: created department id=${department.id}`);

    // Arm the health watchdog so it starts checking this department's alarm
    await this.armWatchdogIfNeeded();

    return department;
  }

  async getDepartmentAsync(departmentId: string): Promise<OrgDepartmentRecord | null> {
    await this.ensureInitialized();
    return this.getDepartment(departmentId);
  }

  private getDepartment(departmentId: string): OrgDepartmentRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${org_departments} WHERE ${org_departments.columns.id} = ?`, [
        departmentId,
      ]),
    ];
    if (rows.length === 0) return null;
    return OrgDepartmentRecord.parse(rows[0]);
  }

  async listDepartments(): Promise<OrgDepartmentRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `SELECT * FROM ${org_departments} ORDER BY ${org_departments.columns.created_at} DESC`,
        []
      ),
    ];
    return OrgDepartmentRecord.array().parse(rows);
  }

  // ── Workstations ──────────────────────────────────────────────────────────────

  async createWorkstation(input: {
    department_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    platform_integration_id?: string;
  }): Promise<UserWorkstationRecord> {
    await this.ensureInitialized();
    console.log(
      `${ORG_LOG} createWorkstation: department_id=${input.department_id} name=${input.name} git_url=${input.git_url} default_branch=${input.default_branch} integration=${input.platform_integration_id ?? 'none'}`
    );

    // Verify department exists
    const department = this.getDepartment(input.department_id);
    if (!department) {
      console.error(`${ORG_LOG} createWorkstation: department ${input.department_id} not found`);
      throw new Error(`Department ${input.department_id} not found`);
    }

    const id = generateId();
    const timestamp = now();

    query(
      this.sql,
      /* sql */ `
        INSERT INTO ${user_workstations} (
          ${user_workstations.columns.id},
          ${user_workstations.columns.department_id},
          ${user_workstations.columns.name},
          ${user_workstations.columns.git_url},
          ${user_workstations.columns.default_branch},
          ${user_workstations.columns.platform_integration_id},
          ${user_workstations.columns.created_at},
          ${user_workstations.columns.updated_at}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.department_id,
        input.name,
        input.git_url,
        input.default_branch,
        input.platform_integration_id ?? null,
        timestamp,
        timestamp,
      ]
    );

    const workstation = this.getWorkstation(id);
    if (!workstation) throw new Error('Failed to create workstation');
    console.log(`${ORG_LOG} createWorkstation: created workstation id=${workstation.id}`);
    return workstation;
  }

  async getWorkstationAsync(workstationId: string): Promise<UserWorkstationRecord | null> {
    await this.ensureInitialized();
    return this.getWorkstation(workstationId);
  }

  private getWorkstation(workstationId: string): UserWorkstationRecord | null {
    const rows = [
      ...query(this.sql, /* sql */ `SELECT * FROM ${user_workstations} WHERE ${user_workstations.columns.id} = ?`, [
        workstationId,
      ]),
    ];
    if (rows.length === 0) return null;
    return UserWorkstationRecord.parse(rows[0]);
  }

  async listWorkstations(departmentId: string): Promise<UserWorkstationRecord[]> {
    await this.ensureInitialized();
    const rows = [
      ...query(
        this.sql,
        /* sql */ `
          SELECT * FROM ${user_workstations}
          WHERE ${user_workstations.columns.department_id} = ?
          ORDER BY ${user_workstations.columns.created_at} DESC
        `,
        [departmentId]
      ),
    ];
    return UserWorkstationRecord.array().parse(rows);
  }

  async deleteWorkstation(workstationId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.getWorkstation(workstationId)) return false;
    query(this.sql, /* sql */ `DELETE FROM ${user_workstations} WHERE ${user_workstations.columns.id} = ?`, [
      workstationId,
    ]);
    return true;
  }

  async deleteDepartment(departmentId: string): Promise<boolean> {
    await this.ensureInitialized();
    if (!this.getDepartment(departmentId)) return false;
    // Cascade: delete all workstations belonging to this department first
    query(this.sql, /* sql */ `DELETE FROM ${user_workstations} WHERE ${user_workstations.columns.department_id} = ?`, [
      departmentId,
    ]);
    query(this.sql, /* sql */ `DELETE FROM ${org_departments} WHERE ${org_departments.columns.id} = ?`, [
      departmentId,
    ]);
    return true;
  }

  async ping(): Promise<string> {
    return 'pong';
  }

  // ── Health Watchdog ───────────────────────────────────────────────────

  /**
   * Arm the watchdog alarm if this org has any departments. Called after
   * creating a department to ensure the watchdog runs.
   */
  private async armWatchdogIfNeeded(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || currentAlarm < Date.now()) {
      const departments = OrgDepartmentRecord.array().parse([
        ...query(this.sql, /* sql */ `SELECT * FROM ${org_departments} LIMIT 1`, []),
      ]);
      if (departments.length > 0) {
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
      }
    }
  }

  /**
   * Watchdog alarm: periodically ping each department's DepartmentDO to verify its
   * alarm is firing and re-arm it if not. This is the external observer
   * that catches a silently broken alarm handler.
   *
   * See #442 — replaces the Boot agent's role from local HELLDESK.
   */
  async alarm(): Promise<void> {
    await this.ensureInitialized();
    const departments = OrgDepartmentRecord.array().parse([
      ...query(this.sql, /* sql */ `SELECT * FROM ${org_departments}`, []),
    ]);

    if (departments.length === 0) return;

    console.log(`${ORG_LOG} watchdog: checking ${departments.length} department(s)`);

    for (const department of departments) {
      try {
        const departmentStub = getDepartmentDOStub(this.env, department.id);
        const health = await departmentStub.healthCheck();
        if (!health.alarmSet) {
          console.warn(`${ORG_LOG} watchdog: re-armed alarm for department=${department.id} (was missing)`);
        }
      } catch (err) {
        console.error(`${ORG_LOG} watchdog: healthCheck failed for department=${department.id}:`, err);
      }
    }

    // Re-arm the watchdog
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_INTERVAL_MS);
  }
}

export function getHelldeskOrgStub(env: Env, orgId: string) {
  return env.HELLDESK_ORG.get(env.HELLDESK_ORG.idFromName(orgId));
}
