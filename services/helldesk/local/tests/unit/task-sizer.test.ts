import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/db';
import { createFakeRunner } from '../../src/inference';
import { sizeTask, taskSpecHash, TSHIRT_POINTS } from '../../src/task-sizer';

function db() {
  const d = openDb(':memory:');
  d.runMigration();
  return d;
}

describe('task sizer', () => {
  test('maps T-shirt sizes to Fibonacci points', () => {
    expect(TSHIRT_POINTS).toEqual({ XS: 1, S: 2, M: 3, L: 5, XL: 8, XXL: 13 });
  });

  test('sizes with the structured fake runner and caches by spec hash', async () => {
    const d = db();
    try {
      const runner = createFakeRunner();
      const spec = { title: 'Add a small settings toggle', objective: 'one file + test' };
      const first = await sizeTask(d, runner, spec, { providerID: 'fake', modelID: 'fake', timeoutMs: 2_000 });
      expect(first.state).toBe('sized');
      expect(first.tshirt).toBe('M');
      expect(first.points).toBe(3);
      expect(first.confidence).toBe('high');
      expect(first.cached).toBe(false);
      const second = await sizeTask(d, runner, spec, { providerID: 'fake', modelID: 'fake', timeoutMs: 2_000 });
      expect(second.state).toBe('sized');
      expect(second.cached).toBe(true);
      expect(taskSpecHash(spec)).toBe(taskSpecHash({ ...spec }));
      expect(taskSpecHash(spec)).not.toBe(taskSpecHash({ title: 'Different task' }));
      const cache = d.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_size_cache`).get();
      expect(cache?.n).toBe(1);
    } finally {
      d.close();
    }
  });

  test('fails open (unsized) when no model is configured', async () => {
    const d = db();
    try {
      const result = await sizeTask(d, createFakeRunner(), { title: 'task' }, { providerID: null, modelID: null });
      expect(result.state).toBe('unsized');
      expect(result.points).toBeNull();
      expect(result.error).toContain('no sizing model');
    } finally {
      d.close();
    }
  });

  test('fails open on malformed JSON and never guesses a point value', async () => {
    const d = db();
    try {
      const runner = {
        kind: 'fake' as const,
        async run() {
          return { ok: true, text: 'this is not json', tookMs: 1 };
        },
      };
      const result = await sizeTask(d, runner, { title: 'bad output' }, { providerID: 'fake', modelID: 'fake', timeoutMs: 2_000 });
      expect(result.state).toBe('unsized');
      expect(result.points).toBeNull();
      expect(result.error).toContain('invalid sizing JSON');
    } finally {
      d.close();
    }
  });

  test('fails open after the timeout cap', async () => {
    const d = db();
    try {
      const runner = {
        kind: 'fake' as const,
        run: () =>
          new Promise<{ ok: true; text: string; tookMs: number }>((resolve) =>
            setTimeout(() => resolve({ ok: true, text: '{"tshirt":"L"}', tookMs: 2_000 }), 2_000)
          ),
      };
      const started = Date.now();
      const result = await sizeTask(d, runner, { title: 'slow sizing' }, { providerID: 'fake', modelID: 'fake', timeoutMs: 1_000 });
      expect(result.state).toBe('unsized');
      expect(result.error).toContain('timed out');
      expect(Date.now() - started).toBeLessThan(1_800);
    } finally {
      d.close();
    }
  });
});
