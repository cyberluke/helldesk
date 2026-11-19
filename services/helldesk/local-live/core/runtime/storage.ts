/**
 * Local HELLDESK — `DurableObjectStorage`-compatible shim (Map-backed, JSON
 * persistence). Department DO's `ctx.storage` (used by config.getDepartmentConfig, owner
 * access, container health, eviction context) is a key-value store. On the
 * local runtime we back it with a per-DO JSON file so alarms/config survive
 * a restart, without Cloudflare Durable Object KV semantics.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

interface StorageEntry { value: unknown; ts: number }

export class LocalDurableObjectStorage {
  private map = new Map<string, unknown>();
  private file: string | null;
  private dirty = false;

  constructor(persistPath?: string) {
    this.file = persistPath ?? null;
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Record<string, StorageEntry>;
        for (const [k, v] of Object.entries(raw)) this.map.set(k, (v as StorageEntry).value);
      } catch { /* corrupt -> start empty */ }
    }
  }

  private persist(): void {
    if (!this.file || !this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const out: Record<string, StorageEntry> = {};
    for (const [k, v] of this.map) out[k] = { value: v, ts: Date.now() };
    writeFileSync(this.file, JSON.stringify(out));
    this.dirty = false;
  }

  async get(key: string, defaultValue?: unknown): Promise<unknown> {
    const v = this.map.get(key);
    return v === undefined ? defaultValue : v;
  }
  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.map.set(keyOrEntries, value);
    } else {
      for (const [k, v] of Object.entries(keyOrEntries)) this.map.set(k, v);
    }
    this.dirty = true; this.persist();
  }
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    let n = 0;
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    for (const k of keys) if (this.map.delete(k)) n++;
    if (n) { this.dirty = true; this.persist(); }
    return n;
  }
  async list(options?: { prefix?: string; limit?: number; reverse?: boolean; start?: string; end?: string; noValues?: boolean }):
    Promise<Map<string, { value: unknown; ts: number }>> {
    const out = new Map<string, { value: unknown; ts: number }>();
    let keys = [...this.map.keys()];
    if (options?.prefix) keys = keys.filter((k) => k.startsWith(options.prefix!));
    if (options?.start) keys = keys.filter((k) => k >= options.start!);
    if (options?.end) keys = keys.filter((k) => k < options.end!);
    keys.sort();
    if (options?.reverse) keys.reverse();
    if (options?.limit) keys = keys.slice(0, options.limit);
    for (const k of keys) out.set(k, { value: options?.noValues ? undefined : this.map.get(k), ts: Date.now() });
    return out;
  }
  async deleteAll(): Promise<void> { this.map.clear(); this.dirty = true; this.persist(); }
  getAlarms(): Promise<unknown[]> { return Promise.resolve([]); }
  async setAlarm(_ts: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
  getCurrentAlarm(): Promise<number | null> { return Promise.resolve(null); }
  sync(): void { this.persist(); }
}