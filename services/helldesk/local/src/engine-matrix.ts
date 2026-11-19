/**
 * Engine matrix — provider-agnostic, per-stage engine selection for a mission.
 *
 * A mission runs several independent engine-bound processes:
 *   - `mutation`     : the agent that edits the writable workspace (soul).
 *   - `review`       : the independent reviewer(s) of each revision.
 *   - `adjudicate`   : the adjudicator that reconciles reviewer findings.
 *
 * Each stage independently selects an ENGINE (a string key resolved by the runner
 * registry) and an optional explicit PROVIDER route. Keep ENGINES open (string,
 * registry-resolved) so adding a future engine is a new resolver entry, not a
 * schema/UI change. A stage with no override falls back to the department default
 * matrix, which itself falls back to the machine policy/autonomy config.
 *
 * Valid engines today (resolver-backed): 'kilo' (headless Kilo SDK), 'codex'
 * (ChatGPT Codex CLI — MUTATION only: the detached review path rejects codex),
 * 'openai' (OpenAI-compatible HTTP), 'fake' (test-only).
 */
import { z } from 'zod';

/** One stage's engine selection: engine key + optional provider route. */
export const EngineStageSchema = z
  .object({
    /** Registry key: 'kilo' | 'codex' | 'openai' | 'fake' (open for the future). */
    engine: z.string().min(1),
    /** Optional provider id (as registered in policy.providers / autonomy). */
    providerID: z.string().optional(),
    /** Optional model id for that provider. */
    modelID: z.string().optional(),
    /** Optional explicit OpenAI-compatible base URL (overrides provider config). */
    baseURL: z.string().optional(),
  })
  .passthrough();

/** Full per-mission engine selection matrix. Undefined stage(s) fall back. */
export const EngineMatrixSchema = z
  .object({
    mutation: EngineStageSchema.optional(),
    review: EngineStageSchema.optional(),
    adjudicate: EngineStageSchema.optional(),
  })
  .passthrough()
  .default({});

export type EngineStage = z.infer<typeof EngineStageSchema>;
export type EngineMatrix = z.infer<typeof EngineMatrixSchema>;

/** Stage keys in a stable order (also the resolver/UI enumeration order). */
export const ENGINE_STAGES = ['mutation', 'review', 'adjudicate'] as const;
export type EngineStageKey = (typeof ENGINE_STAGES)[number];

/** Engines that can run a REVIEW/ADJUDICATE stage. All resolvable reviewers
 * (kilo/openai/codex) — codex drives read-only strict-JSON review via `codex
 * exec`. fake is test-only. */
export const REVIEW_CAPABLE_ENGINES = ['kilo', 'openai', 'codex'] as const;

/** Engines that can run the MUTATION stage (all resolvable mutation runners). */
export const MUTATION_CAPABLE_ENGINES = ['kilo', 'codex', 'openai'] as const;

/** Parse/validate a raw engine-matrix value; returns a normalized matrix (empty
 * object when the input is undefined/invalid — an empty matrix means "defaults"). */
export function parseEngineMatrix(raw: unknown): EngineMatrix {
  const result = EngineMatrixSchema.safeParse(raw ?? {});
  return result.success ? result.data : {};
}

/** Engine is allowed for the given stage (mutations accept codex; review does not). */
export function engineAllowedForStage(engine: string, stage: EngineStageKey): boolean {
  const lower = engine.toLowerCase();
  if (stage === 'mutation') return (MUTATION_CAPABLE_ENGINES as readonly string[]).includes(lower);
  return (REVIEW_CAPABLE_ENGINES as readonly string[]).includes(lower);
}

/** Seeded default matrix matching the CURRENT live runtime (2026-11-18): every
 * stage uses the kilo headless runtime over the litellm-edge provider route. */
export function defaultEngineMatrix(): EngineMatrix {
  return {
    mutation: { engine: 'kilo', providerID: 'litellm-edge', modelID: 'differential_sseproxy', baseURL: 'http://localhost:4000/v1' },
    review: { engine: 'kilo', providerID: 'litellm-edge', modelID: 'differential_sseproxy', baseURL: 'http://localhost:4000/v1' },
    adjudicate: { engine: 'kilo', providerID: 'litellm-edge', modelID: 'differential_sseproxy', baseURL: 'http://localhost:4000/v1' },
  };
}