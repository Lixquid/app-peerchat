/**
 * Peer lifecycle: creating the peer, setting up data connections, and the
 * low-level send primitives.
 */

import Peer from "peerjs";
import type { DataConnection } from "peerjs";
import { ID_PREFIX, generateId, shortPeerId } from "./ids";
import { clearConnection, resetEncryptionState, state } from "./state";
import {
    addSystem,
    closeConnectDialog,
    elements,
    openConnectDialog,
    setLockTitle,
    showConnectError,
    updateComposer,
    updateQrCode,
} from "./ui";
import type { WireMessage } from "./protocol";

type WireHandler = (data: unknown) => void;

let wireHandler: WireHandler | null = null;

/** Register the callback invoked with every raw message from the peer. */
export function setWireHandler(handler: WireHandler): void {
    wireHandler = handler;
}

type DisconnectHandler = () => void;

let disconnectHandler: DisconnectHandler | null = null;

/** Register a callback invoked when the active connection goes away. */
export function setDisconnectHandler(handler: DisconnectHandler): void {
    disconnectHandler = handler;
}

function teardownConnection(): void {
    clearConnection();
    setLockTitle(false);
    updateComposer();
    disconnectHandler?.();
}

/**
 * Drop a leftover connection that never opened (e.g. a connect attempt that
 * failed), so it can't block incoming connections.
 */
function dropStaleConnection(): void {
    if (state.conn && !state.conn.open) {
        state.conn.close();
        teardownConnection();
    }
}

export function setupConnection(c: DataConnection): void {
    if (state.conn && state.conn !== c) {
        state.conn.close();
    }
    state.conn = c;
    state.connectedPeerId = null;
    resetEncryptionState();
    setLockTitle(false);
    updateComposer();

    c.on("open", () => {
        state.connectedPeerId = c.peer;
        addSystem(`Connected to ${shortPeerId(c.peer)}`);
        updateComposer();
        state.connectDialogDismissable = true;
        closeConnectDialog();
    });
    c.on("data", (data) => wireHandler?.(data));
    c.on("close", () => {
        if (state.conn !== c) return;
        teardownConnection();
        addSystem("Peer disconnected.");
    });
    c.on("error", (err) => {
        addSystem(`Connection error: ${err.message ?? err}`);
        if (state.conn === c && !c.open) {
            teardownConnection();
        }
    });
}

export function startPeer(): void {
    const id = generateId();
    const peer = new Peer(ID_PREFIX + id);
    state.peer = peer;
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

        if (state.autoConnectTarget && !state.conn) {
            connectToPeer(state.autoConnectTarget);
        }
    });

    peer.on("connection", (incoming) => {
        if (state.conn && state.conn.open) {
            incoming.close();
            addSystem("Rejected an incoming connection: already connected to a peer.");
            return;
        }
        dropStaleConnection();
        setupConnection(incoming);
    });

    peer.on("error", (err) => {
        switch (err.type) {
            case "unavailable-id":
                peer.destroy();
                state.peer = null;
                startPeer();
                break;
            case "peer-unavailable":
                dropStaleConnection();
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

export function connectToPeer(shortId: string): void {
    if (!state.peer) return;
    addSystem(`Connecting to ${shortId}…`);
    setupConnection(state.peer.connect(ID_PREFIX + shortId, { reliable: true }));
}

export function sendToPeer(message: WireMessage): void {
    state.conn?.send(message);
}
