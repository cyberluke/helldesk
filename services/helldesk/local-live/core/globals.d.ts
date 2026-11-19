/**
 * Local HELLDESK — ambient Cloudflare-Worker types the federated domain code is
 * typed against. In CF these come from the Workers runtime; locally they are
 * structural aliases satisfied by our local SqlStorage/DurableObjectStorage/
 * Env. Declared `declare global` so the copied submodules typecheck unchanged.
 */

declare global {
  /** Durable Object SQLite cursor (iterable, as the domain spreads it). */
  interface SqlStorageCursor extends Iterable<Record<string, unknown>> {
    toArray(): Record<string, unknown>[];
    raw(): unknown[][];
    one(): Record<string, unknown> | null;
    meta(): { columns: { name: string; type?: string }[] };
  }

  /** Durable Object SQLite storage. Satisfied by our LocalSqlStorage. */
  interface SqlStorage {
    exec(query: string, ...params: unknown[]): SqlStorageCursor;
  }

  /** Durable Object KV storage. Satisfied by our LocalDurableObjectStorage. */
  interface DurableObjectStorageEntry { value: unknown; ts: number }
  interface DurableObjectStorage {
    get(key: string): Promise<unknown>;
    get<T>(key: string, defaultValue: T): Promise<T>;
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    put(entries: Record<string, unknown>): Promise<void>;
    delete(key: string): Promise<boolean>;
    delete(keys: string[]): Promise<number>;
    list(options?: { prefix?: string; limit?: number; reverse?: boolean; start?: string; end?: string; noValues?: boolean }): Promise<Map<string, DurableObjectStorageEntry>>;
    deleteAll(): Promise<void>;
    getAlarms(): Promise<unknown[]>;
    setAlarm(ts: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    getCurrentAlarm(): Promise<number | null>;
  }

  /** Worker Env: any object (local runtime provides DO namespaces + flags). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Env { [key: string]: any; ENVIRONMENT?: string }

  /** Local ExecutionContext shape for the worker fetch mount. */
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }
}

export {};