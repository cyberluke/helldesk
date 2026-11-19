import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite access for the local control plane.
 *
 * WAL mode, busy_timeout, foreign keys ON, and versioned transactional
 * migrations. A failed migration leaves the original DB recoverable
 * because we stage schema into the same file inside a transaction and
 * roll back on error.
 */

export interface Db {
  path: string;
  db: Database;
  runMigration(): void;
  /** Transactional wrapper — commit on success, rollback on throw. */
  tx<T>(fn: (t: Database) => T): T;
  close(): void;
}

const MIGRATIONS: Array<{ version: number; file: string }> = [
  { version: 1, file: '0001_schema.sql' },
  { version: 2, file: '0002_control_plane.sql' },
  { version: 3, file: '0003_event_journal.sql' },
  { version: 4, file: '0004_ender_loop.sql' },
  { version: 5, file: '0005_mission_task_gates.sql' },
  { version: 6, file: '0006_mission_idempotency.sql' },
  { version: 7, file: '0007_mission_engine_matrix.sql' },
  { version: 8, file: '0008_job_transcript.sql' },
];

export function openDb(dbPath: string, opts?: { readonly?: boolean }): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  // Bun's SQLite Database treats an explicit `readonly:false` as invalid on
  // some versions; only pass the option when it is actually `true`.
  const db = opts?.readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
  // WAL gives crash-safety and single-writer semantics. On some mounts
  // (e.g. 8.3-short temp paths on Windows) SQLite cannot create -wal/-shm
  // files; fall back to journal DELETE mode so tests and constrained paths
  // still work. Production state dir (%LOCALAPPDATA%) supports WAL.
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    try {
      db.exec('PRAGMA journal_mode = DELETE;');
    } catch {
      /* leave default journaling */
    }
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  const runMigration = (): void => {
    const current = (db.query('PRAGMA user_version').get() as { user_version: number })
      ?.user_version ?? 0;
    for (const m of MIGRATIONS) {
      if (current < m.version) {
        const sql = readFileSync(fileURLToPath(new URL(`./migrations/${m.file}`, import.meta.url)), 'utf8');
        db.transaction(() => {
          db.exec(sql);
          db.exec(`PRAGMA user_version = ${m.version};`);
        })();
      }
    }
  };

  const tx = <T>(fn: (t: Database) => T): T => {
    const run = db.transaction(() => fn(db)) as () => T;
    return run();
  };

  return { path: dbPath, db, runMigration, tx, close: () => db.close() };
}

/** Recover all pending durable work after startup (idempotent with re-apply). */
export function recoverPendingJobs(d: Db): { restarted: string[] } {
  const rows = d.db
    .query<{ job_id: string; state: string }, []>(
      `SELECT job_id, state FROM review_jobs
       WHERE state IN ('DISCOVERED','SNAPSHOTTED','QUEUED','REVIEWING_A_B','ADJUDICATING')`
    )
    .all();
  const now = new Date().toISOString();
  for (const row of rows) {
    if (row.state !== 'QUEUED') {
      // Stale in-flight job: reset lease-held attempts and return to queue.
      d.db.query(`UPDATE review_jobs SET state='QUEUED', updated_at=? WHERE job_id=?`).run(
        now,
        row.job_id
      );
    }
  }
  return { restarted: rows.map((r) => r.job_id) };
}
