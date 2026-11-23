/**
 * task-sizer.ts — one small structured-JSON LLM pass at task creation.
 *
 * The estimate is a PLANNING AID, never a gate:
 *   - T-shirt size is the operator-facing enum; points are the numeric form used
 *     by burndown/velocity.
 *   - Cached by a normalized spec hash so retries do not re-pay for the same task.
 *   - A timeout / provider failure / malformed JSON yields `unsized`, never a
 *     guessed point value and never a blocked task.
 *   - The operator can override the estimate (sizing_state='manual').
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from './db';
import type { InferenceRunner } from './inference';
import { extractJsonObject } from './json-extract';

let sizerSystemCache: string | null = null;
export function sizerSystem(): string {
  if (sizerSystemCache == null) {
    sizerSystemCache = readFileSync(join(import.meta.dir, 'prompts', 'sizer.md'), 'utf8');
  }
  return sizerSystemCache;
}

export const TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const;
export type TShirtSize = (typeof TSHIRT_SIZES)[number];

/** Fibonacci points for the enum. The numeric value is what charts use. */
export const TSHIRT_POINTS: Record<TShirtSize, number> = {
  XS: 1,
  S: 2,
  M: 3,
  L: 5,
  XL: 8,
  XXL: 13,
};

export const TaskSizeSchema = z.object({
  tshirt: z.enum(TSHIRT_SIZES),
  confidence: z.enum(['high', 'medium', 'low']),
  rationale: z.string().trim().min(1).max(600),
});

export const TASK_SIZE_JSON_SCHEMA = z.toJSONSchema(TaskSizeSchema, {
  target: 'draft-7',
  io: 'input',
}) as Record<string, unknown>;

export interface TaskSizeSpec {
  title: string;
  objective?: string | null;
  body?: string | null;
  requirements?: string | string[] | null;
  workspace?: string | null;
  kind?: string | null;
}

export interface TaskSizeResult {
  state: 'sized' | 'unsized';
  tshirt: TShirtSize | null;
  points: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
  rationale: string | null;
  model: string | null;
  cached: boolean;
  error?: string;
}

function clean(value: string | null | undefined, max = 4000): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function requirementsText(value: TaskSizeSpec['requirements']): string {
  if (Array.isArray(value)) return value.map((item) => `- ${item}`).join('\n').slice(0, 4000);
  return clean(value, 4000);
}

/** Stable identity of the sizing input. Bump the version if the prompt contract changes. */
export function taskSpecHash(spec: TaskSizeSpec): string {
  const material = [
    'sizer-v1',
    clean(spec.title, 1000),
    clean(spec.objective, 4000),
    clean(spec.body, 8000),
    requirementsText(spec.requirements),
    clean(spec.workspace, 1000),
    clean(spec.kind, 200),
  ].join('\u0000');
  return createHash('sha256').update(material).digest('hex');
}

export function buildSizingUser(spec: TaskSizeSpec): string {
  return [
    '# Task spec',
    `Title: ${clean(spec.title, 1000)}`,
    spec.kind ? `Kind: ${clean(spec.kind, 200)}` : '',
    spec.workspace ? `Workspace: ${clean(spec.workspace, 1000)}` : '',
    '',
    '## Objective',
    clean(spec.objective, 4000) || '(none)',
    '',
    '## Body',
    clean(spec.body, 8000) || '(none)',
    '',
    '## Requirements',
    requirementsText(spec.requirements) || '(none)',
    '',
    'Return only the strict JSON size object.',
  ].filter(Boolean).join('\n');
}

export function unsizedTaskSize(error: string): TaskSizeResult {
  return {
    state: 'unsized',
    tshirt: null,
    points: null,
    confidence: null,
    rationale: null,
    model: null,
    cached: false,
    error,
  };
}

const unsized = unsizedTaskSize;

interface CachedSize {
  tshirt_size: string;
  story_points: number;
  confidence: string;
  rationale: string | null;
  model: string | null;
}

