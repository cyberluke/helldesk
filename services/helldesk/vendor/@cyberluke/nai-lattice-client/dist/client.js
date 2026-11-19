// Reusable TypeScript NAF/1 client: Windows named-pipe transport (node:net),
// handshake negotiation, request correlation, timeouts, reconnect, bounded
// in-memory queue and structured errors. Source in NAI-Lattice only (NAF-010);
// the Kilo plugin consumes this package and never re-implements NAF.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { encodeWireFrame, parseFrames, MAX_FRAME_BYTES } from './frame.js';
import { encodeHandshakeRequest, decodeHandshakeResponse, KindType, } from './wire.js';
const NAF_MIN = 1;
const NAF_MAX = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUEUE = 1024;
export class NafError extends Error {
    constructor(msg, code) {
        super(msg);
        this.code = code;
        this.name = 'NafError';
    }
}
/**
 * Canonical per-user pipe discovery, backed by NAI-Lattice infrastructure
 * (GATE 1). The native host atomically publishes `endpoint.json` to the Lattice
 * per-user runtime root with the canonical SID-derived pipe + legacy alias.
 * A client MUST NOT guess the pipe from USERNAME alone; it discovers the
 * canonical endpoint from the publication, falling back to the legacy
 * username-derived alias (served by the same singleton while clients migrate).
 */
