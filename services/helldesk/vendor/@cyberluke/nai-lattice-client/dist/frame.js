// Canonical NAF/1 length-prefixed framing, byte-compatible with the Rust host
// (`lattice_protocol::frame`): `u32le length` + protobuf `Frame` with CRC32C +
// BLAKE3 over the serialized body (crc + blake3 fields zeroed for the checksum).
// Source-of-truth framing, so TS↔Rust frames interoperate (NAF-001 / NAF-010).
import { crc32c } from './crc32c.js';
import { blake3, blake3Matches } from './blake3.js';
import { FRAME_MAGIC, encodeFrame, decodeFrame, encodeEnvelope, decodeEnvelope, } from './wire.js';
export const MAX_FRAME_BYTES = 128 * 1024 * 1024;
export class FrameError extends Error {
    constructor(msg) { super(msg); this.name = 'FrameError'; }
}
/** Encode an envelope as one NAF/1 wire frame (length-prefixed + integrity). */
export function encodeWireFrame(env) {
    const body = encodeEnvelope(env);
    // Build the Frame proto with crc + blake3 empty, compute checksums, then
    // re-encode with them filled (mirrors the Rust `encode_frame`).
    const frame = {
        magic: FRAME_MAGIC,
        format_version: 1,
        frame_length: body.length,
        runtime_sequence: 0,
        event_id: '',
        protobuf_event: body,
        crc32c: 0,
        frame_blake3: new Uint8Array(0),
    };
    const serialized = encodeFrame(frame);
    const crc = crc32c(serialized);
    const hash = blake3(serialized);
    const final = encodeFrame({ ...frame, crc32c: crc, frame_blake3: hash });
    const wire = new Uint8Array(4 + final.length);
    const view = new DataView(wire.buffer);
    view.setUint32(0, final.length, true);
    wire.set(final, 4);
    return wire;
}
/** Decode one complete wire frame, verifying length, magic, CRC32C + BLAKE3. */
export function decodeWireFrame(wire) {
    if (wire.length < 4)
        throw new FrameError('truncated wire frame (no length)');
    const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
    const len = view.getUint32(0, true);
    if (len > MAX_FRAME_BYTES)
        throw new FrameError(`frame too large: ${len} > ${MAX_FRAME_BYTES}`);
    const body = wire.subarray(4, 4 + len);
    if (body.length < len)
        throw new FrameError('truncated frame body');
    const frame = decodeFrame(body);
    if (frame.magic !== FRAME_MAGIC)
        throw new FrameError(`bad magic ${frame.magic.toString(16)}`);
    // Recompute integrity over the body with crc + blake3 zeroed.
    const verify = { ...frame, crc32c: 0, frame_blake3: new Uint8Array(0) };
    const serialized = encodeFrame(verify);
    if (crc32c(serialized) !== frame.crc32c)
        throw new FrameError('crc32c mismatch');
    if (!blake3Matches(serialized, frame.frame_blake3))
        throw new FrameError('blake3 mismatch');
    return frame;
}
/** Parse as many complete frames as possible from a byte buffer. Returns the
 * remaining buffered bytes (incomplete tail). */
export function parseFrames(buffer) {
    const frames = [];
    const errors = [];
    let rest = buffer;
    while (rest.length >= 4) {
        const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
        const len = view.getUint32(0, true);
        const total = 4 + len;
        if (len > MAX_FRAME_BYTES) {
            errors.push(`frame too large ${len}`);
            break;
        }
        if (rest.length < total)
            break; // incomplete
        try {
            const frame = decodeWireFrame(rest.subarray(0, total));
            frames.push(decodeEnvelope(frame.protobuf_event));
        }
        catch (e) {
            errors.push(e.message);
        }
        rest = rest.subarray(total);
    }
    return { frames, rest, errors };
}
