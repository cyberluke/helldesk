import { describe, expect, it } from 'bun:test';
import {
  CONTEXT_TIER_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  KILO_CONFIG_CONTENT_ENV_LIMIT_CHARS,
  KILO_CONFIG_TRANSPORT_LIMIT_CHARS,
  contextWindowForTier,
  normalizeContextTier,
  resolveContextBudget,
  tierForContextWindow,
} from '../../src/context-tiers';
import { kiloModelLimitsFromConfig } from '../../src/config-resolve';
import { buildReviewUserPrompt } from '../../src/inference';

/**
 * Context-tier contract gates.
 *
 * These are PURE tests (no files, no temp dirs): detection is exercised through
 * an injected `kiloLimits`/config object so the operator's real kilo.jsonc is
 * never read or mutated.
 */

const profileProvider = {
  provider: {
    'openai-compatible': {
      options: { baseURL: 'http://127.0.0.1:4000/v1' },
      models: {
        'demo-model-ctx-32k': { id: 'demo-model', limit: { context: 32768, input: 28672, output: 4096 } },
        'demo-model-ctx-512k': { id: 'demo-model', limit: { context: 524288, input: 442368, output: 65536 } },
        'demo-model': { id: 'demo-model', limit: { context: 524288, input: 442368, output: 65536 } },
      },
    },
    Azure: {
      models: {
        'deepseek-v4-flash': { limit: { context: 262000, output: 32000 } },
      },
    },
  },
};

describe('tier ladder', () => {
  it('defines the full local AI-first ladder', () => {
    expect(CONTEXT_TIER_TOKENS).toEqual({
      '32k': 32_768,
      '64k': 65_536,
      '96k': 98_304,
      '128k': 131_072,
      '256k': 262_144,
      '384k': 393_216,
      '512k': 524_288,
      '1m': 1_048_576,
    });
    expect(contextWindowForTier('1m')).toBe(1_048_576);
  });

  it('maps a window to the smallest covering tier (never a smaller window)', () => {
    expect(tierForContextWindow(16_384)).toBe('32k');
    expect(tierForContextWindow(32_768)).toBe('32k');
    expect(tierForContextWindow(32_769)).toBe('64k');
    expect(tierForContextWindow(131_072)).toBe('128k');
    expect(tierForContextWindow(262_000)).toBe('256k');
    expect(tierForContextWindow(393_216)).toBe('384k');
    expect(tierForContextWindow(524_288)).toBe('512k');
    expect(tierForContextWindow(4_194_304)).toBe('1m');
    expect(tierForContextWindow(0)).toBe('128k');
  });

  it('normalizes operator spellings without guessing', () => {
    expect(normalizeContextTier('auto')).toBe('auto');
    expect(normalizeContextTier('')).toBe('auto');
    expect(normalizeContextTier('bogus')).toBe('auto');
    expect(normalizeContextTier('512K')).toBe('512k');
    expect(normalizeContextTier(' 1m ')).toBe('1m');
    expect(normalizeContextTier(262_144)).toBe('256k');
    expect(normalizeContextTier('393216')).toBe('384k');
    expect(normalizeContextTier(524_288)).toBe('512k');
  });
});

describe('kilo.jsonc model limit detection', () => {
  it('reads provider.<id>.models.<model>.limit exactly', () => {
    expect(kiloModelLimitsFromConfig(profileProvider, 'Azure', 'deepseek-v4-flash')).toEqual({
      context: 262_000,
      output: 32_000,
    });
  });

  it('matches a profile model by its entry id (the active route may use the profile key)', () => {
    expect(kiloModelLimitsFromConfig(profileProvider, 'openai-compatible', 'demo-model-ctx-512k')).toEqual({
      context: 524_288,
      input: 442_368,
      output: 65_536,
    });
  });

  it('returns null for an unknown provider/model instead of guessing', () => {
    expect(kiloModelLimitsFromConfig(profileProvider, 'nope', 'model')).toBeNull();
    expect(kiloModelLimitsFromConfig(profileProvider, 'Azure', 'missing')).toBeNull();
    expect(kiloModelLimitsFromConfig(null, 'Azure', 'deepseek-v4-flash')).toBeNull();
  });
});

