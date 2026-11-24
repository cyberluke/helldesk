import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveKiloProviderOptions } from '../../src/config-resolve';
import { resolveKiloBinary } from '../../src/kilo-binary';
import { runKiloInference } from '../../src/kilo-headless';

const live = process.env.HELLDESK_LIVE_REVIEW_FILES === '1';

/**
 * Live proof that review workers attach local images as model file parts.
 * Run with HELLDESK_LIVE_REVIEW_FILES=1 bun test tests/integration/review-files-live.test.ts
 * Skipped by default because it calls the real provider and consumes tokens.
 */
(live ? test : test.skip)('review worker sees an attached image', async () => {
  const provider = resolveKiloProviderOptions('cyberluke');
  const kilo = resolveKiloBinary();
  expect(provider).not.toBeNull();
  expect(kilo).not.toBeNull();
  const fixture = join(import.meta.dir, '..', 'fixtures', 'vision-probe.png');

  const result = await runKiloInference({
    role: 'governor',
    providerID: 'cyberluke',
    modelID: 'deepseek-ai--deepseek-v41-flash-1017',
    baseURL: provider!.baseURL,
    apiKey: provider!.apiKey,
    providerConfig: provider!.providerConfig,
    kiloBin: kilo!.path,
    snapshotStore: process.cwd(),
    system: 'You are a read-only vision probe. Answer only from the attached image.',
    user: 'The attached image contains one exact word. Reply with only that word.',
    directory: process.cwd(),
    files: [fixture],
    contextWindowTokens: 32768,
    inputBudgetTokens: 20000,
    maxOutputTokens: 2048,
  });

  expect(result.ok).toBe(true);
  expect(result.text).toContain('VISION_OK');
}, 180_000);

(live ? test : test.skip)('review worker baseline without files', async () => {
  const provider = resolveKiloProviderOptions('cyberluke');
  const kilo = resolveKiloBinary();
  expect(provider).not.toBeNull();
  expect(kilo).not.toBeNull();

  const result = await runKiloInference({
    role: 'governor',
    providerID: 'cyberluke',
    modelID: 'deepseek-ai--deepseek-v41-flash-1017',
    baseURL: provider!.baseURL,
    apiKey: provider!.apiKey,
    providerConfig: provider!.providerConfig,
    kiloBin: kilo!.path,
    snapshotStore: process.cwd(),
    system: 'You are a read-only probe.',
    user: 'Reply with the word BASELINE_OK and nothing else.',
    directory: process.cwd(),
    contextWindowTokens: 32768,
    inputBudgetTokens: 20000,
    maxOutputTokens: 2048,
  });

  if (!result.ok) console.error('BASELINE_ERROR', result.error, result.tookMs);
  expect(result.ok).toBe(true);
  expect(result.text).toContain('BASELINE_OK');
}, 180_000);