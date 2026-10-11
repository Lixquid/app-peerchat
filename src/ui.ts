/**
 * DOM access and message rendering: element lookups, linkified text and file
 * messages, the toast, and the small state-dependent UI updaters.
 */

import qrcode from "qrcode-generator";
import { buildConnectUrl, shortPeerId } from "./ids";
import type { ReceivedFile } from "./protocol";
import { state } from "./state";
import { createZip } from "./zip";

// Threshold above which the user is warned about loading data into memory.
export const LARGE_TRANSFER_BYTES = 500 * 1024 * 1024;

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element #${id}`);
    return el as T;
};

export const elements = {
    myId: $<HTMLElement>("my-id"),
    connectMyId: $<HTMLElement>("connect-my-id"),
    qrCanvas: $<HTMLCanvasElement>("qr-canvas"),
    copyId: $<HTMLButtonElement>("copy-id"),
    toast: $<HTMLElement>("toast"),
    connectButton: $<HTMLButtonElement>("connect-button"),
    messages: $<HTMLElement>("messages"),
    dropOverlay: $<HTMLElement>("drop-overlay"),
    textComposer: $<HTMLElement>("text-composer"),
    textInput: $<HTMLInputElement>("text-input"),
    sendButton: $<HTMLButtonElement>("send-button"),
    fileButton: $<HTMLButtonElement>("file-button"),
    lockButton: $<HTMLButtonElement>("lock-button"),
    fileComposer: $<HTMLElement>("file-composer"),
    sendProgressComposer: $<HTMLElement>("send-progress"),
    sendProgressFill: $<HTMLElement>("send-progress-fill"),
    sendProgressLabel: $<HTMLElement>("send-progress-label"),
    fileList: $<HTMLUListElement>("file-list"),
    fileMoreButton: $<HTMLButtonElement>("file-more-button"),
    fileCancelButton: $<HTMLButtonElement>("file-cancel"),
    fileSendButton: $<HTMLButtonElement>("file-send"),
    fileInput: $<HTMLInputElement>("file-input"),
    connectDialog: $<HTMLDialogElement>("connect-dialog"),
    connectForm: $<HTMLFormElement>("connect-form"),
    peerIdInput: $<HTMLInputElement>("peer-id-input"),
    connectSubmit: $<HTMLButtonElement>("connect-submit"),
    connectError: $<HTMLElement>("connect-error"),
    connectCancelButton: $<HTMLButtonElement>("connect-cancel"),
    passwordDialog: $<HTMLDialogElement>("password-dialog"),
    passwordForm: $<HTMLFormElement>("password-form"),
    passwordInput: $<HTMLInputElement>("password-input"),
    passwordCancelButton: $<HTMLButtonElement>("password-cancel"),
    unlockDialog: $<HTMLDialogElement>("unlock-dialog"),
    unlockForm: $<HTMLFormElement>("unlock-form"),
    unlockInput: $<HTMLInputElement>("unlock-input"),
    unlockError: $<HTMLElement>("unlock-error"),
    unlockCancelButton: $<HTMLButtonElement>("unlock-cancel"),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
    if (bytes < KB) return `${bytes} B`;
    if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
    if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
    return `${(bytes / GB).toFixed(1)} GB`;
}

export function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Run a promise and report any rejection as a system message. */
export function withErrorReporting(promise: Promise<void>, label: string): Promise<void> {
    return promise.catch((err) => addSystem(`${label}: ${describeError(err)}`));
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;

export function showToast(message: string): void {
    elements.toast.textContent = message;
    elements.toast.classList.remove("hidden", "toast-out");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        elements.toast.classList.add("toast-out");
    }, 3000);
}

// ---------------------------------------------------------------------------
// Linkification and message rendering
// ---------------------------------------------------------------------------

// Regex matching http(s) URLs and bare www. domains, excluding trailing punctuation.
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** Split message text into text and link nodes, auto-linking detected URLs. */
function linkify(text: string): Node[] {
    const nodes: Node[] = [];
    let lastIndex = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        let url = match[0];
        // Trim trailing punctuation so sentences don't break the link.
        const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? "";
        if (trailing) url = url.slice(0, -trailing.length);
        const start = match.index ?? 0;

        if (start > lastIndex) {
            nodes.push(document.createTextNode(text.slice(lastIndex, start)));
        }
        const anchor = document.createElement("a");
        anchor.href = url.startsWith("www.") ? `https://${url}` : url;
        anchor.textContent = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        nodes.push(anchor);
        lastIndex = start + url.length;
    }
    if (lastIndex < text.length) {
        nodes.push(document.createTextNode(text.slice(lastIndex)));
    }
    return nodes;
}

function appendLinkified(parent: Node, text: string): void {
    for (const node of linkify(text)) parent.appendChild(node);
}

