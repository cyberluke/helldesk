// BLAKE3-256 for NAF/1 frame integrity — uses `@noble/hashes` (correct + fast).
// Frame integrity is byte-verified against the Rust host golden, so any
// resolution that changes the hash would fail interop immediately.
import { blake3 as nobleBlake3 } from '@noble/hashes/blake3';
export function blake3(data) {
    return nobleBlake3(data);
}
export function blake3Hex(data) {
    return Buffer.from(blake3(data)).toString('hex');
}
export function blake3Matches(data, expected) {
    const got = blake3(data);
    if (got.length !== expected.length)
        return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++)
        diff |= got[i] ^ expected[i];
    return diff === 0;
}
