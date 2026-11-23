/**
 * pricing.ts — token-usage → USD cost.
 *
 * Prices are USD per 1,000,000 tokens, configured by the operator in Settings
 * (policy.pricing). Resolution is explicit and deterministic:
 *
 *   models["provider/model"] → providers["provider"] → runners["runner"] → default
 *
 * Missing pricing is NOT zero: the cost is reported as null/unknown so a cheap
 * looking report can never be fabricated from absent data.
 */
import type { PricingConfig, TokenPrice } from './config';

export interface PricingLookup {
  providerID?: string | null;
  modelID?: string | null;
  runner?: string | null;
}

export interface TokenCostInput extends PricingLookup {
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface PriceResolution {
  price: TokenPrice;
  /** Which rule matched, for the report/UI audit trail. */
  rule: string;
}

export interface TokenCostResult {
  cost: number | null;
  rule: string | null;
  inputPer1M: number | null;
  outputPer1M: number | null;
}

export function resolveTokenPrice(
  pricing: PricingConfig | undefined,
  lookup: PricingLookup,
): PriceResolution | null {
  if (!pricing) return null;
  const providerID = lookup.providerID?.trim() || null;
  const modelID = lookup.modelID?.trim() || null;
  const runner = lookup.runner?.trim() || null;
  const modelKey = providerID && modelID ? `${providerID}/${modelID}` : null;
  if (modelKey) {
    const price = pricing.models?.[modelKey];
    if (price) return { price, rule: `model:${modelKey}` };
  }
  if (providerID) {
    const price = pricing.providers?.[providerID];
    if (price) return { price, rule: `provider:${providerID}` };
  }
  if (runner) {
    const price = pricing.runners?.[runner];
    if (price) return { price, rule: `runner:${runner}` };
  }
  if (pricing.default) return { price: pricing.default, rule: 'default' };
  return null;
}

export function computeTokenCost(
  pricing: PricingConfig | undefined,
  input: TokenCostInput,
): TokenCostResult {
  const resolved = resolveTokenPrice(pricing, input);
  if (!resolved) {
    return { cost: null, rule: null, inputPer1M: null, outputPer1M: null };
  }
  if (input.tokensIn == null && input.tokensOut == null) {
    return {
      cost: null,
      rule: resolved.rule,
      inputPer1M: resolved.price.inputPer1M,
      outputPer1M: resolved.price.outputPer1M,
    };
  }
  const tokensIn = input.tokensIn ?? 0;
  const tokensOut = input.tokensOut ?? 0;
  const cost =
    (tokensIn / 1_000_000) * resolved.price.inputPer1M +
    (tokensOut / 1_000_000) * resolved.price.outputPer1M;
  return {
    cost,
    rule: resolved.rule,
    inputPer1M: resolved.price.inputPer1M,
    outputPer1M: resolved.price.outputPer1M,
  };
}

/** Operator-facing compact USD formatting (four decimals; sub-cent stays visible). */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'not priced';
  if (value === 0) return '$0.0000';
  if (Math.abs(value) < 0.0001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}
