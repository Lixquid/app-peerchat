/**
 * Password-based extra encryption: the offer/accept handshake and the
 * encrypted inner-payload send/receive path.
 */

import {
    HANDSHAKE_PLAINTEXT,
    decryptToString,
    deriveKey,
    encryptString,
    fromBase64,
    randomBytes,
    toBase64,
} from "./crypto";
import { sendToPeer } from "./connection";
import type { InnerPayload, WireMessage } from "./protocol";
import { validateInnerPayload } from "./protocol";
import { handleFilesBegin, handleFilesChunk, handleFilesEnd } from "./receive";
import { state } from "./state";
import {
    addMessage,
    addSystem,
    cancelReceiveProgress,
    elements,
    reportInvalidTransfer,
    setLockTitle,
    updateComposer,
} from "./ui";

/** Activate encryption for the current connection and update the UI. */
export function enableEncryption(key: CryptoKey): void {
    state.encKey = key;
    state.pendingKey = null;
    state.pendingOffer = null;
    setLockTitle(true);
    addSystem("Extra P2P encryption enabled 🔒");
    updateComposer();
}

/** Send an inner payload wrapped in an `enc-message`. Throws if encryption is off. */
export async function sendEncryptedInner(inner: InnerPayload): Promise<void> {
    if (!state.encKey) throw new Error("encryption is not active");
    const { iv, data } = await encryptString(state.encKey, JSON.stringify(inner));
    sendToPeer({ type: "enc-message", iv: toBase64(iv), data: toBase64(data) });
}

export async function handleCryptoOffer(
    msg: Extract<WireMessage, { type: "crypto-offer" }>,
): Promise<void> {
    if (state.encKey) {
        // Already encrypted; nothing to do.
        return;
    }
    if (state.pendingKey) {
        addSystem("Peer sent an encryption request while one is already pending.");
        return;
    }
    state.pendingOffer = { salt: msg.salt, iv: msg.iv, data: msg.data };
    elements.unlockError.classList.add("hidden");
    elements.unlockInput.value = "";
    if (!elements.unlockDialog.open) {
        elements.unlockDialog.showModal();
    }
    elements.unlockInput.focus();
}

export async function handleCryptoAccept(
    msg: Extract<WireMessage, { type: "crypto-accept" }>,
): Promise<void> {
    if (!state.pendingKey) return;
    try {
        const plaintext = await decryptToString(
            state.pendingKey,
            fromBase64(msg.iv),
            fromBase64(msg.data),
        );
        if (plaintext !== HANDSHAKE_PLAINTEXT) throw new Error("handshake mismatch");
        enableEncryption(state.pendingKey);
    } catch {
        addSystem("Peer's encryption confirmation could not be verified.");
    }
}

export async function handleEncMessage(
    msg: Extract<WireMessage, { type: "enc-message" }>,
): Promise<void> {
    if (!state.encKey) {
        addMessage("Peer", "[encrypted message — enable encryption to read]");
        return;
    }
    let inner: InnerPayload | null = null;
    try {
        const plaintext = await decryptToString(state.encKey, fromBase64(msg.iv), fromBase64(msg.data));
        inner = validateInnerPayload(JSON.parse(plaintext));
    } catch {
        addSystem("Failed to decrypt a message from your peer.");
        return;
    }
    if (!inner) {
        reportInvalidTransfer();
        return;
    }
    switch (inner.kind) {
        case "text":
            addMessage("Peer", inner.text, true);
            break;
        case "files-begin":
            handleFilesBegin(inner.transferId, inner.count, inner.totalChunks);
            break;
        case "files-chunk": {
            try {
                handleFilesChunk(
                    inner.transferId,
                    inner.fileIndex,
                    inner.name,
                    inner.mime,
                    fromBase64(inner.data),
                );
            } catch {
                cancelReceiveProgress(inner.transferId);
                reportInvalidTransfer(inner.transferId);
            }
            break;
        }
        case "files-end":
            handleFilesEnd(inner.transferId);
            break;
    }
}

// ---------------------------------------------------------------------------
// Handshake UI flows
// ---------------------------------------------------------------------------

export async function startEncryptionHandshake(): Promise<void> {
    const password = elements.passwordInput.value;
    if (!password || !state.conn?.open) return;
    try {
        const salt = randomBytes(16);
        const key = await deriveKey(password, salt);
        const { iv, data } = await encryptString(key, HANDSHAKE_PLAINTEXT);
        state.pendingKey = key;
        sendToPeer({
            type: "crypto-offer",
            salt: toBase64(salt),
            iv: toBase64(iv),
            data: toBase64(data),
        });
        addSystem("Encryption request sent — waiting for your peer to unlock…");
        updateComposer();
    } catch (err) {
        state.pendingKey = null;
        throw err;
    }
}

export async function answerEncryptionHandshake(): Promise<void> {
    const password = elements.unlockInput.value;
    const offer = state.pendingOffer;
    if (!password || !offer || !state.conn?.open) return;
    try {
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
        state.pendingOffer = null;
        elements.unlockDialog.close();
        const accept = await encryptString(key, HANDSHAKE_PLAINTEXT);
        sendToPeer({ type: "crypto-accept", iv: toBase64(accept.iv), data: toBase64(accept.data) });
        enableEncryption(key);
    } catch (err) {
        addSystem(`Encryption handshake failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
