/**
 * Task Studio enforcer mapping — the regression guard for the operator report
 * "I picked Build + ExcellenceGovernor and it engaged Reviewer A/B too".
 */
import { describe, expect, it } from 'bun:test';
import { enforcerToControls } from './engine';

describe('Task Studio enforcer → break_room_controls', () => {
  it('Build + ExcellenceGovernor does NOT implicitly enable Reviewer A/B', () => {
    expect(enforcerToControls('excellenceGovernor')).toEqual({
      agents: true,
      reviewer: false,
      reviewerA: false,
      reviewerB: false,
      excellenceGovernor: true,
    });
  });

  it('HELLDESK Reviewer enables A/B and leaves the governor stage off', () => {
    expect(enforcerToControls('reviewer')).toMatchObject({
      agents: true,
      reviewer: true,
      reviewerA: true,
      reviewerB: true,
      excellenceGovernor: false,
    });
  });

  it('Souls keeps the department default review policy (no role override)', () => {
    expect(enforcerToControls('soul')).toEqual({ agents: true });
  });

  it('Reviewer A/B + Governor enables the full independent review stack', () => {
    expect(enforcerToControls('reviewerAndGovernor')).toEqual({
      agents: true,
      reviewer: true,
      reviewerA: true,
      reviewerB: true,
      excellenceGovernor: true,
    });
  });
});
