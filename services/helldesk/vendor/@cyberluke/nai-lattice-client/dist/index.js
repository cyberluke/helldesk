// NAI-Lattice shared TypeScript NAF/1 client (`@cyberluke/nai-lattice-client`).
// Public export surface. Protocol source of truth: protos/naf/protocol.proto.
export { NafClient, NafError, } from './client.js';
export { encodeWireFrame, decodeWireFrame, parseFrames, FrameError, MAX_FRAME_BYTES, } from './frame.js';
export { FRAME_MAGIC, KindType, encodeEnvelope, decodeEnvelope, encodeHandshakeRequest, decodeHandshakeResponse, } from './wire.js';
export { crc32c } from './crc32c.js';
export { blake3, blake3Hex } from './blake3.js';
