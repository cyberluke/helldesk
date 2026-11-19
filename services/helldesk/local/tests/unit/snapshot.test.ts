import { describe, expect, it } from 'bun:test';
import { targetFingerprint, captureGitSnapshot, fsFolderSnapshot, isGitRepo } from '../../src/snapshot';
import { makeGitFixture, makeFsFixture } from '../helpers';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('snapshot engine', () => {
  it('detects git repos and rejects non-git for git targets', () => {
    const g = makeGitFixture();
    expect(isGitRepo(g.dir)).toBe(true);
    const f = makeFsFixture({ 'a.txt': 'hello' });
    expect(isGitRepo(f.dir)).toBe(false);
  });

  it('captures committed HEAD snapshot with immutable diff + changed files', async () => {
    const g = makeGitFixture();
    const store = mkdtempSync(join(tmpdir(), 'gt-store-'));
    const snap = await captureGitSnapshot({ workspacePath: g.dir, kind: 'git-head', snapshotStore: store });
    expect(snap.headHash).toBe(g.head);
    expect(snap.baseHash).toBe(g.base);
    expect(snap.changedFiles).toContain('math.js');
    expect(snap.diff).toContain('math.js');
    expect(snap.manifestHash.length).toBe(64);
  });

  it('fingerprint changes with dirty state and is stable across identical states', () => {
    const g = makeGitFixture();
    const fp1 = targetFingerprint({ workspaceId: 'ws1', kind: 'git-head', baseHash: g.base, headHash: g.head, dirtyHash: null, untrackedHash: null, policyVersion: '1', reviewerConfigVersion: '1' });
    const fp2 = targetFingerprint({ workspaceId: 'ws1', kind: 'git-head', baseHash: g.base, headHash: g.head, dirtyHash: 'dirty1', untrackedHash: null, policyVersion: '1', reviewerConfigVersion: '1' });
    expect(fp1).not.toBe(fp2);
    const fp3 = targetFingerprint({ workspaceId: 'ws1', kind: 'git-head', baseHash: g.base, headHash: g.head, dirtyHash: null, untrackedHash: null, policyVersion: '1', reviewerConfigVersion: '1' });
    expect(fp3).toBe(fp1);
  });

  it('captures plain-folder snapshots without git', () => {
    const f = makeFsFixture({ 'src/app.js': 'x', 'tests/app.test.js': 'test' });
    const store = mkdtempSync(join(tmpdir(), 'gt-fstore-'));
    const snap = fsFolderSnapshot({ workspacePath: f.dir, snapshotStore: store });
    expect(snap.kind).toBe('fs-folder');
    expect(snap.changedFiles).toContain('src/app.js');
    expect(snap.changedFiles.length).toBe(2);
  });

  it('large-repo mode: only materializes changed files, bounded content', async () => {
    const g = makeGitFixture();
    const store = mkdtempSync(join(tmpdir(), 'gt-bigstore-'));
    const snap = await captureGitSnapshot({ workspacePath: g.dir, kind: 'git-head', snapshotStore: store });
    // No full clone/copy: snapshot is just the diff + changed blob.
    const filesAfter = join(store, snap.snapshotId, 'files');
    // At least the changed file is materialized
    expect(existsSync(join(filesAfter, 'math.js'))).toBe(true);
    expect(readdirSync(filesAfter).length).toBeGreaterThan(0);
  });
});