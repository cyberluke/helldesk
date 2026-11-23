/**
 * backfill-mission-workstations.ts — one-shot, idempotent repair of the local
 * department board after the department store was reset.
 *
 * WHY: engine missions are projected read-only onto the board with
 * `workstation_id = null` (mission-reconcile.ts). A workstation page only lists
 * LOCAL tickets, so a freshly created workstation (Delta) made every older
 * mission disappear from Local. The engine has no workstation column; the local
 * department store is the only place the binding can live. This script
 * materialises one local ticket per unbound engine mission, carrying the real
 * `metadata.local_mission` binding (so the projection folds instead of
 * duplicating) and assigning it to the requested workstation.
 *
 * SAFETY:
 *   - dry-run by default; pass --apply to write;
 *   - VACUUM INTO backup before any write;
 *   - one BEGIN IMMEDIATE transaction;
 *   - INSERT OR IGNORE on a deterministic id (`local-<missionId>`), so re-running
 *     is a no-op;
 *   - never touches a mission that already has a local ticket (SOL98 stays on
 *     Delta), and never moves agent rows (crew agents are department-scoped).
 *
 * USAGE:
 *   bun run scripts/backfill-mission-workstations.ts            # dry run
 *   bun run scripts/backfill-mission-workstations.ts --apply    # write
 *
 * Optional: --target=<workstation-id> (default workstation-local),
 *           --db=<department sqlite>, --engine-db=<control-plane sqlite>
 */
import { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..', '..'); // <repo>

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const arg = (name: string): string | undefined => {
  const hit = args.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const dataRoot = process.env.HELLDESK_DATA_ROOT ?? join(pkgRoot, 'data');
const departmentDbPath = resolve(arg('db') ?? join(dataRoot, 'department-default.sqlite'));

/** The control-plane DB lives beside its token; config.json is authoritative. */
function resolveEngineDb(): string {
  const explicit = arg('engine-db');
  if (explicit) return resolve(explicit);
  try {
    const config = JSON.parse(readFileSync(join(repoRoot, 'services', 'helldesk', 'local', 'config.json'), 'utf8')) as {
      daemon?: { dataDir?: string };
    };
    const dataDir = config.daemon?.dataDir;
    if (dataDir) return join(dataDir, 'helldesk.db');
  } catch {
    /* fall through to the default profile location */
  }
  return join(process.env.LOCALAPPDATA ?? '', 'HELLDESK', 'LocalDepartment', 'helldesk.db');
}
const engineDbPath = resolveEngineDb();
const targetWorkstationId = arg('target') ?? 'workstation-local';

for (const [label, path] of [['department DB', departmentDbPath], ['engine DB', engineDbPath]] as const) {
  if (!existsSync(path)) {
    console.error(`[backfill] ${label} not found: ${path}`);
    process.exit(1);
  }
}

type MissionRow = {
  mission_id: string;
  state: string;
  human_acceptance: string | null;
  verified_at: string | null;
  created_at: string;
  objective: string;
  workspace_path: string | null;
  ticket_title: string | null;
};

const engine = new Database(engineDbPath, { readonly: true });
const missions = engine
  .query(
    `SELECT m.mission_id, m.state, m.human_acceptance, m.verified_at, m.created_at, m.objective,
            w.path AS workspace_path,
            (SELECT t.title FROM mission_tickets t WHERE t.mission_id = m.mission_id
              ORDER BY t.created_at ASC LIMIT 1) AS ticket_title
       FROM autonomy_missions m
       LEFT JOIN workspaces w ON w.workspace_id = m.workspace_id
      ORDER BY m.created_at ASC`,
  )
  .all() as MissionRow[];
engine.close();

const department = new Database(departmentDbPath);
department.exec('PRAGMA busy_timeout = 5000');

const workstation = department
  .query('SELECT id, name FROM workstations WHERE id = ?')
  .get(targetWorkstationId) as { id: string; name: string } | null;
if (!workstation) {
  console.error(`[backfill] target workstation not found: ${targetWorkstationId}`);
  department.close();
  process.exit(1);
}

/** Board status mirrors mission-reconcile.ts missionBoardStatus(). */
function boardStatus(state: string, humanAcceptance: string | null): string {
  const s = (state ?? '').toUpperCase();
  const accepted = humanAcceptance === 'accepted';
  if (s === 'CANCELLED' || s === 'CLOSED' || (s === 'VERIFIED_10_10' && accepted)) return 'closed';
  if (s === 'VERIFIED_10_10') return 'in_review';
  if (['BLOCKED', 'BLOCKED_EXTERNAL', 'FAILED_TERMINAL', 'INCONCLUSIVE', 'FAILED'].includes(s)) return 'failed';
  if (s === 'REJECTED' || s === 'FINDINGS') return 'in_review';
  if (
    ['ACTIVE', 'PLANNING', 'PLANNED', 'MUTATING', 'CAPTURING_EVIDENCE', 'EVIDENCE_CAPTURED', 'VERIFYING', 'REPLANNING', 'RUNNING', 'READY'].includes(s)
  ) return 'in_progress';
  return 'open';
}

/** A human task name: the ticket title, else the first prose line without wrappers. */
function taskTitle(mission: MissionRow): string {
  const ticketTitle = (mission.ticket_title ?? '').trim();
  if (ticketTitle) return ticketTitle.slice(0, 160);
  const lines = (mission.objective ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/^#{1,6}\s*/, '').replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, ''))
    .filter((line) => line.length > 0 && !/^\[[^\]]+\]$/.test(line));
  return (lines[0] ?? mission.mission_id).slice(0, 160);
}

const localMissionIds = new Set<string>();
const bound = department
  .query("SELECT ticket_id, metadata FROM tickets WHERE metadata LIKE '%local_mission%'")
  .all() as Array<{ ticket_id: string; metadata: string | null }>;
for (const row of bound) {
  try {
    const metadata = row.metadata ? (JSON.parse(row.metadata) as { local_mission?: { missionId?: unknown } }) : {};
    const missionId = metadata.local_mission?.missionId;
    if (typeof missionId === 'string' && missionId) localMissionIds.add(missionId);
  } catch {
    /* malformed metadata is not a binding */
  }
}

const unbound = missions.filter((mission) => !localMissionIds.has(mission.mission_id));
const insert = department.query(
  `INSERT OR IGNORE INTO tickets (
     ticket_id, type, status, title, body, workstation_id, parent_ticket_id,
     assignee_agent_ticket_id, priority, labels, metadata, dispatch_attempts,
     last_dispatch_attempt_at, created_by, created_at, updated_at, closed_at
   ) VALUES (?, 'shift', ?, ?, ?, ?, NULL, NULL, 'high', '[]', ?, 0, NULL,
             'migration:backfill-mission-workstations', ?, ?, ?)`,
);

console.log(`[backfill] department DB: ${departmentDbPath}`);
console.log(`[backfill] engine DB:     ${engineDbPath}`);
console.log(`[backfill] target:        ${workstation.name} (${workstation.id})`);
console.log(`[backfill] missions:      ${missions.length} total, ${localMissionIds.size} already local-bound, ${unbound.length} to bind`);

const now = new Date().toISOString();
const plan = unbound.map((mission) => {
  const status = boardStatus(mission.state, mission.human_acceptance);
  const title = taskTitle(mission);
  const metadata = JSON.stringify({
    is_mission: true,
    local_mission: {
      missionId: mission.mission_id,
      submission: 'accepted',
      workspace: mission.workspace_path ?? '',
      objective: mission.objective,
      title,
    },
    engine_state: mission.state,
    engine_verified_at: mission.verified_at,
    backfilled_by: 'backfill-mission-workstations',
  });
  return {
    ticketId: `local-${mission.mission_id}`,
    missionId: mission.mission_id,
    state: mission.state,
    status,
    title,
    objective: mission.objective,
    createdAt: mission.created_at,
    metadata,
  };
});

for (const row of plan) {
  console.log(`  + ${row.ticketId}  ${row.status.padEnd(11)}  ${row.title}`);
}

if (!apply) {
  console.log('[backfill] dry run — nothing written. Re-run with --apply to commit.');
  department.close();
  process.exit(0);
}

const backupPath = `${departmentDbPath}.bak-${now.replace(/[:.]/g, '-')}`;
department.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`[backfill] backup: ${backupPath}`);

department.exec('BEGIN IMMEDIATE');
try {
  let inserted = 0;
  for (const row of plan) {
    const closedAt = row.status === 'closed' ? now : null;
    const result = insert.run(
      row.ticketId,
      row.status,
      row.title,
      row.objective,
      targetWorkstationId,
      row.metadata,
      row.createdAt,
      now,
      closedAt,
    );
    if (result.changes > 0) inserted += 1;
  }
  department.exec('COMMIT');
  console.log(`[backfill] inserted ${inserted} local ticket(s) under ${workstation.name}.`);
} catch (error) {
  department.exec('ROLLBACK');
  console.error('[backfill] failed, rolled back:', error instanceof Error ? error.message : error);
  department.close();
  process.exit(1);
}

const verify = department
  .query("SELECT workstation_id, COUNT(*) AS n FROM tickets WHERE type <> 'agent' GROUP BY workstation_id ORDER BY workstation_id")
  .all();
console.log('[backfill] non-agent tickets by workstation:');
for (const row of verify as Array<{ workstation_id: string | null; n: number }>) {
  console.log(`  ${row.workstation_id ?? '(department)'}: ${row.n}`);
}
department.close();
