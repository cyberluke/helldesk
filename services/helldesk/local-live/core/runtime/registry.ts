/**
 * Local HELLDESK — DO runtime registry.
 *
 * Routes `env.department.get(env.department.idFromName(id))` to an in-process `LocalDepartment`
 * instance bound to a per-department LocalSqlStorage + LocalDurableObjectStorage.
 * This is the "durable object namespace" for the local single-user experience.
 */
import { join } from 'node:path';
import { LocalSqlStorage, doDbPath } from './sql';
import { LocalDurableObjectStorage } from './storage';
import { LocalDepartment } from './LocalDepartment';

export interface LocalDoNamespaceLike<TId extends { toString(): string } = { toString(): string }> {
  idFromName(name: string): TId;
  get(id: TId): any;
}

export interface LocalEnv {
  department: LocalDoNamespaceLike;
  DEPARTMENT_CONTAINER: LocalDoNamespaceLike;
  AGENT: LocalDoNamespaceLike;
  AGENT_IDENTITY: LocalDoNamespaceLike;
  HELLDESK_USER: LocalDoNamespaceLike;
  HELLDESK_ORG: LocalDoNamespaceLike;
  [key: string]: unknown;
}

/** A durable-object id wrapper (stable per name). */
export class LocalDoId {
  constructor(public readonly name: string) {}
  toString(): string { return `do:${this.name}`; }
}

export class LocalDoNamespace implements LocalDoNamespaceLike<LocalDoId> {
  constructor(private readonly factory: (name: string) => unknown) {}
  idFromName(name: string): LocalDoId { return new LocalDoId(name); }
  get(_id: LocalDoId): any { return this.factory(_id.name); }
}

export interface DepartmentRuntimeOptions {
  dataRoot: string;
}

export class LocalRuntime {
  readonly env: LocalEnv;
  private readonly departmentCache = new Map<string, LocalDepartment>();
  readonly dataRoot: string;

  constructor(opts: DepartmentRuntimeOptions) {
    this.dataRoot = opts.dataRoot;
    const self = this;
    this.env = {
      department: new LocalDoNamespace((name) => self.getDepartment(name)),
      DEPARTMENT_CONTAINER: new LocalDoNamespace((name) => self.getContainerStub(name)),
      AGENT: new LocalDoNamespace((name) => self.getAgentStub(name)),
      AGENT_IDENTITY: new LocalDoNamespace(() => ({ noop: true })),
      HELLDESK_USER: new LocalDoNamespace((name) => ({ getUser: async () => ({ user_id: name, name: 'local-dev' }) })),
      HELLDESK_ORG: new LocalDoNamespace((name) => ({ getOrg: async () => ({ org_id: name, name: 'local-dev' }) })),
    };
  }

  getDepartment(name: string): LocalDepartment {
    let t = this.departmentCache.get(name);
    if (!t) {
      const dbPath = doDbPath(this.dataRoot, 'department', name);
      const sql = new LocalSqlStorage(dbPath);
      const storage = new LocalDurableObjectStorage(join(this.dataRoot, `storage-${name}.json`));
      t = new LocalDepartment({ departmentId: name, sql, storage, dataRoot: this.dataRoot });
      this.departmentCache.set(name, t);
    }
    return t;
  }

  getContainerStub(_name: string): unknown {
    // No containerS locally (billing/containers excluded). Return a stub whose
    // health/status conform to a safe default; agent-run starts are no-ops.
    return {
      getBillingStatus: async () => ({ ok: true, running: false, estimated_charge: 0 }),
      warmUp: async () => {},
      setRunPolicy: async (p: unknown) => ({ ok: true }),
      setAccessRevoked: async (_r: boolean) => {},
      getContainerStatus: async () => ({ status: 'idle' }),
      fetch: async (_req: Request): Promise<Response> => new Response('no local container', { status: 200 }),
    };
  }

  /** List already-materialised department ids (for dashboard boot). */
  listDepartmentIds(): string[] {
    return Array.from(this.departmentCache.keys());
  }

  /** Start the colony reconciler on every materialised department. Idempotent. */
  startAllReconcilers(intervalMs = 5_000): () => void {
    const stops: Array<() => void> = [];
    for (const t of this.departmentCache.values()) {
      stops.push(t.startReconciler(intervalMs));
    }
    return () => {
      for (const s of stops) s();
    };
  }

  getAgentStub(_name: string): unknown {
    return {
      appendAgentEvent: async () => {},
      getAgentEvents: async () => [],
      fetch: async (_req: Request): Promise<Response> => new Response('no local agent container', { status: 200 }),
    };
  }
}

/** Create the local runtime + env for a given data root. */
export function createLocalRuntime(dataRoot: string): LocalRuntime {
  return new LocalRuntime({ dataRoot });
}