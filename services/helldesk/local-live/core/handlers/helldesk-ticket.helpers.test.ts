import { describe, it, expect } from 'vitest';
import { pickWorkstationIdForHelldeskTicket } from './helldesk-ticket.helpers';
import { readHelldeskTicketOrigin } from '../dos/department/helldesk-ticket-origin';

describe('pickWorkstationIdForHelldeskTicket', () => {
  it('matches a local workstation by name when workstation_handle is the workstation name', () => {
    const workstations = [
      { id: 'workstation-a', name: 'cyberluke/helldesk' },
      { id: 'workstation-b', name: 'cyberluke/web' },
    ];
    expect(pickWorkstationIdForHelldeskTicket(workstations, 'cyberluke/web')).toBe('workstation-b');
  });

  it('falls back to the only workstation when there is exactly one and no name match', () => {
    const workstations = [{ id: 'workstation-only', name: 'something-else' }];
    expect(pickWorkstationIdForHelldeskTicket(workstations, 'cyberluke/helldesk')).toBe('workstation-only');
  });

  it('returns null when there are multiple workstations and none match', () => {
    const workstations = [
      { id: 'workstation-a', name: 'foo' },
      { id: 'workstation-b', name: 'bar' },
    ];
    expect(pickWorkstationIdForHelldeskTicket(workstations, 'baz')).toBeNull();
  });

  it('returns null when there are no workstations at all', () => {
    expect(pickWorkstationIdForHelldeskTicket([], 'foo')).toBeNull();
  });
});

describe('readHelldeskTicketOrigin', () => {
  it('returns null for missing or non-object metadata', () => {
    expect(readHelldeskTicketOrigin(null)).toBeNull();
    expect(readHelldeskTicketOrigin(undefined)).toBeNull();
    expect(readHelldeskTicketOrigin({})).toBeNull();
    expect(readHelldeskTicketOrigin({ helldesk: 'not-an-object' })).toBeNull();
  });

  it('returns null when the helldesk field has the wrong shape', () => {
    expect(readHelldeskTicketOrigin({ helldesk: { kind: 'unknown' } })).toBeNull();
    expect(readHelldeskTicketOrigin({ helldesk: { kind: 'wanted-item-claim' } })).toBeNull(); // missing ids
  });

  it('parses a well-formed origin', () => {
    const origin = readHelldeskTicketOrigin({
      helldesk: {
        kind: 'wanted-item-claim',
        helldesk_id: 'w',
        item_id: 'i',
      },
    });
    expect(origin).toEqual({
      kind: 'wanted-item-claim',
      helldesk_id: 'w',
      item_id: 'i',
    });
  });
});
