// probe-sqlite.mjs — reusable read-only probe for any HELLDESK bun:sqlite store.
// Usage: bun run scripts/probe-sqlite.mjs <path-to-sqlite> ["<sql>"] [json]
//   - no sql arg  -> list tables
//   - sql arg     -> run the query and print rows as JSON (or pretty when 'json' passed)
// Read-only: opens with readonly:true. Never mutates the store.
import { Database } from 'bun:sqlite';
const [dbPath, sql, mode] = process.argv.slice(2);
if (!dbPath) { console.error('usage: bun run scripts/probe-sqlite.mjs <db> [sql] [json]'); process.exit(2); }
const db = new Database(dbPath, { readonly: true });
if (!sql) {
  const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
  console.log(JSON.stringify(tables.map(t => t.name)));
  process.exit(0);
}
const rows = db.query(sql).all();
const out = mode === 'json' ? JSON.stringify(rows, null, 2) : JSON.stringify(rows);
console.log(out);