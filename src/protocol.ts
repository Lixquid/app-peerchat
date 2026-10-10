/**
 * Wire protocol: message types, runtime validation, and chunked file transfer.
 *
 * Every message arriving from a peer passes through `validateWireMessage`
 * (or `validateInnerPayload` for the decrypted inner layer) before use; a
 * message with a wrong shape is reported to the user as INVALID MESSAGE.
 *
 * File payloads are transferred in chunks so large files don't have to fit in
 * a single WebRTC message.
 */

export type ReceivedFile = { name: string; mime: string; data: Uint8Array<ArrayBuffer> };

/** Chunk size for file transfers. Kept small enough to travel as a single
 * DataChannel message (peerjs performs its own SCTP-level chunking as needed).
 * Change this value to tune transfer granularity. */
export const CHUNK_SIZE = 512 * 1024;

/** Inner (decrypted) payload of an `enc-message`. */
export type InnerPayload =
    | { kind: "text"; text: string }
    | { kind: "files-begin"; transferId: number; count: number; totalChunks: number }
    | {
          kind: "files-chunk";
          transferId: number;
          fileIndex: number;
          name: string;
          mime: string;
          /** One chunk of the file, base64-encoded. */
          data: string;
      }
    | { kind: "files-end"; transferId: number };

export type WireMessage =
    | { type: "text"; text: string }
    | { type: "files-begin"; transferId: number; count: number; totalChunks: number }
    | {
          type: "files-chunk";
          transferId: number;
          fileIndex: number;
          name: string;
          mime: string;
          /** One chunk of the file, as binary. */
          data: ArrayBuffer | Uint8Array;
      }
    | { type: "files-end"; transferId: number }
    | { type: "crypto-offer"; salt: string; iv: string; data: string }
    | { type: "crypto-accept"; iv: string; data: string }
    | { type: "enc-message"; iv: string; data: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function isIndex(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBinary(value: unknown): value is ArrayBuffer | Uint8Array {
    return value instanceof ArrayBuffer || value instanceof Uint8Array;
}

function isCount(value: unknown): value is number {
    return isIndex(value) && value >= 1;
}

/** Validate an untrusted message from the wire. Returns null if malformed. */
export function validateWireMessage(raw: unknown): WireMessage | null {
    if (!isRecord(raw)) return null;
    switch (raw.type) {
        case "text":
            return isString(raw.text) ? { type: "text", text: raw.text } : null;
        case "files-begin":
            return isIndex(raw.transferId) && isCount(raw.count) && isCount(raw.totalChunks)
                ? {
                      type: "files-begin",
                      transferId: raw.transferId,
                      count: raw.count,
                      totalChunks: raw.totalChunks,
                  }
                : null;
        case "files-chunk":
            return isIndex(raw.transferId) &&
                isIndex(raw.fileIndex) &&
                isString(raw.name) &&
                isString(raw.mime) &&
                isBinary(raw.data)
                ? {
                      type: "files-chunk",
                      transferId: raw.transferId,
                      fileIndex: raw.fileIndex,
                      name: raw.name,
                      mime: raw.mime,
                      data: raw.data,
                  }
                : null;
        case "files-end":
            return isIndex(raw.transferId) ? { type: "files-end", transferId: raw.transferId } : null;
        case "crypto-offer":
            return isString(raw.salt) && isString(raw.iv) && isString(raw.data)
                ? { type: "crypto-offer", salt: raw.salt, iv: raw.iv, data: raw.data }
                : null;
        case "crypto-accept":
            return isString(raw.iv) && isString(raw.data)
                ? { type: "crypto-accept", iv: raw.iv, data: raw.data }
                : null;
        case "enc-message":
            return isString(raw.iv) && isString(raw.data)
                ? { type: "enc-message", iv: raw.iv, data: raw.data }
                : null;
        default:
            return null;
    }
}

/** Validate the untrusted inner payload of a decrypted `enc-message`. */
export function validateInnerPayload(raw: unknown): InnerPayload | null {
    if (!isRecord(raw)) return null;
    switch (raw.kind) {
        case "text":
            return isString(raw.text) ? { kind: "text", text: raw.text } : null;
        case "files-begin":
            return isIndex(raw.transferId) && isCount(raw.count) && isCount(raw.totalChunks)
                ? {
                      kind: "files-begin",
                      transferId: raw.transferId,
                      count: raw.count,
                      totalChunks: raw.totalChunks,
                  }
                : null;
        case "files-chunk":
            return isIndex(raw.transferId) &&
                isIndex(raw.fileIndex) &&
                isString(raw.name) &&
                isString(raw.mime) &&
                isString(raw.data)
                ? {
                      kind: "files-chunk",
                      transferId: raw.transferId,
                      fileIndex: raw.fileIndex,
                      name: raw.name,
                      mime: raw.mime,
                      data: raw.data,
                  }
                : null;
        case "files-end":
            return isIndex(raw.transferId) ? { kind: "files-end", transferId: raw.transferId } : null;
        default:
            return null;
    }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Split data into CHUNK_SIZE pieces; empty data yields one empty chunk so
 * the receiving side still materializes the file. */
export function chunkBytes(data: Uint8Array): Uint8Array[] {
    if (data.length === 0) return [new Uint8Array(0)];
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        chunks.push(data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length)));
    }
    return chunks;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

type PendingFile = { name: string; mime: string; parts: Uint8Array[]; size: number };
type PendingTransfer = {
    expectedCount: number;
    totalChunks: number;
    receivedChunks: number;
    files: PendingFile[];
    onProgress?: (received: number, total: number) => void;
};

/**
 * Reassembles chunked file transfers. The sender transmits files sequentially
 * (all chunks of file 0, then file 1, ...), so chunks arrive grouped by file.
 */
export class FileTransferAssembler {
    private transfers = new Map<number, PendingTransfer>();

    begin(
        transferId: number,
        count: number,
        totalChunks: number,
        onProgress?: (received: number, total: number) => void,
    ): void {
        this.transfers.set(transferId, {
            expectedCount: count,
            totalChunks,
            receivedChunks: 0,
            files: [],
            onProgress,
        });
    }

    /** Returns false if the chunk does not belong to an active transfer. */
    addChunk(
        transferId: number,
        fileIndex: number,
        name: string,
        mime: string,
        data: Uint8Array,
    ): boolean {
        const transfer = this.transfers.get(transferId);
        if (!transfer) return false;

        let file: PendingFile;
        if (fileIndex === transfer.files.length) {
            file = { name, mime, parts: [], size: 0 };
            transfer.files.push(file);
        } else if (fileIndex === transfer.files.length - 1) {
            file = transfer.files[fileIndex];
            if (file.name !== name || file.mime !== mime) return false;
        } else {
            return false;
        }

        file.parts.push(data);
        file.size += data.byteLength;
        transfer.receivedChunks += 1;
        transfer.onProgress?.(transfer.receivedChunks, transfer.totalChunks);
        return true;
    }

    /** Returns the assembled files, or null if the transfer is incomplete. */
    end(transferId: number): ReceivedFile[] | null {
        const transfer = this.transfers.get(transferId);
        if (!transfer) return null;
        this.transfers.delete(transferId);
        if (transfer.files.length !== transfer.expectedCount) return null;
        return transfer.files.map((file) => ({
            name: file.name,
            mime: file.mime,
            data: concatBytes(file.parts),
        }));
    }

    clear(): void {
        this.transfers.clear();
    }
}

/** Shared assembler for transfers received from the peer. */
export const fileTransfers = new FileTransferAssembler();
