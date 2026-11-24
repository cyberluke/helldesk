/**
 * Prepare an isolated dashboard demo from a completed M3 proof DB.
 *
 * Copies the proof DB into a throwaway demo data dir, registers the proof
 * workspace for display, and writes a benchmark control-plane config on port
 * 4791. The production config is never read for writing and never modified.
 *
 * Usage:
 *   bun run benchmarks/v0/dashboard/prepare-demo.ts [--proof-db <path>]
 *
 * Output (parseable):
 *   DEMO_ROOT=...
 *   CONFIG=...
 *   DAEMON_URL=http://127.0.0.1:4791
 *   DASHBOARD_URL=http://127.0.0.1:8792/
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalWorkspacePath } from '../../../services/helldesk/local/src/workspace-registry';

const repoRoot = process.cwd();
const proofRoot = join(repoRoot, '.local', 'benchmark', 'v0', 'm3-regression-proof');

function latestProof(): { db: string; run: string } | null {
  if (!existsSync(proofRoot)) return null;
  const dirs = readdirSync(proofRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const run = join(proofRoot, d.name);
      const db = join(run, 'proof.db');
      return { run, db, mtime: existsSync(db) ? statSync(db).mtimeMs : 0 };
    })
    .filter((d) => d.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime);
  return dirs[0] ? { db: dirs[0].db, run: dirs[0].run } : null;
}

const argProofIdx = process.argv.indexOf('--proof-db');
const explicitProof = argProofIdx >= 0 ? process.argv[argProofIdx + 1] : undefined;
const proof = explicitProof
  ? { db: explicitProof, run: join(explicitProof, '..') }
  : latestProof();
if (!proof) throw new Error('no M3 regression proof DB found; run benchmarks/v0/m3-regression-proof.ts first');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const demoRoot = join(repoRoot, '.local', 'benchmark', 'v0', 'dashboard', stamp);
const daemonDir = join(demoRoot, 'daemon');
const liveDir = join(demoRoot, 'local-live');
const captureDir = join(demoRoot, 'capture');
mkdirSync(daemonDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
mkdirSync(captureDir, { recursive: true });

const targetDb = join(daemonDir, 'helldesk.db');
copyFileSync(proof.db, targetDb);
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(`${proof.db}${suffix}`)) copyFileSync(`${proof.db}${suffix}`, `${targetDb}${suffix}`);
}

const db = new Database(targetDb);
try {
  const mission = db
    .query<{ workspace_id: string }, []>(`SELECT workspace_id FROM autonomy_missions ORDER BY created_at DESC LIMIT 1`)
    .get();
  const workspaceId = mission?.workspace_id ?? 'ws_m3_regression_proof';
  const proofWorkspace = join(proof.run, 'workspace');
  const workspacePath = existsSync(proofWorkspace) ? proofWorkspace : join(repoRoot, 'benchmarks', 'v0', 'visual-fixture');
  db.query(
    `INSERT INTO workspaces (workspace_id, path, enabled, created_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET path=excluded.path, enabled=1`
  ).run(workspaceId, canonicalWorkspacePath(workspacePath), new Date().toISOString());
} finally {
  db.close();
}

const production = JSON.parse(readFileSync(join(repoRoot, 'services', 'helldesk', 'local', 'config.json'), 'utf8')) as Record<string, unknown>;
const benchmarkConfig = {
  ...production,
  daemon: {
    ...(production.daemon as Record<string, unknown> | undefined),
    bind: '127.0.0.1',
    port: 4791,
    dataDir: daemonDir,
    production: true,
    detachedWorkers: true,
    maxConcurrentJobs: 1,
    leaseSeconds: 30,
  },
  autonomy: {
    ...(production.autonomy as Record<string, unknown> | undefined),
    // The copied mission is terminal; do not let the demo daemon mutate anything.
    enabled: false,
  },
  workspaces: [],
};
const configPath = join(demoRoot, 'benchmark-demo.config.json');
writeFileSync(configPath, JSON.stringify(benchmarkConfig, null, 2), 'utf8');

console.log(`DEMO_ROOT=${demoRoot}`);
console.log(`CONFIG=${configPath}`);
console.log(`DAEMON_URL=http://127.0.0.1:4791`);
console.log(`DASHBOARD_URL=http://127.0.0.1:8792/`);
console.log(`CAPTURE_DIR=${captureDir}`);
