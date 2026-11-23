import { describe, expect, it } from 'bun:test';
import { structuredFromPromptResponse } from '../../src/kilo-headless';

/**
 * Kilo's native structured output returns the tool-validated payload on the
 * assistant message (`info.structured`, server 7.8.x). The extractor is the
 * single transport boundary; older/alternate shapes are tolerated so the worker
 * never depends on one SDK version's envelope.
 */
describe('kilo structured-output extraction', () => {
  const verdict = {
    result: 'PASS',
    coverage: { changedFiles: 1, inspectedFiles: 1, uncoveredPaths: [] },
    findings: [],
    models: [],
  };

  it('reads info.structured from the 7.8.x prompt response', () => {
    const res = { data: { info: { structured: verdict }, parts: [{ type: 'text', text: 'ignored' }] } };
    expect(structuredFromPromptResponse(res)).toEqual(verdict);
  });

  it('tolerates alternate envelopes', () => {
    expect(structuredFromPromptResponse({ data: { structured: { a: 1 } } })).toEqual({ a: 1 });
    expect(structuredFromPromptResponse({ info: { structured: { b: 2 } } })).toEqual({ b: 2 });
    expect(structuredFromPromptResponse({ structured: { c: 3 } })).toEqual({ c: 3 });
  });

  it('returns undefined when no structured payload was produced (text fallback)', () => {
    expect(structuredFromPromptResponse({ data: { parts: [{ type: 'text', text: '{}' }] } })).toBeUndefined();
    expect(structuredFromPromptResponse({})).toBeUndefined();
    expect(structuredFromPromptResponse(null)).toBeUndefined();
    expect(structuredFromPromptResponse(undefined)).toBeUndefined();
  });
});
