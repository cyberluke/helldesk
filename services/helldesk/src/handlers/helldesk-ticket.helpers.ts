/**
 * Pure helpers for the helldesk → ticket bridge. Kept out of the
 * `helldesk-tools.handler.ts` module so unit tests can import them
 * without pulling in the Durable Object runtime (which transitively
 * requires `cloudflare:workers` and breaks pure-Node Vitest).
 */

/**
 * Pick a local helldesk `workstation_id` for a helldesk-originated ticket. Tries to
 * match the upstream `workstation_handle` against a local workstation name; falls back to
 * the only workstation in the department when there is exactly one. Returns null when
 * neither rule matches — the caller can either skip the workstation or fall back
 * to a different scoping rule.
 */
export function pickWorkstationIdForHelldeskTicket(
  workstations: ReadonlyArray<{ id: string; name: string }>,
  workstationHandle: string
): string | null {
  const handleMatch = workstations.find(r => r.name === workstationHandle);
  if (handleMatch) return handleMatch.id;
  if (workstations.length === 1) return workstations[0].id;
  return null;
}
