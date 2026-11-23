import { describe, it, expect } from 'bun:test';
import { crewStatusOf, projectWorkersIntoRoster } from './worker-reconcile';
import type { Agent } from '../types';

/**
 * Regression lock for the operator header's "N working" counter.
 *
 * The control plane reports PROCESS statuses (running/launching/succeeded/…),
 * the crew UI counts CREW statuses (working/idle/stalled/dead). An earlier
 * projection passed `active` through for a live mission worker, so the console
 * showed "0 working" while the agent was genuinely producing results.
 */
describe('crewStatusOf', () => {
  it('maps a live worker (running) to working — the header must count it', () => {
    expect(crewStatusOf('running')).toBe('working');
  });

  it('maps a worker that is still launching to working', () => {
    expect(crewStatusOf('launching')).toBe('working');
  });

  it('maps finished/unknown process states to idle, never inventing liveness', () => {
    expect(crewStatusOf('succeeded')).toBe('idle');
    expect(crewStatusOf('terminated')).toBe('idle');
    expect(crewStatusOf(null)).toBe('idle');
    expect(crewStatusOf(undefined)).toBe('idle');
    expect(crewStatusOf('')).toBe('idle');
  });

  it('is case-insensitive so an upstream casing change cannot silence the counter', () => {
    expect(crewStatusOf('RUNNING')).toBe('working');
  });
});

describe('projectWorkersIntoRoster — a seat roster never inherits department crew', () => {
  const seatAgent = {
    id: 'agent-seat',
    workstation_id: 'workstation-local',
    role: 'soul',
  } as unknown as Agent;
  const projectedSoul = {
    id: 'role:soul',
    workstation_id: null,
    role: 'soul',
  } as unknown as Agent;
  const projectedReviewer = {
    id: 'role:reviewer-a',
    workstation_id: null,
    role: 'qualityAssurance',
  } as unknown as Agent;

  it('keeps a workstation-filtered roster to its own agents', () => {
    const local = [seatAgent];
    const roster = projectWorkersIntoRoster(local, [projectedSoul, projectedReviewer], {
      workstation_id: 'workstation-local',
    });
    expect(roster).toEqual(local);
  });

  it('merges the engine crew on the department roster with distinct role identities', () => {
    const roster = projectWorkersIntoRoster([], [projectedSoul, projectedReviewer], {});
    expect(roster.map(a => a.id)).toEqual(['role:soul', 'role:reviewer-a']);
  });

  it('prefers the named local soul over the synthetic role:soul projection', () => {
    const roster = projectWorkersIntoRoster([seatAgent], [projectedSoul], {});
    expect(roster.map(a => a.id)).toEqual(['agent-seat']);
  });

  it('keeps every named local agent — two souls on two seats are both visible', () => {
    const secondSeat = {
      id: 'agent-seat-2',
      workstation_id: 'workstation-delta',
      role: 'soul',
    } as unknown as Agent;
    const roster = projectWorkersIntoRoster([seatAgent, secondSeat], [projectedSoul], {});
    expect(roster.map(a => a.id)).toEqual(['agent-seat', 'agent-seat-2']);
  });

  it('keeps a projected role that has no named local counterpart (reviewer-a)', () => {
    const localQa = {
      id: 'agent-local-qa',
      workstation_id: 'workstation-local',
      role: 'qualityAssurance',
    } as unknown as Agent;
    const roster = projectWorkersIntoRoster([localQa], [projectedReviewer], {});
    expect(roster.map(a => a.id)).toEqual(['agent-local-qa', 'role:reviewer-a']);
  });
});