/** Read a cached estimate for a spec (no provider call). */
export function cachedTaskSize(d: Db, spec: TaskSizeSpec): TaskSizeResult | null {
  const cached = d.db
    .query<CachedSize, [string]>(
      `SELECT tshirt_size, story_points, confidence, rationale, model
         FROM task_size_cache WHERE spec_hash=?`
    )
    .get(taskSpecHash(spec));
  if (!cached) return null;
  return {
    state: 'sized',
    tshirt: cached.tshirt_size as TShirtSize,
    points: cached.story_points,
    confidence: cached.confidence as TaskSizeResult['confidence'],
    rationale: cached.rationale,
    model: cached.model,
    cached: true,
  };
}

/** Persist a validated size for reuse. Best effort. */
export function cacheTaskSize(
  d: Db,
  spec: TaskSizeSpec,
  parsed: z.infer<typeof TaskSizeSchema>,
  model: string | null,
): void {
  try {
    d.db
      .query(
        `INSERT OR REPLACE INTO task_size_cache
           (spec_hash, tshirt_size, story_points, confidence, rationale, model, created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        taskSpecHash(spec),
        parsed.tshirt,
        TSHIRT_POINTS[parsed.tshirt],
        parsed.confidence,
        parsed.rationale,
        model,
        new Date().toISOString(),
      );
  } catch {
    /* caching is best effort */
  }
}

export async function sizeTask(
  d: Db,
  runner: InferenceRunner,
  spec: TaskSizeSpec,
  opts: { providerID: string | null; modelID: string | null; timeoutMs?: number },
): Promise<TaskSizeResult> {
  if (!spec.title.trim()) return unsized('empty task title');
  const cached = cachedTaskSize(d, spec);
  if (cached) return cached;
  const providerID = opts.providerID?.trim() || '';
  const modelID = opts.modelID?.trim() || '';
  if (!providerID || !modelID || providerID === 'unset' || modelID === 'unset') {
    return unsized('no sizing model configured');
  }

  const timeoutMs = Math.max(1_000, Math.min(opts.timeoutMs ?? 8_000, 30_000));
  const prompt = {
    role: 'sizer' as const,
    system: sizerSystem(),
    user: buildSizingUser(spec),
    providerID,
    modelID,
    jsonSchema: TASK_SIZE_JSON_SCHEMA,
    jsonSchemaName: 'TaskSize',
  };
  const inference = runner
    .run(prompt)
    .then((result) => ({ kind: 'result' as const, result }))
    .catch((error: unknown) => ({
      kind: 'result' as const,
      result: { ok: false, text: '', error: error instanceof Error ? error.message : String(error), tookMs: 0 },
    }));
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    // Do not keep the event loop alive solely for the cap.
    if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
  });
  const raced = await Promise.race([inference, timeout]);
  if (raced.kind === 'timeout') return unsized(`sizing timed out after ${timeoutMs}ms`);
  if (!raced.result.ok) return unsized(raced.result.error ?? 'sizing inference failed');

  let parsed: z.infer<typeof TaskSizeSchema>;
  try {
    parsed = TaskSizeSchema.parse(extractJsonObject(raced.result.text));
  } catch (error) {
    return unsized(`invalid sizing JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const points = TSHIRT_POINTS[parsed.tshirt];
  const model = `${providerID}/${modelID}`;
  cacheTaskSize(d, spec, parsed, model);
  return {
    state: 'sized',
    tshirt: parsed.tshirt,
    points,
    confidence: parsed.confidence,
    rationale: parsed.rationale,
    model,
    cached: false,
  };
}

/** Metadata fragment for local department tickets. */
export function sizeMetadata(result: TaskSizeResult): Record<string, unknown> {
  if (result.state !== 'sized') {
    return { sizing_state: 'unsized', size_error: result.error ?? null };
  }
  return {
    story_points: result.points,
    tshirt_size: result.tshirt,
    size_confidence: result.confidence,
    size_rationale: result.rationale,
    size_model: result.model,
    sized_at: new Date().toISOString(),
    sizing_state: result.cached ? 'sized' : 'sized',
  };
}
