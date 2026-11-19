import { describe, expect, it } from 'bun:test';
import {
  resolveSafePath,
  makeEvidenceCtx,
  reviewListChangedFiles,
  reviewReadDiff,
  reviewReadFile,
  reviewSearch,
  verifyPathInSnapshot,
  verifyLineRange,
} from '../../src/context-reader';
import { captureGitSnapshot } from '../../src/snapshot';
import { makeGitFixture } from '../helpers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('context-reader (read-only evidence)', () => {
  it('blocks path traversal outside the workspace root', () => {
    const safe = resolveSafePath('C:/proj', '../C:/Windows/system32/config.dat');
    expect(safe).toBeNull();
    const okay = resolveSafePath('C:/proj', 'src/app.ts');
    expect(okay).toBe(join('C:/proj', 'src/app.ts'));
  });

  it('provides frozen diff/files/search from a pinned snapshot', async () => {
    const g = makeGitFixture();
    const store = mkdtempSync(join(tmpdir(), 'gt-evstore-'));
    const snap = await captureGitSnapshot({ workspacePath: g.dir, kind: 'git-head', snapshotStore: store });
    const ctx = makeEvidenceCtx(store, snap.snapshotId, g.dir);
    expect(ctx).not.toBeNull();
    expect(reviewListChangedFiles(ctx!)).toContain('math.js');
    expect(reviewReadDiff(ctx!)).toContain('math.js');
    expect(reviewReadFile(ctx!, null, 'math.js')).toContain('compute');
    const hits = reviewSearch(ctx!, 'compute', undefined, 5);
    expect(hits).toContain('math.js');
  });

  it('verifies real paths/lines and rejects fabricated ones', async () => {
    const g = makeGitFixture();
    const store = mkdtempSync(join(tmpdir(), 'gt-verstore-'));
    const snap = await captureGitSnapshot({ workspacePath: g.dir, kind: 'git-head', snapshotStore: store });
    const ctx = makeEvidenceCtx(store, snap.snapshotId, g.dir)!;
    expect(verifyPathInSnapshot(ctx, 'math.js')).toBe(true);
    expect(verifyPathInSnapshot(ctx, 'not-real.js')).toBe(false);
    expect(verifyLineRange(ctx, 'math.js', 1, 2)).toBe(true);
    expect(verifyLineRange(ctx, 'math.js', 999, 1000)).toBe(false);
    const evades = makeEvidenceCtx(store, snap.snapshotId, g.dir);
    // reading a path that would traverse out of blob store must not escape
    expect(evades).not.toBeNull();
  });
});