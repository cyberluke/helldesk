/**
 * Commit-observability contract for the operator console.
 *
 * Mirrors the engine's read-only `/v1/commits*` endpoints
 * (services/helldesk/local/src/git-commits.ts). Commit messages, metadata and
 * per-file patches are real git output; nothing is synthesized.
 */
import { z } from 'zod';

export const CommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authoredAt: z.string(),
  committerName: z.string(),
  committerEmail: z.string(),
  committedAt: z.string(),
  parents: z.array(z.string()),
  refs: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
});

export const CommitWorkspaceSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  isGit: z.boolean(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  dirty: z.boolean().nullable(),
  lastCommitAt: z.string().nullable(),
  lastCommitSubject: z.string().nullable(),
  error: z.string().nullable(),
  activeMissionId: z.string().nullable().optional(),
  activeMissionState: z.string().nullable().optional(),
  scratch: z.boolean().optional(),
});

export const CommitProvenanceSchema = z.object({
  sha: z.string(),
  missionId: z.string(),
  ticketId: z.string(),
  revisionId: z.string(),
  revisionNo: z.number(),
  state: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  humanAcceptance: z.string().nullable(),
});

export const CommitFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X']),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  binary: z.boolean(),
});

export const CommitDetailSchema = CommitSummarySchema.extend({
  message: z.string(),
  stats: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }),
  files: z.array(CommitFileSchema),
  truncated: z.boolean(),
});

export const CommitListSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  commits: z.array(CommitSummarySchema),
});

export const CommitFileDiffSchema = z.object({
  sha: z.string(),
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U', 'X']),
  binary: z.boolean(),
  patch: z.string(),
  truncated: z.boolean(),
});

export type CommitSummary = z.output<typeof CommitSummarySchema>;
export type CommitWorkspace = z.output<typeof CommitWorkspaceSchema>;
export type CommitProvenance = z.output<typeof CommitProvenanceSchema>;
export type CommitFile = z.output<typeof CommitFileSchema>;
export type CommitDetail = z.output<typeof CommitDetailSchema>;
export type CommitList = z.output<typeof CommitListSchema>;
export type CommitFileDiff = z.output<typeof CommitFileDiffSchema>;
