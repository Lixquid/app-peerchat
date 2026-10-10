/**
 * Minimal ZIP archive builder using the "store" (no compression) method.
 * Produces a standard ZIP blob that any unzip tool can read.
 */

export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> };

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
    const time =
        (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const d =
        (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, date: d };
}

/** Build a ZIP archive from the given entries and return it as a Blob. */
export function createZip(entries: ZipEntry[]): Blob {
    const now = dosDateTime(new Date());
    const chunks: BlobPart[] = [];
    const central: Uint8Array<ArrayBuffer>[] = [];
    let offset = 0;
    const UTF8_FLAG = 0x0800; // indicate UTF-8 encoded file names
    const encoder = new TextEncoder();

    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const size = entry.data.byteLength;

        // Local file header (30 bytes + name).
        const header = new Uint8Array(30 + nameBytes.length);
        const view = new DataView(header.buffer);
        view.setUint32(0, 0x04034b50, true); // local file header signature
        view.setUint16(4, 20, true); // version needed to extract
        view.setUint16(6, UTF8_FLAG, true); // general purpose flags
        view.setUint16(8, 0, true); // compression method: store
        view.setUint16(10, now.time, true);
        view.setUint16(12, now.date, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true); // compressed size
        view.setUint32(22, size, true); // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true); // extra field length
        header.set(nameBytes, 30);

        chunks.push(header, entry.data);

        // Central directory record (46 bytes + name).
        const record = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(record.buffer);
        cv.setUint32(0, 0x02014b50, true); // central directory signature
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true); // version needed to extract
        cv.setUint16(8, UTF8_FLAG, true);
        cv.setUint16(10, 0, true); // compression method: store
        cv.setUint16(12, now.time, true);
        cv.setUint16(14, now.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, size, true);
        cv.setUint32(24, size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true); // extra field length
        cv.setUint16(32, 0, true); // comment length
        cv.setUint16(34, 0, true); // disk number start
        cv.setUint16(36, 0, true); // internal attributes
        cv.setUint32(38, 0, true); // external attributes
        cv.setUint32(42, offset, true); // relative offset of local header
        record.set(nameBytes, 46);
        central.push(record);

        offset += header.length + size;
    }

    const centralSize = central.reduce((sum, r) => sum + r.length, 0);

    // End of central directory record (22 bytes).
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // EOCD signature
    ev.setUint16(4, 0, true); // disk number
    ev.setUint16(6, 0, true); // disk with central directory
    ev.setUint16(8, entries.length, true); // entries on this disk
    ev.setUint16(10, entries.length, true); // total entries
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true); // central directory offset
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...chunks, ...central, eocd], { type: "application/zip" });
}