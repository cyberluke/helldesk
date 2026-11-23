/**
 * ScrollbackBuffer — bounded recent-output memory for a PTY session.
 *
 * A PTY starts printing the moment it is spawned (the frontDesk REPL prints its
 * welcome banner and prompt immediately). The operator terminal attaches later:
 * the page mounts, polls the session, opens the WebSocket. Without a replay
 * buffer that banner is lost and the terminal opens blank.
 *
 * This keeps the newest `limit` bytes of raw PTY output so `attachOutput` can
 * replay it to a late-attaching socket before live streaming begins. It is a
 * byte ring, not a rendered screen model: raw ANSI is preserved, so replays
 * re-render exactly as the live stream would.
 */
export class ScrollbackBuffer {
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly limit = 64 * 1024) {
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('ScrollbackBuffer limit must be positive');
  }

  /** Append output. The chunk is copied so callers may reuse their buffers. */
  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    // A single chunk larger than the whole budget keeps only its tail.
    if (chunk.byteLength > this.limit) {
      this.chunks = [chunk.slice(chunk.byteLength - this.limit)];
      this.bytes = this.limit;
      return;
    }
    this.chunks.push(chunk.slice());
    this.bytes += chunk.byteLength;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.bytes -= dropped.byteLength;
    }
  }

  /** Contiguous copy of the retained bytes, oldest → newest. */
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /** Retained byte count (never exceeds the limit). */
  get size(): number {
    return this.bytes;
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
