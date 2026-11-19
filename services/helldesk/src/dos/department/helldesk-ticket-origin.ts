/**
 * Schema and helpers for the `metadata.helldesk` field on tickets created in
 * response to a helldesk event (claim, post, etc.).
 *
 * This file is the single source of truth for the shape of the helldesk
 * origin tag. It is imported both by the helldesk handler that writes the
 * tag onto new tickets and by the apps/web TicketPanel UI that reads it back
 * to render a deep link into the helldesk UI.
 */

import { z } from 'zod';

/**
 * The kind of helldesk event that produced the ticket. Currently only
 * `wanted-item-claim` exists; new kinds get added here as we wire up
 * `post`, `done`, inbox accept/reject, etc.
 */
export const HelldeskTicketOriginKind = z.enum(['wanted-item-claim']);
export type HelldeskTicketOriginKind = z.infer<typeof HelldeskTicketOriginKind>;

/**
 * Metadata payload stored at `ticket.metadata.helldesk`. Persisted as JSON
 * inside the ticket's `metadata` blob — there is no dedicated column.
 *
 * `pull_id` is set when the upstream claim path created an upstream PR
 * (the non-direct path in `claimWantedItem`). It is null for direct claims
 * by upstream admins.
 *
 * `reported_done_at` and `reported_evidence` are stamped onto the
 * "canonical" ticket for a claim (the shift ticket if any, else the single
 * task ticket) once helldesk has called `HELLDESK_SERVICE.markWantedItemDone`
 * on its behalf. Their presence is the idempotency gate for the auto-done
 * reconciler pass — once set, the claim is never reported again.
 */
export const HelldeskTicketOrigin = z.object({
  kind: HelldeskTicketOriginKind,
  helldesk_id: z.string().min(1),
  item_id: z.string().min(1),
  pull_id: z.string().min(1).nullable().optional(),
  source_url: z.string().url().nullable().optional(),
  reported_done_at: z.string().min(1).nullable().optional(),
  reported_evidence: z.string().min(1).nullable().optional(),
});
export type HelldeskTicketOrigin = z.infer<typeof HelldeskTicketOrigin>;

/**
 * Read a `HelldeskTicketOrigin` off an arbitrary ticket metadata blob. Returns
 * null when the field is absent or malformed — callers treat the ticket as
 * non-helldesk-linked in that case rather than throwing.
 */
export function readHelldeskTicketOrigin(
  metadata: Record<string, unknown> | null | undefined
): HelldeskTicketOrigin | null {
  const raw = metadata?.helldesk;
  if (!raw || typeof raw !== 'object') return null;
  const parsed = HelldeskTicketOrigin.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