import fs from 'node:fs';
import path from 'node:path';
export function defaultPipePaths() {
    const local = process.env.LOCALAPPDATA;
    const candidates = [];
    if (local) {
        candidates.push(path.join(local, 'NAI', 'Lattice', 'v1', 'endpoint.json'));
    }
    for (const cand of candidates) {
        try {
            const text = fs.readFileSync(cand, 'utf8');
            const v = JSON.parse(text);
            const canonical = typeof v.canonical_pipe === 'string' ? v.canonical_pipe : undefined;
            const alias = typeof v.legacy_alias === 'string' ? v.legacy_alias : '';
            if (canonical)
                return { canonical, legacy: alias || canonical };
        }
        catch { /* fall through */ }
    }
    // Legacy username-derived alias (host serves it while clients migrate).
    const user = (process.env.USERNAME || 'unknown').toLowerCase();
    const legacy = `\\\\.\\pipe\\NAI.AmbientFabric.NAF1.${stableHex(user, 6)}`;
    return { legacy };
}
/** Per-user pipe endpoint: prefer canonical discovery, else legacy alias. */
function defaultPipePath() {
    const p = defaultPipePaths();
    return p.canonical ?? p.legacy;
}
// Stable hash helper: FNV-1a over the username, hex slice for the pipe id.
// Matches the "sidecar" concept; the Rust host uses BLAKE3(USERNAME)[..6].
// We mirror the byte-fidelity by hashing with the same crate through noble.
import { blake3 } from './blake3.js';
function stableHex(input, n) {
    return Buffer.from(blake3(new TextEncoder().encode(input))).toString('hex').slice(0, n);
}
export class NafClient {
    constructor(opts) {
        this.socket = null;
        this.readBuffer = Buffer.alloc(0);
        this.pendings = new Map();
        this.queue = [];
        this.seq = 0;
        this.connected = false;
        this.connecting = false;
        this.shutdown = false;
        this.runtimeInstanceId = null;
        this.nafVersion = null;
        this.retryMs = 200;
        this.opts = { timeoutMs: DEFAULT_TIMEOUT_MS, maxQueue: MAX_QUEUE, ...opts };
        this.producerId = opts.producerId ?? opts.appId;
    }
    async connect() {
        if (this.connected)
            return;
        const pipe = await this._resolvePipe();
        const socket = net.createConnection(pipe);
        this.socket = socket;
        socket.setNoDelay(true);
        await new Promise((resolve, reject) => {
            const onConnect = () => { socket.removeListener('error', onError); resolve(); };
            const onError = (e) => { socket.removeListener('connect', onConnect); reject(e); };
            socket.once('connect', onConnect);
            socket.once('error', onError);
        });
        // Handshake: write the request frame and read exactly one complete response
        // frame (proven live-pipe pattern), before entering the dispatch model.
        const hsEnv = {
            request_id: 0,
            request_id_raw: new Uint8Array(0),
            idempotency_key: '',
            producer_id: this.producerId,
            correlation_id: '',
            causation_id: '',
            deadline_ms: 0,
            priority: 0,
            payload_type: 'naf.handshake',
            payload: new Uint8Array(0),
            kindType: KindType.Request,
            request: {
                method: '__handshake',
                args: encodeHandshakeRequest({
                    client_app_id: this.opts.appId,
                    client_version: this.opts.clientVersion,
                    client_pid: process.pid,
                    naf_min: NAF_MIN,
                    naf_max: NAF_MAX,
                    requested_capabilities: this.opts.requestedCapabilities,
                    package_identity: this.opts.packageIdentity ?? '',
                    build_sha: this.opts.buildSha ?? '',
                    nonce: this.opts.nonce ?? new Uint8Array(0),
                }),
            },
        };
        const hsFrame = encodeWireFrame(hsEnv);
        const respEnv = await new Promise((resolve, reject) => {
            let hsBuf = Buffer.alloc(0);
            let settled = false;
            let onHsData = null;
            const finish = (v) => { if (!settled) {
                settled = true;
                if (onHsData)
                    socket.removeListener('data', onHsData);
                resolve(v);
            } };
            const fail = (e) => { if (!settled) {
                settled = true;
                if (onHsData)
                    socket.removeListener('data', onHsData);
                reject(e);
            } };
            onHsData = (chunk) => {
                hsBuf = Buffer.concat([hsBuf, chunk]);
                const { frames, rest, errors } = parseFrames(hsBuf);
                if (errors.length) {
                    fail(new NafError(errors[0], 'FRAME_ERROR'));
                    return;
                }
                if (frames.length) {
                    finish(frames[0]);
                    return;
                }
                if (rest.length < hsBuf.length || rest.length === 0)
                    hsBuf = Buffer.from(rest);
            };
            socket.on('data', onHsData);
            socket.once('error', fail);
            const timer = setTimeout(() => { fail(new NafError('handshake timeout', 'HANDSHAKE_TIMEOUT')); clearTimerAndFailTimeout(timer); }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            function clearTimerAndFailTimeout(t) { clearTimeout(t); }
            socket.write(Buffer.from(hsFrame), (err) => { if (err)
                fail(err); });
        });
        if (!respEnv || respEnv.kindType !== KindType.Response || !respEnv.response) {
            throw new NafError('unexpected handshake envelope', 'HANDSHAKE_REJECTED');
        }
        if (respEnv.response.status !== 0) {
            throw new NafError(`handshake rejected: ${respEnv.response.error}`, 'HANDSHAKE_REJECTED');
        }
        // Capture negotiated NAF version + runtime instance from the handshake body.
        try {
            const hsResp = decodeHandshakeResponse(respEnv.response.body);
            this.nafVersion = hsResp.selected_naf_version || null;
            this.runtimeInstanceId = hsResp.runtime_instance_id || null;
        }
        catch { /* non-fatal */ }
        // Enter the persistent dispatch model.
        socket.removeAllListeners('data');
        socket.removeAllListeners('error');
        socket.removeAllListeners('close');
        socket.on('data', (d) => this.onData(d));
        socket.on('error', (e) => this.handleError(e));
        socket.on('close', () => this.handleClose());
        this.connected = true;
    }
    /** Dispatch a typed NAF method with JSON args. */
    dispatch(method, args, idempotencyKey) {
        if (this.queue.length >= (this.opts.maxQueue ?? MAX_QUEUE)) {
            return Promise.reject(new NafError('NAF write queue full (backpressure)', 'QUEUE_FULL'));
        }
        const env = {
            request_id: 0,
            request_id_raw: new TextEncoder().encode(randomUUID()),
            idempotency_key: idempotencyKey ?? '',
            producer_id: this.producerId,
            correlation_id: '',
            causation_id: '',
            deadline_ms: Date.now() + (this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * 2,
            priority: 0,
            payload_type: 'naf.request',
            payload: new Uint8Array(0),
            kindType: KindType.Request,
            request: { method, args: new TextEncoder().encode(JSON.stringify(args ?? {})) },
        };
        this.queue.push(env);
        return this.flush();
    }
    async flush() {
        if (!this.connected || this.socket === null) {
            throw new NafError('not connected', 'NOT_CONNECTED');
        }
        // Send all queued frames (ordered per producer + epoch).
        while (this.queue.length > 0) {
            const env = this.queue.shift();
            const result = await this.sendRaw(encodeWireFrame(env), env.request?.method ?? '');
            if (result.ok)
                return result;
            // Re-queue on transient failure and break; caller can retry.
            this.queue.unshift(env);
            return result;
        }
        throw new NafError('empty dispatch', 'EMPTY');
    }
    sendRaw(data, method) {
        return new Promise((resolve, reject) => {
            if (!this.socket)
                return reject(new NafError('not connected', 'NOT_CONNECTED'));
            const id = `m-${this.seq++}-${method}-${randomUUID().slice(0, 6)}`;
            const timer = setTimeout(() => {
                this.pendings.delete(id);
                resolve({ ok: false, status: 504, body: new Uint8Array(0), error: `timeout calling ${method}` });
            }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            this.pendings.set(id, { resolve, timer });
            this.socket.write(Buffer.from(data), (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendings.delete(id);
                    reject(err);
                }
            });
        });
    }
    onData(data) {
        this.readBuffer = Buffer.concat([this.readBuffer, data]);
        const { frames, rest, errors } = parseFrames(this.readBuffer);
        this.readBuffer = Buffer.from(rest);
        for (const err of errors)
            if (this.opts.onDisconnect)
                this.opts.onDisconnect(new Error(err));
        for (const env of frames) {
            if (env.kindType === KindType.Response && env.response) {
                // Match response to the earliest pending caller (FIFO correlation;
                // the host answers in request order).
                const pending = this.pendings.values().next().value;
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendings.delete(this.pendings.keys().next().value);
                    pending.resolve({
                        ok: env.response.status === 0,
                        status: env.response.status,
                        body: env.response.body,
                        error: env.response.error,
                        response: env,
                    });
                }
            }
            else if (env.kindType === KindType.Event || (env.kindType === null && env.payload_type === 'helldesk.event')) {
                if (this.opts.onEvent)
                    this.opts.onEvent(env);
            }
        }
    }
    handleError(e) {
        if (this.opts.onDisconnect)
            this.opts.onDisconnect(e);
    }
    handleClose() {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        const err = new NafError('NAF pipe closed', 'PIPE_CLOSED');
        for (const [, p] of this.pendings) {
            clearTimeout(p.timer);
            p.resolve({ ok: false, status: 500, body: new Uint8Array(0), error: err.message });
        }
        this.pendings.clear();
        if (this.opts.onDisconnect)
            this.opts.onDisconnect(err);
        // Auto-reconnect with retry/backoff, rediscovering the current endpoint each
        // attempt (GATE 1). Bound and graceful: stops on `close()`/shutdown.
        if (wasConnected && !this.shutdown) {
            const backoff = Math.min(this.retryMs * 2, 4000);
            this.retryMs = backoff;
            setTimeout(() => {
                if (this.shutdown)
                    return;
                this.connect().catch((e) => { if (this.opts.onDisconnect)
                    this.opts.onDisconnect(e instanceof Error ? e : new Error(String(e))); });
            }, backoff);
        }
    }
    /** Resolve the endpoint to (re)connect to, rediscovering the canonical pipe. */
    async _resolvePipe() {
        return this.opts.pipePath ?? defaultPipePath();
    }
    async close() {
        this.shutdown = true;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        for (const [, p] of this.pendings) {
            clearTimeout(p.timer);
            p.resolve({ ok: false, status: 499, body: new Uint8Array(0), error: 'client closed' });
        }
        this.pendings.clear();
        this.queue.length = 0;
    }
    /**
     * Read a range of canonical events from the fabric ledger (`event.read_range`).
     * Resumes via `after` (exclusive runtime_sequence); filters apply server-side.
     * AAF: the read-back delta the runtime contract already advertised.
     */
    async eventReadRange(args) {
        return this.dispatch('event.read_range', args ?? {});
    }
    /** Append a canonical event with an optional idempotency key. */
    async eventAppend(args, idempotencyKey) {
        return this.dispatch('event.append', args ?? {}, idempotencyKey);
    }
    // ---- collection.v1 (Mastra canonical persistence) ----
    /** Register / additively evolve a collection schema (Mastra CollectionSchema). */
    async collectionEnsureSchema(schema) {
        return this.dispatch('collection.schema.ensure', { schema });
    }
    async collectionFindOne(collection, where) {
        return this.dispatch('collection.find_one', { collection, where });
    }
    async collectionFindMany(collection, where, opts) {
        return this.dispatch('collection.find_many', {
            collection,
            where,
            order_by: opts?.order_by ?? [],
            limit: opts?.limit ?? undefined,
        });
    }
    async collectionCount(collection, where) {
        return this.dispatch('collection.count', { collection, where });
    }
    async collectionUpsert(collection, row, conflictKeys, txId) {
        return this.dispatch('collection.upsert', {
            collection,
            row,
            conflict_keys: conflictKeys ?? [],
            tx_id: txId,
        });
    }
    async collectionInsert(collection, row, txId) {
        return this.dispatch('collection.insert', {
            collection,
            row,
            conflict_keys: [],
            tx_id: txId,
        });
    }
    async collectionUpdateMany(collection, where, set, txId) {
        return this.dispatch('collection.update_many', { collection, where, set, tx_id: txId });
    }
    async collectionDeleteMany(collection, where, txId) {
        return this.dispatch('collection.delete_many', { collection, where, tx_id: txId });
    }
    async collectionUpdateAtomic(collection, where, set) {
        return this.dispatch('collection.update_atomic', { collection, where, set });
    }
    // ---- transaction.v1 ----
    async transactionBegin() {
        return this.dispatch('transaction.begin', {});
    }
    async transactionRollback(txId) {
        return this.dispatch('transaction.rollback', { tx_id: txId });
    }
    async transactionCommit(txId) {
        return this.dispatch('transaction.commit', { tx_id: txId });
    }
    // ---- lease.v1 (Mastra workflow run ownership / fencing) ----
    async leaseClaim(leaseId, ownerId, ttlMs) {
        return this.dispatch('lease.claim', { lease_id: leaseId, owner_id: ownerId, ttl_ms: ttlMs });
    }
    async leaseRenew(leaseId, ownerId, ttlMs) {
        return this.dispatch('lease.renew', { lease_id: leaseId, owner_id: ownerId, ttl_ms: ttlMs });
    }
    async leaseRelease(leaseId, ownerId) {
        return this.dispatch('lease.release', { lease_id: leaseId, owner_id: ownerId });
    }
}
export { MAX_FRAME_BYTES };
