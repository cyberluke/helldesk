#!/usr/bin/env bun
/**
 * migrate-db-gastown-to-helldesk.mjs
 *
 * FULL-RENAME data migration for the local control-plane kanban DB.
 *
 * Why this exists (the rename saga):
 *   The runtime DB that the helldesk server uses is config.json `daemon.dataDir`
 *   -> <dataDir>/helldesk.db. It was created fresh (schema-only rename: beads ->
 *   tickets, towns -> departments etc.), with ALL 7 migrations applied but ZERO
 *   rows. The REAL kanban data still lives in the pre-rename
 *   ...\CyberLuke\LocalGasTown\gastown.db under the OLD table/column names
 *   (mission_beads / bead_revisions / bead_dependencies / current_bead_id).
 *
 *   This script performs a FULL data migration: it copies every row of the
 *   populated source DB into the authoritative new schema (the code-canonical
 *   helldesk.db created by the renamed application), renaming tables AND columns
 *   to the helldesk names so the server sees the real mission/ticket/revision
 *   history, NOT an empty kanban. It does NOT repoint dataDir or rename files in
 *   place; it produces a fully-renamed, fully-populated target DB.
 *
 * Rename map (old -> new, derived by diffing the two schemas):
 *   mission_beads          -> mission_tickets      (bead_id            -> ticket_id)
 *   bead_revisions         -> ticket_revisions     (bead_id            -> ticket_id)
 *   bead_dependencies      -> ticket_dependencies   (bead_id -> ticket_id,
 *                                                    depends_on_bead_id -> depends_on_ticket_id)
 *   autonomy_missions.col  current_bead_id         -> current_ticket_id
 *
 * Everything else is a same-name 1:1 column copy. All id VALUES are opaque keys
 * and are preserved verbatim (bead_... values become ticket_... column values;
 * the code treats them as opaque identities).
 *
 * Safety / correctness guarantees:
 *   - The source is opened READ-ONLY. The output goes to a NEW file; the live
 *     <dataDir>/helldesk.db is only replaced AFTER every check passes.
 *   - Runs inside a single WRITE transaction (all-or-nothing) with
 *     `PRAGMA foreign_keys=OFF` during load, so cross-table FKs (evidence,
 *     quality_gate_results, repair_plans -> ticket_revisions) are not rechecked
 *     mid-copy (they are valid at the end, which we verify with
 *     `PRAGMA foreign_key_check`).
 *   - After load: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, row-count
 *     parity per table, and `PRAGMA user_version` (must stay 7).
 *   - Prints a human-readable manifest.
 *
 * Usage:
 *   bun run migrate-db-gastown-to-helldesk.mjs [source] [target-schema] [output] [--apply]
 *
 *   source        populated old DB (default: <LOCALAPPDATA>\CyberLuke\LocalGasTown\gastown.db)
 *   target-schema empty new-schema DB (default: <LOCALAPPDATA>\CyberLuke\LocalGasDepartment\helldesk.db)
 *   output        staged output file (default: <target-schema-dir>\helldesk.db.migrated)
 *   --apply       replace the live target-schema with the staged output (after it passes)
 *
 * Without --apply this is a pure staging dry-run: it builds the migrated file and
 * prints the manifest; it does NOT touch the live helldesk.db.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, copyFileSync, rmSync } from "node:fs";

const defaultSource = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CyberLuke", "LocalGasTown", "gastown.db");
const defaultTemplate = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CyberLuke", "LocalGasDepartment", "helldesk.db");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const positional = args.filter((a) => a !== "--apply");
const sourcePath = resolve(positional[0] ?? defaultSource);
const templatePath = resolve(positional[1] ?? defaultTemplate);
const outputPath = resolve(positional[2] ?? join(dirname(templatePath), "helldesk.db.migrated"));

if (!existsSync(sourcePath)) { console.error(`[migrate] source not found: ${sourcePath}`); process.exit(2); }
if (!existsSync(templatePath)) { console.error(`[migrate] target-schema (template) not found: ${templatePath}`); process.exit(2); }

/** Rename map: sourceTable -> { targetTable, columnMap (srcCol -> tgtCol) } */
const TABLE_RENAME = {
  mission_beads: { targetTable: "mission_tickets", columnMap: { bead_id: "ticket_id" } },
  bead_revisions: { targetTable: "ticket_revisions", columnMap: { bead_id: "ticket_id" } },
  bead_dependencies: { targetTable: "ticket_dependencies", columnMap: { bead_id: "ticket_id", depends_on_bead_id: "depends_on_ticket_id" } },
  // autonomy_missions is the SAME table name in both; only the column is renamed.
  autonomy_missions: { targetTable: "autonomy_missions", columnMap: { current_bead_id: "current_ticket_id" } },
};

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((c) => c.name);
}

