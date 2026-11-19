import { describe, it, expect } from 'vitest';
import { buildSoulSystemPrompt } from './soul-system.prompt';

describe('buildSoulSystemPrompt', () => {
  const params = {
    agentName: 'polly',
    workstationId: 'workstation-123',
    departmentId: 'department-abc',
    identity: 'soul-alpha',
    gates: [],
  };

  it('should include agent name and identity', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('polly');
    expect(prompt).toContain('soul-alpha');
  });

  it('should include workstation and department IDs', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('workstation-123');
    expect(prompt).toContain('department-abc');
  });

  it('should include GUPP principle', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('GUPP');
    expect(prompt).toContain('execute immediately');
  });

  it('should list all 8 helldesk tools', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('gt_prime');
    expect(prompt).toContain('gt_ticket_status');
    expect(prompt).toContain('gt_ticket_close');
    expect(prompt).toContain('gt_done');
    expect(prompt).toContain('gt_memo_send');
    expect(prompt).toContain('gt_memo_check');
    expect(prompt).toContain('gt_escalate');
    expect(prompt).toContain('gt_checkpoint');
  });

  it('should include commit/push hygiene instructions', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('Push after every commit');
    expect(prompt).toContain('ephemeral');
  });

  it('should include escalation protocol', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('gt_escalate');
    expect(prompt).toContain('stuck');
  });

  it('should include Pre-Submission Gates section when gates are provided', () => {
    const prompt = buildSoulSystemPrompt({
      ...params,
      gates: ['pnpm test', 'pnpm lint', 'pnpm build'],
    });
    expect(prompt).toContain('## Pre-Submission Gates');
    expect(prompt).toContain('1. `pnpm test`');
    expect(prompt).toContain('2. `pnpm lint`');
    expect(prompt).toContain('3. `pnpm build`');
    expect(prompt).toContain('Do NOT call gt_done until all gates pass');
  });

  it('should not include Pre-Submission Gates section when gates is empty', () => {
    const prompt = buildSoulSystemPrompt({ ...params, gates: [] });
    expect(prompt).not.toContain('## Pre-Submission Gates');
  });

  it('should forbid PR creation when mergeStrategy is not set', () => {
    const prompt = buildSoulSystemPrompt(params);
    expect(prompt).toContain('Do NOT create pull requests');
    expect(prompt).toContain('Do NOT pass a `pr_url` to `gt_done`');
    expect(prompt).not.toContain('## Pull Request Creation');
  });

  it('should forbid PR creation when mergeStrategy is direct', () => {
    const prompt = buildSoulSystemPrompt({ ...params, mergeStrategy: 'direct' });
    expect(prompt).toContain('Do NOT create pull requests');
    expect(prompt).not.toContain('## Pull Request Creation');
  });

  it('should include PR creation instructions when mergeStrategy is pr', () => {
    const prompt = buildSoulSystemPrompt({
      ...params,
      mergeStrategy: 'pr',
      targetBranch: 'main',
    });
    expect(prompt).toContain('## Pull Request Creation');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('--base main');
    expect(prompt).toContain('pr_url');
    expect(prompt).not.toContain('Do NOT create pull requests');
    expect(prompt).not.toContain('Do NOT pass a `pr_url` to `gt_done`');
  });

  it('should use the provided targetBranch in PR creation instructions', () => {
    const prompt = buildSoulSystemPrompt({
      ...params,
      mergeStrategy: 'pr',
      targetBranch: 'develop',
    });
    expect(prompt).toContain('--base develop');
  });
});
