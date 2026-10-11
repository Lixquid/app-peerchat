/**
 * Application composition root: top-level wire dispatch, sending flows,
 * DOM event wiring, and boot.
 */

import "./style.css";
import { toBase64 } from "./crypto";
import { clearConnectHash, readConnectHash } from "./ids";
import type { ReceivedFile } from "./protocol";
import { CHUNK_SIZE, chunkBytes, validateWireMessage } from "./protocol";
import { handleFilesBegin, handleFilesChunk, handleFilesEnd, resetFileReceiving } from "./receive";
import { state } from "./state";
import {
    addFilesMessage,
    addMessage,
    addSystem,
    describeError,
    elements,
    formatSize,
    hideSendProgress,
    LARGE_TRANSFER_BYTES,
    openConnectDialog,
    reportInvalidTransfer,
    showToast,
    showSendProgress,
    updateComposer,
    updateSendProgress,
    withErrorReporting,
} from "./ui";
import {
    connectToPeer,
    sendToPeer,
    setDisconnectHandler,
    setWireHandler,
    startPeer,
} from "./connection";
import {
    answerEncryptionHandshake,
    handleCryptoAccept,
    handleCryptoOffer,
    handleEncMessage,
    sendEncryptedInner,
    startEncryptionHandshake,
} from "./handshake";

// ---------------------------------------------------------------------------
// Wire dispatch
// ---------------------------------------------------------------------------

function handleWireMessage(raw: unknown): void {
    const msg = validateWireMessage(raw);
    if (!msg) {
        reportInvalidTransfer();
        return;
    }
    switch (msg.type) {
        case "text":
            addMessage("Peer", msg.text);
            break;
        case "files-begin":
            handleFilesBegin(msg.transferId, msg.count, msg.totalChunks);
            break;
        case "files-chunk": {
            const data = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
            handleFilesChunk(msg.transferId, msg.fileIndex, msg.name, msg.mime, data);
            break;
        }
        case "files-end":
            handleFilesEnd(msg.transferId);
            break;
        case "crypto-offer":
            void withErrorReporting(handleCryptoOffer(msg), "Encryption handshake failed");
            break;
        case "crypto-accept":
            void withErrorReporting(handleCryptoAccept(msg), "Encryption handshake failed");
            break;
        case "enc-message":
            void withErrorReporting(handleEncMessage(msg), "Encrypted message handling failed");
            break;
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendText(): Promise<void> {
    const text = elements.textInput.value.trim();
    if (!text || !state.conn?.open) return;
    try {
        if (state.encKey) {
            await sendEncryptedInner({ kind: "text", text });
        } else {
            sendToPeer({ type: "text", text });
        }
    } catch (err) {
        addSystem(`Failed to send: ${describeError(err)}`);
        return;
    }
    addMessage("You", text, state.encKey !== null);
    elements.textInput.value = "";
    elements.textInput.focus();
}

type SendProgressCallback = (sent: number, total: number) => void;

async function sendEncryptedFiles(
    transferId: number,
    payload: ReceivedFile[],
    totalChunks: number,
    onProgress: SendProgressCallback,
): Promise<void> {
    await sendEncryptedInner({
        kind: "files-begin",
        transferId,
        count: payload.length,
        totalChunks,
    });
    let sent = 0;
    for (let fileIndex = 0; fileIndex < payload.length; fileIndex++) {
        for (const chunk of chunkBytes(payload[fileIndex].data)) {
            await sendEncryptedInner({
                kind: "files-chunk",
                transferId,
                fileIndex,
                name: payload[fileIndex].name,
                mime: payload[fileIndex].mime,
                data: toBase64(chunk),
            });
            sent += 1;
            onProgress(sent, totalChunks);
            // Yield periodically so a large transfer doesn't freeze the UI.
            if (sent % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    await sendEncryptedInner({ kind: "files-end", transferId });
}

async function sendPlainFiles(
    transferId: number,
    payload: ReceivedFile[],
    totalChunks: number,
    onProgress: SendProgressCallback,
): Promise<void> {
    sendToPeer({ type: "files-begin", transferId, count: payload.length, totalChunks });
    let sent = 0;
    for (let fileIndex = 0; fileIndex < payload.length; fileIndex++) {
        for (const chunk of chunkBytes(payload[fileIndex].data)) {
            sendToPeer({
                type: "files-chunk",
                transferId,
                fileIndex,
                name: payload[fileIndex].name,
                mime: payload[fileIndex].mime,
                data: chunk,
            });
            sent += 1;
            onProgress(sent, totalChunks);
            // Yield periodically so the progress UI gets a chance to repaint.
            if (sent % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    sendToPeer({ type: "files-end", transferId });
}

async function sendFiles(): Promise<void> {
    if (!state.conn?.open || state.pendingFiles.length === 0) return;
    const files = state.pendingFiles;
    state.pendingFiles = [];
    cancelFiles();

    const transferId = state.nextTransferId++;
    const encrypted = state.encKey !== null;
    // A transfer spanning more than one chunk gets a progress bar in place of
    // the text input, with sending disabled until it completes. Chunk counts
    // depend only on file sizes, so show the progress bar right away instead
    // of waiting for the (potentially slow) reads into memory.
    const totalChunks = files.reduce(
        (sum, file) => sum + Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
        0,
    );
    const chunked = totalChunks > 1;
    const onProgress = chunked
        ? (sent: number, total: number) => updateSendProgress(sent, total)
        : null;
    if (chunked) showSendProgress(totalChunks, "Preparing files…");
    let payload: ReceivedFile[];
    try {
        // Read all files first, then deliver them so the peer sees one message
        // containing every file.
        payload = [];
        for (const file of files) {
            payload.push({
                name: file.name,
                mime: file.type || "application/octet-stream",
                data: new Uint8Array(await file.arrayBuffer()),
            });
        }

        // Reading is done: switch the label to the actual sending phase.
        if (chunked) updateSendProgress(0, totalChunks);
        if (encrypted) {
            await sendEncryptedFiles(
                transferId,
                payload,
                totalChunks,
                onProgress ?? (() => {}),
            );
        } else {
            await sendPlainFiles(transferId, payload, totalChunks, onProgress ?? (() => {}));
        }
    } catch (err) {
        if (chunked) hideSendProgress();
        addSystem(`Failed to send files: ${describeError(err)}`);
        return;
    }
    if (chunked) hideSendProgress();
    addFilesMessage("You", payload, encrypted);
}

// ---------------------------------------------------------------------------
// File preparation UI
// ---------------------------------------------------------------------------

function prepareFiles(incoming: File[]): void {
    if (incoming.length === 0) return;
    const totalBytes =
        incoming.reduce((sum, f) => sum + f.size, 0) +
        state.pendingFiles.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > LARGE_TRANSFER_BYTES && !state.largeTransferWarningAccepted) {
        const proceed = window.confirm(
            `Preparing ${formatSize(totalBytes)} of files will load them all into memory at once. Continue?`,
        );
        if (!proceed) return;
        // Accepted once — don't warn again for the rest of the session.
        state.largeTransferWarningAccepted = true;
    }
    state.pendingFiles.push(...incoming);
    renderFileList();
    elements.textComposer.classList.add("hidden");
    elements.fileComposer.classList.remove("hidden");
    updateComposer();
}

function renderFileList(): void {
    elements.fileList.textContent = "";
    for (const file of state.pendingFiles) {
        const li = document.createElement("li");
        li.textContent = `${file.name} (${formatSize(file.size)})`;
        const remove = document.createElement("button");
        remove.className = "icon-button remove-file";
        remove.title = "Remove";
        remove.textContent = "✕";
        remove.addEventListener("click", () => {
            state.pendingFiles = state.pendingFiles.filter((f) => f !== file);
            if (state.pendingFiles.length === 0) {
                cancelFiles();
            } else {
                renderFileList();
            }
        });
        li.appendChild(remove);
        elements.fileList.appendChild(li);
    }
}

function cancelFiles(): void {
    state.pendingFiles = [];
    elements.fileInput.value = "";
    elements.fileComposer.classList.add("hidden");
    elements.textComposer.classList.remove("hidden");
    updateComposer();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

elements.sendButton.addEventListener("click", () => void sendText());
elements.textInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        void sendText();
    }
});

elements.fileButton.addEventListener("click", () => elements.fileInput.click());
elements.fileMoreButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
    prepareFiles(Array.from(elements.fileInput.files ?? []));
    elements.fileInput.value = "";
});
elements.fileCancelButton.addEventListener("click", cancelFiles);
elements.fileSendButton.addEventListener("click", () => void sendFiles());

// Drag and drop files onto the window to prepare them for sending.
window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer?.types.includes("Files")) {
        elements.dropOverlay.classList.remove("hidden");
    }
});
window.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget) {
        elements.dropOverlay.classList.add("hidden");
    }
});
window.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropOverlay.classList.add("hidden");
    prepareFiles(Array.from(event.dataTransfer?.files ?? []));
});