function quoteId(c) { return `"${c.replace(/"/g, '""')}"`; }

// ── Read schema + source data (source is READ-ONLY) ──────────────────────────
const src = new Database(sourcePath, { readonly: true });
const srcTables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
const srcCols = new Map();
for (const t of srcTables) srcCols.set(t, tableColumns(src, t));

// Template (authoritative new schema) — authoritative column list per target
const tpl = new Database(templatePath, { readonly: true });
const tplTables = tpl.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const tplCols = new Map();
for (const t of tplTables) tplCols.set(t, tableColumns(tpl, t));
const tplUserVersion = Number(tpl.prepare("PRAGMA user_version").get().user_version);
tpl.close();

console.log(`[migrate] source rows/tables -> ${srcTables.size} tables in ${sourcePath}`);
console.log(`[migrate] template schema -> ${tplTables.length} tables in ${templatePath} (user_version=${tplUserVersion})`);

// Build plan: for each target table in template, find the source table + column map
const plan = [];
for (const tgt of tplTables) {
  // Resolve the source table for this target
  let srcTable = tgt;
  let colMap = {};
  for (const [s, r] of Object.entries(TABLE_RENAME)) {
    if (r.targetTable === tgt) { srcTable = s; colMap = { ...r.columnMap }; break; }
  }
  if (!srcTables.has(srcTable)) {
    console.error(`[migrate] ABORT: no source table for target '${tgt}' (expected '${srcTable}').`);
    process.exit(2);
  }
  // Reverse map: targetCol -> sourceCol
  const reverse = {};
  for (const [sc, tc] of Object.entries(colMap)) reverse[tc] = sc;
  const tgtCols = tplCols.get(tgt);
  const srcColList = tgtCols.map((tc) => reverse[tc] ?? tc);
  // Validate all source columns exist
  const srcHave = new Set(srcCols.get(srcTable));
  const missing = srcColList.filter((c) => !srcHave.has(c));
  if (missing.length) {
    console.error(`[migrate] ABORT: source '${srcTable}' missing columns for target '${tgt}': ${missing.join(', ')}`);
    process.exit(2);
  }
  plan.push({ targetTable: tgt, sourceTable: srcTable, targetCols: tgtCols, sourceCols: srcColList, isRenamed: tgt !== srcTable || Object.keys(colMap).length > 0 });
}

