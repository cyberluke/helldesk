// Minimal protobuf (proto3) wire codec for the NAF/1 messages defined in
// `protos/naf/protocol.proto`. Hand-rolled but faithful to the protobuf binary
// format so it interoperates with the Rust `prost` bindings on the host.
// Only the messages used on the wire are implemented. Field numbers are exact.
// ---------------------------------------------------------------- writer ----
export class Writer {
    constructor() {
        this.out = [];
        // repeated string (packed). We write unpacked strings (matches prost default for string).
    }
    len() { return this.out.length; }
    finish() { return Uint8Array.from(this.out); }
    tag(field, wire) { return this.varint((field << 3) | wire); }
    varint(value) {
        let v = value >>> 0;
        while (v >= 0x80) {
            this.out.push((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        this.out.push(v);
        return this;
    }
    u32(value) { this.varint(value >>> 0); return this; }
    i64(value) {
        // up to 2^53 works in JS via BigInt-free two's-complement varint.
        let v = BigInt(value);
        const neg = v < 0n;
        if (neg)
            v = (1n << 64n) + v;
        for (let i = 0n; i < 10n; i++) {
            if (v < 0x80n) {
                this.out.push(Number(v));
                break;
            }
            this.out.push(Number((v & 0x7fn) | 0x80n));
            v >>= 7n;
        }
        return this;
    }
    f64(_value) { throw new Error('f64 encode unsupported'); }
    str(s) { const b = encoder.encode(s); this.varint(b.length); for (const c of b)
        this.out.push(c); return this; }
    putBytes(b) { this.varint(b.length); for (const c of b)
        this.out.push(c); return this; }
}
const encoder = new TextEncoder();
// ---------------------------------------------------------------- reader ----
export class Reader {
    constructor(buf) {
        this.pos = 0;
        this.buf = buf;
    }
    get eof() { return this.pos >= this.buf.length; }
    varint() {
        let result = 0;
        let shift = 0;
        while (true) {
            if (this.pos >= this.buf.length)
                throw new Error('varint overflow');
            const byte = this.buf[this.pos++];
            result |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0)
                break;
            shift += 7;
            if (shift >= 32)
                throw new Error('varint too long');
        }
        return result >>> 0;
    }
    signedVarint() {
        const v = this.varint();
        return v & 1 ? -((v >>> 1) ^ 0xffffffff) - 1 : v >>> 1;
    }
    tag() {
        const t = this.varint();
        return [t >>> 3, t & 7];
    }
    bytes() {
        const len = this.varint();
        const start = this.pos;
        this.pos += len;
        if (this.pos > this.buf.length)
            throw new Error('read past end');
        return this.buf.subarray(start, this.pos);
    }
    str() { return new TextDecoder().decode(this.bytes()); }
    skip(wire) {
        switch (wire) {
            case 0:
                this.varint();
                break;
            case 1:
                this.pos += 8;
                break;
            case 2: {
                const l = this.varint();
                this.pos += l;
                break;
            }
            case 5:
                this.pos += 4;
                break;
            default: throw new Error('unsupported wire type ' + wire);
        }
    }
}
export var KindType;
(function (KindType) {
    KindType[KindType["Request"] = 11] = "Request";
    KindType[KindType["Response"] = 12] = "Response";
    KindType[KindType["Event"] = 13] = "Event";
})(KindType || (KindType = {}));
export const FRAME_MAGIC = 0x4e414631; // b"NAF1" as u32le (the u32 value of bytes N,A,F,1)
// ----------------------------------------------------------- encoders ------
// proto3 semantics: fields at their default value (0 / "") are OMITTED, exactly
// like the Rust `prost` codec — otherwise TS and Rust frames differ and the
// canonical BLAKE3/CRC checksums would not match byte-for-byte.
export function encodeFrame(f) {
    const w = new Writer();
    w.tag(1, 0).u32(f.magic); // magic (always set)
    if (f.format_version !== 0)
        w.tag(2, 0).u32(f.format_version);
    if (f.frame_length !== 0)
        w.tag(3, 0).varint(f.frame_length);
    if (f.runtime_sequence !== 0)
        w.tag(4, 0).varint(f.runtime_sequence);
    if (f.event_id)
        w.tag(5, 2).str(f.event_id);
    if (f.protobuf_event.length)
        w.tag(6, 2).putBytes(f.protobuf_event);
    if (f.crc32c !== 0)
        w.tag(7, 0).u32(f.crc32c);
    if (f.frame_blake3.length)
        w.tag(8, 2).putBytes(f.frame_blake3);
    return w.finish();
}
export function decodeFrame(buf) {
    const r = new Reader(buf);
    const f = { magic: 0, format_version: 0, frame_length: 0, runtime_sequence: 0, event_id: '', protobuf_event: new Uint8Array(0), crc32c: 0, frame_blake3: new Uint8Array(0) };
    while (!r.eof) {
        const [field, wire] = r.tag();
        if (wire === 0) {
            const v = r.varint();
            if (field === 1)
                f.magic = v >>> 0;
            else if (field === 2)
                f.format_version = v >>> 0;
            else if (field === 3)
                f.frame_length = v >>> 0;
            else if (field === 4)
                f.runtime_sequence = v >>> 0;
            else if (field === 7)
                f.crc32c = v >>> 0;
        }
        else if (wire === 2) {
            const b = r.bytes();
            if (field === 5)
                f.event_id = new TextDecoder().decode(b);
            else if (field === 6)
                f.protobuf_event = b;
            else if (field === 8)
                f.frame_blake3 = b;
        }
        else
            r.skip(wire);
    }
    return f;
}
function writeRequest(w, req) {
    if (req.method)
        w.tag(1, 2).str(req.method);
    if (req.args.length)
        w.tag(2, 2).putBytes(req.args);
}
function readRequest(r) {
    const req = { method: '', args: new Uint8Array(0) };
    while (!r.eof) {
        const [f, wire] = r.tag();
        if (wire === 2) {
            const b = r.bytes();
            if (f === 1)
                req.method = new TextDecoder().decode(b);
            else if (f === 2)
                req.args = b;
        }
        else
            r.skip(wire);
    }
    return req;
}
function writeResponse(w, resp) {
    if (resp.status !== 0)
        w.tag(1, 0).u32(resp.status);
    if (resp.error)
        w.tag(2, 2).str(resp.error);
    if (resp.body.length)
        w.tag(3, 2).putBytes(resp.body);
}
function readResponse(r) {
    const resp = { status: 0, error: '', body: new Uint8Array(0) };
    while (!r.eof) {
        const [f, wire] = r.tag();
        if (wire === 0) {
            const v = r.varint();
            if (f === 1)
                resp.status = v >>> 0;
        }
        else if (wire === 2) {
            const b = r.bytes();
            if (f === 2)
                resp.error = new TextDecoder().decode(b);
            else if (f === 3)
                resp.body = b;
        }
        else
            r.skip(wire);
    }
    return resp;
}
export function encodeEnvelope(e) {
    const w = new Writer();
    if (e.request_id !== 0)
        w.tag(1, 0).varint(e.request_id);
    if (e.request_id_raw.length)
        w.tag(2, 2).putBytes(e.request_id_raw);
    if (e.idempotency_key)
        w.tag(3, 2).str(e.idempotency_key);
    if (e.producer_id)
        w.tag(4, 2).str(e.producer_id);
    if (e.correlation_id)
        w.tag(5, 2).str(e.correlation_id);
    if (e.causation_id)
        w.tag(6, 2).str(e.causation_id);
    if (e.deadline_ms)
        w.tag(7, 0).varint(e.deadline_ms);
    if (e.priority)
        w.tag(8, 0).u32(e.priority);
    if (e.payload_type)
        w.tag(9, 2).str(e.payload_type);
    if (e.payload.length)
        w.tag(10, 2).putBytes(e.payload);
    if (e.kindType === KindType.Request && e.request) {
        w.tag(11, 2);
        const sub = new Writer();
        writeRequest(sub, e.request);
        w.putBytes(sub.finish());
    }
    else if (e.kindType === KindType.Response && e.response) {
        w.tag(12, 2);
        const sub = new Writer();
        writeResponse(sub, e.response);
        w.putBytes(sub.finish());
    }
    return w.finish();
}
export function decodeEnvelope(buf) {
    const r = new Reader(buf);
    const e = { request_id: 0, request_id_raw: new Uint8Array(0), idempotency_key: '', producer_id: '', correlation_id: '', causation_id: '', deadline_ms: 0, priority: 0, payload_type: '', payload: new Uint8Array(0), kindType: null };
    while (!r.eof) {
        const [field, wire] = r.tag();
        if (wire === 0) {
            const v = r.varint();
            if (field === 1)
                e.request_id = v >>> 0;
            else if (field === 7)
                e.deadline_ms = v >>> 0;
            else if (field === 8)
                e.priority = v >>> 0;
        }
        else if (wire === 2) {
            const b = r.bytes();
            if (field === 2)
                e.request_id_raw = b;
            else if (field === 3)
                e.idempotency_key = new TextDecoder().decode(b);
            else if (field === 4)
                e.producer_id = new TextDecoder().decode(b);
            else if (field === 5)
                e.correlation_id = new TextDecoder().decode(b);
            else if (field === 6)
                e.causation_id = new TextDecoder().decode(b);
            else if (field === 9)
                e.payload_type = new TextDecoder().decode(b);
            else if (field === 10)
                e.payload = b;
            else if (field === 11) {
                e.kindType = KindType.Request;
                const sr = new Reader(b);
                e.request = readRequest(sr);
            }
            else if (field === 12) {
                e.kindType = KindType.Response;
                const sr = new Reader(b);
                e.response = readResponse(sr);
            }
        }
        else
            r.skip(wire);
    }
    return e;
}
export function encodeHandshakeRequest(h) {
    const w = new Writer();
    if (h.client_app_id)
        w.tag(1, 2).str(h.client_app_id);
    if (h.client_version)
        w.tag(2, 2).str(h.client_version);
    w.tag(3, 0).i64(h.client_pid);
    w.tag(4, 0).u32(h.naf_min);
    w.tag(5, 0).u32(h.naf_max);
    for (const c of h.requested_capabilities)
        w.tag(6, 2).str(c);
    if (h.package_identity)
        w.tag(7, 2).str(h.package_identity);
    if (h.build_sha)
        w.tag(8, 2).str(h.build_sha);
    if (h.nonce.length)
        w.tag(9, 2).putBytes(h.nonce);
    return w.finish();
}
export function decodeHandshakeResponse(buf) {
    const r = new Reader(buf);
    const hr = { runtime_version: '', runtime_build_sha: '', selected_naf_version: 0, capabilities: [], runtime_instance_id: '', storage_schema_version: 0, health: null };
    while (!r.eof) {
        const [field, wire] = r.tag();
        if (wire === 0) {
            const v = r.varint();
            if (field === 3)
                hr.selected_naf_version = v >>> 0;
            else if (field === 6)
                hr.storage_schema_version = v >>> 0;
        }
        else if (wire === 2) {
            const b = r.bytes();
            if (field === 1)
                hr.runtime_version = new TextDecoder().decode(b);
            else if (field === 2)
                hr.runtime_build_sha = new TextDecoder().decode(b);
            else if (field === 4) {
                const cr = new Reader(b);
                hr.capabilities.push(readCapability(cr));
            }
            else if (field === 5)
                hr.runtime_instance_id = new TextDecoder().decode(b);
            else if (field === 7) {
                const cr = new Reader(b);
                hr.health = readHealth(cr);
            }
        }
        else
            r.skip(wire);
    }
    return hr;
}
function readCapability(r) {
    const c = { name: '', version: '', detail: '' };
    while (!r.eof) {
        const [f, wire] = r.tag();
        if (wire === 2) {
            const b = r.bytes();
            if (f === 1)
                c.name = new TextDecoder().decode(b);
            else if (f === 2)
                c.version = new TextDecoder().decode(b);
            else if (f === 3)
                c.detail = new TextDecoder().decode(b);
        }
        else
            r.skip(wire);
    }
    return c;
}
function readHealth(r) {
    const h = { state: '', detail: '', lanes: [] };
    while (!r.eof) {
        const [f, wire] = r.tag();
        if (wire === 2) {
            const b = r.bytes();
            if (f === 1)
                h.state = new TextDecoder().decode(b);
            else if (f === 2)
                h.detail = new TextDecoder().decode(b);
            else if (f === 3)
                h.lanes.push(new TextDecoder().decode(b));
        }
        else
            r.skip(wire);
    }
    return h;
}
export function encodeResponse(resp) { const w = new Writer(); writeResponse(w, resp); return w.finish(); }
