import { describe, expect, it } from 'bun:test';
import {
  describeReviewPolicy,
  effectiveReviewStages,
  mergeReviewControls,
  normalizeReviewControls,
  parseReviewControls,
  validateReviewControls,
} from '../../src/review-controls';

describe('review controls — per-task policy model', () => {
  it('defaults every review stage ON when no policy is stored', () => {
    expect(effectiveReviewStages(undefined)).toEqual({
      reviewerA: true,
      reviewerB: true,
      governor: true,
      anyReviewer: true,
    });
    expect(effectiveReviewStages({})).toEqual({
      reviewerA: true,
      reviewerB: true,
      governor: true,
      anyReviewer: true,
    });
  });

  it('the legacy reviewer master switch disables A and B but leaves the governor', () => {
    expect(effectiveReviewStages({ reviewer: false })).toEqual({
      reviewerA: false,
      reviewerB: false,
      governor: true,
      anyReviewer: false,
    });
  });

  it('Reviewer A and Reviewer B toggle independently', () => {
    expect(effectiveReviewStages({ reviewerB: false })).toMatchObject({
      reviewerA: true,
      reviewerB: false,
      governor: true,
      anyReviewer: true,
    });
    expect(effectiveReviewStages({ reviewerA: false, excellenceGovernor: false })).toMatchObject({
      reviewerA: false,
      reviewerB: true,
      governor: false,
      anyReviewer: true,
    });
  });

  it('ExcellenceGovernor only: A and B off, governor on', () => {
    const controls = { reviewer: false, reviewerA: false, reviewerB: false, excellenceGovernor: true };
    expect(effectiveReviewStages(controls)).toEqual({
      reviewerA: false,
      reviewerB: false,
      governor: true,
      anyReviewer: false,
    });
    expect(validateReviewControls(controls)).toBeNull();
  });

  it('rejects a policy that would run unreviewed (all stages off)', () => {
    expect(validateReviewControls({ reviewer: false, excellenceGovernor: false })).toContain('At least one');
    expect(validateReviewControls({ reviewerA: false, reviewerB: false, excellenceGovernor: false })).toContain('At least one');
    expect(validateReviewControls({ reviewerA: false, reviewerB: false, excellenceGovernor: false })).toContain('unreviewed');
  });

  it('normalizes only known, well-typed fields', () => {
    expect(normalizeReviewControls({
      reviewerA: 'yes',
      reviewerB: false,
      excellenceGovernor: 0,
      agents: true,
      review_mode: 'ReviewThenLand',
      junk: true,
    })).toEqual({ reviewerB: false, agents: true, review_mode: 'ReviewThenLand' });
    expect(normalizeReviewControls(null)).toEqual({});
    expect(normalizeReviewControls([])).toEqual({});
  });

  it('merges a patch without dropping persisted fields', () => {
    const base = { reviewer: false, reviewerA: false, reviewerB: false, excellenceGovernor: true, agents: true };
    expect(mergeReviewControls(base, { reviewerA: true })).toEqual({
      reviewer: false,
      reviewerA: true,
      reviewerB: false,
      excellenceGovernor: true,
      agents: true,
    });
  });

  it('describes the review policy honestly for the report/timeline', () => {
    expect(describeReviewPolicy({})).toContain('full');
    expect(describeReviewPolicy({ reviewer: false, excellenceGovernor: true })).toContain('ExcellenceGovernor only');
    expect(describeReviewPolicy({ reviewerB: false, excellenceGovernor: false })).toContain('Reviewer A only');
    expect(describeReviewPolicy({ reviewerA: true, reviewerB: true, excellenceGovernor: false })).toContain('Governor disabled');
  });

  it('parses JSON strings and plain objects', () => {
    expect(parseReviewControls('{"reviewerB":false}')).toEqual({ reviewerB: false });
    expect(parseReviewControls({ reviewerB: false })).toEqual({ reviewerB: false });
    expect(parseReviewControls('not-json')).toEqual({});
    expect(parseReviewControls(null)).toEqual({});
  });
});
