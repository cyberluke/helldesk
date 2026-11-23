/**
 * observability-probe.ts — operator probe for the real observability snapshot.
 *
 * Reads the live control-plane SQLite database READ-ONLY (WAL allows this while
 * the daemon is writing) and prints the same aggregate the GUI's
 * `/v1/observability` endpoint serves. Useful to answer "does the console match
 * the journal?" without restarting the daemon or touching the browser.
 *
 * Usage (from services/helldesk/local):
 *   bun run scripts/observability-probe.ts
 *   bun run scripts/observability-probe.ts --json > snapshot.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db';
import { buildObservabilitySnapshot, type ObservabilityQueueDepth } from '../src/observability';

const ZERO_QUEUE: ObservabilityQueueDepth = { queued: 0, running: 0, inFlight: 0 };

function dataDir(): string {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf-8')) as {
      daemon?: { dataDir?: string; port?: number };
    };
    if (cfg.daemon?.dataDir) return cfg.daemon.dataDir;
  } catch {
    // Fall through to the platform default.
  }
  return join(process.env.LOCALAPPDATA ?? '', 'HELLDESK', 'LocalDepartment');
}

function controlPort(): number {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf-8')) as {
      daemon?: { port?: number };
    };
    if (cfg.daemon?.port) return cfg.daemon.port;
  } catch {
    // Fall through to the historical default.
  }
  return 4790;
}

async function liveQueue(): Promise<ObservabilityQueueDepth> {
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort()}/v1/queue`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return ZERO_QUEUE;
    const body = (await res.json()) as { queue?: ObservabilityQueueDepth };
    return body.queue ?? ZERO_QUEUE;
  } catch {
    return ZERO_QUEUE;
  }
}

const dbPath = join(dataDir(), 'helldesk.db');
const d = openDb(dbPath, { readonly: true });
try {
  const snapshot = buildObservabilitySnapshot(d, await liveQueue(), { maxAgeMs: -1 });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(`HELLDESK observability probe — ${snapshot.generatedAt}`);
    console.log(`engine live: ${snapshot.engine.live}`);
    console.log(`journal: ${snapshot.events.total} events, ${snapshot.events.last24h} in 24h, ${snapshot.events.lastHour} in 1h`);
    console.log(`event types (24h): ${snapshot.events.byType24h.map((t) => `${t.eventType}=${t.count}`).join(', ') || 'none'}`);
    console.log(`workspaces (24h): ${snapshot.events.byWorkspace24h.map((w) => `${w.workspaceName}=${w.count}`).join(', ') || 'none'}`);
    console.log(`latest: ${snapshot.events.latest.slice(-5).map((e) => `${e.eventType}@${e.createdAt}`).join(', ') || 'none'}`);
    console.log(`reviews: total=${snapshot.reviews.total} open=${snapshot.reviews.open} completed24h=${snapshot.reviews.completed24h} avgTimeToVerdict=${snapshot.reviews.avgTimeToVerdictMs ?? 'n/a'}ms`);
    console.log(`missions: total=${snapshot.missions.total} active=${snapshot.missions.active} blocked=${snapshot.missions.blocked} verified=${snapshot.missions.verified}`);
    console.log(`workers: total=${snapshot.workers.total} running=${snapshot.workers.running} failures24h=${snapshot.workers.recentFailures24h}`);
    console.log(`gates: total=${snapshot.gates.total} ${snapshot.gates.byStatus.map((s) => `${s.status}=${s.count}`).join(', ')}`);
    console.log(`usage: runs=${snapshot.usage.runs} tokensIn=${snapshot.usage.tokensIn} tokensOut=${snapshot.usage.tokensOut} cost=${snapshot.usage.cost}`);
  }
} finally {
  d.close();
}
