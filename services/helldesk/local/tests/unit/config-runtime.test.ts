import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config';
import { RuntimeConfigStore } from '../../src/config-runtime';

/**
 * Regression: the default config path is relative (`config.json`), so
 * dirname(path) === '.'. mkdirSync('.', {recursive:true}) throws EEXIST on
 * Windows, which made every config PATCH (including per-role models) fail.
 */
describe('RuntimeConfigStore.persist', () => {
  test('applies token pricing live and persists it', async () => {
    const name = `config-runtime-pricing-${process.pid}.json`;
    const path = join(process.cwd(), name);
    try {
      const store = new RuntimeConfigStore(loadConfig(), name);
      const result = await store.patch({
        policy: {
          pricing: {
            providers: { cyberluke: { inputPer1M: 0.14, outputPer1M: 0.28 } },
            runners: { kilo: { inputPer1M: 1, outputPer1M: 2 } },
          },
        },
      });
      expect(result.appliedLive).toContain('policy.pricing');
      expect(result.rejected).toEqual([]);
      expect(store.get().policy.pricing?.providers?.cyberluke).toEqual({ inputPer1M: 0.14, outputPer1M: 0.28 });
      expect(store.get().policy.pricing?.runners?.kilo).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    } finally {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
      try { rmSync(`${path}.tmp`, { force: true }); } catch { /* best effort */ }
    }
  });

  test('persists a bare relative config file without mkdir EEXIST', () => {
    const name = `config-runtime-test-${process.pid}.json`;
    const path = join(process.cwd(), name);
    try {
      const store = new RuntimeConfigStore(loadConfig(), name);
      expect(() => store.persist()).not.toThrow();
      expect(existsSync(path)).toBe(true);
    } finally {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
      try { rmSync(`${path}.tmp`, { force: true }); } catch { /* best effort */ }
    }
  });
});
