import { z } from 'zod';

/**
 * Zod schemas for review targets, findings, coverage, and strict JSON results.
 *
 * Cross-checks file paths and line numbers against the pinned snapshot are
 * performed by `snapshot.ts` before a finding is persisted as VERIFIED.
 */

export const SeveritySchema = z.enum(['BLOCKER', 'HIGH', 'MEDIUM', 'LOW']);
export const ConfidenceSchema = z.enum(['VERIFIED', 'LIKELY', 'HYPOTHESIS']);
export const ReviewResultSchema = z.enum(['PASS', 'FINDINGS', 'INCONCLUSIVE']);

export const SubjectKindSchema = z.enum([
  'git-head',
  'git-commit',
  'git-range',
  'git-dirty',
  'git-mixed',
  'fs-folder',
]);

export type SubjectKind = z.infer<typeof SubjectKindSchema>;

export const FindingSchema = z.object({
  /** Optional: the engine always scopes/persists its own id; models may omit it. */
  id: z.string().optional(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  title: z.string().min(1),
  file: z.string().optional(),
  lineStart: z.number().int().min(1).optional(),
  lineEnd: z.number().int().min(1).optional(),
  revision: z.string().optional(),
  evidence: z.string(),
  counterexample: z.string().optional(),
  requirement: z.string().optional(),
  verification: z.string().optional(),
  reviewerIds: z.array(z.string()).default(['A']),
  /** Adjudicator-only fields. */
  adjudicated: z.boolean().optional(),
  adjudication: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const CoverageSchema = z.object({
  changedFiles: z.number().int().min(0),
  inspectedFiles: z.number().int().min(0),
  uncoveredPaths: z.array(z.string()).default([]),
});

export const ReviewReportSchema = z.object({
  jobId: z.string(),
  targetFingerprint: z.string(),
  result: ReviewResultSchema,
  coverage: CoverageSchema,
  findings: z.array(FindingSchema).default([]),
  models: z.array(
    z.object({
      role: z.string(),
      providerID: z.string(),
      modelID: z.string(),
    })
  ).default([]),
  attempts: z.array(z.number().int()).default([]),
  createdAt: z.string(),
  completedAt: z.string(),
  /** Which independent review stages actually ran for this verdict. */
  policy: z
    .object({
      summary: z.string(),
      reviewerA: z.boolean(),
      reviewerB: z.boolean(),
      governor: z.boolean(),
      controls: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /** Per-role usage rolled up from agent_runs (null = not reported by the runner). */
  cost: z
    .object({
      tokensIn: z.number().nullable(),
      tokensOut: z.number().nullable(),
      cost: z.number().nullable(),
    })
    .optional(),
});

export type ReviewReport = z.infer<typeof ReviewReportSchema>;

/** Review target request as accepted by the API / scheduler. */
export const ReviewTargetSchema = z.object({
  workspaceId: z.string(),
  subjectKind: SubjectKindSchema,
  baseCommit: z.string().optional(),
  headCommit: z.string().optional(),
  /** base..head (two-dot) or merge-base...head range. */
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  /** When subjectKind === 'git-dirty'/'git-mixed', include working-tree changes. */
  includeDirty: z.boolean().optional().default(true),
  includeUntracked: z.boolean().optional().default(true),
  /** Directory relative subject when subjectKind === 'fs-folder'. */
  fsPath: z.string().optional(),
  requirements: z.string().optional(),
  source: z.string().optional().default('api'),
  triggerSessionId: z.string().optional(),
});

export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const CreateJobRequestSchema = z.object({
  workspaceId: z.string().optional(),
  subject: ReviewTargetSchema,
  policyVersion: z.string().optional().default('1'),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export const EventOutboxRecordSchema = z.object({
  seq: z.number(),
  event_type: z.string(),
  job_id: z.string().nullable(),
  payload: z.string(),
  created_at: z.string(),
});

export type EventOutboxRecord = z.infer<typeof EventOutboxRecordSchema>;