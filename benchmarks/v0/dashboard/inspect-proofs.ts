/** Inspect M3 regression proof DBs and the current demo DB. */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const base = join(repoRoot, '.local', 'benchmark', 'v0', 'm3-regression-proof');

function inspect(dbPath: string, label: string): void {
  if (!existsSync(dbPath)) {
    console.log(`${label}: missing ${dbPath}`);
    return;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const missions = db
      .query<{ mission_id: string; state: string; objective: string }, []>(
        `SELECT mission_id, state, objective FROM autonomy_missions ORDER BY created_at ASC`,
      )
      .all();
    console.log(`${label}: dbMtime=${statSync(dbPath).mtime.toISOString()} missions=${missions.length}`);
    for (const mission of missions) {
      console.log(`  ${mission.mission_id} ${mission.state} ${mission.objective.slice(0, 80)}`);
    }
  } finally {
    db.close();
  }
}

for (const entry of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const run = join(base, entry.name);
  inspect(join(run, 'proof.db'), entry.name);
}

const demoRoot = readdirSync(join(repoRoot, '.local', 'benchmark', 'v0', 'dashboard'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(repoRoot, '.local', 'benchmark', 'v0', 'dashboard', d.name, 'daemon', 'helldesk.db')))
  .map((d) => join(repoRoot, '.local', 'benchmark', 'v0', 'dashboard', d.name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (demoRoot) inspect(join(demoRoot, 'daemon', 'helldesk.db'), `DEMO ${demoRoot}`);
