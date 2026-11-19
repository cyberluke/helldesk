/**
 * Isolated run of the REAL ChatGPT Codex mutation transport (`CodexMutationRunner`
 * → `bun run codex-mutation-child.ts` → `codex exec -m ${model}`), independent of
 * the live mission controller.
 *
 * Purpose (regression): the HELLDESK mission controller runs mutations through
 * `resolveMutationRunner` — `kilo` (headless Kilo SDK) OR `codex` (ChatGPT Codex
 * CLI). The `codex` transport had a documented review-path rejection
 * (`runner codex cannot drive detached worker review`) but the MUTATION path
 * itself (spawning `codex exec` against a writable workspace) was never isolated
 * in the `services/helldesk/local` test suite. This test drives only that mutation
 * transport against a tiny git fixture and asserts the codex agent makes a real,
 * detectable change — so a future break in the codex transport is caught here,
 * not as an opaque `no-change` / rejection in a live mission.
 *
 * Requires: codex CLI installed (resolveCodexBin finds it) and the model
 * (default gpt-6-luna) reachable. Skipped if codex binary cannot be resolved so a
 * CI box without codex stays green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexMutationRunner, resolveCodexBin, type RepairRequest } from '../../src/mutation-runner';

const CODEX_MODEL = process.env.GT_CODEX_TEST_MODEL ?? 'gpt-6-luna';
const MARKER = '__HELLDESK_CODEX_TEST_SENTINEL__';

describe('CodexMutationRunner isolated mutation transport', () => {
  let root: string;
  let workspace: string;
  let codexBin: string | undefined;
  let headBefore: string;

  beforeAll(() => {
    // Resolve the codex binary ONCE; if none exists, skip the real-inference tests.
    try { codexBin = resolveCodexBin(); } catch { codexBin = undefined; }
    if (!codexBin || !existsSync(codexBin) && process.env.GT_CODEX_TEST_STRICT !== '1') {
      // No codex binary available → the transport cannot run here; record and skip.
      return;
    }
    root = mkdtempSync(join(tmpdir(), 'gt-codex-mutation-'));
    workspace = join(root, 'ws');
    execFileSync('git', ['init', '--quiet', workspace]);
    // A tiny fixture with a marker string the codex agent must change.
    writeFileSync(join(workspace, 'index.ts'), `export const marker = '${MARKER}';\n`);
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'add', '-A'], { cwd: workspace });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-m', 'fixture'], { cwd: workspace });
    headBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  });

  afterAll(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('codex CLI binary is resolvable on this machine (transport precondition)', () => {
    if (process.env.GT_CODEX_TEST_STRICT !== '1' && (!codexBin || !existsSync(codexBin))) {
      return; // non-strict CI: skip silently
    }
    expect(codexBin).toBeTruthy();
    expect(existsSync(codexBin!)).toBe(true);
  });

  it('codex mutation makes a real, detectable change to the workspace (CHANGED, not no-change)', async () => {
    if (!codexBin || !existsSync(codexBin)) return; // codex unavailable → skip
    const runner = new CodexMutationRunner({ codexBin, modelID: CODEX_MODEL, timeoutMs: 180_000 });
    const req: RepairRequest = {
      missionId: 'test-codex',
      ticketId: 'ticket_codex_iso',
      revisionId: 'rev_codex_iso',
      workspacePath: workspace,
      objective:
        `Edit index.ts so the exported constant equals a DIFFERENT non-empty marker value ` +
        `(e.g. '${MARKER}_CHANGED'). Change only that line. Do not delete the file or leave it empty. ` +
        `Verify with git diff that a real change was made.`,
      currentFindings: [],
      failedQualityGateKeys: [],
      verifiedScientificFacts: [],
      activeHypotheses: [],
      falsifiedHypotheses: [],
      allowedCapabilities: ['edit', 'bash'],
    };

    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
    const result = await runner.execute(req, new AbortController().signal);
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' }).trim();

    // The transport contract that matters and that historically broke (the mission
    // stuck in `no-change` / `spawn ENOENT` loops): a REAL mutation either moved
    // HEAD (committed) or left a dirty working tree, and reports `CHANGED`.
    const madeChange = after !== before || dirty.length > 0;
    expect(madeChange).toBe(true);
    expect(result.outcome).toBe('CHANGED');
    if (after !== before) {
      // Committed: assert a real diff between the fixture and the new HEAD.
      const committedDiff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '--'], { cwd: workspace, encoding: 'utf8' });
      expect(committedDiff.length).toBeGreaterThan(0);
    }
  }, 300_000);
});