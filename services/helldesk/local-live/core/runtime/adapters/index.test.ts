/**
 * Local-git dispatch adapter output-repo initialisation.
 *
 * Regression test for the bug where a dispatch failed with
 * "Could not initialize output HEAD" forever: the output-delta target directory
 * already existed on disk but had never been `git init`'d (no `.git`), so the
 * old guard (`existsSync(outPath)`) treated it as a valid repo, skipped init,
 * then `rev-parse HEAD` and the empty seed commit both failed, wedging the ticket
 * in a `dispatch_failed` loop (task stuck in_progress + agent_exited).
 *
 * Under the fix an existing-but-uninitialised directory is `git init`'d like a
 * missing one, so dispatch can proceed and the output repo gets a HEAD.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { localGitAdapter, type DispatchAdapterConfig } from './index';

function datetime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace(/[:.]/g, '-');
}

function makeCfg(root: string, outputPath: string, initIfMissing: boolean): DispatchAdapterConfig {
  return {
    workdir: join(root, 'work'),
    repoPath: join(root, 'input'),
    outputRepo: { repoPath: outputPath, initIfMissing },
    sourceRepos: [],
    branch: 'main',
    allowCommit: true,
  };
}

/** Create a git repo (source or seeded output) at `path` by cloning a seed repo. */
function makeGitRepo(root: string, path: string): void {
  mkdirSync(join(root, 'seed'), { recursive: true });
  execFileSync('git', ['init', '--quiet', join(root, 'seed')]);
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '--allow-empty', '-m', 'seed'], { cwd: join(root, 'seed') });
  execFileSync('git', ['clone', '--quiet', join(root, 'seed'), path]);
}

function gitHead(path: string): string {
  return execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: path }).toString().trim();
}

describe('localGitAdapter.prepare output-repo initialisation (existing-but-uninitialised dir)', () => {
  let root: string;
  let out: string;
  let cfg: DispatchAdapterConfig;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gt-adapter-output-'));
    out = join(root, 'output');
    // The OUTPUT target already exists (mkdir'd) but is NOT a git repo — the
    // exact state that used to throw "Could not initialize output HEAD".
    mkdirSync(out, { recursive: true });
    expect(existsSync(join(out, '.git'))).toBe(false);
    // Input is a real git repo.
    makeGitRepo(root, join(root, 'input'));
    cfg = makeCfg(root, out, true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('initialises an existing-but-empty output directory and gives it a HEAD (no dispatch_failed)', async () => {
    await expect(localGitAdapter.prepare(cfg)).resolves.toBeUndefined();
    // The output dir is now a git repo with a resolvable HEAD.
    const head = gitHead(out);
    expect(head.length).toBeGreaterThan(0);
    // The workdir mirrors the output checkout for the agent.
    const workOut = join(cfg.workdir, 'output');
    expect(existsSync(join(workOut, '.git'))).toBe(true);
  });

  it('rejects an existing-but-uninitialised output dir when initIfMissing is false', async () => {
    const cfgNoInit = makeCfg(root, out, false);
    await expect(localGitAdapter.prepare(cfgNoInit)).rejects.toThrow(
      /initialization is disabled|missing and initialization is disabled/,
    );
  });

  it('is idempotent: a second prepare on a warm workspace leaves a valid HEAD', async () => {
    await localGitAdapter.prepare(cfg);
    const headBefore = gitHead(out);
    await localGitAdapter.prepare(cfg); // warm — should be a no-op for output
    expect(gitHead(out)).toBe(headBefore);
  });

  it('leaves a pre-existing git output repo untouched (no re-init, HEAD preserved)', async () => {
    // Pre-seed a real committed repo as the output target.
    const seededOut = join(root, 'seeded-output');
    makeGitRepo(root, seededOut);
    const headBefore = gitHead(seededOut);
    const cfgSeeded = makeCfg(root, seededOut, true);
    await expect(localGitAdapter.prepare(cfgSeeded)).resolves.toBeUndefined();
    expect(existsSync(join(seededOut, '.git'))).toBe(true);
    expect(gitHead(seededOut)).toBe(headBefore);
  });
});