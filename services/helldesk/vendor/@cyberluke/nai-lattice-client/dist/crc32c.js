// CRC-32C (Castagnoli) — RFC 3720. Matches the Rust `crc32c` crate used by
// `lattice_protocol::frame` so TS↔Rust frame integrity is identical.
const POLY = 0x82f63b78; // reflected 0x1EDC6F41
let TABLE = null;
function table() {
    if (TABLE)
        return TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
        }
        t[n] = c >>> 0;
    }
    TABLE = t;
    return t;
}
export function crc32c(bytes) {
    const t = table();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = (crc >>> 8) ^ t[(crc ^ bytes[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
}
