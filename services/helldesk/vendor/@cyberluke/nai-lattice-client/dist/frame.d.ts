import { type FrameDesc, type EnvelopeDesc } from './wire.js';
export declare const MAX_FRAME_BYTES: number;
export declare class FrameError extends Error {
    constructor(msg: string);
}
/** Encode an envelope as one NAF/1 wire frame (length-prefixed + integrity). */
export declare function encodeWireFrame(env: EnvelopeDesc): Uint8Array;
/** Decode one complete wire frame, verifying length, magic, CRC32C + BLAKE3. */
export declare function decodeWireFrame(wire: Uint8Array): FrameDesc;
/** Parse as many complete frames as possible from a byte buffer. Returns the
 * remaining buffered bytes (incomplete tail). */
export declare function parseFrames(buffer: Uint8Array): {
    frames: EnvelopeDesc[];
    rest: Uint8Array;
    errors: string[];
};
