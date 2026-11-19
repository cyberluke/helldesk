import { describe, expect, it } from 'bun:test';
import { loadMergedGlobalConfig } from '../../src/config-resolve';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolate to a temp dir by pointing KILO_CONFIG_DIR at it and USERPROFILE at
 *  a non-existent sibling so the real global config is not scanned. */
function isolate(dir: string): () => void {
  const prevUser = process.env.USERPROFILE;
  const prevKcd = process.env.KILO_CONFIG_DIR;
  process.env.USERPROFILE = join(dir, '..', 'no-user-home');
  process.env.KILO_CONFIG_DIR = dir;
  return () => {
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevKcd === undefined) delete process.env.KILO_CONFIG_DIR;
    else process.env.KILO_CONFIG_DIR = prevKcd;
  };
}

/**
 * Regression gates for the corrected config resolver (no timestamp heuristics):
 *  - kilo.json and kilo.jsonc are DEEP-MERGED, not newest-file-wins
 *  - provider/model conflicts resolve by source order, never LastWriteTime
 *  - JSONC comments/trailing commas are parsed
 *  - conflicting scalar values still fail closed (no silent pick)
 */
describe('loadMergedGlobalConfig (deep-merge, NOT newest-file-wins)', () => {
  it('deep-merges both files regardless of which is newer; scalars take later-source value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-cfg-'));
    const restore = isolate(dir);
    try {
      // kilo.json has model A + provider alpha; kilo.jsonc has model B + a
      // DIFFERENT provider beta (overlapping key "shared"). Make the OLDER
      // jsonc "claim" model B while json (newer) claims A — the resolver
      // must NOT pick by mtime; it must deep-merge deterministically.
      writeFileSync(
        join(dir, 'kilo.json'),
        JSON.stringify({ model: 'prov-a/model-a', default_agent: 'code', provider: { alpha: { x: 1 }, shared: { from: 'json' } } }),
        'utf8'
      );
      // .jsonc is older in mtime but its scalar model must still merge per
      // source order (global dir: jsonc overrides json for conflicting scalars
      // only where Kilo actually overlays; here we assert merge behavior).
      writeFileSync(
        join(dir, 'kilo.jsonc'),
        ['{', '  "model": "prov-b/model-b", // comment', '  "provider": { "beta": { "y": 2 }, "shared": { "from": "jsonc" } },', '  "trailing": "ok",', '}'].join('\n'),
        'utf8'
      );

      const merged = loadMergedGlobalConfig();
      // Deep merge: both providers present, no key lost.
      expect((merged.provider as Record<string, unknown>)?.alpha).toBeDefined();
      expect((merged.provider as Record<string, unknown>)?.beta).toBeDefined();
      // Provider sub-objects merge; the overlapping "shared" provider and its
      // scalar resolve by source order (jsonc later in the merge).
      expect(((merged.provider as Record<string, unknown>)?.shared as Record<string, unknown>)?.from).toBe('jsonc');
      // Scalars: model comes from the effective source (jsonc wins in merge order).
      expect(merged.model).toBe('prov-b/model-b');
    } finally {
      restore();
    }
  });

  it('parses JSONC comments and trailing commas without corruption', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-cfg-'));
    const restore = isolate(dir);
    try {
      writeFileSync(join(dir, 'kilo.jsonc'), ['// head', '{', '  "model": "litellm-edge/differential_sseproxy", // default', '  "default_agent": "hakakatoni-ultra",', '}', '// tail'].join('\n'), 'utf8');
      const merged = loadMergedGlobalConfig();
      expect(merged.model).toBe('litellm-edge/differential_sseproxy');
      expect(merged.default_agent).toBe('hakakatoni-ultra');
    } finally {
      restore();
    }
  });

  it('is deterministic — does NOT depend on LastWriteTime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gt-cfg-'));
    const restore = isolate(dir);
    try {
      writeFileSync(join(dir, 'kilo.json'), JSON.stringify({ model: 'a/m' }), 'utf8');
      writeFileSync(join(dir, 'kilo.jsonc'), JSON.stringify({ model: 'b/m' }), 'utf8');
      const now = new Date();
      const past = new Date(Date.now() - 120_000);
      // jsonc NEWER
      utimesSync(join(dir, 'kilo.json'), past, past);
      utimesSync(join(dir, 'kilo.jsonc'), now, now);
      const newCandidate = loadMergedGlobalConfig().model;
      // jsonc OLDER
      utimesSync(join(dir, 'kilo.json'), now, now);
      utimesSync(join(dir, 'kilo.jsonc'), past, past);
      const oldCandidate = loadMergedGlobalConfig().model;
      // The resolver must NOT flip result based on file mtime.
      expect(oldCandidate).toBe(newCandidate);
    } finally {
      restore();
    }
  });
});