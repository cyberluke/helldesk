/**
 * review-controls.ts — the ONE per-task review-policy model.
 *
 * The operator's task controls (Task Studio enforcer picker, Kanban toggles, the
 * task drawer) all persist the same `break_room_controls` object:
 *
 *   {
 *     agents?: boolean,             // dispatch the implementer crew at all
 *     reviewer?: boolean,           // master switch for the A/B reviewer layer
 *     reviewerA?: boolean,          // independent correctness reviewer
 *     reviewerB?: boolean,          // independent adversarial reviewer
 *     excellenceGovernor?: boolean, // the governor/adjudicator verdict stage
 *     review_mode?: 'ReviewThenLand' | 'ReviewAndMerge'
 *   }
 *
 * Defaults are backward compatible: an omitted flag means ENABLED. `reviewer:
 * false` is the legacy master switch and disables A and B regardless of their
 * individual flags. At least one of {reviewerA, reviewerB, excellenceGovernor}
 * must remain enabled — the platform never silently runs unreviewed work.
 *
 * This module is pure (no DB/HTTP) so the engine, the mission controller, the
 * local-live handlers and the UI can share exactly one interpretation.
 */

export type ReviewMode = 'ReviewThenLand' | 'ReviewAndMerge';

export interface ReviewControls {
  agents?: boolean;
  reviewer?: boolean;
  reviewerA?: boolean;
  reviewerB?: boolean;
  excellenceGovernor?: boolean;
  review_mode?: ReviewMode;
}

export interface EffectiveReviewStages {
  reviewerA: boolean;
  reviewerB: boolean;
  /** The ExcellenceGovernor verdict stage (adjudicator, or a direct single pass). */
  governor: boolean;
  anyReviewer: boolean;
}

const BOOL_KEYS = ['agents', 'reviewer', 'reviewerA', 'reviewerB', 'excellenceGovernor'] as const;

/** Keep only well-typed control fields; unknown keys are ignored, never trusted. */
export function normalizeReviewControls(raw: unknown): ReviewControls {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: ReviewControls = {};
  for (const key of BOOL_KEYS) {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
  }
  if (src.review_mode === 'ReviewThenLand' || src.review_mode === 'ReviewAndMerge') {
    out.review_mode = src.review_mode;
  }
  return out;
}

/** Resolve the flags that actually govern review execution. */
export function effectiveReviewStages(raw: unknown): EffectiveReviewStages {
  const controls = normalizeReviewControls(raw);
  const reviewerMaster = controls.reviewer !== false;
  const reviewerA = reviewerMaster && controls.reviewerA !== false;
  const reviewerB = reviewerMaster && controls.reviewerB !== false;
  const governor = controls.excellenceGovernor !== false;
  return { reviewerA, reviewerB, governor, anyReviewer: reviewerA || reviewerB };
}

/** Merge a persisted/base controls object with an operator patch (last write wins). */
export function mergeReviewControls(base: unknown, patch: unknown): ReviewControls {
  return { ...normalizeReviewControls(base), ...normalizeReviewControls(patch) };
}

/**
 * Validate a MERGED controls object. Returns an operator-readable error when the
 * policy would run the task with no independent review at all.
 */
export function validateReviewControls(raw: unknown): string | null {
  const stages = effectiveReviewStages(raw);
  if (!stages.reviewerA && !stages.reviewerB && !stages.governor) {
    return 'At least one of excellenceGovernor, reviewerA, reviewerB must remain enabled (a task cannot run unreviewed).';
  }
  return null;
}

/** Human-readable policy label used by the review report, mission report and UI. */
export function describeReviewPolicy(raw: unknown): string {
  const stages = effectiveReviewStages(raw);
  const reviewers = [
    ...(stages.reviewerA ? ['Reviewer A'] : []),
    ...(stages.reviewerB ? ['Reviewer B'] : []),
  ];
  if (!stages.reviewerA && !stages.reviewerB && stages.governor) {
    return 'ExcellenceGovernor only (Reviewer A/B disabled by operator)';
  }
  if (stages.reviewerA && stages.reviewerB && stages.governor) {
    return 'Reviewer A + Reviewer B + ExcellenceGovernor (full)';
  }
  if (reviewers.length && !stages.governor) {
    return `${reviewers.join(' + ')} only (Governor disabled by operator)`;
  }
  if (reviewers.length) {
    return `${reviewers.join(' + ')} + ExcellenceGovernor`;
  }
  return 'Unreviewed (invalid policy)';
}

/**
 * Stable identity of the EFFECTIVE review roles for job dedupe. The default
 * policy keeps the legacy fingerprint ('1') so existing jobs/revisions dedupe
 * exactly as before. A non-default policy gets its own identity so toggling
 * Reviewer A/B (or Governor) on the SAME immutable snapshot starts a genuinely
 * new review instead of silently reusing a verdict produced under another policy.
 */
export function reviewControlsFingerprint(raw: unknown): string {
  const stages = effectiveReviewStages(raw);
  if (stages.reviewerA && stages.reviewerB && stages.governor) return '1';
  return `roles-a${stages.reviewerA ? 1 : 0}b${stages.reviewerB ? 1 : 0}g${stages.governor ? 1 : 0}`;
}

/** Parse a persisted controls_json / metadata.break_room_controls value. */
export function parseReviewControls(raw: unknown): ReviewControls {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return normalizeReviewControls(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return normalizeReviewControls(raw);
}
