/**
 * adapters.source-repos.test.ts — verifies the two-repo transform delta:
 * `localGitAdapter.prepare()` mounts configured SOURCE repos into
 * `<workdir>/sources/<id>` alongside the project workspace, so a task like
 * "read the game app, build a game-agnostic framework" has a structural home
 * and the source is actually present on disk for agents to read.
 *
 * Single-repository mode (no output repo) works IN PLACE: the project workspace
 * is the writable repo (input = output), not a `<workdir>/repo` clone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localGitAdapter } from './adapters';

describe('localGitAdapter prepare() — two-repo source mounting', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-adapter-'));
  let destHead: string;

  beforeAll(async () => {
    // A destination repo (the framework) and a source repo (the game).
    const dest = join(root, 'framework');
    const game = join(root, 'game');
    mkdirSync(dest); mkdirSync(game);

    const git = (cwd: string, ...args: string[]) =>
      new Promise<void>((resolve, reject) => {
        const { execFile } = require('node:child_process');
        execFile('git', args, { cwd }, (err: Error | null) => (err ? reject(err) : resolve()));
      });

    // init a bare dest (the adapter inits it if missing) + seed the game source.
    writeFileSync(join(game, 'game.js'), '// the game app\n');
    await git(game, 'init', '-q'); await git(game, 'add', '-A'); await git(game, 'commit', '-qm', 'game init');
    // give the dest a git repo so clone works (or let adapter init it)
    writeFileSync(join(dest, 'readme.md'), '# framework\n');
    await git(dest, 'init', '-q'); await git(dest, 'add', '-A'); await git(dest, 'commit', '-qm', 'framework init');

    // A fresh workdir not yet prepared.
    const workdir = join(root, 'work');
    await localGitAdapter.prepare({
      workdir,
      repoPath: dest,
      sourceRepos: [{ id: 'game', path: game, label: 'Game app' }],
      branch: 'main',
      allowCommit: true,
    });
    const { execFileSync } = require('node:child_process');
    destHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dest, encoding: 'utf8' }).trim();
    void destHead;
  }, 30_000);

  afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('clones the source repo into workdir/sources/<id>', () => {
    expect(existsSync(join(root, 'work', 'sources', 'game', '.git'))).toBeTrue();
    expect(existsSync(join(root, 'work', 'sources', 'game', 'game.js'))).toBeTrue();
  });

  it('uses the destination workspace in place — no shadow workdir/repo clone', () => {
    expect(existsSync(join(root, 'work', 'repo'))).toBeFalse();
    expect(existsSync(join(root, 'framework', '.git'))).toBeTrue();
    expect(existsSync(join(root, 'framework', 'readme.md'))).toBeTrue();
  });

  it('re-prepare is idempotent (does not error when already mounted)', async () => {
    await expect(
      localGitAdapter.prepare({
        workdir: join(root, 'work'),
        repoPath: join(root, 'framework'),
        sourceRepos: [{ id: 'game', path: join(root, 'game') }],
        branch: 'main',
        allowCommit: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('localGitAdapter commit() — output repo federation (AAF cross-repo delta)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-output-'));
  let outputRepo = '';
  let srcContent = '';

  beforeAll(async () => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const git = (cwd: string, ...args: string[]) =>
      new Promise<void>((resolve, reject) => execFile('git', args, { cwd }, (e: Error | null) => (e ? reject(e) : resolve())));

    // workspace (input) + existing output repo
    const ws = join(root, 'ws');
    outputRepo = join(root, 'out');
    mkdirSync(ws); mkdirSync(outputRepo);
    writeFileSync(join(ws, 'module.js'), '// workspace module\n');
    await git(ws, 'init', '-q'); await git(ws, 'add', '-A'); await git(ws, 'commit', '-qm', 'ws init');
    writeFileSync(join(outputRepo, 'index.js'), '// output\n');
    await git(outputRepo, 'init', '-q'); await git(outputRepo, 'add', '-A'); await git(outputRepo, 'commit', '-qm', 'out init');

    // prepare with an output repo; confirm output checkout exists
    await localGitAdapter.prepare({
      workdir: join(root, 'w'),
      repoPath: ws,
      outputRepo: { repoPath: outputRepo, initIfMissing: true },
      branch: 'main',
      allowCommit: true,
    });

    // Extraction missions write the configured OUTPUT directly (the adapter
    // intentionally never copies a source tree over a reviewed destination).
    // Mutate the output repo itself, then commit that delta.
    writeFileSync(join(outputRepo, 'module.js'), '// extracted module CHANGED\n');
    const res = await localGitAdapter.commit({
      workdir: join(root, 'w'),
      repoPath: ws,
      outputRepo: { repoPath: outputRepo, initIfMissing: true },
      branch: 'main',
      allowCommit: true,
    }, 'feat: change module');
    expect(res.ok).toBeTrue();
    srcContent = existsSync(join(outputRepo, 'module.js')) ? readFileSync(join(outputRepo, 'module.js'), 'utf8') : '';
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: outputRepo, encoding: 'utf8' }).trim();
    expect(log).toBe('feat: change module');
  }, 30_000);

  afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('prepares an existing output repo into workdir/output', () => {
    expect(existsSync(join(root, 'w', 'output', '.git'))).toBeTrue();
    expect(existsSync(join(root, 'w', 'output', 'index.js'))).toBeTrue();
  });

  it('commits the configured output repo delta (extraction writes directly)', () => {
    expect(srcContent).toContain('CHANGED');
    expect(srcContent).toContain('module');
  });
});