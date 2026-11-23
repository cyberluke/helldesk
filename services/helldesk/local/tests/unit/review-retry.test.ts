import { describe, expect, it } from 'bun:test';
import {
  REVIEW_MAX_ATTEMPTS,
  REVIEW_RETRY_BASE_MS,
  REVIEW_RETRY_MAX_MS,
  reviewRetryDelayMs,
  reviewRetryDue,
} from '../../src/review-retry';

describe('reviewRetryDelayMs', () => {
  it('runs the first attempt immediately, then backs off exponentially', () => {
    expect(reviewRetryDelayMs(0)).toBe(0);
    expect(reviewRetryDelayMs(1)).toBe(REVIEW_RETRY_BASE_MS);
    expect(reviewRetryDelayMs(2)).toBe(REVIEW_RETRY_BASE_MS * 2);
    expect(reviewRetryDelayMs(3)).toBe(REVIEW_RETRY_BASE_MS * 4);
    expect(reviewRetryDelayMs(6)).toBe(REVIEW_RETRY_MAX_MS);
    expect(reviewRetryDelayMs(99)).toBe(REVIEW_RETRY_MAX_MS);
  });

  it('caps the attempt budget (no 118-attempt governor storms)', () => {
    expect(REVIEW_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('reviewRetryDue', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');

  it('allows a first run immediately', () => {
    expect(reviewRetryDue(0, new Date(now).toISOString(), now)).toBe(true);
  });

  it('holds a failed job until its exponential backoff elapses', () => {
    const updated = new Date(now).toISOString();
    expect(reviewRetryDue(1, updated, now + 5_000)).toBe(false);
    expect(reviewRetryDue(1, updated, now + REVIEW_RETRY_BASE_MS)).toBe(true);
    expect(reviewRetryDue(2, updated, now + REVIEW_RETRY_BASE_MS)).toBe(false);
    expect(reviewRetryDue(2, updated, now + REVIEW_RETRY_BASE_MS * 2)).toBe(true);
  });

  it('treats missing/unparseable timestamps as due (never strand a job)', () => {
    expect(reviewRetryDue(3, null, now)).toBe(true);
    expect(reviewRetryDue(3, 'not-a-date', now)).toBe(true);
  });
});
