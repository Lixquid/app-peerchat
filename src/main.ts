import Peer from "peerjs";
import type { DataConnection } from "peerjs";
import "./style.css";
import {
    HANDSHAKE_PLAINTEXT,
    decryptToString,
    deriveKey,
    encryptString,
    fromBase64,
    randomBytes,
    toBase64,
} from "./crypto";
import qrcode from "qrcode-generator";
import { createZip } from "./zip";

const ID_PREFIX = "com_lixquid_peerchat-";
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

type InnerPayload =
    | { kind: "text"; text: string }
    | { kind: "files"; files: { name: string; mime: string; data: string }[] };

type WireMessage =
    | { type: "text"; text: string }
    | { type: "files"; files: { name: string; mime: string; data: ArrayBuffer }[] }
    | { type: "crypto-offer"; salt: string; iv: string; data: string }
    | { type: "crypto-accept"; iv: string; data: string }
    | { type: "enc-message"; iv: string; data: string };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const elements = {
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
// State
// ---------------------------------------------------------------------------

let peer: Peer | null = null;
let conn: DataConnection | null = null;
let encKey: CryptoKey | null = null;
let pendingKey: CryptoKey | null = null; // key awaiting crypto-accept from the peer
let pendingOffer: { iv: string; data: string; salt: string } | null = null; // incoming crypto-offer
let pendingFiles: File[] = [];
let connectedPeerId: string | null = null;
let autoConnectTarget: string | null = null;
let connectDialogDismissable = false; // false until the first connection is established

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function generateId(): string {
    const bytes = randomBytes(4);
    // Rejection sampling to avoid modulo bias.
    while (bytes.some((b) => b >= 256 - (256 % ID_ALPHABET.length))) {
        crypto.getRandomValues(bytes);
    }
    return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

function readConnectHash(): string | null {
    const match = /^#connectTo=([A-Za-z]{4})$/.exec(window.location.hash);
    return match ? match[1].toUpperCase() : null;
}

function clearConnectHash(): void {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url);
}

function shortPeerId(fullId: string): string {
    return fullId.startsWith(ID_PREFIX) ? fullId.slice(ID_PREFIX.length) : fullId;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// QR code / welcome dialog
// ---------------------------------------------------------------------------

function buildConnectUrl(id: string): string {
    return `${window.location.origin}${window.location.pathname}#connectTo=${id}`;
}

function updateQrCode(id: string): void {
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

function openConnectDialog(): void {
    showConnectError("");
    elements.peerIdInput.value = "";
    elements.connectSubmit.disabled = true;
    elements.connectCancelButton.classList.toggle("hidden", !connectDialogDismissable);
    elements.connectDialog.showModal();
    elements.peerIdInput.focus();
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

// Regex matching http(s) URLs and bare www. domains, excluding trailing punctuation.
const URL_PATTERN =
    /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
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
        const start = match.index + (match[0].length - url.length - trailing.length);

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

function addSystem(text: string): void {
    const div = document.createElement("div");
    div.className = "message system";
    appendLinkified(div, text);
    elements.messages.appendChild(div);
    scrollToBottom();
}

function addMessage(sender: string, text: string, encrypted = false): void {
    const div = document.createElement("div");
    div.className = sender === "You" ? "message you" : "message";
    const textSpan = document.createElement("span");
    textSpan.className = "content";
    appendLinkified(textSpan, text);
    div.appendChild(textSpan);
    elements.messages.appendChild(div);
    scrollToBottom();
}

function addFilesMessage(
    sender: string,
    files: { name: string; mime: string; data: Uint8Array<ArrayBuffer> }[],
    encrypted = false,
): void {
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
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([file.data], { type: file.mime }));
        link.download = file.name;
        link.textContent = "Save";
        li.append(name, fileSize, link);
        list.appendChild(li);
    }

    const zipButton = document.createElement("button");
    zipButton.className = "zip-button";
    zipButton.textContent = "⬇ Download all (.zip)";
    zipButton.addEventListener("click", () => {
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
    elements.messages.appendChild(div);
    scrollToBottom();
}

function scrollToBottom(): void {
    elements.messages.scrollTop = elements.messages.scrollHeight;
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function setEncrypted(active: boolean): void {
    encKey = active ? encKey : null;
    elements.lockButton.disabled = active;
    elements.lockButton.title = active ? "Extra P2P encryption is active" : "Enable extra P2P encryption";
}

function updateConnectButton(): void {
    const button = elements.connectButton;
    button.classList.remove("state-disconnected", "state-connected", "state-encrypted");
    if (connectedPeerId && encKey) {
        button.textContent = `Encrypted to ${shortPeerId(connectedPeerId)}`;
        button.classList.add("state-encrypted");
    } else if (connectedPeerId) {
        button.textContent = `Connected to ${shortPeerId(connectedPeerId)}`;
        button.classList.add("state-connected");
    } else {
        button.textContent = "Connect to...";
        button.classList.add("state-disconnected");
    }
}

function updateComposer(): void {
    const connected = conn !== null && conn.open;
    elements.textInput.disabled = !connected;
    elements.sendButton.disabled = !connected;
    elements.fileSendButton.disabled = !connected;
    elements.lockButton.disabled = !connected || encKey !== null;
    updateConnectButton();
}

function resetEncryptionState(): void {
    pendingKey = null;
    pendingOffer = null;
    setEncrypted(false);
}

function setupConnection(c: DataConnection): void {
    if (conn) {
        conn.close();
    }
    conn = c;
    connectedPeerId = null;
    resetEncryptionState();
    updateComposer();

    c.on("open", () => {
        connectedPeerId = c.peer;
        addSystem(`Connected to ${c.peer}`);
        updateComposer();
        connectDialogDismissable = true;
        if (elements.connectDialog.open) {
            elements.connectDialog.close();
        }
    });
    c.on("data", (data) => handleData(data));
    c.on("close", () => {
        if (conn !== c) return;
        conn = null;
        connectedPeerId = null;
        resetEncryptionState();
        addSystem("Peer disconnected.");
        updateComposer();
    });
    c.on("error", (err) => {
        addSystem(`Connection error: ${err.message ?? err}`);
    });
}

function startPeer(): void {
    const id = generateId();
    peer = new Peer(ID_PREFIX + id);
    elements.myId.textContent = "····";
    elements.connectMyId.textContent = "····";

    peer.on("open", () => {
        elements.myId.textContent = id;
        elements.connectMyId.textContent = id;
        updateQrCode(id);
        addSystem(`Your ID is ${id}. Share it with a peer, or enter theirs to connect.`);
        updateComposer();

        // Show the connect dialog as part of the load workflow. It stays
        // undismissable until a connection has been established.
        openConnectDialog();

        if (autoConnectTarget && !conn) {
            connectToPeer(autoConnectTarget);
        }
    });

    peer.on("connection", (incoming) => {
        if (conn) {
            incoming.close();
            return;
        }
        setupConnection(incoming);
    });

    peer.on("error", (err) => {
        switch (err.type) {
            case "unavailable-id":
                peer?.destroy();
                peer = null;
                startPeer();
                break;
            case "peer-unavailable":
                showConnectError("Peer not found. Check the ID and try again.");
                addSystem("Could not connect: peer unavailable.");
                break;
            case "network":
            case "server-error":
            case "socket-error":
            case "socket-closed":
                addSystem(`Network error: ${err.type}. Reconnecting…`);
                break;
            default:
                addSystem(`Error: ${err.type ?? "unknown"}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

function sendToPeer(message: WireMessage): void {
    conn?.send(message);
}

async function sendEncryptedInner(inner: InnerPayload): Promise<void> {
    if (!encKey) return;
    const { iv, data } = await encryptString(encKey, JSON.stringify(inner));
    sendToPeer({ type: "enc-message", iv: toBase64(iv), data: toBase64(data) });
}

function handleData(raw: unknown): void {
    const msg = raw as WireMessage;
    switch (msg?.type) {
        case "text":
            addMessage("Peer", msg.text);
            break;
        case "files":
            addFilesMessage(
                "Peer",
                msg.files.map((f) => ({ name: f.name, mime: f.mime, data: new Uint8Array(f.data) })),
            );
            break;
        case "crypto-offer":
            void handleCryptoOffer(msg);
            break;
        case "crypto-accept":
            void handleCryptoAccept(msg);
            break;
        case "enc-message":
            void handleEncMessage(msg);
            break;
        default:
            addSystem("Received an unknown message type.");
    }
}

// ---------------------------------------------------------------------------
// Encryption handshake
// ---------------------------------------------------------------------------

async function handleCryptoOffer(msg: Extract<WireMessage, { type: "crypto-offer" }>): Promise<void> {
    if (encKey) {
        // Already encrypted; nothing to do.
        return;
    }
    if (pendingKey) {
        addSystem("Peer sent an encryption request while one is already pending.");
        return;
    }
    pendingOffer = { salt: msg.salt, iv: msg.iv, data: msg.data };
    elements.unlockError.classList.add("hidden");
    elements.unlockInput.value = "";
    elements.unlockDialog.showModal();
    elements.unlockInput.focus();
}

async function handleCryptoAccept(msg: Extract<WireMessage, { type: "crypto-accept" }>): Promise<void> {
    if (!pendingKey) return;
    try {
        const plaintext = await decryptToString(pendingKey, fromBase64(msg.iv), fromBase64(msg.data));
        if (plaintext !== HANDSHAKE_PLAINTEXT) throw new Error("handshake mismatch");
        encKey = pendingKey;
        pendingKey = null;
        setEncrypted(true);
        addSystem("Extra P2P encryption enabled 🔒");
        updateComposer();
    } catch {
        addSystem("Peer's encryption confirmation could not be verified.");
    }
}

async function handleEncMessage(msg: Extract<WireMessage, { type: "enc-message" }>): Promise<void> {
    if (!encKey) {
        addMessage("Peer", "[encrypted message — enable encryption to read]");
        return;
    }
    let inner: InnerPayload;
    try {
        const plaintext = await decryptToString(encKey, fromBase64(msg.iv), fromBase64(msg.data));
        inner = JSON.parse(plaintext) as InnerPayload;
    } catch {
        addSystem("Failed to decrypt a message from your peer.");
        return;
    }
    if (inner.kind === "text") {
        addMessage("Peer", inner.text, true);
    } else if (inner.kind === "files") {
        addFilesMessage(
            "Peer",
            inner.files.map((f) => ({ name: f.name, mime: f.mime, data: fromBase64(f.data) })),
            true,
        );
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendText(): Promise<void> {
    const text = elements.textInput.value.trim();
    if (!text || !conn?.open) return;
    if (encKey) {
        await sendEncryptedInner({ kind: "text", text });
    } else {
        sendToPeer({ type: "text", text });
    }
    addMessage("You", text, encKey !== null);
    elements.textInput.value = "";
    elements.textInput.focus();
}

function prepareFiles(files: File[]): void {
    if (files.length === 0) return;
    pendingFiles.push(...files);
    renderFileList();
    elements.textComposer.classList.add("hidden");
    elements.fileComposer.classList.remove("hidden");
    updateComposer();
}

function renderFileList(): void {
    elements.fileList.textContent = "";
    for (const file of pendingFiles) {
        const li = document.createElement("li");
        li.textContent = `${file.name} (${formatSize(file.size)})`;
        const remove = document.createElement("button");
        remove.className = "icon-button remove-file";
        remove.title = "Remove";
        remove.textContent = "✕";
        remove.addEventListener("click", () => {
            pendingFiles = pendingFiles.filter((f) => f !== file);
            if (pendingFiles.length === 0) {
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
    pendingFiles = [];
    elements.fileInput.value = "";
    elements.fileComposer.classList.add("hidden");
    elements.textComposer.classList.remove("hidden");
    updateComposer();
}

async function sendFiles(): Promise<void> {
    if (!conn?.open || pendingFiles.length === 0) return;
    const files = pendingFiles;
    pendingFiles = [];
    cancelFiles();

    // Read all files first, then deliver them as a single message so the peer
    // sees one message containing every file.
    const payload: { name: string; mime: string; data: Uint8Array<ArrayBuffer> }[] = [];
    for (const file of files) {
        payload.push({
            name: file.name,
            mime: file.type || "application/octet-stream",
            data: new Uint8Array(await file.arrayBuffer()),
        });
    }

    if (encKey) {
        await sendEncryptedInner({
            kind: "files",
            files: payload.map((f) => ({ name: f.name, mime: f.mime, data: toBase64(f.data) })),
        });
    } else {
        sendToPeer({
            type: "files",
            files: payload.map((f) => ({
                name: f.name,
                mime: f.mime,
                data: f.data.slice().buffer as ArrayBuffer,
            })),
        });
    }
    addFilesMessage("You", payload, encKey !== null);
}

// ---------------------------------------------------------------------------
// Encryption UI
// ---------------------------------------------------------------------------

async function startEncryptionHandshake(): Promise<void> {
    const password = elements.passwordInput.value;
    if (!password || !conn?.open) return;
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    const { iv, data } = await encryptString(key, HANDSHAKE_PLAINTEXT);
    pendingKey = key;
    sendToPeer({ type: "crypto-offer", salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) });
    addSystem("Encryption request sent — waiting for your peer to unlock…");
    updateComposer();
}

async function answerEncryptionHandshake(): Promise<void> {
    const password = elements.unlockInput.value;
    const offer = pendingOffer;
    if (!password || !offer || !conn?.open) return;
    const key = await deriveKey(password, fromBase64(offer.salt));
    // The peer is known to have the right password when the special handshake
    // message decrypts successfully.
    try {
        const plaintext = await decryptToString(key, fromBase64(offer.iv), fromBase64(offer.data));
        if (plaintext !== HANDSHAKE_PLAINTEXT) throw new Error("handshake mismatch");
    } catch {
        elements.unlockError.classList.remove("hidden");
        return;
    }
    encKey = key;
    pendingOffer = null;
    elements.unlockDialog.close();
    const accept = await encryptString(key, HANDSHAKE_PLAINTEXT);
    sendToPeer({ type: "crypto-accept", iv: toBase64(accept.iv), data: toBase64(accept.data) });
    setEncrypted(true);
    addSystem("Extra P2P encryption enabled 🔒");
    updateComposer();
}

function showConnectError(text: string): void {
    elements.connectError.textContent = text;
    elements.connectError.classList.remove("hidden");
}

function connectToPeer(shortId: string): void {
    if (!peer) return;
    addSystem(`Connecting to ${shortId}…`);
    setupConnection(peer.connect(ID_PREFIX + shortId, { reliable: true }));
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
    if (encKey) return;
    elements.passwordInput.value = "";
    elements.passwordDialog.showModal();
    elements.passwordInput.focus();
});
elements.passwordCancelButton.addEventListener("click", () => elements.passwordDialog.close());
elements.passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void startEncryptionHandshake().then(() => elements.passwordDialog.close());
});

elements.unlockCancelButton.addEventListener("click", () => {
    pendingOffer = null;
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
    if (!connectDialogDismissable) {
        event.preventDefault();
    }
});
elements.peerIdInput.addEventListener("input", () => {
    elements.peerIdInput.value = elements.peerIdInput.value.toUpperCase().replace(/[^A-Z]/g, "");
    elements.connectSubmit.disabled = elements.peerIdInput.value.length !== 4;
});
elements.connectForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!peer) return;
    showConnectError("");
    connectToPeer(elements.peerIdInput.value);
    // The dialog stays open (and undismissable until connected) and is closed
    // automatically once the connection opens.
});

let toastTimer: number | undefined;
const showToast = (message: string) => {
    elements.toast.textContent = message;
    elements.toast.classList.remove("hidden", "toast-out");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        elements.toast.classList.add("toast-out");
    }, 3000);
};

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

autoConnectTarget = readConnectHash();
if (autoConnectTarget) {
    clearConnectHash();
}

startPeer();
updateComposer();
