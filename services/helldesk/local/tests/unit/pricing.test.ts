import { describe, expect, it } from 'bun:test';
import { computeTokenCost, formatUsd, resolveTokenPrice } from '../../src/pricing';
import type { PricingConfig } from '../../src/config';

const pricing: PricingConfig = {
  models: { 'cyberluke/deepseek-v41': { inputPer1M: 0.14, outputPer1M: 0.28 } },
  providers: { cyberluke: { inputPer1M: 1, outputPer1M: 2 } },
  runners: { kilo: { inputPer1M: 3, outputPer1M: 6 } },
  default: { inputPer1M: 10, outputPer1M: 20 },
};

describe('token pricing', () => {
  it('resolves model → provider → runner → default in that order', () => {
    expect(resolveTokenPrice(pricing, { providerID: 'cyberluke', modelID: 'deepseek-v41', runner: 'kilo' })?.rule)
      .toBe('model:cyberluke/deepseek-v41');
    expect(resolveTokenPrice(pricing, { providerID: 'cyberluke', modelID: 'other', runner: 'kilo' })?.rule)
      .toBe('provider:cyberluke');
    expect(resolveTokenPrice(pricing, { providerID: 'unknown', runner: 'kilo' })?.rule).toBe('runner:kilo');
    expect(resolveTokenPrice(pricing, { providerID: 'unknown', runner: 'codex' })?.rule).toBe('default');
  });

  it('calculates USD from input and output tokens per 1M', () => {
    // 1M input @ $3 + 0.5M output @ $15 (model rule overrides the runner rule)
    const modelPricing: PricingConfig = {
      models: { 'fake-provider/fake-model': { inputPer1M: 3, outputPer1M: 15 } },
    };
    const result = computeTokenCost(modelPricing, {
      providerID: 'fake-provider',
      modelID: 'fake-model',
      tokensIn: 1_000_000,
      tokensOut: 500_000,
    });
    expect(result.rule).toBe('model:fake-provider/fake-model');
    expect(result.cost).toBeCloseTo(10.5, 10);
  });

  it('reports unknown instead of $0 when no price applies', () => {
    const result = computeTokenCost(undefined, {
      providerID: 'x',
      modelID: 'y',
      tokensIn: 100,
      tokensOut: 100,
    });
    expect(result.cost).toBeNull();
    expect(result.rule).toBeNull();
  });

  it('treats missing usage as unknown, not free', () => {
    const result = computeTokenCost(pricing, { providerID: 'cyberluke', modelID: 'deepseek-v41' });
    expect(result.cost).toBeNull();
    expect(result.rule).toBe('model:cyberluke/deepseek-v41');
  });

  it('treats a configured $0 as a real $0 (local/free), not missing', () => {
    const result = computeTokenCost(
      { default: { inputPer1M: 0, outputPer1M: 0 } },
      { providerID: 'local', modelID: 'llama', tokensIn: 1_000, tokensOut: 500 },
    );
    expect(result.cost).toBe(0);
    expect(result.rule).toBe('default');
    expect(formatUsd(result.cost)).toBe('$0.0000');
  });

  it('formats tiny and normal costs for the operator UI', () => {
    expect(formatUsd(0.086793)).toBe('$0.0868');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(null)).toBe('not priced');
  });
});
