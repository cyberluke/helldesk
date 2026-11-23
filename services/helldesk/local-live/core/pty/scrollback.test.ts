import { describe, it, expect } from 'bun:test';
import { ScrollbackBuffer } from './scrollback';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ScrollbackBuffer', () => {
  it('replays the banner in order (oldest → newest)', () => {
    const buf = new ScrollbackBuffer();
    buf.push(bytes('welcome\n'));
    buf.push(bytes('mayor@default > '));
    expect(text(buf.snapshot())).toBe('welcome\nmayor@default > ');
  });

  it('keeps only the newest bytes when the budget is exceeded', () => {
    const buf = new ScrollbackBuffer(10);
    buf.push(bytes('aaaa'));
    buf.push(bytes('bbbb'));
    buf.push(bytes('cccc'));
    expect(buf.size).toBe(8);
    expect(text(buf.snapshot())).toBe('bbbbcccc');
  });

  it('keeps the tail of a single oversized chunk', () => {
    const buf = new ScrollbackBuffer(5);
    buf.push(bytes('0123456789'));
    expect(text(buf.snapshot())).toBe('56789');
  });

  it('copies on push so a reused source buffer cannot rewrite history', () => {
    const buf = new ScrollbackBuffer();
    const src = bytes('hello');
    buf.push(src);
    src.fill(0);
    expect(text(buf.snapshot())).toBe('hello');
  });

  it('is safe to replay when nothing was printed', () => {
    const buf = new ScrollbackBuffer();
    expect(buf.snapshot().byteLength).toBe(0);
    expect(buf.size).toBe(0);
  });

  it('rejects a nonsensical budget instead of silently dropping everything', () => {
    expect(() => new ScrollbackBuffer(0)).toThrow();
  });
});
