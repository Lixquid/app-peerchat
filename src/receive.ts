/**
 * Shared receive path for chunked file transfers, used by both the plain wire
 * dispatch (main.ts) and the encrypted inner-payload dispatch (handshake.ts).
 * Keeps the transfer assembler and the "Receiving chunks X / Y" progress
 * message in sync, replacing the progress message with the regular file
 * download UI once the transfer completes.
 */

import type { ReceivedFile } from "./protocol";
import { fileTransfers } from "./protocol";
import { state } from "./state";
import {
    addReceiveProgress,
    cancelAllReceiveProgress,
    cancelReceiveProgress,
    clearInvalidTransferReport,
    completeReceiveProgress,
    reportInvalidTransfer,
    updateReceiveProgress,
} from "./ui";

export function handleFilesBegin(transferId: number, count: number, totalChunks: number): void {
    clearInvalidTransferReport(transferId);
    fileTransfers.begin(transferId, count, totalChunks, (received, total) => {
        updateReceiveProgress(transferId, received, total);
    });
    // Only chunked transfers get a progress message; a single-chunk transfer
    // completes immediately, so showing one would just flicker.
    if (totalChunks > 1) {
        addReceiveProgress(transferId, totalChunks);
    }
}

export function handleFilesChunk(
    transferId: number,
    fileIndex: number,
    name: string,
    mime: string,
    data: Uint8Array,
): void {
    if (!fileTransfers.addChunk(transferId, fileIndex, name, mime, data)) {
        cancelReceiveProgress(transferId);
        reportInvalidTransfer(transferId);
    }
}

export function handleFilesEnd(transferId: number): void {
    const files = fileTransfers.end(transferId);
    if (files) {
        completeReceiveProgress(transferId, files, state.encKey !== null);
    } else {
        cancelReceiveProgress(transferId);
        reportInvalidTransfer(transferId);
    }
}

/** Drop all in-flight receive state and UI (e.g. on disconnect). */
export function resetFileReceiving(): void {
    fileTransfers.clear();
    cancelAllReceiveProgress();
}