import { MAX_FRAME_BYTES } from './frame.js';
import { type EnvelopeDesc } from './wire.js';
export declare class NafError extends Error {
    readonly code: string;
    constructor(msg: string, code: string);
}
export interface NafClientOptions {
    appId: string;
    clientVersion: string;
    requestedCapabilities: string[];
    packageIdentity?: string;
    buildSha?: string;
    pipePath?: string;
    timeoutMs?: number;
    producerId?: string;
    nonce?: Uint8Array;
    onEvent?: (env: EnvelopeDesc) => void;
    onDisconnect?: (err: Error) => void;
    maxQueue?: number;
}
export declare function defaultPipePaths(): {
    canonical?: string;
    legacy: string;
};
export interface DispatchResult {
    ok: boolean;
    status: number;
    body: Uint8Array;
    error: string;
    response?: EnvelopeDesc;
}
export declare class NafClient {
    private socket;
    private readBuffer;
    private pendings;
    private queue;
    private seq;
    private connected;
    private connecting;
    private shutdown;
    runtimeInstanceId: string | null;
    nafVersion: number | null;
    private opts;
    producerId: string;
    constructor(opts: NafClientOptions);
    connect(): Promise<void>;
    /** Dispatch a typed NAF method with JSON args. */
    dispatch(method: string, args: unknown, idempotencyKey?: string): Promise<DispatchResult>;
    private flush;
    private sendRaw;
    private onData;
    private handleError;
    private handleClose;
    private retryMs;
    /** Resolve the endpoint to (re)connect to, rediscovering the canonical pipe. */
    private _resolvePipe;
    close(): Promise<void>;
    /**
     * Read a range of canonical events from the fabric ledger (`event.read_range`).
     * Resumes via `after` (exclusive runtime_sequence); filters apply server-side.
     * AAF: the read-back delta the runtime contract already advertised.
     */
    eventReadRange(args: {
        after?: number;
        limit?: number;
        namespace?: string;
        event_type?: string;
        entity_id?: string;
        correlation_id?: string;
    }): Promise<DispatchResult>;
    /** Append a canonical event with an optional idempotency key. */
    eventAppend(args: {
        namespace: string;
        event_type: string;
        entity_id?: string;
        payload?: unknown;
        timestamp_utc_ms?: number;
        correlation_id?: string;
        durability?: 'durable' | 'batched';
    }, idempotencyKey?: string): Promise<DispatchResult>;
    /** Register / additively evolve a collection schema (Mastra CollectionSchema). */
    collectionEnsureSchema(schema: unknown): Promise<DispatchResult>;
    collectionFindOne<T extends Record<string, unknown>>(collection: string, where: Record<string, unknown>): Promise<DispatchResult & {
        row?: T | null;
    }>;
    collectionFindMany<T extends Record<string, unknown>>(collection: string, where: Record<string, unknown>, opts?: {
        order_by?: [string, 'asc' | 'desc'][];
        limit?: number;
    }): Promise<DispatchResult & {
        rows?: T[];
    }>;
    collectionCount(collection: string, where: Record<string, unknown>): Promise<DispatchResult & {
        count?: number;
    }>;
    collectionUpsert<T extends Record<string, unknown>>(collection: string, row: Partial<T>, conflictKeys?: string[], txId?: string): Promise<DispatchResult>;
    collectionInsert<T extends Record<string, unknown>>(collection: string, row: Partial<T>, txId?: string): Promise<DispatchResult>;
    collectionUpdateMany<T extends Record<string, unknown>>(collection: string, where: Record<string, unknown>, set: Record<string, unknown>, txId?: string): Promise<DispatchResult>;
    collectionDeleteMany(collection: string, where: Record<string, unknown>, txId?: string): Promise<DispatchResult>;
    collectionUpdateAtomic<T extends Record<string, unknown>>(collection: string, where: Record<string, unknown>, set: Record<string, unknown>): Promise<DispatchResult>;
    transactionBegin(): Promise<DispatchResult & {
        tx_id?: string;
    }>;
    transactionRollback(txId: string): Promise<DispatchResult>;
    transactionCommit(txId: string): Promise<DispatchResult>;
    leaseClaim(leaseId: string, ownerId: string, ttlMs?: number): Promise<DispatchResult>;
    leaseRenew(leaseId: string, ownerId: string, ttlMs?: number): Promise<DispatchResult>;
    leaseRelease(leaseId: string, ownerId: string): Promise<DispatchResult>;
}
export { MAX_FRAME_BYTES };