describe('resolveContextBudget precedence', () => {
  it('explicit window wins over tier and detection', () => {
    const b = resolveContextBudget({
      context: { tier: '32k', contextWindow: 524_288 },
      providerID: 'Azure',
      modelID: 'deepseek-v4-flash',
      kiloLimits: { context: 262_000, output: 32_000 },
    });
    expect(b.source).toBe('config-window');
    expect(b.contextWindow).toBe(524_288);
    expect(b.tier).toBe('512k');
  });

  it('explicit tier wins over detection', () => {
    const b = resolveContextBudget({
      context: { tier: '96k' },
      kiloLimits: { context: 524_288, output: 65_536 },
    });
    expect(b.source).toBe('config-tier');
    expect(b.contextWindow).toBe(98_304);
    expect(b.tier).toBe('96k');
  });

  it('auto detects the kilo.jsonc window', () => {
    const b = resolveContextBudget({
      context: { tier: 'auto' },
      providerID: 'openai-compatible',
      modelID: 'demo-model',
      kiloLimits: { context: 524_288, input: 442_368, output: 65_536 },
    });
    expect(b.source).toBe('kilo-jsonc');
    expect(b.contextWindow).toBe(524_288);
    expect(b.tier).toBe('512k');
    expect(b.outputBudgetTokens).toBe(65_536);
    expect(b.inputBudgetTokens).toBe(442_368);
  });

  it('falls back to 128K when nothing is configured or detected', () => {
    const b = resolveContextBudget({ context: { tier: 'auto' }, detect: false });
    expect(b.source).toBe('default');
    expect(b.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(b.tier).toBe('128k');
  });

  it('honors detected limit.input only when it belongs to the effective window', () => {
    const matching = resolveContextBudget({
      context: { tier: 'auto' },
      kiloLimits: { context: 131_072, input: 114_688, output: 16_384 },
    });
    expect(matching.inputBudgetTokens).toBe(114_688);

    const mismatched = resolveContextBudget({
      context: { tier: '32k' },
      kiloLimits: { context: 524_288, input: 442_368, output: 65_536 },
    });
    // Tier pinned the 32K window; the 512K profile's input budget must NOT leak.
    expect(mismatched.contextWindow).toBe(32_768);
    expect(mismatched.inputBudgetTokens).toBe(32_768 - 4_096);
  });
});

describe('review prompt uses the tier budget', () => {
  const promptFor = (promptCharBudget: number, diff: string) =>
    buildReviewUserPrompt({
      role: 'reviewer-a',
      targetId: 'snap_test',
      requirements: 'do the thing',
      changedFiles: ['src/a.ts', 'src/b.ts'],
      diff,
      reviewMode: 'frozen-evidence',
      promptCharBudget,
    });

  it('slices a huge diff to a small tier budget and marks the truncation honestly', () => {
    const diff = 'x'.repeat(2_000_000);
    const prompt = promptFor(40_000, diff);
    // Budget + the small truncation marker/tail.
    expect(prompt.length).toBeLessThan(42_000);
    expect(prompt).toContain('[diff truncated: showing');
    expect(prompt).toContain('context tier budget');
  });

  it('sends the full diff at a huge tier budget (no artificial 128K cap)', () => {
    const diff = 'y'.repeat(500_000);
    const prompt = promptFor(2_000_000, diff);
    expect(prompt).not.toContain('[diff truncated');
    expect(prompt.length).toBeGreaterThan(499_000);
  });
});

describe('budget math per tier', () => {
  it('32K: output 4096, input 28672, char budgets within the window', () => {
    const b = resolveContextBudget({ context: { tier: '32k' }, detect: false });
    expect(b.outputBudgetTokens).toBe(4_096);
    expect(b.inputBudgetTokens).toBe(28_672);
    expect(b.userPromptCharBudget).toBe(Math.floor(28_672 * 4 * 0.9));
    expect(b.reviewDiffCharBudget).toBeLessThan(b.userPromptCharBudget);
  });

  it('512K: output 65536 and a large prompt budget', () => {
    const b = resolveContextBudget({ context: { tier: '512k' }, detect: false });
    expect(b.contextWindow).toBe(524_288);
    expect(b.outputBudgetTokens).toBe(65_536);
    expect(b.inputBudgetTokens).toBe(524_288 - 65_536);
    expect(b.userPromptCharBudget).toBeGreaterThan(1_500_000);
  });

  it('1M: full ladder step, clamped output', () => {
    const b = resolveContextBudget({ context: { tier: '1m' }, detect: false });
    expect(b.contextWindow).toBe(1_048_576);
    expect(b.outputBudgetTokens).toBe(131_072);
    expect(b.userPromptCharBudget).toBeGreaterThan(3_000_000);
  });

  it('auto-detects a 1M frontier model and honors its declared input/output', () => {
    const b = resolveContextBudget({
      context: { tier: 'auto' },
      kiloLimits: { context: 1_048_576, input: 786_432, output: 262_144 },
    });
    expect(b.source).toBe('kilo-jsonc');
    expect(b.tier).toBe('1m');
    expect(b.inputBudgetTokens).toBe(786_432);
    expect(b.outputBudgetTokens).toBe(262_144);
    expect(b.userPromptCharBudget).toBe(Math.floor(786_432 * 4 * 0.9));
  });

  it('operator knobs shrink the prompt budget without touching the transport cap', () => {
    const b = resolveContextBudget({
      context: { tier: '512k', charsPerToken: 3, promptUtilization: 0.5, reservedOutputTokens: 32_000 },
      detect: false,
    });
    expect(b.outputBudgetTokens).toBe(32_000);
    expect(b.inputBudgetTokens).toBe(524_288 - 32_000);
    expect(b.userPromptCharBudget).toBe(Math.floor((524_288 - 32_000) * 3 * 0.5));
    // The Windows config transport is a DIFFERENT budget; context tiers never move it.
    expect(b.kiloConfigTransportLimitChars).toBe(28_000);
    expect(KILO_CONFIG_TRANSPORT_LIMIT_CHARS).toBeLessThan(KILO_CONFIG_CONTENT_ENV_LIMIT_CHARS);
  });

  it('clamps an absurd reserved output so the input budget never goes non-positive', () => {
    const b = resolveContextBudget({
      context: { tier: '32k', reservedOutputTokens: 262_144 },
      detect: false,
    });
    expect(b.outputBudgetTokens).toBeLessThanOrEqual(32_768 - 1_024);
    expect(b.inputBudgetTokens).toBeGreaterThan(0);
  });
});
