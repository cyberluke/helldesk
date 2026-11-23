/** Review-job retry policy.
 *
 * The governor/adjudication loop used to requeue a failing review immediately:
 * 118 attempts at ~15s looked like 118 model turns and burned the provider
 * socket budget. Reviews now retry with bounded exponential backoff and a hard
 * attempt cap; the attempts stay visible through `review_attempts` / workers.
 */
export const REVIEW_MAX_ATTEMPTS = 8;
export const REVIEW_RETRY_BASE_MS = 15_000;
export const REVIEW_RETRY_MAX_MS = 300_000;

/** Delay after the Nth failed attempt (0 for the first run). */
export function reviewRetryDelayMs(attemptCount: number): number {
  if (!Number.isFinite(attemptCount) || attemptCount <= 0) return 0;
  const exponent = Math.min(Math.floor(attemptCount) - 1, 10);
  return Math.min(REVIEW_RETRY_MAX_MS, REVIEW_RETRY_BASE_MS * Math.pow(2, exponent));
}

/** True when a QUEUED job has waited out its backoff and may run again. */
export function reviewRetryDue(
  attemptCount: number,
  updatedAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (reviewRetryDelayMs(attemptCount) === 0) return true;
  if (!updatedAt) return true;
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return true;
  return now - updated >= reviewRetryDelayMs(attemptCount);
}
