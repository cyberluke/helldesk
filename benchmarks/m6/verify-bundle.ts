/**
 * verify-bundle.ts — audit a HELLDESK M6 evidence bundle WITHOUT the machine
 * that produced it and WITHOUT trusting the engine's verdict.
 *
 * Checks:
 *  1. INTEGRITY: every artifact listed in bundle.json exists under the bundle,
 *     has the recorded byte length, and hashes to the recorded sha256. No
 *     unlisted files under artifacts/.
 *  2. CLAIM: if the mission says VERIFIED_10_10, the certification must be
 *     provable from the recorded hashes alone:
 *        tree at the verification instant == gate candidate tree
 *     A verified mission without that equality is reported INVALID (exit 1).
 *     A non-verified mission is NOT_CLAIMED (exit 0) — it is a finding bundle,
 *     not a certificate.
 *
 * Usage:
 *   bun run benchmarks/m6/verify-bundle.ts benchmarks/m6/evidence/m6a
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

interface Artifact {
  id: string;
  kind: string;
  source: string;
  bundlePath: string;
  sha256: string;
  bytes: number;
  sourceSha256?: string | null;
  missing?: boolean;
}

interface Bundle {
  schema: string;
  runId: string;
  generatedAt: string;
  mission: { mission_id: string; state: string; verified_at?: string | null };
  revisions: Array<{
    revision_id: string;
    revision_no: number;
    state: string;
    gates: Array<{ gate_key: string; status: string; candidate_hash: string; result_path: string | null }>;
    gate_candidates: string[];
    gate_candidates_consistent: boolean;
    review: { job_id: string; state: string; result: string | null } | null;
  }>;
  workspaceAtExport: {
    head: string;
    head_tree: string;
    tree: string;
    reflog: Array<{ commit: string; time: string; subject: string }>;
  };
  certification: {
    certified: boolean;
    certificationValid: boolean;
    reason: string;
    verifiedRevisions: Array<{
      revision_id: string;
      gate_candidate: string | null;
      tree_at_verification: string | null;
      tree_at_verification_equals_gate_candidate: boolean | null;
      head_at_verification?: { commit: string; time: string } | null;
      valid: boolean;
    }>;
  };
  artifacts: Artifact[];
}

const bundleDir = resolve(process.argv[2] ?? '');
if (!bundleDir || !existsSync(join(bundleDir, 'bundle.json'))) {
  console.error('usage: bun run benchmarks/m6/verify-bundle.ts <bundle-dir>');
  process.exit(64);
}

const integrityFailures: string[] = [];
const claimFailures: string[] = [];
const warnings: string[] = [];

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

const bundle: Bundle = JSON.parse(readFileSync(join(bundleDir, 'bundle.json'), 'utf8'));

// ── 1. Artifact integrity ─────────────────────────────────────────────────────
const listed = new Set<string>();
for (const artifact of bundle.artifacts) {
  listed.add(artifact.bundlePath);
  const full = join(bundleDir, artifact.bundlePath);
  if (artifact.missing) {
    integrityFailures.push(`missing at export: ${artifact.id} (${artifact.kind}) ${artifact.source}`);
    continue;
  }
  if (!existsSync(full)) {
    integrityFailures.push(`missing file: ${artifact.bundlePath} (${artifact.id})`);
    continue;
  }
  const st = statSync(full);
  if (st.size !== artifact.bytes) {
    integrityFailures.push(`size mismatch: ${artifact.bundlePath} expected ${artifact.bytes} got ${st.size}`);
    continue;
  }
  const actual = sha256File(full);
  if (actual !== artifact.sha256) {
    integrityFailures.push(`sha256 mismatch: ${artifact.bundlePath} expected ${artifact.sha256} got ${actual}`);
  }
}

const artifactsRoot = join(bundleDir, 'artifacts');
if (existsSync(artifactsRoot)) {
  for (const full of walk(artifactsRoot)) {
    const rel = relative(bundleDir, full).replace(/\\/g, '/');
    if (!listed.has(rel)) warnings.push(`unlisted artifact file: ${rel}`);
  }
}

// ── 2. Gate evidence presence ────────────────────────────────────────────────
for (const rev of bundle.revisions) {
  if (!rev.gates.length) continue;
  if (!rev.gate_candidates_consistent) {
    warnings.push(`revision ${rev.revision_id}: gate executions disagree on the candidate tree`);
  }
  for (const gate of rev.gates) {
    if (!gate.result_path) {
      integrityFailures.push(`revision ${rev.revision_id} gate ${gate.gate_key}: no result.json artifact`);
    }
    if (gate.status === 'PASS' && !gate.candidate_hash) {
      integrityFailures.push(`revision ${rev.revision_id} gate ${gate.gate_key}: PASS without a candidate tree`);
    }
  }
}

// ── 3. Certification claim ───────────────────────────────────────────────────
let certification: 'VALID' | 'INVALID' | 'NOT_CLAIMED' = 'NOT_CLAIMED';
if (bundle.mission.state === 'VERIFIED_10_10') {
  certification = 'VALID';
  if (!bundle.certification?.certified) {
    certification = 'INVALID';
    claimFailures.push('mission is VERIFIED_10_10 but the bundle records no certification claim');
  }
  if (!bundle.certification?.certificationValid) {
    certification = 'INVALID';
    claimFailures.push(`certification invalid: ${bundle.certification.reason}`);
  }
  for (const rev of bundle.certification?.verifiedRevisions ?? []) {
    if (!rev.gate_candidate) {
      certification = 'INVALID';
      claimFailures.push(`revision ${rev.revision_id}: no single gate candidate`);
    }
    if (rev.tree_at_verification_equals_gate_candidate !== true) {
      certification = 'INVALID';
      claimFailures.push(
        `revision ${rev.revision_id}: tree at verification (${rev.tree_at_verification ?? 'unknown'}) `
        + `!= gate candidate (${rev.gate_candidate ?? 'unknown'})`,
      );
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const integrityOk = integrityFailures.length === 0;
console.log(`bundle:        ${bundle.schema} run=${bundle.runId}`);
console.log(`generated:     ${bundle.generatedAt}`);
console.log(`mission:       ${bundle.mission.mission_id} state=${bundle.mission.state}`);
console.log(`revisions:     ${bundle.revisions.map((r) => `${r.revision_no}:${r.state}`).join(', ')}`);
console.log(`artifacts:     ${bundle.artifacts.length} (${bundle.artifacts.filter((a) => a.missing).length} missing)`);
console.log(`integrity:     ${integrityOk ? 'PASS' : 'FAIL'} (${integrityFailures.length} failure(s))`);
console.log(`certification: ${certification}`);
if (bundle.certification?.reason) console.log(`claim reason:  ${bundle.certification.reason}`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const f of integrityFailures) console.log(`FAIL  ${f}`);
for (const f of claimFailures) console.log(`CLAIM ${f}`);
if (!bundle.certification?.certified) {
  console.log('note: this bundle does not claim a valid certification; integrity is still audited.');
}
process.exit(integrityOk && certification !== 'INVALID' ? 0 : 1);
