import { z } from 'zod';
import { CoverageSchema, FindingSchema, ReviewResultSchema } from './schemas';

/**
 * THE reviewer-verdict contract — one source of truth for every runner.
 *
 * - `ReviewVerdictSchema` is the runtime validator (control plane + detached
 *   workers both parse with it; findings are only persisted after it passes).
 * - `REVIEW_VERDICT_JSON_SCHEMA` is GENERATED from that same zod schema
 *   (draft-07, `io: 'input'` so fields the model may omit stay optional).
 *   Never hand-maintain a second schema: change zod and the transport contract
 *   follows (parity is asserted by tests/unit/review-contract.test.ts).
 * - `REVIEW_OUTPUT_FORMAT` is Kilo's native structured-output request. The
 *   server registers a `StructuredOutput` tool with this schema, forces
 *   `toolChoice: "required"`, validates the tool arguments and retries
 *   (`retryCount`) — i.e. real tool calling, not prose JSON.
 */
export const ReviewVerdictSchema = z.object({
  result: ReviewResultSchema,
  coverage: CoverageSchema,
  findings: z.array(FindingSchema).default([]),
  models: z.array(z.unknown()).default([]),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const REVIEW_VERDICT_JSON_SCHEMA = z.toJSONSchema(ReviewVerdictSchema, {
  target: 'draft-7',
  io: 'input',
}) as Record<string, unknown>;

/** Kilo `session.prompt` `format` block (OutputFormatJsonSchema v1). */
export interface StructuredOutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
  retryCount?: number;
}

export const REVIEW_OUTPUT_FORMAT: StructuredOutputFormat = {
  type: 'json_schema',
  schema: REVIEW_VERDICT_JSON_SCHEMA,
  retryCount: 2,
};

/** OpenAI-compatible `response_format` chain, most precise first, legacy last. */
export function structuredResponseFormatChain(
  schema: Record<string, unknown>,
  name: string,
): Array<Record<string, unknown> | undefined> {
  return [
    {
      type: 'json_schema',
      json_schema: {
        name,
        strict: true,
        schema,
      },
    },
    { type: 'json_object' },
    undefined,
  ];
}

/** Backwards-compatible review chain (review verdict schema). */
export function reviewResponseFormatChain(): Array<Record<string, unknown> | undefined> {
  return structuredResponseFormatChain(REVIEW_VERDICT_JSON_SCHEMA, 'ReviewVerdict');
}

/**
 * True when a provider REJECTED the requested structured-output mode (rather
 * than failing for an unrelated reason). Only then is it safe to fall back a
 * step in the chain: silently downgrading for a real error would hide it.
 */
export function isUnsupportedStructuredOutput(status: number | undefined, message: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /response_?format|json_?schema|structured|unsupported|not supported|unknown (?:field|parameter)/i.test(message);
}

/** Validate a structured payload (tool arguments / JSON body) against the contract. */
export function parseReviewVerdict(value: unknown): ReviewVerdict | null {
  const result = ReviewVerdictSchema.safeParse(value);
  return result.success ? result.data : null;
}
