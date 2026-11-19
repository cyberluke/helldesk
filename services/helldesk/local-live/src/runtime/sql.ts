/**
 * Local HELLDESK — SqlStorage-compatible implementation over `bun:sqlite`.
 *
 * The Cloudflare HELLDESK domain (dos/department/*, db/tables) drives every query
 * through `util/query.util.ts` `query(sql, stmt, ...params)` which calls
 * `sql.exec(stmt, ...params)` and expects a **spreadable/iterable** cursor
 * with `toArray()/raw()/one()/meta()`. This is the single storage contract we
 * must satisfy to federate all of the domain logic locally.
 *
 * Bun's `bun:sqlite` runs in-process (no blocking subprocess), so this is the
 * daemon-safe, keep-alive/SSE friendly persistence layer.
 */
import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SqlStorageValue = string | number | bigint | Uint8Array | null;
export type SqlStorageRow = Record<string, SqlStorageValue>;

/** SQLite column metadata. */
export interface SqliteColumnMeta {
  name: string;
  type?: string;
}

/**
 * Execute a statement against bun:sqlite, returning rows for SELECT-like
 * statements and [] for DDL/DML. `db.exec()` runs DDL/multi-statement; `.all()`
 * yields rows for SELECT; `.run()` handles parameterized DML.
 */
export function executeStatement(db: Database, rawSql: string, params: unknown[]): SqlStorageRow[] {
  const sql = rawSql.trim().replace(/;+\s*;?$/g, '');
  const head = sql.slice(0, 48).toUpperCase();
  const yieldsRows =
    /^SELECT|^WITH|^EXPLAIN|^PRAGMA table_info|^PRAGMA table_xinfo|^PRAGMA [a-z_]+\(/.test(head) &&
    !/^PRAGMA (journal_mode|busy_timeout|synchronous|foreign_keys)/.test(head);
  if (yieldsRows) {
    return db.query(sql).all(...(params as SQLQueryBindings[])) as SqlStorageRow[];
  }
  // DDL / parameterless DML → db.exec (multi-statement capable).
  if (params.length === 0) {
    db.exec(sql);
  } else {
    db.query(sql).run(...(params as SQLQueryBindings[]));
  }
  return [];
}

/**
 * Iterable cursor matching Cloudflare's SqlStorageCursor surface. Every domain
 * read either spreads it (`...sql.exec(...)`, `[...query(...)]`) or calls one
 * of the helper methods below. The statement is EXECUTED EAGERLY at construction
 * so DML/DDL with an ignored cursor (the common domain pattern) still runs.
 */
export class LocalSqlStorageCursor implements Iterable<SqlStorageRow> {
  private executedRows: SqlStorageRow[];
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly params: unknown[],
    private readonly columnMeta: SqliteColumnMeta[] = [],
  ) {
    this.executedRows = [];
    // Eager execution: side-effecting statements must run even if the returned
    // cursor is never consumed (the domain calls `query(sql, INSERT...)` and
    // discards the cursor, relying on Cloudflare's `exec` executing inline).
    this.executedRows = executeStatement(db, sql, params);
  }

  private rows(): SqlStorageRow[] {
    return this.executedRows;
  }

  /** Iterable protocol: spread support (`...exec(...)`). */
  [Symbol.iterator](): Iterator<SqlStorageRow> {
    return this.rows()[Symbol.iterator]();
  }

  toArray(): SqlStorageRow[] {
    return this.rows();
  }

  raw(): unknown[][] {
    return this.rows().map((r) => Object.values(r));
  }

  one(): SqlStorageRow | null {
    return this.rows()[0] ?? null;
  }

  meta(): { columns: SqliteColumnMeta[] } {
    return { columns: this.columnMeta };
  }
}

/**
 * A SQLite-backed SqlStorage. One instance = one Durable-Object-equivalent
 * database file (department-<id>.sqlite, agent-<id>.sqlite, ...).
 */
export class LocalSqlStorage implements Iterable<SqlStorageRow> {
  readonly db: Database;
  readonly name: string;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.name = dbPath;
  }

  /** The iterator contract forwards to exec of a single "SELECT 1". */
  [Symbol.iterator](): Iterator<SqlStorageRow> {
    return this.exec('SELECT 1 as _one')[Symbol.iterator]();
  }

  /**
   * Execute a statement with positional params, returning an iterable cursor.
   * Supports DDL, DML, SELECT, and SAVEPOINT/ROLLBACK/RELEASE (raw SQL).
   */
  exec(query: string, ...params: unknown[]): LocalSqlStorageCursor {
    return new LocalSqlStorageCursor(this.db, query, params);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

/** Deterministic per-DO DB path inside a root data dir. */
export function doDbPath(dataRoot: string, kind: 'department' | 'agent' | 'container' | 'identity' | 'user' | 'org', id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dataRoot, `${kind}-${safe}.sqlite`);
}

export { join as doJoin };