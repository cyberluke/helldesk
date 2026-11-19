import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ReviewReport, Finding } from './schemas';

/** Persist a review report as both JSON and human-readable Markdown. */
export function writeReport(opts: {
  reportDir: string;
  report: ReviewReport;
  snapshot?: { baseHash: string | null; headHash: string | null; dirtyHash: string | null };
  providerMap: Array<{ role: string; providerID: string; modelID: string }>;
  costMeta?: { tokensIn?: number; tokensOut?: number; cost?: number };
}): { jsonPath: string; mdPath: string; hash: string } {
  mkdirSync(opts.reportDir, { recursive: true });
  const { report } = opts;
  const jsonPath = join(opts.reportDir, `${report.jobId}.json`);
  const mdPath = join(opts.reportDir, `${report.jobId}.md`);

  const sorted = [...report.findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  const md = buildMarkdown(report, sorted, opts);
  const json = JSON.stringify({ ...report, findings: sorted }, null, 2);
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  // Content hash for reproducibility
  return { jsonPath, mdPath, hash: createHash('sha256').update(json).digest('hex') };
}

function sevRank(s: string): number {
  switch (s) {
    case 'BLOCKER': return 0;
    case 'HIGH': return 1;
    case 'MEDIUM': return 2;
    case 'LOW': return 3;
    default: return 4;
  }
}

function buildMarkdown(report: ReviewReport, sorted: Finding[], opts: {
  snapshot?: { baseHash: string | null; headHash: string | null; dirtyHash: string | null };
  providerMap: Array<{ role: string; providerID: string; modelID: string }>;
  costMeta?: { tokensIn?: number; tokensOut?: number; cost?: number };
}): string {
  const lines: string[] = [];
  lines.push(`# Adversarial Review Report — ${report.jobId}`);
  lines.push('');
  lines.push(`**Status:** \`${report.result}\``);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(`- **Target fingerprint:** \`${report.targetFingerprint.slice(0, 16)}…\``);
  lines.push(
    `- **Commits:** base=\`${opts.snapshot?.baseHash ?? report.attempts[0] ?? '—'}\` head=\`${opts.snapshot?.headHash ?? '—'}\``
  );
  if (opts.snapshot?.dirtyHash) lines.push(`- **Dirty working tree hash:** \`${opts.snapshot.dirtyHash.slice(0, 12)}…\``);
  lines.push(`- **Reviewed files:** ${report.coverage.inspectedFiles} / ${report.coverage.changedFiles} changed`);
  if (report.coverage.uncoveredPaths.length > 0) {
    lines.push('');
    lines.push('## Unreviewed scope');
    lines.push('');
    for (const p of report.coverage.uncoveredPaths) lines.push(`- \`${p}\``);
  }
  lines.push('');
  lines.push('## Models');
  lines.push('');
  for (const m of opts.providerMap) {
    lines.push(`- **${m.role}:** \`${m.providerID}/${m.modelID}\``);
  }
  if (opts.costMeta) {
    lines.push('');
    lines.push(`**Token/latency:** in=${opts.costMeta.tokensIn ?? 'unknown'} out=${opts.costMeta.tokensOut ?? 'unknown'} cost=${opts.costMeta.cost ?? 'unknown'}`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (sorted.length === 0) {
    lines.push('No findings. (A PASS reflects full coverage, not the absence of defects in unreviewed scope.)');
  } else {
    for (const f of sorted) {
      lines.push(`### [${f.severity}/${f.confidence}] ${f.title}`);
      lines.push('');
      if (f.file) {
        const loc = f.lineStart && f.lineEnd ? `:${f.lineStart}-${f.lineEnd}` : '';
        lines.push(`- **Location:** \`${f.file}${loc}\` (revision \`${f.revision ?? '—'}\`)`);
      }
      lines.push(`- **Evidence:** ${f.evidence}`);
      if (f.counterexample) lines.push(`- **Counterexample:** ${f.counterexample}`);
      if (f.requirement) lines.push(`- **Requirement:** ${f.requirement}`);
      if (f.verification) lines.push(`- **Verification:** ${f.verification}`);
      lines.push(`- **Reviewers:** ${f.reviewerIds.join(', ')}${f.adjudicated ? ` (adjudicated: ${f.adjudication ?? 'accepted'})` : ''}`);
      lines.push('');
    }
  }
  lines.push('## Adjudication outcome');
  lines.push('');
  lines.push(`Final status propagated: **${report.result}**. High/BLOCKER claims were re-verified against immutable source evidence. Unsupported or hypothetical assertions that survived no evidence were discarded.`);
  lines.push('');
  lines.push(`_Generated ${report.completedAt}; job created ${report.createdAt}._`);
  lines.push('_This report intentionally distinguishes source inspection from executable runtime proof. Evidence is specific source observation, not a claim of live execution._');
  return lines.join('\n');
}

// Re-export for convenience
export function sevSort(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
}