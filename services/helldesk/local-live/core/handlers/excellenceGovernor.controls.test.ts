/**
 * Ticket control routing: mission cards must update the LOCAL ENGINE mission,
 * local tickets must persist to their metadata, and an all-off review policy is
 * rejected. This is the regression guard for the operator report "toggling
 * Reviewer A/B did nothing" (the old handler only called the native host at
 * :8787, which returned 500 for local missions).
 */
import { describe, expect, it } from 'bun:test';
import { handleSetTicketControls, type Ctx, type TicketControlsDeps } from './excellenceGovernor.handler';
import type { ReviewControls } from '../../../local/src/review-controls';

function fakeCtx(body: unknown): Ctx {
  return {
    req: { json: async () => body },
    json: (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status }),
  } as unknown as Ctx;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('handleSetTicketControls — local truth first', () => {
  it('updates a mission-backed card through the local engine, not the native host', async () => {
    let mission: { id: string; controls: ReviewControls } | null = null;
    const deps: TicketControlsDeps = {
      getTicket: async () => null,
      setMissionControls: async (missionId, controls) => {
        mission = { id: missionId, controls };
        return controls;
      },
    };
    const response = await handleSetTicketControls(
      fakeCtx({ reviewerA: false, reviewerB: false, reviewer: false }),
      { departmentId: 'default', ticketId: 'mis_39748afb1d644e29a29018a0b68bceec' },
      deps,
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.success).toBe(true);
    expect(mission).not.toBeNull();
    expect(mission!.id).toBe('mis_39748afb1d644e29a29018a0b68bceec');
    expect(mission!.controls).toMatchObject({ reviewer: false, reviewerA: false, reviewerB: false });
  });

  it('persists controls on a local ticket that has not been dispatched yet', async () => {
    let stored: ReviewControls | null = null;
    const deps: TicketControlsDeps = {
      getTicket: async () => ({ metadata: { break_room_controls: { agents: true } } }),
      updateTicketControls: async (_ticketId, controls) => { stored = controls; },
      setMissionControls: async (_missionId, controls) => controls,
    };
    const response = await handleSetTicketControls(
      fakeCtx({ reviewerB: false }),
      { departmentId: 'default', ticketId: 'ticket-local-1' },
      deps,
    );
    expect(response.status).toBe(200);
    expect(stored).toMatchObject({ agents: true, reviewerB: false });
  });

  it('rejects a policy that turns every review stage off', async () => {
    const deps: TicketControlsDeps = {
      getTicket: async () => ({
        metadata: {
          break_room_controls: { excellenceGovernor: false, reviewer: true, reviewerA: true, reviewerB: true },
        },
      }),
      updateTicketControls: async () => { throw new Error('must not be called'); },
    };
    const response = await handleSetTicketControls(
      fakeCtx({ reviewer: false }),
      { departmentId: 'default', ticketId: 'ticket-local-2' },
      deps,
    );
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(String(body.error)).toContain('At least one');
  });
});