export function addSystem(text: string): void {
    const div = document.createElement("div");
    div.className = "message system";
    appendLinkified(div, text);
    elements.messages.appendChild(div);
    scrollToBottom();
}

export function addMessage(sender: string, text: string, encrypted = false): void {
    const div = document.createElement("div");
    div.className = sender === "You" ? "message you" : "message";
    if (encrypted) {
        const lock = document.createElement("span");
        lock.className = "lock";
        lock.title = "Encrypted message";
        lock.textContent = "🔒";
        div.appendChild(lock);
    }
    const textSpan = document.createElement("span");
    textSpan.className = "content";
    appendLinkified(textSpan, text);
    div.appendChild(textSpan);
    elements.messages.appendChild(div);
    scrollToBottom();
}

export function addFilesMessage(sender: string, files: ReceivedFile[], encrypted = false): void {
    elements.messages.appendChild(buildFilesMessage(sender, files, encrypted));
    scrollToBottom();
}

/** Build the regular file download message (file list, save buttons, zip). */
export function buildFilesMessage(
    sender: string,
    files: ReceivedFile[],
    encrypted = false,
): HTMLElement {
    const div = document.createElement("div");
    div.className = sender === "You" ? "message you" : "message";

    const content = document.createElement("span");
    content.className = "content files";

    const totalSize = files.reduce((sum, f) => sum + f.data.byteLength, 0);
    const header = document.createElement("div");
    header.className = "files-header";
    const icon = document.createElement("span");
    icon.textContent = encrypted ? "🔒📁 " : "📁 ";
    const label = document.createElement("span");
    label.className = "files-count";
    label.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    const size = document.createElement("span");
    size.className = "file-size muted";
    size.textContent = ` (${formatSize(totalSize)})`;
    header.append(icon, label, size);

    const list = document.createElement("ul");
    list.className = "file-entries";
    for (const file of files) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = file.name;
        const fileSize = document.createElement("span");
        fileSize.className = "file-size muted";
        fileSize.textContent = ` (${formatSize(file.data.byteLength)})`;
        // Create the blob URL on demand so completed transfers don't pin their
        // data in memory via long-lived object URLs.
        const save = document.createElement("button");
        save.type = "button";
        save.className = "save-button";
        save.textContent = "Save";
        save.addEventListener("click", () => {
            const url = URL.createObjectURL(new Blob([file.data], { type: file.mime }));
            const a = document.createElement("a");
            a.href = url;
            a.download = file.name;
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        });
        li.append(name, fileSize, save);
        list.appendChild(li);
    }

    const zipButton = document.createElement("button");
    zipButton.className = "zip-button";
    zipButton.textContent = "⬇ Download all (.zip)";
    zipButton.addEventListener("click", () => {
        if (totalSize > LARGE_TRANSFER_BYTES && !window.confirm(
            `Downloading all files (${formatSize(totalSize)}) will build them into a single archive in memory. Continue?`,
        )) {
            return;
        }
        const zip = createZip(files.map((f) => ({ name: f.name, data: f.data })));
        const url = URL.createObjectURL(zip);
        const a = document.createElement("a");
        a.href = url;
        a.download = "files.zip";
        a.click();
        URL.revokeObjectURL(url);
    });

    content.append(header, list, zipButton);
    div.appendChild(content);
    return div;
}

