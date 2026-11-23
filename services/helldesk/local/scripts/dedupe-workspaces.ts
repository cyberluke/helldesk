/**
 * One-time admin merge of duplicate workspace identities.
 *
 * Usage:
 *   bun run scripts/dedupe-workspaces.ts            # dry run (safe)
 *   bun run scripts/dedupe-workspaces.ts --apply --force [--keep ws_...]
 *
 * Stop the local daemon before --apply. The script takes a consistent SQLite
 * backup (VACUUM INTO) beside the database, rewrites every workspace_id
 * reference in a transaction, and deletes only duplicates with no remaining
 * references. `--force` is the explicit "daemon stopped / backup approved"
 * acknowledgement.
 */
import { existsSync } from 'node:fs';
import { loadConfig, defaultDataDir, defaultDbPath } from '../src/config';
import { openDb } from '../src/db';
import { applyWorkspaceDedupe, planWorkspaceDedupe } from '../src/workspace-registry';

const config = loadConfig();
const dataDir = config.daemon.dataDir ?? defaultDataDir();
const dbPath = config.daemon.dbPath ?? defaultDbPath(dataDir);
const apply = process.argv.includes('--apply');
const forced = process.argv.includes('--force');
const keep: string[] = [];
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--keep' && process.argv[index + 1]) keep.push(process.argv[index + 1]!);
}

if (!existsSync(dbPath)) {
  console.error(`database not found: ${dbPath}`);
  process.exit(1);
}

const d = openDb(dbPath);
const plan = planWorkspaceDedupe(d, { keep });
if (plan.length === 0) {
  console.log(`No duplicate workspace identities in ${dbPath}`);
  d.close();
  process.exit(0);
}

console.log(`Database: ${dbPath}`);
console.log(`Duplicate workspace groups: ${plan.length}`);
for (const group of plan) {
  console.log(`\n  ${group.canonicalPath}`);
  console.log(`    keep   ${group.representative.workspaceId}  ${group.representative.path}`);
  for (const duplicate of group.duplicates) {
    console.log(`    merge  ${duplicate.workspaceId}  ${duplicate.path}`);
  }
}

if (!apply) {
  console.log('\nDry run only. Re-run with --apply --force after stopping the daemon.');
  d.close();
  process.exit(0);
}
if (!forced) {
  console.error('\nRefusing to apply without --force. Stop the daemon, then re-run with --apply --force.');
  d.close();
  process.exit(2);
}

const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
d.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`\nBackup: ${backup}`);

const result = applyWorkspaceDedupe(d, { keep });
console.log('\nApplied:');
console.log(`  groups merged: ${result.groups.length}`);
console.log(`  duplicate rows removed: ${result.removed}`);
for (const [table, changes] of Object.entries(result.updated)) {
  console.log(`  ${table}: ${changes} workspace_id reference(s) rewritten`);
}
if (result.leftover.length > 0) {
  console.log('\nLeftover rows (duplicate kept for manual review):');
  for (const item of result.leftover) console.log(`  ${item}`);
}
d.close();
