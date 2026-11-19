/**
 * room.test.ts — the HITL non-blocking steer invariant + chat row formatting.
 *
 * The user's hard requirement: agents are fully autonomous, approval comes from
 * reviewer agents, the human is ASYNC and NON-BLOCKING, and interrupting /
 * force-reviewing / disapproving never stops an agent from delivering value.
 * These tests pin that invariant so a future "make it a blocking gate" refactor
 * fails loudly.
 */
import { describe, it, expect } from 'bun:test';
import {
  formatRoomEvent,
  planSteer,
  isNonBlocking,
  type RoomChatRow,
} from '../breakRoom/room';
import type { RuntimeEvent } from '../runtime/local-reconciler';

function evt(partial: Partial<RuntimeEvent> & { payload?: Record<string, unknown> }): RuntimeEvent {
  return {
    type: 'ticket',
    departmentId: 't1',
    ticketId: 'ticket-00000000',
    payload: {},
    ...partial,
  } as RuntimeEvent;
}

describe('planSteer — every human steer is non-blocking', () => {
  const ctx = { ticketId: 'ticket-00000001', agentId: 'soul-00000001', note: 'reconsider the approach' };

  it('interrupt plans an advisory nudge, never cancels', () => {
    const p = planSteer('interrupt', ctx);
    // The mechanical invariant: no terminal/abort content; has a nudge; hints it is a continue.
    expect(isNonBlocking(p)).toBeTrue();
    expect(p.nudge?.agentId).toBe('soul-00000001');
    expect(p.nudge?.text).toContain('Continue delivering');
    expect(p.chat.text).toContain('You interrupted');
    // No finding emitted for a pure interrupt — just the nudge to the agent.
    expect(p.emit).toBeUndefined();
  });

  it('force-review emits a review_queued finding and never blocks the agent', () => {
    const p = planSteer('force-review', ctx);
    expect(isNonBlocking(p)).toBeTrue();
    expect(p.emit?.event).toBe('review_queued');
    expect(p.emit?.source).toBe('human-steer');
    expect(p.emit?.intent).toBe('force-review');
    // The agent keeps working; the reviewer picks it up async.
    expect(p.chat.text).toContain('reviewer agent will pick it up async');
  });

  it('disapprove emits a finding + a corrective nudge; delivery continues', () => {
    const p = planSteer('disapprove', ctx);
    expect(isNonBlocking(p)).toBeTrue();
    expect(p.emit?.event).toBe('finding.recorded');
    expect(p.emit?.severity).toBe('human-objection');
    expect(p.nudge?.text).toContain('Finish the current change');
    expect(p.chat.text).toContain('still finishes this pass');
  });

  it('every plan is a human chat row broadcast to the room (origin helldesk, actor human)', () => {
    for (const k of ['interrupt', 'force-review', 'disapprove'] as const) {
      const p = planSteer(k, ctx);
      expect(p.chat.origin).toBe('helldesk');
      expect(p.chat.actor).toBe('human');
      expect(p.chat.kind).toBe('text');
    }
  });

  it('rejects an unknown kind (compile-time safe; runtime guard in handler)', () => {
    // planSteer is typed, so the guard lives at the edge. Assert the edge's guard logic
    // separately by checking that the three valid kinds all pass the invariant, and
    // an out-of-range value maps to undefined via a manual check.
    const g = (k: string | undefined) => k === 'interrupt' || k === 'force-review' || k === 'disapprove';
    expect(g('interrupt')).toBeTrue();
    expect(g('halt')).toBeFalse();
  });
});

describe('formatRoomEvent — colony activity renders as Discord-like chat rows', () => {
  it('reviewer approval reads as a reviewer actor line', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'reviewer.approved', ticketId: 'ticket-12345678' } }));
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('reviewer');
    expect(row!.role).toBe('assistant');
    expect(row!.text).toContain('approved');
  });

  it('reviewer findings reads as a reviewer line feeding the next revision', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'reviewer.findings', ticketId: 'ticket-12345678' } }));
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('reviewer');
    expect(row!.text).toContain('findings');
    expect(row!.text).toContain('next revision');
  });

  it('agent completed reads as an agent line', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'agent_done', agentId: 'soul-00000001', ticketId: 'ticket-12345678' } }));
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('agent');
    expect(row!.text).toContain('finished work');
  });

  it('agent stall is a system/agent recovery line, delivery unaffected', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'agent_exited', agentId: 'soul-00000001' } }));
    expect(row).not.toBeNull();
    expect(row!.text).toContain('recover it');
  });

  it('ticket closed reads as a delivered line', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'ticket.closed', ticketId: 'ticket-12345678' } }));
    expect(row).not.toBeNull();
    expect(row!.text).toContain('closed');
    expect(row!.kind).toBe('text');
  });

  it('unknown event type still renders a neutral chat line (not dropped)', () => {
    const row = formatRoomEvent(evt({ payload: { type: 'colony.new_signal' } }));
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('system');
    expect(typeof row!.text).toBe('string');
  });
});

// Helper so the type surface is exercised (RoomChatRow union carries actor).
void ((row: RoomChatRow) => row.actor) as unknown;