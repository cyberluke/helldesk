export declare class Writer {
    out: number[];
    len(): number;
    finish(): Uint8Array;
    tag(field: number, wire: number): this;
    varint(value: number): this;
    u32(value: number): this;
    i64(value: number): this;
    f64(_value: number): this;
    str(s: string): this;
    putBytes(b: Uint8Array): this;
}
export declare class Reader {
    buf: Uint8Array;
    pos: number;
    constructor(buf: Uint8Array);
    get eof(): boolean;
    varint(): number;
    signedVarint(): number;
    tag(): [number, number];
    bytes(): Uint8Array;
    str(): string;
    skip(wire: number): void;
}
export interface FrameDesc {
    magic: number;
    format_version: number;
    frame_length: number;
    runtime_sequence: number;
    event_id: string;
    protobuf_event: Uint8Array;
    crc32c: number;
    frame_blake3: Uint8Array;
}
export interface RequestDesc {
    method: string;
    args: Uint8Array;
}
export interface ResponseDesc {
    status: number;
    error: string;
    body: Uint8Array;
}
export declare enum KindType {
    Request = 11,
    Response = 12,
    Event = 13
}
export interface EnvelopeDesc {
    request_id: number;
    request_id_raw: Uint8Array;
    idempotency_key: string;
    producer_id: string;
    correlation_id: string;
    causation_id: string;
    deadline_ms: number;
    priority: number;
    payload_type: string;
    payload: Uint8Array;
    kindType: KindType | null;
    request?: RequestDesc;
    response?: ResponseDesc;
}
export interface HandshakeRequestDesc {
    client_app_id: string;
    client_version: string;
    client_pid: number;
    naf_min: number;
    naf_max: number;
    requested_capabilities: string[];
    package_identity: string;
    build_sha: string;
    nonce: Uint8Array;
}
export interface CapabilityDesc {
    name: string;
    version: string;
    detail: string;
}
export interface HealthDesc {
    state: string;
    detail: string;
    lanes: string[];
}
export interface HandshakeResponseDesc {
    runtime_version: string;
    runtime_build_sha: string;
    selected_naf_version: number;
    capabilities: CapabilityDesc[];
    runtime_instance_id: string;
    storage_schema_version: number;
    health: HealthDesc | null;
}
export declare const FRAME_MAGIC = 1312900657;
export declare function encodeFrame(f: FrameDesc): Uint8Array;
export declare function decodeFrame(buf: Uint8Array): FrameDesc;
export declare function encodeEnvelope(e: EnvelopeDesc): Uint8Array;
export declare function decodeEnvelope(buf: Uint8Array): EnvelopeDesc;
export declare function encodeHandshakeRequest(h: HandshakeRequestDesc): Uint8Array;
export declare function decodeHandshakeResponse(buf: Uint8Array): HandshakeResponseDesc;
export declare function encodeResponse(resp: ResponseDesc): Uint8Array;
