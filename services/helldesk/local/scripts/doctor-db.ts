/**
 * Database half of `scripts/doctor.ps1`: read-only health snapshot of the local
 * control-plane SQLite store. Never mutates. Exit 1 when the schema is behind or
 * duplicate workspace identities still exist.
 */
import { existsSync } from 'node:fs';
import { loadConfig, defaultDataDir, defaultDbPath } from '../src/config';
import { LATEST_MIGRATION_VERSION, MIGRATION_COUNT, openDb } from '../src/db';
import { planWorkspaceDedupe } from '../src/workspace-registry';

const config = loadConfig();
const dataDir = config.daemon.dataDir ?? defaultDataDir();
const dbPath = config.daemon.dbPath ?? defaultDbPath(dataDir);

if (!existsSync(dbPath)) {
  console.log(`DB      FAIL  ${dbPath} (missing)`);
  process.exit(1);
}

const d = openDb(dbPath);
try {
  const userVersion = (d.db.query('PRAGMA user_version').get() as { user_version: number } | null)?.user_version ?? 0;
  const missions = d.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM autonomy_missions`).get()?.n ?? 0;
  const tickets = d.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM mission_tickets`).get()?.n ?? 0;
  const jobs = d.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM review_jobs`).get()?.n ?? 0;
  const workspaces = d.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM workspaces`).get()?.n ?? 0;
  const active = d.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM autonomy_missions WHERE state NOT IN ('VERIFIED_10_10','CANCELLED')`)
    .get()?.n ?? 0;
  const missionColumns = d.db
    .query<{ name: string }, []>(`PRAGMA table_info(autonomy_missions)`)
    .all()
    .map((column) => column.name);
  // A schema-behind DB must not crash the doctor: report the migration gap and
  // skip columns introduced by the pending migration.
  const awaitingRows = missionColumns.includes('human_acceptance')
    ? d.db
        .query<{ state: string; human_acceptance: string | null }, []>(
          `SELECT state, human_acceptance FROM autonomy_missions WHERE state='VERIFIED_10_10'`
        )
        .all()
    : [];
  const awaiting = awaitingRows.filter((row) => row.human_acceptance !== 'accepted').length;
  const queue = d.db
    .query<{ state: string; n: number }, []>(`SELECT state, COUNT(*) AS n FROM review_jobs GROUP BY state ORDER BY state`)
    .all();
  const duplicates = planWorkspaceDedupe(d);

  const schemaOk = userVersion >= LATEST_MIGRATION_VERSION;
  console.log(`DB      ${schemaOk ? 'PASS' : 'FAIL'}  ${dbPath}`);
  console.log(`        schema user_version=${userVersion} latest=${LATEST_MIGRATION_VERSION} (${MIGRATION_COUNT} migrations)`);
  console.log(`        missions=${missions} active=${active} awaiting_acceptance=${awaiting} tickets=${tickets} review_jobs=${jobs} workspaces=${workspaces}`);
  console.log(`        review queue: ${queue.map((row) => `${row.state}=${row.n}`).join(' ') || 'empty'}`);
  console.log(`        duplicate workspace groups: ${duplicates.length}`);
  for (const group of duplicates) {
    console.log(`          ${group.canonicalPath} → keep ${group.representative.workspaceId} (${group.duplicates.length} duplicate(s))`);
  }
  if (!schemaOk || duplicates.length > 0) process.exitCode = 1;
} finally {
  d.close();
}
