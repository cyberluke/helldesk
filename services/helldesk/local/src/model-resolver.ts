/**
 * Effective local provider/model resolution. Never selects the Kilo Gateway,
 * never invents provider IDs, and never silently substitutes an unavailable
 * model. Provider IDs containing slashes are preserved verbatim.
 */
export interface ResolvedModel {
  providerID: string;
  modelID: string;
  source: 'explicit' | 'inherit';
}

export interface ModelCatalogLookup {
  /** Look up whether a provider/model pair is present in the effective config. */
  hasModel(providerID: string, modelID: string): boolean;
  /** The user's currently active (selected) model pair, if known. */
  activeModel(): { providerID: string; modelID: string } | null;
}

export class ModelResolutionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ModelResolutionError';
  }
}

let catalog: ModelCatalogLookup | null = null;

export function setModelCatalog(lookup: ModelCatalogLookup | null): void {
  catalog = lookup;
}

/** Best-effort parse of a "providerId/modelId" or "providerId/modelId" string. */
export function parseModelRef(raw: string): { providerID: string; modelID: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Preserve a model ID that itself contains a slash: split on the FIRST slash
  // only when it looks like provider/model. If there's no slash, provider is
  // unknown -> we cannot resolve safely without the catalog.
  const firstSlash = trimmed.indexOf('/');
  if (firstSlash === -1) return null;
  const providerID = trimmed.slice(0, firstSlash);
  const modelID = trimmed.slice(firstSlash + 1);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Resolve the effective model for a review session.
 *
 * Precedence:
 *  1. Explicit reviewerModel config `{ providerID, modelID }`.
 *  2. Inherit the active selection from the local Kilo catalog.
 *  3. If a catalog is present but the requested model is missing, fail loudly
 *     (no silent substitution).
 */
export function resolveModel(opts: {
  explicit?: { providerID: string; modelID: string } | null;
  inheritFrom?: 'catalog' | 'none';
}): ResolvedModel {
  if (opts.explicit?.providerID && opts.explicit.modelID) {
    if (catalog && !catalog.hasModel(opts.explicit.providerID, opts.explicit.modelID)) {
      throw new ModelResolutionError(
        `Requested model ${opts.explicit.providerID}/${opts.explicit.modelID} is not present in the effective config. Refusing to substitute silently.`
      );
    }
    return { providerID: opts.explicit.providerID, modelID: opts.explicit.modelID, source: 'explicit' };
  }

  if (opts.inheritFrom === 'catalog' && catalog) {
    const active = catalog.activeModel();
    if (active) {
      return { providerID: active.providerID, modelID: active.modelID, source: 'inherit' };
    }
  }

  // No explicit model and no way to inherit -> the caller must supply one.
  throw new ModelResolutionError(
    'No model resolved: no explicit reviewerModel and no active model catalog available.'
  );
}