export function scrollToBottom(): void {
    elements.messages.scrollTop = elements.messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// Send progress (replaces the text input while a chunked send is in flight)
// ---------------------------------------------------------------------------

export function showSendProgress(totalChunks: number, label = "Sending files…"): void {
    elements.textComposer.classList.add("hidden");
    elements.fileComposer.classList.add("hidden");
    elements.sendProgressComposer.classList.remove("hidden");
    // Sending is in flight: no new messages until it completes.
    elements.sendButton.disabled = true;
    elements.fileSendButton.disabled = true;
    updateSendProgress(0, totalChunks);
    // Set after updateSendProgress, which resets the label.
    elements.sendProgressLabel.textContent = label;
}

export function updateSendProgress(sent: number, total: number): void {
    elements.sendProgressLabel.textContent = `Sending files… ${sent} / ${total}`;
    elements.sendProgressFill.style.width = `${total === 0 ? 100 : (sent / total) * 100}%`;
}

export function hideSendProgress(): void {
    elements.sendProgressComposer.classList.add("hidden");
    elements.textComposer.classList.remove("hidden");
    updateComposer();
}

// ---------------------------------------------------------------------------
// Receive progress ("Receiving chunks X / Y" message, replaced on completion)
// ---------------------------------------------------------------------------

type ReceiveProgress = { root: HTMLElement; count: HTMLElement; fill: HTMLElement };

const receiveProgress = new Map<number, ReceiveProgress>();

export function addReceiveProgress(transferId: number, totalChunks: number): void {
    cancelReceiveProgress(transferId);

    const div = document.createElement("div");
    div.className = "message";

    const content = document.createElement("span");
    content.className = "content files";

    const header = document.createElement("div");
    header.className = "files-header";
    const icon = document.createElement("span");
    icon.textContent = "⏳ ";
    const label = document.createElement("span");
    label.className = "files-count";
    label.textContent = "Receiving chunks";
    const count = document.createElement("span");
    count.className = "file-size muted";
    count.textContent = `0 / ${totalChunks}`;
    header.append(icon, label, count);

    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill";
    track.appendChild(fill);

    content.append(header, track);
    div.appendChild(content);
    elements.messages.appendChild(div);
    scrollToBottom();
    receiveProgress.set(transferId, { root: div, count, fill });
}

export function updateReceiveProgress(transferId: number, received: number, total: number): void {
    const progress = receiveProgress.get(transferId);
    if (!progress) return;
    progress.count.textContent = `${received} / ${total}`;
    progress.fill.style.width = `${total === 0 ? 100 : (received / total) * 100}%`;
}

/** Replace the progress message in place with the regular download UI. */
export function completeReceiveProgress(
    transferId: number,
    files: ReceivedFile[],
    encrypted = false,
): void {
    const progress = receiveProgress.get(transferId);
    receiveProgress.delete(transferId);
    const message = buildFilesMessage("Peer", files, encrypted);
    if (progress) {
        progress.root.replaceWith(message);
    } else {
        elements.messages.appendChild(message);
    }
    scrollToBottom();
}

export function cancelReceiveProgress(transferId: number): void {
    const progress = receiveProgress.get(transferId);
    if (!progress) return;
    receiveProgress.delete(transferId);
    progress.root.remove();
}

export function cancelAllReceiveProgress(): void {
    for (const transferId of [...receiveProgress.keys()]) {
        cancelReceiveProgress(transferId);
    }
}

// ---------------------------------------------------------------------------
// State-dependent UI updates
// ---------------------------------------------------------------------------

export function setLockTitle(encrypted: boolean): void {
    elements.lockButton.title = encrypted
        ? "Extra P2P encryption is active"
        : "Enable extra P2P encryption";
}

export function updateConnectButton(): void {
    const button = elements.connectButton;
    button.classList.remove("state-disconnected", "state-connected", "state-encrypted");
    if (state.connectedPeerId && state.encKey) {
        button.textContent = `Encrypted to ${shortPeerId(state.connectedPeerId)}`;
        button.classList.add("state-encrypted");
    } else if (state.connectedPeerId) {
        button.textContent = `Connected to ${shortPeerId(state.connectedPeerId)}`;
        button.classList.add("state-connected");
    } else {
        button.textContent = "Connect to...";
        button.classList.add("state-disconnected");
    }
}

export function updateComposer(): void {
    const connected = state.conn !== null && state.conn.open;
    elements.textInput.disabled = !connected;
    elements.sendButton.disabled = !connected;
    elements.fileSendButton.disabled = !connected;
    elements.lockButton.disabled = !connected || state.encKey !== null;
    updateConnectButton();
}

// ---------------------------------------------------------------------------
// Connect dialog
// ---------------------------------------------------------------------------

export function showConnectError(text: string): void {
    elements.connectError.textContent = text;
    elements.connectError.classList.remove("hidden");
}

export function openConnectDialog(): void {
    showConnectError("");
    elements.peerIdInput.value = "";
    elements.connectSubmit.disabled = true;
    elements.connectCancelButton.classList.toggle("hidden", !state.connectDialogDismissable);
    elements.connectDialog.showModal();
    elements.peerIdInput.focus();
}

export function closeConnectDialog(): void {
    if (elements.connectDialog.open) elements.connectDialog.close();
}

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

export function updateQrCode(id: string): void {
    const qr = qrcode(0, "M");
    qr.addData(buildConnectUrl(id));
    qr.make();

    const canvas = elements.qrCanvas;
    const size = canvas.width;
    const count = qr.getModuleCount();
    const cell = Math.floor(size / (count + 4));
    const offset = Math.floor((size - cell * count) / 2);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) {
                ctx.fillRect(offset + col * cell, offset + row * cell, cell, cell);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Invalid transfer reporting (once per transfer ID)
// ---------------------------------------------------------------------------

const invalidTransferReported = new Set<number>();

/** Report an INVALID MESSAGE, at most once per transfer ID to avoid spamming
 * the chat for every chunk of a broken transfer. */
export function reportInvalidTransfer(transferId?: number): void {
    if (transferId === undefined) {
        addSystem("INVALID MESSAGE");
        return;
    }
    if (invalidTransferReported.has(transferId)) return;
    invalidTransferReported.add(transferId);
    addSystem("INVALID MESSAGE");
}

export function clearInvalidTransferReport(transferId: number): void {
    invalidTransferReported.delete(transferId);
}