// ── Stage the output: get a self-contained WAL-consistent copy of the template,
//    then load data into it. A raw file copy is UNSAFE here: the live template is
//    WAL-mode and may hold its schema+data in an uncheckpointed `-wal`, so copying
//    only the main `.db` file yields a broken/empty shell. `VACUUM INTO` checkpoints
//    and writes a fully standalone database (all tables + current data), which is
//    the correct base schema for the migration.
if (existsSync(outputPath)) rmSync(outputPath);
{
  const snap = new Database(templatePath, { readonly: true });
  snap.run(`VACUUM INTO '${outputPath.replace(/'/g, "''")}'`);
  snap.close();
}
const out = new Database(outputPath);
out.run("PRAGMA foreign_keys=OFF");
// Attach the populated source so one connection can read FROM it while INSERTing
// into the output's new-schema tables. `src` resolves only within this connection.
out.run(`ATTACH '${sourcePath.replace(/'/g, "''")}' AS src`);
out.run("BEGIN");
try {
  for (const p of plan) {
    const colsQ = p.targetCols.map(quoteId).join(", ");
    const srcQ = p.sourceCols.map(quoteId).join(", ");
    // Clear any schema-template rows (e.g. benign events from the empty server)
    // so the migrated file carries ONLY the real source data.
    out.run(`DELETE FROM ${quoteId(p.targetTable)}`);
    const sql = `INSERT INTO ${quoteId(p.targetTable)} (${colsQ}) SELECT ${srcQ} FROM src.${quoteId(p.sourceTable)}`;
    out.run(sql);
  }
  out.run("COMMIT");
  out.run("DETACH src");
} catch (e) {
  try { out.run("ROLLBACK"); } catch {}
  out.close();
  console.error(`[migrate] data load failed: ${e.message}`);
  process.exit(1);
}
out.run("PRAGMA foreign_keys=ON");
out.close();

// ── Verify the staged output ─────────────────────────────────────────────────
const verify = new Database(outputPath, { readonly: true });
const checks = {};
// row-count parity per table
for (const p of plan) {
  const s = Number(src.prepare(`SELECT COUNT(*) n FROM ${quoteId(p.sourceTable)}`).get().n);
  const t = Number(verify.prepare(`SELECT COUNT(*) n FROM ${quoteId(p.targetTable)}`).get().n);
  checks[`${p.sourceTable}->${p.targetTable}`] = { srcRows: s, tgtRows: t, ok: s === t };
}
// integrity
const integrity = verify.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
checks.integrity_check = integrity.filter((v) => v !== "ok").length === 0;
// fk
const fkViol = verify.prepare("PRAGMA foreign_key_check").all();
checks.foreign_key_check = fkViol.length === 0;
// user_version preserved
const ver = Number(verify.prepare("PRAGMA user_version").get().user_version);
checks.user_version = ver === tplUserVersion;
verify.close();

console.log("\n[migrate] verifying staged output:", outputPath);
let allOk = true;
// table-by-table row parity
for (const [k, v] of Object.entries(checks)) {
  if (typeof v === "object" && v !== null && "srcRows" in v) {
    const ok = v.ok === true;
    if (!ok) allOk = false;
    console.log(`  [${ok ? "OK  " : "FAIL"}] ${k}  src=${v.srcRows} -> tgt=${v.tgtRows}`);
  }
}
const report = (label, pass) => { if (!pass) allOk = false; console.log(`  [${pass ? "OK  " : "FAIL"}] ${label}`); };
report("integrity_check", checks.integrity_check === true);
report("foreign_key_check", checks.foreign_key_check === true);
report(`user_version=${ver}`, checks.user_version === true);
src.close();

if (!allOk) {
  console.error(`\n[migrate] RESULT: FAILED — staged file kept at ${outputPath} for inspection, live DB NOT touched.`);
  process.exit(1);
}

if (!apply) {
  console.log(`\n[migrate] RESULT: PASS (staging dry-run). Live helldesk.db NOT touched.`);
  console.log(`[migrate] Staged migrated DB: ${outputPath}`);
  console.log(`[migrate] To apply (replace the live DB), re-run WITHOUT the output arg but WITH --apply.`);
  process.exit(0);
}

// ── Apply: replace the live template DB with the staged, verified output ─────
// Keep a backup of the (currently empty) live DB before replacing it.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const liveBackup = `${templatePath}.pre-migration-${stamp}.bak`;
copyFileSync(templatePath, liveBackup);
rmSync(templatePath);
copyFileSync(outputPath, templatePath);
console.log(`\n[migrate] APPLIED: live DB replaced.`);
console.log(`[migrate]   live now:   ${templatePath}`);
console.log(`[migrate]   backup:     ${liveBackup}`);
console.log(`[migrate]   staged:     ${outputPath}`);
process.exit(0);