/**
 * Adapted HELLDESK orchestration semantics.
 *
 * These constants and algorithms are sourced directly from the HELLDESK
 * domain snapshot (commit 322138a19, `services/helldesk`).
 * The upstream modules were authored against Cloudflare `SqlStorage`, DO
 * alarms, remote containerFetch/Next.js APIs and a `tickets`/`agent_metadata`/
 * `shift` schema driven by a soul/qualityAssurance/frontDesk agent colony that
 * reviews and merges hosted-Git branches. That runtime surface is not
 * portable to a native-Windows, immutable-snapshot, read-only, no-merge
 * adversarial review engine, so the *algorithms* below are preserved and
 * adapted while the *transport/schema* is not imported.
 *
 * Provenance:
 *  - getDispatchCooldownMs   -> `src/dos/department/reconciler.ts` reconcileTickets
 *  - MAX_DISPATCH_ATTEMPTS   -> `src/dos/department/scheduling.ts`
 *  - DISPATCH_COOLDOWN_MS    -> `src/dos/department/scheduling.ts`
 *  - STUCK_REVIEW_TIMEOUT_MS -> `src/dos/department/reconciler.ts`
 *  - STALE_IN_PROGRESS_TIMEOUT_MS -> `src/dos/department/reconciler.ts`
 *  - staleMs (heartbeat 90s) -> `src/dos/department/reconciler.ts` reconcileAgents
 *  - review-queue rework lifecycle -> `src/dos/department/review-queue.ts`
 *  - agent_done / agent_completed distinctions -> `src/dos/department/review-queue.ts`
 *  - qualityAssurance review gates   -> `src/prompts/quality-assurance-system.prompt.ts`
 */

/** Dispatch backoff (ms) per prior attempt — exponential, upstream-preserved. */
export function getDispatchCooldownMs(dispatchAttempts: number): number {
  if (dispatchAttempts <= 1) return 30_000;
  if (dispatchAttempts === 2) return 60_000;
  if (dispatchAttempts === 3) return 2 * 60_000;
  if (dispatchAttempts === 4) return 5 * 60_000;
  return 10 * 60_000;
}

/** Max dispatch attempts before a review/work item is failed, not retried forever. */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** Base cooldown between dispatches of the same work item. */
export const DISPATCH_COOLDOWN_MS = 30_000;

/** Stuck non-PR review (in_progress, no PR, no working reviewer) is reset to open. */
export const STUCK_REVIEW_TIMEOUT_MS = 30 * 60_000;

/** In-progress issue with no live reviewer considered stale. */
export const STALE_IN_PROGRESS_TIMEOUT_MS = 5 * 60_000;

/** A reviewer/agent with no heartbeat for this long is treated as dead. */
export const HEARTBEAT_LOST_MS = 90_000;

/** A stale timestamp is one older than the given threshold. */
export function staleMs(timestamp: string | null | undefined, thresholdMs: number): boolean {
  if (!timestamp) return true;
  return Date.now() - new Date(timestamp).getTime() > thresholdMs;
}

/**
 * Rework lifecycle (upstream review-queue.ts `failReviewWithRework` path):
 * when a review does not pass, the source returns to an open/in_progress
 * state and the assignee is cleared so a fresh reviewer is re-dispatched.
 * Local engine maps this to: INCONCLUSIVE/FINDINGS job -> requeue with a
 * cleared lease, capped at MAX_DISPATCH_ATTEMPTS.
 */
export const REWORK_MAX_RETRIES = MAX_DISPATCH_ATTEMPTS;

/**
 * department-level circuit breaker (upstream `checkDispatchCircuitBreaker`):
 * too many consecutive failures trips the breaker and pauses dispatch
 * until failures clear. Local equivalent bounds reviewer retries and
 * surfaces INCONCLUSIVE instead of silently retrying forever.
 */
export const LOCAL_BREAKER_THRESHOLD = 3; // upstream uses 20 for the colony; local keeps it low for single-machine concurrency
export const LOCAL_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Evidence rules adapted from `quality-assurance-system.prompt.ts`:
 * a subjective "pass" with no specific evidence is not acceptable; a
 * reviewer unable to determine correctness must escalate / mark
 * inconclusive (never guess PASS).
 */
export const REVIEWER_EVIDENCE_RULES = [
  'Correctness — does the code do what the requirement asked?',
  'Test coverage — are new features actually tested meaningfully?',
  'Security — no secrets, injection, or unsafe patterns in the changed surface.',
  'Regression — does the change preserve pre-existing behavior?',
  'Build artifacts — no generated files / node_modules / build output in scope.',
] as const;

/** Independent reviewer count (A + B) and one adjudicator pass, upstream-style. */
export const NUM_INDEPENDENT_REVIEWERS = 2;
export const ADJUDICATION_PASSES = 1;