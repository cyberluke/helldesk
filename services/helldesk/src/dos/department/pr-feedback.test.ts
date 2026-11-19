import { describe, it, expect } from 'vitest';
import { DepartmentConfigSchema } from '../../types';
import { _parsePrUrl as parsePrUrl } from './actions';
import { DepartmentEventType } from '../../db/tables/department-events.table';
import { ReviewMetadataRecord } from '../../db/tables/review-metadata.table';
import { buildQualityAssuranceSystemPrompt } from '../../prompts/quality-assurance-system.prompt';

describe('DepartmentConfigSchema qualityAssurance extensions', () => {
  it('defaults code_review to true', () => {
    const config = DepartmentConfigSchema.parse({ qualityAssurance: {} });
    expect(config.qualityAssurance?.code_review).toBe(true);
  });

  it('accepts code_review = false', () => {
    const config = DepartmentConfigSchema.parse({ qualityAssurance: { code_review: false } });
    expect(config.qualityAssurance?.code_review).toBe(false);
  });

  // Schema-level defaults are deliberately conservative — parsing an empty
  // object returns undefined/false/null for the keys whose "new department" values
  // moved into seedNewDepartmentConfig(). This protects existing persisted configs
  // from silently flipping behavior when they're re-loaded after a deploy.
  it('does NOT inject qualityAssurance defaults when parsing an empty object', () => {
    const config = DepartmentConfigSchema.parse({});
    expect(config.qualityAssurance).toBeUndefined();
  });

  it('defaults auto_resolve_pr_feedback to false when qualityAssurance: {} is supplied', () => {
    const configWithQualityAssurance = DepartmentConfigSchema.parse({ qualityAssurance: {} });
    expect(configWithQualityAssurance.qualityAssurance?.auto_resolve_pr_feedback).toBe(false);
  });

  it('defaults auto_merge_delay_minutes to null', () => {
    const config = DepartmentConfigSchema.parse({ qualityAssurance: {} });
    expect(config.qualityAssurance?.auto_merge_delay_minutes).toBeNull();
  });

  it('accepts auto_resolve_pr_feedback = true', () => {
    const config = DepartmentConfigSchema.parse({
      qualityAssurance: { auto_resolve_pr_feedback: true },
    });
    expect(config.qualityAssurance?.auto_resolve_pr_feedback).toBe(true);
  });

  it('accepts auto_merge_delay_minutes = 0 (immediate merge)', () => {
    const config = DepartmentConfigSchema.parse({
      qualityAssurance: { auto_merge_delay_minutes: 0 },
    });
    expect(config.qualityAssurance?.auto_merge_delay_minutes).toBe(0);
  });

  it('accepts auto_merge_delay_minutes = 15', () => {
    const config = DepartmentConfigSchema.parse({
      qualityAssurance: { auto_merge_delay_minutes: 15 },
    });
    expect(config.qualityAssurance?.auto_merge_delay_minutes).toBe(15);
  });

  it('rejects negative auto_merge_delay_minutes', () => {
    expect(() => DepartmentConfigSchema.parse({ qualityAssurance: { auto_merge_delay_minutes: -1 } })).toThrow();
  });

  it('preserves existing qualityAssurance fields alongside new ones', () => {
    const config = DepartmentConfigSchema.parse({
      qualityAssurance: {
        gates: ['npm test'],
        auto_merge: false,
        require_clean_merge: true,
        auto_resolve_pr_feedback: true,
        auto_merge_delay_minutes: 60,
      },
    });
    expect(config.qualityAssurance?.gates).toEqual(['npm test']);
    expect(config.qualityAssurance?.auto_merge).toBe(false);
    expect(config.qualityAssurance?.require_clean_merge).toBe(true);
    expect(config.qualityAssurance?.auto_resolve_pr_feedback).toBe(true);
    expect(config.qualityAssurance?.auto_merge_delay_minutes).toBe(60);
  });
});

