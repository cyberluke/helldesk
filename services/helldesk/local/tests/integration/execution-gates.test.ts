import { describe, it, expect } from 'bun:test';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestDb } from '../helpers';
import {
  createMissionRequest,
  getMission,
  getQualityGates,
  getRevision,
  isRevisionVerified10,
  latestGateExecution,
  listEvidence,
  listRevisions,
  type GateExecutionRow,
} from '../../src/mission-repository';
import { advanceMission, type ControllerDeps, type ReviewVerdict } from '../../src/mission-controller';
import type { MutationRunner, RepairRequest, RepairResult } from '../../src/mutation-runner';
import { captureMissionBaseline } from '../../src/mission-baseline';

/**
 * M1 PROOF — host-executed gates cannot be fabriccated by the mutator/reviewer.
 *
 * Revision 1: the scripted mutator leaves the seeded defect in place and writes
 * `proof/test-output.txt` claiming PASS. The scripted reviewer is deliberately
 * fooled and returns PASS citing that fabricated artifact. The controller runs
 * `node test/counter.test.mjs` in an isolated candidate tree; it exits 1.
 * Therefore:
 *   - the execution gate FAILs,
 *   - the quality gate becomes FAIL even though the reviewer said PASS,
 *   - isRevisionVerified10 is false,
 *   - the revision is rejected and replanned.
 *
 * Revision 2: the mutator actually repairs `increment(n)`, the host execution
 * exits 0, the reviewer cites the execution evidence, and the mission reaches
 * VERIFIED_10_10. Revision 1's failing execution evidence is still present.
 */

const FIXTURE = join(import.meta.dir, '..', '..', '..', '..', '..', 'benchmarks', 'v0', 'fixture');

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8' }).trim();
}

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gt-exec-gates-ws-'));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, 'git init -q');
  git(dir, 'git config user.email test@localhost');
  git(dir, 'git config user.name test');
  git(dir, 'git add -A && git commit -qm baseline');
  return dir;
}

