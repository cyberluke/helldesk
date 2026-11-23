import { describe, expect, it, afterEach } from 'bun:test';
import { resolveModel, setModelCatalog, parseModelRef, ModelResolutionError } from '../../src/model-resolver';
import { resolveMutationRunner } from '../../src/mutation-runner';

afterEach(() => setModelCatalog(null));

describe('model resolver (no Kilo Gateway)', () => {
  it('never introduces a kilo provider or invents IDs', () => {
    const m = resolveModel({ explicit: { providerID: 'qwen-flash-next', modelID: 'qwen3-flash-next-cyber' } });
    expect(m.providerID).toBe('qwen-flash-next');
    expect(m.modelID).toBe('qwen3-flash-next-cyber');
    expect(m.modelID).not.toMatch(/^kilo\//);
  });

  it('preserves model IDs containing slashes verbatim', () => {
    const m = parseModelRef('anthropic/claude-opus-4.1/foo');
    expect(m).toEqual({ providerID: 'anthropic', modelID: 'claude-opus-4.1/foo' });
  });

  it('refuses to silently substitute an unavailable explicit model', () => {
    setModelCatalog({ hasModel: () => false, activeModel: () => null });
    expect(() =>
      resolveModel({ explicit: { providerID: 'p', modelID: 'm' } })
    ).toThrow(ModelResolutionError);
  });

  it('inherits the active model from the catalog', () => {
    setModelCatalog({ hasModel: () => true, activeModel: () => ({ providerID: 'local', modelID: 'lm-studio/qwen' }) });
    const m = resolveModel({ inheritFrom: 'catalog' });
    expect(m.source).toBe('inherit');
    expect(m.providerID).toBe('local');
  });

  it('throws without a resolvable model rather than guessing', () => {
    expect(() => resolveModel({ inheritFrom: 'none' })).toThrow(ModelResolutionError);
  });

  it('fails closed when the Kilo mutation runner has no effective model route', () => {
    expect(() =>
      resolveMutationRunner({
        mutationRunner: 'kilo',
        codexBin: '',
        providerID: '',
        modelID: '',
        baseURL: '',
      })
    ).toThrow(/mutation-model-missing/);
  });
});