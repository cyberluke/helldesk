import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReviewFiles } from '../../src/review-attachments';

function makeImage(path: string, bytes = 32): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
  return path;
}

describe('collectReviewFiles', () => {
  test('collects requirement attachments before committed evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'helldesk-review-files-'));
    const original = makeImage(join(root, 'attachments', 'att_abc123', 'original.png'));
    const page = makeImage(join(root, 'attachments', 'att_abc123', 'page-0001.png'));
    const workspace = join(root, 'workspace');
    const evidence = makeImage(join(workspace, 'proof', 'state.png'));

    const files = collectReviewFiles({
      requirements: [
        '## Input attachments',
        `- original: ${original} (http://127.0.0.1/x)`,
        `- page images: 1:${page}`,
      ].join('\n'),
      workspace,
    });

    expect(files[0]).toBe(original);
    expect(files).toContain(page);
    expect(files).toContain(evidence);
    expect(files.length).toBeLessThanOrEqual(4);
  });

  test('dedupes attachment paths and ignores non-images', () => {
    const root = mkdtempSync(join(tmpdir(), 'helldesk-review-files-'));
    const original = makeImage(join(root, 'attachments', 'att_abc123', 'original.png'));
    const note = join(root, 'attachments', 'att_abc123', 'notes.txt');
    writeFileSync(note, 'not an image');

    const files = collectReviewFiles({
      requirements: `- original: ${original}\n- again: ${original}\n- note: ${note}`,
      workspace: '',
    });

    expect(files).toEqual([original]);
  });

  test('respects the maxFiles bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'helldesk-review-files-'));
    const workspace = join(root, 'workspace');
    for (let index = 0; index < 6; index += 1) {
      makeImage(join(workspace, 'proof', `shot-${index}.png`));
    }
    const files = collectReviewFiles({ requirements: '', workspace, maxFiles: 2 });
    expect(files).toHaveLength(2);
  });
});
