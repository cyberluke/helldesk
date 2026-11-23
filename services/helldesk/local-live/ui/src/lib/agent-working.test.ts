/**
 * Operator header liveness — the regression guard for the reported bug
 * "operator console shows 0 working while the agent is producing results".
 *
 * The header counts a crew member as working when EITHER the status word is
 * `working` OR the engine checkpoint says `running`. The second signal matters:
 * the room projection once shipped a running worker with a non-canonical status
 * word, and a live mission must never read as an idle crew.
 */
import { describe, expect, it } from 'bun:test';
import { isAgentWorking, type RoomAgent } from './engine';

function agent(overrides: Record<string, unknown> = {}): RoomAgent {
  return { id: 'role:soul', name: 'Soul', role: 'soul', status: 'idle', ...overrides } as RoomAgent;
}

describe('isAgentWorking', () => {
  it('counts the canonical working status', () => {
    expect(isAgentWorking(agent({ status: 'working' }))).toBe(true);
  });

  it('counts a running engine checkpoint even when the status word drifted', () => {
    expect(isAgentWorking(agent({ status: 'active', checkpoint: { running: true } }))).toBe(true);
  });

  it('never counts an idle or finished agent', () => {
    expect(isAgentWorking(agent({ status: 'idle' }))).toBe(false);
    expect(isAgentWorking(agent({ status: 'idle', checkpoint: { running: false } }))).toBe(false);
    expect(isAgentWorking(agent({ status: 'stalled' }))).toBe(false);
  });

  it('does not require a checkpoint (local agents have none)', () => {
    expect(isAgentWorking(agent({ status: 'working', checkpoint: null }))).toBe(true);
    expect(isAgentWorking(agent({ status: 'idle', checkpoint: null }))).toBe(false);
  });
});