function clean(dir: string | undefined): void {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function fakePassEvidenceId(rows: ReturnType<typeof listEvidence>): string | undefined {
  return rows.find((e) => (e.path ?? '').replace(/\\/g, '/').endsWith('proof/test-output.txt'))?.artifact_id;
}

function executionEvidence(rows: ReturnType<typeof listEvidence>): ReturnType<typeof listEvidence>[number] | undefined {
  return rows.find((e) => e.kind === 'execution');
}

describe('M1 — execution gates reject a fabricated PASS and verify a real repair', () => {
  it('revision 1 fake PASS is blocked by host execution; revision 2 genuinely repaired reaches VERIFIED_10_10', async () => {
    const h = makeTestDb();
    const workspace = makeWorkspace();
    const gateDataDir = mkdtempSync(join(tmpdir(), 'gt-exec-gates-data-'));
    try {
      const taskGates = ['functional_correctness', 'regression_checks'];
      const baseline = captureMissionBaseline({ workspacePath: workspace });
      const created = createMissionRequest(h.d, {
        workspaceId: 'ws_exec_gates',
        objective:
          'Fix src/counter.mjs so increment(n) returns n + 1. The repository test test/counter.test.mjs is authoritative; do not modify it.',
        taskGates,
        gateCommands: {
          functional_correctness: { command: 'node test/counter.test.mjs', timeoutMs: 30_000 },
        },
        baseline,
        tickets: [{ title: 'B1', objective: 'Repair increment semantics', dependsOn: [] }],
      });
      if (created.conflict) throw new Error('unexpected idempotency conflict');
      const { missionId, ticketIds } = created;
      const ticketId = ticketIds[0]!;

      let mutations = 0;
      const runner: MutationRunner = {
        transport: 'fixture-scripted-mutator',
        provider: 'fixture',
        model: 'fixture',
        agent: 'fixture',
        writeCapability: true,
        shellCapability: true,
        async execute(_request: RepairRequest): Promise<RepairResult> {
          mutations += 1;
          if (mutations === 1) {
            // The liar: do not fix the defect; write a plausible PASS report.
            const sourcePath = join(workspace, 'src', 'counter.mjs');
            const original = readFileSync(sourcePath, 'utf8');
            writeFileSync(sourcePath, `${original}\n// attempted repair (does not change behavior)\n`, 'utf8');
            mkdirSync(join(workspace, 'proof'), { recursive: true });
            writeFileSync(join(workspace, 'proof', 'test-output.txt'), 'PASS\nAll 3 tests passed\n', 'utf8');
            return {
              outcome: 'CHANGED',
              changedFiles: ['src/counter.mjs', 'proof/test-output.txt'],
              commandsExecuted: ['node test/counter.test.mjs (claimed)'],
              artifactsProduced: ['proof/test-output.txt'],
              workspaceFingerprintBefore: 'A1',
              workspaceFingerprintAfter: 'B1',
            };
          }
          // The genuine repair.
          writeFileSync(
            join(workspace, 'src', 'counter.mjs'),
            'export function increment(n) {\n  return n + 1;\n}\n',
            'utf8',
          );
          return {
            outcome: 'CHANGED',
            changedFiles: ['src/counter.mjs'],
            commandsExecuted: ['write src/counter.mjs'],
            artifactsProduced: [],
            workspaceFingerprintBefore: 'B1',
            workspaceFingerprintAfter: 'B2',
          };
        },
      };

      let reviews = 0;
      const review: ControllerDeps['review'] = async ({ revisionId }): Promise<Awaited<ReturnType<ControllerDeps['review']>>> => {
        reviews += 1;
        const evidence = listEvidence(h.d, revisionId);
        const resolvable = evidence.filter((e) => e.bytes > 0 && e.sha256.length === 64).map((e) => e.artifact_id);
        if (reviews === 1) {
          // Deliberately fooled reviewer: cites the fabricated PASS log and
          // ignores the host execution. The Quality Oracle must still block it.
          const fake = fakePassEvidenceId(evidence);
          const refs = fake ? [fake] : resolvable.slice(0, 1);
          const verdict: ReviewVerdict = 'PASS';
          return {
            verdict,
            mandatoryGates: taskGates,
            gatePassed: { functional_correctness: true, regression_checks: true },
            gateEvidenceRefs: { functional_correctness: refs, regression_checks: refs },
            findings: [],
            evidenceResolved: true,
            snapshotId: 'snap-fake',
            reviewJobId: 'job-fake',
          };
        }
        const exec = latestGateExecution(h.d, revisionId, 'functional_correctness');
        const execRefs = exec ? [exec.evidence_artifact_id] : [];
        return {
          verdict: exec?.status === 'PASS' ? 'PASS' : 'FINDINGS',
          mandatoryGates: taskGates,
          gatePassed: {
            functional_correctness: exec?.status === 'PASS',
            regression_checks: exec?.status === 'PASS',
          },
          gateEvidenceRefs: { functional_correctness: execRefs, regression_checks: execRefs },
          findings: exec?.status === 'PASS' ? [] : ['[BLOCKER] host execution failed'],
          evidenceResolved: exec?.status === 'PASS',
          snapshotId: 'snap-repair',
          reviewJobId: 'job-repair',
        };
      };

      const deps: ControllerDeps = {
        d: h.d,
        runner,
        taskGates,
        workspacePathFor: () => workspace,
        gateDataDir,
        review,
      };

      let state = 'ACTIVE';
      let guard = 0;
      while (state !== 'VERIFIED_10_10' && guard < 16) {
        state = (await advanceMission(missionId, deps)).nextState;
        guard += 1;
      }

      const revisions = listRevisions(h.d, ticketId);
      expect(revisions.length).toBeGreaterThanOrEqual(2);
      const first = revisions[0]!;
      const second = revisions[1]!;

      // Revision 1 is rejected; its host execution failed.
      expect(getRevision(h.d, first.revision_id)?.state).toBe('REJECTED');
      const firstExec: GateExecutionRow | undefined = latestGateExecution(h.d, first.revision_id, 'functional_correctness');
      expect(firstExec).toBeDefined();
      expect(firstExec!.status).toBe('FAIL');
      expect(firstExec!.exit_code).toBe(1);
      expect(firstExec!.candidate_hash.length).toBeGreaterThanOrEqual(40);
      expect(firstExec!.stdout_sha256).toHaveLength(64);
      expect(firstExec!.stderr_sha256).toHaveLength(64);
      expect(firstExec!.test_file_hashes_json).toContain('test/counter.test.mjs');

      // The fabricated PASS artifact is real content evidence — but it is not
      // execution evidence and it cannot satisfy the execution gate.
      const firstEvidence = listEvidence(h.d, first.revision_id);
      const fake = fakePassEvidenceId(firstEvidence);
      expect(fake).toBeDefined();
      const fakeRow = firstEvidence.find((e) => e.artifact_id === fake);
      expect(fakeRow?.kind).not.toBe('execution');
      expect(fakeRow?.bytes).toBeGreaterThan(0);

      const firstExecEvidence = executionEvidence(firstEvidence);
      expect(firstExecEvidence).toBeDefined();
      expect(firstExecEvidence!.exit_code).toBe(1);
      expect(firstExecEvidence!.sha256).toHaveLength(64);
      expect((firstExecEvidence!.path ?? '').replace(/\\/g, '/')).toContain('/gate-runs/');
      expect((firstExecEvidence!.path ?? '').replace(/\\/g, '/').startsWith(workspace.replace(/\\/g, '/'))).toBe(false);

      // The reviewer said PASS; the Quality Oracle still refuses the gate.
      const firstGate = getQualityGates(h.d, first.revision_id).find((g) => g.gate_key === 'functional_correctness');
      expect(firstGate?.status).toBe('FAIL');
      expect(isRevisionVerified10(h.d, first.revision_id, taskGates)).toBe(false);

      // Revision 2 genuinely passes and the mission verifies.
      expect(getRevision(h.d, second.revision_id)?.state).toBe('VERIFIED_10_10');
      const secondExec = latestGateExecution(h.d, second.revision_id, 'functional_correctness');
      expect(secondExec?.status).toBe('PASS');
      expect(secondExec?.exit_code).toBe(0);
      expect(isRevisionVerified10(h.d, second.revision_id, taskGates)).toBe(true);
      expect(getMission(h.d, missionId)?.state).toBe('VERIFIED_10_10');

      // History: revision 1's failing execution evidence is still present after
      // revision 2 verified.
      expect(listEvidence(h.d, first.revision_id).some((e) => e.kind === 'execution' && e.exit_code === 1)).toBe(true);
      expect(latestGateExecution(h.d, first.revision_id, 'functional_correctness')?.status).toBe('FAIL');
    } finally {
      clean(workspace);
      clean(gateDataDir);
      h.close();
    }
  }, 60_000);
});