elements.lockButton.addEventListener("click", () => {
    if (state.encKey) return;
    elements.passwordInput.value = "";
    elements.passwordDialog.showModal();
    elements.passwordInput.focus();
});
elements.passwordCancelButton.addEventListener("click", () => elements.passwordDialog.close());
elements.passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    startEncryptionHandshake()
        .then(() => elements.passwordDialog.close())
        .catch((err) => addSystem(`Encryption handshake failed: ${describeError(err)}`));
});

elements.unlockCancelButton.addEventListener("click", () => {
    state.pendingOffer = null;
    elements.unlockDialog.close();
});
elements.unlockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void answerEncryptionHandshake();
});

elements.connectButton.addEventListener("click", () => openConnectDialog());
elements.connectCancelButton.addEventListener("click", () => elements.connectDialog.close());
elements.connectDialog.addEventListener("cancel", (event) => {
    // Keep the dialog undismissable (e.g. Escape key) until the first
    // connection has been established.
    if (!state.connectDialogDismissable) {
        event.preventDefault();
    }
});
elements.peerIdInput.addEventListener("input", () => {
    elements.peerIdInput.value = elements.peerIdInput.value.toUpperCase().replace(/[^A-Z]/g, "");
    elements.connectSubmit.disabled = elements.peerIdInput.value.length !== 4;
});
elements.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state.peer) return;
    connectToPeer(elements.peerIdInput.value);
    // The dialog stays open (and undismissable until connected) and is closed
    // automatically once the connection opens.
});

elements.toast.addEventListener("animationend", () => {
    if (elements.toast.classList.contains("toast-out")) {
        elements.toast.classList.add("hidden");
        elements.toast.classList.remove("toast-out");
    }
});

elements.copyId.addEventListener("click", () => {
    void navigator.clipboard.writeText(elements.myId.textContent ?? "");
    showToast("Copied!");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

setWireHandler(handleWireMessage);
setDisconnectHandler(() => {
    resetFileReceiving();
    hideSendProgress();
});

state.autoConnectTarget = readConnectHash();
if (state.autoConnectTarget) {
    clearConnectHash();
}

startPeer();
updateComposer();
