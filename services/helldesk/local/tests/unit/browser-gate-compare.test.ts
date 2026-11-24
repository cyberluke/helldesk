import { describe, expect, it } from 'bun:test';
import { PNG } from 'pngjs';
import { compareScreenshotBuffers } from '../../src/browser-gate';

function solid(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

describe('browser-gate visual comparator', () => {
  it('passes identical screenshots', () => {
    const image = solid(12, 12, [10, 20, 30, 255]);
    const out = compareScreenshotBuffers(image, image, 0.002);
    expect(out.ok).toBe(true);
    expect(out.ratio).toBe(0);
    expect(out.sizeDelta).toBeNull();
  });

  it('compares the overlap for a 1px clip delta instead of failing the gate', () => {
    // M6 run C: 565x565 actual vs 565x566 golden after a reboot; the extra row
    // is a clip-rounding artifact, not a layout defect.
    const actual = solid(12, 11, [10, 20, 30, 255]);
    const golden = solid(12, 12, [10, 20, 30, 255]);
    const out = compareScreenshotBuffers(actual, golden, 0.002);
    expect(out.ok).toBe(true);
    expect(out.ratio).toBe(0);
    expect(out.sizeDelta).toEqual({ width: 0, height: -1, tolerancePx: 2 });
    expect(out.reason).toContain('clip size delta');
  });

  it('still fails a genuine content change over the overlap', () => {
    const actual = solid(12, 12, [10, 20, 30, 255]);
    const golden = new PNG({ width: 12, height: 12 });
    for (let i = 0; i < 12 * 12; i += 1) {
      const changed = i % 2 === 0;
      golden.data[i * 4] = changed ? 255 : 10;
      golden.data[i * 4 + 1] = changed ? 255 : 20;
      golden.data[i * 4 + 2] = changed ? 255 : 30;
      golden.data[i * 4 + 3] = 255;
    }
    const out = compareScreenshotBuffers(actual, PNG.sync.write(golden), 0.002);
    expect(out.ok).toBe(false);
    expect(out.ratio).toBeGreaterThan(0.002);
  });

  it('fails a size delta beyond the tolerance', () => {
    const actual = solid(12, 8, [10, 20, 30, 255]);
    const golden = solid(12, 12, [10, 20, 30, 255]);
    const out = compareScreenshotBuffers(actual, golden, 0.002);
    expect(out.ok).toBe(false);
    expect(out.ratio).toBeNull();
    expect(out.reason).toContain('size mismatch');
    expect(out.sizeDelta?.height).toBe(-4);
  });
});
