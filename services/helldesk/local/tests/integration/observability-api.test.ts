import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db';
import { handleRequest, type ApiContext } from '../../src/api';

const MIN = 60_000;

function seed(d: ReturnType<typeof openDb>): void {
  d.runMigration();
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago).toISOString();
  d.db
    .query(`INSERT INTO workspaces (workspace_id, path, enabled, created_at) VALUES ('ws_api', 'C:\\src\\api-repo', 1, ?)`)
    .run(iso(120 * MIN));
  d.db
    .query(
      `INSERT INTO autonomy_missions
         (mission_id, workspace_id, objective, state, policy_version, created_at, updated_at)
       VALUES ('mis_api', 'ws_api', 'api test', 'ACTIVE', 'ender-1', ?, ?)`,
    )
    .run(iso(120 * MIN), iso(1 * MIN));
  const insert = (type: string, payload: object, ago: number) =>
    d.db
      .query(
        `INSERT INTO events_outbox (event_type, job_id, payload, created_at, delivery_attempts)
         VALUES (?, NULL, ?, ?, 0)`,
      )
      .run(type, JSON.stringify(payload), iso(ago));

  insert('mission.created', { mission_id: 'mis_api' }, 120 * MIN);
  insert('mission.state_changed', { mission_id: 'mis_api', state: 'ACTIVE' }, 3 * MIN);
  insert('revision.created', { mission_id: 'mis_api', ticket_id: null, revision_no: 1 }, 0.2 * MIN);
}

function context(d: ReturnType<typeof openDb>): ApiContext {
  return {
    d,
    engine: {} as ApiContext['engine'],
    config: {} as ApiContext['config'],
    configStore: {} as ApiContext['configStore'],
    token: 'test-token',
    queueDepth: () => ({ queued: 2, running: 1, inFlight: 3 }),
  };
}

describe('/v1/events and /v1/observability', () => {
  test('tail mode returns the newest events with workspace identity', async () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const res = await handleRequest(context(d), new Request('http://127.0.0.1:4790/v1/events?tail=2'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        events: Array<{ eventType: string; workspaceId: string | null; workspaceName: string | null }>;
        nextSeq: number;
      };
      expect(body.events.map(e => e.eventType)).toEqual(['mission.state_changed', 'revision.created']);
      expect(body.events.every(e => e.workspaceId === 'ws_api')).toBe(true);
      expect(body.events.every(e => e.workspaceName === 'api-repo')).toBe(true);
      expect(body.nextSeq).toBe(3);
    } finally {
      d.close();
    }
  });

  test('cursor mode stays oldest-first for SSE resume compatibility', async () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const res = await handleRequest(context(d), new Request('http://127.0.0.1:4790/v1/events?after=0'));
      const body = (await res.json()) as { events: Array<{ eventType: string; seq: number }>; nextSeq: number };
      expect(body.events.map(e => e.eventType)).toEqual([
        'mission.created',
        'mission.state_changed',
        'revision.created',
      ]);
      expect(body.nextSeq).toBe(3);

      const resumed = await handleRequest(context(d), new Request('http://127.0.0.1:4790/v1/events?after=2'));
      const resumedBody = (await resumed.json()) as { events: Array<{ seq: number }>; nextSeq: number };
      expect(resumedBody.events.map(e => e.seq)).toEqual([3]);
    } finally {
      d.close();
    }
  });

  test('observability snapshot exposes measured events, workspace and queue', async () => {
    const d = openDb(':memory:');
    try {
      seed(d);
      const res = await handleRequest(context(d), new Request('http://127.0.0.1:4790/v1/observability'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        generatedAt: string;
        engine: { queue: { queued: number; running: number; inFlight: number } };
        events: {
          total: number;
          last24h: number;
          perHour24h: Array<{ count: number }>;
          byType24h: Array<{ eventType: string; count: number }>;
          byWorkspace24h: Array<{ workspaceId: string | null; workspaceName: string; count: number }>;
          latest: Array<{ workspaceName: string | null }>;
        };
      };

      expect(body.generatedAt).toBeTruthy();
      expect(body.engine.queue).toEqual({ queued: 2, running: 1, inFlight: 3 });
      expect(body.events.total).toBe(3);
      expect(body.events.last24h).toBe(3);
      expect(body.events.perHour24h).toHaveLength(24);
      expect(body.events.perHour24h.reduce((sum, b) => sum + b.count, 0)).toBe(3);
      expect(body.events.byType24h).toHaveLength(3);
      expect(body.events.byWorkspace24h).toEqual([{ workspaceId: 'ws_api', workspaceName: 'api-repo', count: 3 }]);
      expect(body.events.latest).toHaveLength(3);
      expect(body.events.latest.every(e => e.workspaceName === 'api-repo')).toBe(true);
    } finally {
      d.close();
    }
  });
});
