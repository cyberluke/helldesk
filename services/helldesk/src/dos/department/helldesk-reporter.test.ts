import { describe, it, expect } from 'vitest';
import {
  buildEvidence,
  computeClaimStatus,
  groupTicketsByHelldeskClaim,
  isAlreadyReported,
  pickCanonicalTicket,
  type ReporterTicket,
  type ReporterClaim,
} from './helldesk-reporter';

const WL = 'wl-1';
const ITEM = 'item-7';

const helldeskTag = (overrides: Record<string, unknown> = {}) => ({
  helldesk: {
    kind: 'wanted-item-claim',
    helldesk_id: WL,
    item_id: ITEM,
    ...overrides,
  },
});

const ticket = (overrides: Partial<ReporterTicket>): ReporterTicket => ({
  ticket_id: overrides.ticket_id ?? `b-${Math.random()}`,
  type: 'issue',
  status: 'open',
  title: 'Untitled',
  metadata: helldeskTag(),
  pr_url: null,
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('groupTicketsByHelldeskClaim', () => {
  it('skips tickets with no helldesk origin', () => {
    const claims = groupTicketsByHelldeskClaim([
      ticket({ metadata: {} }),
      ticket({ metadata: { helldesk: { kind: 'unknown' } } }),
    ]);
    expect(claims).toEqual([]);
  });

  it('groups all tickets with the same item_id into one claim', () => {
    const claims = groupTicketsByHelldeskClaim([
      ticket({ ticket_id: 'a', type: 'shift', created_at: '2026-01-01T00:00:00Z' }),
      ticket({ ticket_id: 'b', type: 'issue', created_at: '2026-01-02T00:00:00Z' }),
      ticket({ ticket_id: 'c', type: 'merge_request', created_at: '2026-01-03T00:00:00Z' }),
    ]);
    expect(claims).toHaveLength(1);
    expect(claims[0].helldesk_id).toBe(WL);
    expect(claims[0].item_id).toBe(ITEM);
    expect(claims[0].tickets.map(b => b.ticket_id)).toEqual(['a', 'b', 'c']);
  });

  it('separates claims by helldesk_id and item_id', () => {
    const claims = groupTicketsByHelldeskClaim([
      ticket({ ticket_id: 'a' }),
      ticket({ ticket_id: 'b', metadata: helldeskTag({ item_id: 'other' }) }),
      ticket({ ticket_id: 'c', metadata: helldeskTag({ helldesk_id: 'wl-2' }) }),
    ]);
    expect(claims).toHaveLength(3);
  });
});

describe('pickCanonicalTicket', () => {
  it('returns null for empty input', () => {
    expect(pickCanonicalTicket([])).toBeNull();
  });

  it('picks the shift ticket when present', () => {
    const a = ticket({ ticket_id: 'a', type: 'issue', created_at: '2026-01-01T00:00:00Z' });
    const b = ticket({ ticket_id: 'b', type: 'shift', created_at: '2026-01-02T00:00:00Z' });
    expect(pickCanonicalTicket([a, b])?.ticket_id).toBe('b');
  });

  it('falls back to the first ticket by created_at when no shift ticket exists', () => {
    const a = ticket({ ticket_id: 'a', type: 'issue', created_at: '2026-01-01T00:00:00Z' });
    const b = ticket({ ticket_id: 'b', type: 'issue', created_at: '2026-01-02T00:00:00Z' });
    // groupTicketsByHelldeskClaim already sorts; pickCanonicalTicket trusts that.
    expect(pickCanonicalTicket([a, b])?.ticket_id).toBe('a');
  });
});

describe('computeClaimStatus', () => {
  const buildClaim = (tickets: ReporterTicket[]): ReporterClaim => {
    const claims = groupTicketsByHelldeskClaim(tickets);
    return claims[0];
  };

  it('returns in-flight when no merge_request ticket exists', () => {
    const claim = buildClaim([ticket({ ticket_id: 'a', type: 'issue', status: 'open' })]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'in-flight' });
  });

  it('returns in-flight when an MR ticket is still open', () => {
    const claim = buildClaim([
      ticket({ ticket_id: 'a', type: 'issue', status: 'closed' }),
      ticket({ ticket_id: 'b', type: 'merge_request', status: 'in_progress' }),
    ]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'in-flight' });
  });

  it('returns failed when every MR is failed and none merged', () => {
    const claim = buildClaim([
      ticket({ ticket_id: 'a', type: 'merge_request', status: 'failed' }),
      ticket({ ticket_id: 'b', type: 'merge_request', status: 'failed' }),
    ]);
    expect(computeClaimStatus(claim)).toEqual({ kind: 'failed' });
  });

  it('returns merged with PR URLs when all MRs are closed (single-ticket claim)', () => {
    const claim = buildClaim([
      ticket({
        ticket_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        title: 'Fix bug',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    const status = computeClaimStatus(claim);
    expect(status.kind).toBe('merged');
    if (status.kind === 'merged') {
      expect(status.merged_pr_urls).toEqual([
        { url: 'https://github.com/o/r/pull/1', title: 'Fix bug' },
      ]);
    }
  });

  it('strict-all: in-flight when one MR merged but another still open', () => {
    const claim = buildClaim([
      ticket({
        ticket_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
      ticket({ ticket_id: 'mr2', type: 'merge_request', status: 'in_progress' }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('in-flight');
  });

  it('strict-all: merged when MRs partly merged + partly failed (still terminal, ≥1 merged)', () => {
    const claim = buildClaim([
      ticket({
        ticket_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
      ticket({ ticket_id: 'mr2', type: 'merge_request', status: 'failed' }),
    ]);
    const status = computeClaimStatus(claim);
    expect(status.kind).toBe('merged');
  });

  it('shift gating: in-flight when MRs closed but shift still open', () => {
    const claim = buildClaim([
      ticket({ ticket_id: 'cv', type: 'shift', status: 'open' }),
      ticket({
        ticket_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('in-flight');
  });

  it('shift gating: merged when shift is also closed', () => {
    const claim = buildClaim([
      ticket({ ticket_id: 'cv', type: 'shift', status: 'closed' }),
      ticket({
        ticket_id: 'mr',
        type: 'merge_request',
        status: 'closed',
        pr_url: 'https://github.com/o/r/pull/1',
      }),
    ]);
    expect(computeClaimStatus(claim).kind).toBe('merged');
  });

  it('deduplicates PR URLs in evidence', () => {
    const claim = buildClaim([
      ticket({
        ticket_id: 'mr1',
        type: 'merge_request',
        status: 'closed',
        title: 'A',
        pr_url: 'https://x/pr/1',
      }),
      ticket({
        ticket_id: 'mr2',
        type: 'merge_request',
        status: 'closed',
        title: 'B',
        pr_url: 'https://x/pr/1',
      }),
    ]);
    const status = computeClaimStatus(claim);
    if (status.kind === 'merged') {
      expect(status.merged_pr_urls).toHaveLength(1);
    } else {
      throw new Error('expected merged');
    }
  });
});

describe('buildEvidence', () => {
  it('formats a single PR as an inline sentence', () => {
    const evidence = buildEvidence(
      { kind: 'merged', merged_pr_urls: [{ url: 'https://x/pr/1', title: 'Fix bug' }] },
      'fallback'
    );
    expect(evidence).toBe('Implemented by https://x/pr/1 (Fix bug).');
  });

  it('formats multiple PRs as a markdown list', () => {
    const evidence = buildEvidence(
      {
        kind: 'merged',
        merged_pr_urls: [
          { url: 'https://x/pr/1', title: 'A' },
          { url: 'https://x/pr/2', title: 'B' },
        ],
      },
      'fallback'
    );
    expect(evidence).toBe('Implemented by:\n- https://x/pr/1 (A)\n- https://x/pr/2 (B)');
  });

  it('falls back when no PR URLs are available', () => {
    const evidence = buildEvidence(
      { kind: 'merged', merged_pr_urls: [] },
      'HELLDESK claim: item-7'
    );
    expect(evidence).toContain('HELLDESK claim: item-7');
  });
});

describe('isAlreadyReported', () => {
  it('returns false when no reported_done_at is set', () => {
    const claim = groupTicketsByHelldeskClaim([ticket({ ticket_id: 'a' })])[0];
    expect(isAlreadyReported(claim)).toBe(false);
  });

  it('returns true when reported_done_at is a non-empty string', () => {
    const claim = groupTicketsByHelldeskClaim([
      ticket({
        ticket_id: 'a',
        metadata: helldeskTag({ reported_done_at: '2026-05-11T20:00:00Z' }),
      }),
    ])[0];
    expect(isAlreadyReported(claim)).toBe(true);
  });
});
