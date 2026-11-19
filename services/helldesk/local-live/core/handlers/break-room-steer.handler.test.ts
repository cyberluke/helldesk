/**
 * break-room-steer.handler.test.ts — the non-blocking steer API end-to-end (with a
 * mocked fabric / nudge / broadcast, no live engine). Proves the handler:
 *   - accepts all three steer kinds,
 *   - fans a chat row to the fabric,
 *   - enqueues a nudge when a target agent is named,
 *   - emits a finding when the steer calls for one,
 *   - and NEVER returns a blocking/error path for a valid steer.
 */
import { describe, it, expect } from 'bun:test';
import { handleBreakRoomSteer } from './break-room-steer.handler';

export type Ctx = { req: { json(): Promise<unknown> }; json(body: unknown, status?: number): Response };

function makeCtx(body: unknown): Ctx {
  return {
    req: { json: () => Promise.resolve(body) },
    json: (b, s = 200) => new Response(JSON.stringify(b), { status: s }),
  };
}

function makeDeps(log: string[]) {
  const published: Array<Record<string, unknown>> = [];
  const nudges: Array<{ agentId: string; message: string }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const fabric = {
    publish: (m: { role: string; kind: string; text?: string; origin: string }) => { published.push(m as never); },
  } as never;
  return {
    deps: {
      fabric,
      broadcast: (evt: Record<string, unknown>) => emitted.push(evt),
      queueNudge: async (agentId: string, message: string) => { log.push(`nudge:${agentId}`); nudges.push({ agentId, message }); return 'n1'; },
    },
    published, nudges, emitted,
  };
}

describe('handleBreakRoomSteer — non-blocking steer API', () => {
  it('interrupt publishes a chat row, enqueues a nudge, emits no finding', async () => {
    const log: string[] = [];
    const { deps, published, nudges, emitted } = makeDeps(log);
    const c = makeCtx({ kind: 'interrupt', ticketId: 'ticket-00000001', agentId: 'soul-00000001', note: 're-check the edge case' });
    const res = await handleBreakRoomSteer(c as never, { departmentId: 't1' }, deps as never);
    const body = await res.json() as { success: boolean; data?: { applied?: string } };
    expect(body.success).toBeTrue();
    expect(body.data?.applied).toBe('async-nonblocking');
    expect(published.length).toBe(1); // the human's steer row
    expect(nudges.length).toBe(1);
    expect(nudges[0].agentId).toBe('soul-00000001');
    expect(nudges[0].message).toContain('Continue delivering');
    expect(emitted.length).toBe(0); // pure interrupt -> no finding
  });

  it('force-review emits a review_queued finding; the agent is not stopped', async () => {
    const log: string[] = [];
    const { deps, emitted } = makeDeps(log);
    const c = makeCtx({ kind: 'force-review', ticketId: 'ticket-00000002' });
    const res = await handleBreakRoomSteer(c as never, { departmentId: 't1' }, deps as never);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBeTrue();
    const finding = emitted.find((e) => e.event === 'review_queued');
    expect(finding).toBeTruthy();
    expect(finding?.intent).toBe('force-review');
    expect(finding?.source).toBe('human-steer');
  });

  it('disapprove emits a finding + a corrective nudge; delivery continues', async () => {
    const log: string[] = [];
    const { deps, nudges, emitted } = makeDeps(log);
    const c = makeCtx({ kind: 'disapprove', ticketId: 'ticket-00000003', agentId: 'quality-assurance-00000001', note: 'wrong framing' });
    const res = await handleBreakRoomSteer(c as never, { departmentId: 't1' }, deps as never);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBeTrue();
    expect(nudges.some((n) => n.message.includes('Finish the current change'))).toBeTrue();
    expect(emitted.some((e) => e.event === 'finding.recorded' && e.severity === 'human-objection')).toBeTrue();
  });

  it('rejects missing ticketId but never errors on a valid steer', async () => {
    const log: string[] = [];
    const { deps } = makeDeps(log);
    const c = makeCtx({ kind: 'interrupt' });
    const res = await handleBreakRoomSteer(c as never, { departmentId: 't1' }, deps as never);
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBeFalse();
  });
});