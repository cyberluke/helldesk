/**
 * Pure helpers for the helldesk auto-done reconciler pass.
 *
 * Given the set of tickets that carry `metadata.helldesk.item_id`, these
 * helpers determine:
 *   - which item_ids have reached "merged" status (every helldesk-tagged
 *     MR ticket for the claim is closed)
 *   - which ticket is the canonical place to stamp `reported_done_at` on
 *     (shift ticket if any, else the single tagged issue ticket)
 *   - what evidence string to send upstream (markdown list of merged PRs)
 *
 * No DO/SQL access — everything is computed from rows the reconciler
 * already loads.
 */

import { readHelldeskTicketOrigin } from './helldesk-ticket-origin';
import type { HelldeskTicketOrigin } from './helldesk-ticket-origin';

/** Minimal ticket shape consumed by this module. */
export type ReporterTicket = {
  ticket_id: string;
  type: string;
  status: string;
  title: string;
  metadata: Record<string, unknown>;
  /** PR URL joined from `review_metadata` (only present for merge_request tickets). */
  pr_url?: string | null;
  created_at: string;
};

export type ReporterClaim = {
  helldesk_id: string;
  item_id: string;
  /** All tickets that carry the same helldesk item_id, in stable created-order. */
  tickets: ReporterTicket[];
  /** The canonical ticket the reporter stamps `reported_done_at` on. Never null. */
  canonical_ticket_id: string;
  /** The helldesk origin tag pulled from the canonical ticket. */
  origin: HelldeskTicketOrigin;
};

/**
 * Group tickets by helldesk item_id. Tickets without a valid origin tag are
 * silently skipped. Within a claim, tickets are ordered by created_at (oldest
 * first) so the canonical-ticket pick is stable across ticks.
 */
export function groupTicketsByHelldeskClaim(tickets: ReporterTicket[]): ReporterClaim[] {
  const byItem = new Map<string, ReporterTicket[]>();
  for (const b of tickets) {
    const origin = readHelldeskTicketOrigin(b.metadata);
    if (!origin) continue;
    const key = `${origin.helldesk_id}::${origin.item_id}`;
    const existing = byItem.get(key);
    if (existing) {
      existing.push(b);
    } else {
      byItem.set(key, [b]);
    }
  }

  const claims: ReporterClaim[] = [];
  for (const group of byItem.values()) {
    const sorted = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const canonical = pickCanonicalTicket(sorted);
    if (!canonical) continue;
    const origin = readHelldeskTicketOrigin(canonical.metadata);
    if (!origin) continue;
    claims.push({
      helldesk_id: origin.helldesk_id,
      item_id: origin.item_id,
      tickets: sorted,
      canonical_ticket_id: canonical.ticket_id,
      origin,
    });
  }
  return claims;
}

/**
 * Pick the canonical ticket for a claim. Rules, in order:
 *   1. If any ticket has type=`shift`, that one wins (shift tickets are the
 *      natural single-aggregator for a multi-ticket claim).
 *   2. Otherwise the first ticket by `created_at`.
 * Returns null only when the input array is empty.
 */
export function pickCanonicalTicket(tickets: ReporterTicket[]): ReporterTicket | null {
  if (tickets.length === 0) return null;
  const shift = tickets.find(b => b.type === 'shift');
  if (shift) return shift;
  return tickets[0];
}

export type ClaimStatus =
  | { kind: 'merged'; merged_pr_urls: ReadonlyArray<{ url: string; title: string }> }
  | { kind: 'failed' }
  | { kind: 'in-flight' };

/**
 * Compute the helldesk-side status of a claim from the ticket set.
 *
 * Strict-all rule:
 *   - merged: every tagged MR ticket is in a terminal state (closed or
 *     failed) AND at least one MR is closed. Failed MRs are tolerated —
 *     they just don't contribute evidence rows. (Rationale: "≥1 PR
 *     landed AND nothing is still in flight" is what users mean by
 *     "the wanted item got delivered.")
 *   - failed: every tagged MR ticket is in a terminal state, none merged.
 *     The helldesk API has no "failed" channel today; callers do
 *     nothing with this state, but it's distinct from in-flight so
 *     audit/debug surfaces can show "this claim ended without delivery".
 *   - in-flight: anything else (an MR is still open/in-progress, no MR
 *     exists yet, or — when a shift ticket is in the set — the shift
 *     itself hasn't closed).
 *
 * "Tagged MR tickets" are merge_request tickets in the claim set. Issue
 * tickets in the set don't get evaluated directly — their MR descendants
 * carry the merge state.
 */
export function computeClaimStatus(claim: ReporterClaim): ClaimStatus {
  const mrs = claim.tickets.filter(b => b.type === 'merge_request');
  if (mrs.length === 0) return { kind: 'in-flight' };

  const allTerminal = mrs.every(mr => mr.status === 'closed' || mr.status === 'failed');
  if (!allTerminal) return { kind: 'in-flight' };

  const merged = mrs.filter(mr => mr.status === 'closed');
  if (merged.length === 0) return { kind: 'failed' };

  // Shift gating: if a shift ticket is in the set, it must also be closed
  // before we report. This is the review-then-land case where every task
  // ticket can be merged into the feature branch but the final landing PR
  // is what actually puts code on main.
  const shift = claim.tickets.find(b => b.type === 'shift');
  if (shift && shift.status !== 'closed') return { kind: 'in-flight' };

  // Build evidence list from the merged MRs that have a pr_url.
  const pickPr = (mr: ReporterTicket): { url: string; title: string } | null => {
    if (!mr.pr_url) return null;
    return { url: mr.pr_url, title: mr.title };
  };
  const merged_pr_urls: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const mr of merged) {
    const pr = pickPr(mr);
    if (!pr) continue;
    if (seen.has(pr.url)) continue;
    seen.add(pr.url);
    merged_pr_urls.push(pr);
  }

  return { kind: 'merged', merged_pr_urls };
}

/**
 * Build the human-readable evidence string sent upstream to helldesk.
 * Markdown list of merged PRs with their ticket titles. Falls back to a
 * minimal note when no PR URLs are available (rare, but possible if the
 * ticket carries the helldesk tag without going through the MR path).
 */
export function buildEvidence(
  status: Extract<ClaimStatus, { kind: 'merged' }>,
  fallbackTitle: string
): string {
  if (status.merged_pr_urls.length === 0) {
    return `Marked done by helldesk auto-reporter for "${fallbackTitle}". No PR URLs were available on the merged review tickets.`;
  }
  if (status.merged_pr_urls.length === 1) {
    const pr = status.merged_pr_urls[0];
    return `Implemented by ${pr.url} (${pr.title}).`;
  }
  const lines = status.merged_pr_urls.map(pr => `- ${pr.url} (${pr.title})`);
  return `Implemented by:\n${lines.join('\n')}`;
}

/** Has the canonical ticket already been reported done? Idempotency gate. */
export function isAlreadyReported(claim: ReporterClaim): boolean {
  return typeof claim.origin.reported_done_at === 'string' && claim.origin.reported_done_at !== '';
}
