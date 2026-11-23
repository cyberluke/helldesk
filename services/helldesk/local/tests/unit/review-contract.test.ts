import { describe, expect, it } from 'bun:test';
import {
  REVIEW_OUTPUT_FORMAT,
  REVIEW_VERDICT_JSON_SCHEMA,
  ReviewVerdictSchema,
  isUnsupportedStructuredOutput,
  parseReviewVerdict,
  reviewResponseFormatChain,
} from '../../src/review-contract';

/**
 * The verdict contract is the ONE definition shared by:
 *   - zod validation (control plane + detached workers),
 *   - Kilo's native StructuredOutput tool (`format: json_schema`),
 *   - OpenAI `response_format` (strict json_schema → json_object → prompt),
 *   - Codex `--output-schema`.
 * These tests pin the contract and the negotiation semantics.
 */
describe('review-verdict contract (single source of truth)', () => {
  it('parses a valid verdict and applies the schema defaults', () => {
    const parsed = ReviewVerdictSchema.parse({
      result: 'PASS',
      coverage: { changedFiles: 1, inspectedFiles: 1 },
    });
    expect(parsed.result).toBe('PASS');
    expect(parsed.coverage.uncoveredPaths).toEqual([]);
    expect(parsed.findings).toEqual([]);
    expect(parsed.models).toEqual([]);
  });

  it('rejects the renamed-coverage shape that forced reviewer repair retries', () => {
    // This is the exact deviation observed from reviewer B in production.
    const renamed = {
      result: 'PASS',
      coverage: { targetId: 'snap_git_x', changedFilesReviewed: ['src/math.ts'] },
      findings: [],
      models: [],
    };
    expect(parseReviewVerdict(renamed)).toBeNull();
  });

  it('generates draft-07 JSON Schema from the same zod contract', () => {
    expect(REVIEW_VERDICT_JSON_SCHEMA.$schema).toBe('http://json-schema.org/draft-07/schema#');
    const properties = REVIEW_VERDICT_JSON_SCHEMA.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['result', 'coverage', 'findings', 'models']));
    expect(properties.result?.enum).toEqual(['PASS', 'FINDINGS', 'INCONCLUSIVE']);
    // io:'input' keeps defaulted fields optional for the MODEL.
    expect(REVIEW_VERDICT_JSON_SCHEMA.required).toEqual(['result', 'coverage']);
  });

  it('Kilo format carries the generated schema and bounded server-side retries', () => {
    expect(REVIEW_OUTPUT_FORMAT.type).toBe('json_schema');
    expect(REVIEW_OUTPUT_FORMAT.schema).toBe(REVIEW_VERDICT_JSON_SCHEMA);
    expect(REVIEW_OUTPUT_FORMAT.retryCount).toBe(2);
  });

  it('OpenAI response_format chain is strict json_schema → json_object → prompt-only', () => {
    const chain = reviewResponseFormatChain();
    expect(chain.map((f) => (f as { type?: string } | undefined)?.type ?? 'none')).toEqual([
      'json_schema',
      'json_object',
      'none',
    ]);
    const strict = chain[0] as { json_schema: { name: string; strict: boolean; schema: unknown } };
    expect(strict.json_schema.name).toBe('ReviewVerdict');
    expect(strict.json_schema.strict).toBe(true);
    expect(strict.json_schema.schema).toBe(REVIEW_VERDICT_JSON_SCHEMA);
  });

  it('downgrades only on explicit unsupported-mode rejections', () => {
    expect(isUnsupportedStructuredOutput(400, 'response_format json_schema is not supported')).toBe(true);
    expect(isUnsupportedStructuredOutput(422, 'unknown parameter: response_format')).toBe(true);
    expect(isUnsupportedStructuredOutput(404, 'json_schema unsupported by this model')).toBe(true);
    // Unrelated failures must surface, never silently downgrade.
    expect(isUnsupportedStructuredOutput(400, 'context length exceeded')).toBe(false);
    expect(isUnsupportedStructuredOutput(500, 'response_format unsupported')).toBe(false);
    expect(isUnsupportedStructuredOutput(undefined, 'response_format unsupported')).toBe(false);
  });
});