describe('parsePrUrl', () => {
  it('parses GitHub PR URLs', () => {
    const result = parsePrUrl('https://github.com/cyberluke/helldesk/pull/42');
    expect(result).toEqual({ repo: 'cyberluke/helldesk', prNumber: 42 });
  });

  it('parses GitHub PR URLs with long paths', () => {
    const result = parsePrUrl('https://github.com/org/repo/pull/123');
    expect(result).toEqual({ repo: 'org/repo', prNumber: 123 });
  });

  it('parses GitLab MR URLs', () => {
    const result = parsePrUrl('https://gitlab.com/group/project/-/merge_requests/7');
    expect(result).toEqual({ repo: 'group/project', prNumber: 7 });
  });

  it('parses GitLab MR URLs with subgroups', () => {
    const result = parsePrUrl('https://gitlab.example.com/org/team/project/-/merge_requests/99');
    expect(result).toEqual({ repo: 'org/team/project', prNumber: 99 });
  });

  it('returns null for unrecognized URLs', () => {
    expect(parsePrUrl('https://example.com/pr/1')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });
});

describe('DepartmentEventType enum', () => {
  it('includes pr_feedback_detected and pr_auto_merge', () => {
    expect(DepartmentEventType.options).toContain('pr_feedback_detected');
    expect(DepartmentEventType.options).toContain('pr_auto_merge');
  });
});

describe('ReviewMetadataRecord', () => {
  it('includes auto_merge_ready_since and last_feedback_check_at fields', () => {
    const result = ReviewMetadataRecord.parse({
      ticket_id: 'test-id',
      branch: 'feature/test',
      target_branch: 'main',
      merge_commit: null,
      pr_url: 'https://github.com/org/repo/pull/1',
      retry_count: 0,
      auto_merge_ready_since: '2025-01-01T00:00:00.000Z',
      last_feedback_check_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.auto_merge_ready_since).toBe('2025-01-01T00:00:00.000Z');
    expect(result.last_feedback_check_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('accepts null for new fields', () => {
    const result = ReviewMetadataRecord.parse({
      ticket_id: 'test-id',
      branch: 'feature/test',
      target_branch: 'main',
      merge_commit: null,
      pr_url: null,
      retry_count: 0,
      auto_merge_ready_since: null,
      last_feedback_check_at: null,
    });
    expect(result.auto_merge_ready_since).toBeNull();
    expect(result.last_feedback_check_at).toBeNull();
  });
});

describe('buildQualityAssuranceSystemPrompt with existingPrUrl', () => {
  const baseParams = {
    identity: 'quality-assurance-alpha',
    workstationId: 'workstation-1',
    departmentId: 'department-1',
    gates: ['pnpm test'],
    branch: 'gt/toast/abc123',
    targetBranch: 'main',
    soulAgentId: 'soul-1',
    mergeStrategy: 'pr' as const,
  };

  it('produces standard PR-creation prompt when no existingPrUrl', () => {
    const prompt = buildQualityAssuranceSystemPrompt(baseParams);
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('create a pull request');
    expect(prompt).not.toContain('Pull Request:');
  });

  it('produces PR-review prompt in rework mode (default) when existingPrUrl is set', () => {
    const prompt = buildQualityAssuranceSystemPrompt({
      ...baseParams,
      existingPrUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(prompt).toContain('https://github.com/org/repo/pull/42');
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('gt_request_changes');
    expect(prompt).toContain('Do NOT merge the PR');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).toContain('Do NOT create a new PR');
  });

  it('produces PR-review prompt in comments mode when existingPrUrl is set', () => {
    const prompt = buildQualityAssuranceSystemPrompt({
      ...baseParams,
      existingPrUrl: 'https://github.com/org/repo/pull/42',
      reviewMode: 'comments',
    });
    expect(prompt).toContain('https://github.com/org/repo/pull/42');
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('gh api repos/');
    expect(prompt).toContain('gh pr comment');
    expect(prompt).toContain('Do NOT merge the PR');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).toContain('Do NOT use `gh pr review --approve`');
  });

  it('includes gates in PR-review prompt', () => {
    const prompt = buildQualityAssuranceSystemPrompt({
      ...baseParams,
      gates: ['pnpm test', 'pnpm lint'],
      existingPrUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(prompt).toContain('pnpm test');
    expect(prompt).toContain('pnpm lint');
  });
});
