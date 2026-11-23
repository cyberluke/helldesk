import { describe, expect, test } from 'bun:test';
import { buildSdkConfig } from '../../src/kilo-headless';

describe('headless Kilo SDK config', () => {
  const config = buildSdkConfig({
    role: 'sizer',
    providerID: 'test-provider',
    modelID: 'test-model',
    baseURL: 'http://127.0.0.1:1/v1',
    kiloBin: 'kilo',
    snapshotStore: 'C:\\store',
    system: 'system',
    user: 'user',
    directory: 'C:\\workspace',
    contextWindowTokens: 32768,
    maxOutputTokens: 2048,
    agentName: 'helldesk-sizer',
    agentPrompt: 'Estimate the task size.',
  });
  const agent = (config.agent as Record<string, { prompt?: unknown }>)['helldesk-sizer'];

  test('agent prompt is a string (the server rejects an array)', () => {
    expect(typeof agent?.prompt).toBe('string');
    expect(agent?.prompt).toContain('Estimate');
  });

  test('the model has an explicit output limit', () => {
    const provider = (config.provider as Record<string, { models: Record<string, { limit: Record<string, number> }> }>)['test-provider'];
    expect(provider?.models['test-model']?.limit.output).toBe(2048);
    expect(provider?.models['test-model']?.limit.input).toBe(30720);
  });
});
