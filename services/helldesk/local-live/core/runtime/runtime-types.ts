/**
 * Local HELLDESK — runtime types.
 *
 * `SqlStorage` is the Cloudflare Durable Object SQLite type the federated
 * submodules are typed against. We re-export an alias so `LocalSqlStorage`
 * satisfies it structurally without importing Cloudflare's type package.
 */
import type { LocalSqlStorageCursor } from './sql';

export interface SqlStorage {
  exec(query: string, ...params: unknown[]): LocalSqlStorageCursor;
}

/** DurableObjectStorage-shaped key-value store used by department config. */
export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  get<T>(key: string, defaultValue: T): Promise<T>;
  put(key: string, value: unknown): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list(options?: { prefix?: string; limit?: number; reverse?: boolean; start?: string; end?: string; noValues?: boolean }):
    Promise<Map<string, { value: unknown; ts: number }>>;
}