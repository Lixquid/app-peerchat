import type Peer from "peerjs";
import type { DataConnection } from "peerjs";

/** An incoming `crypto-offer` awaiting the user's password. */
export type PendingOffer = { salt: string; iv: string; data: string };

/**
 * Single mutable application state. Individual modules read from and write to
 * this object instead of each keeping private globals, so lifecycle rules
 * (what gets cleared on disconnect, etc.) live in one place.
 */
export type AppState = {
    peer: Peer | null;
    conn: DataConnection | null;
    encKey: CryptoKey | null;
    /** Key derived for our own crypto-offer, awaiting the peer's crypto-accept. */
    pendingKey: CryptoKey | null;
    /** Incoming crypto-offer awaiting the user to enter the password. */
    pendingOffer: PendingOffer | null;
    pendingFiles: File[];
    connectedPeerId: string | null;
    autoConnectTarget: string | null;
    /** False until the first connection is established. */
    connectDialogDismissable: boolean;
    /** Set once the user accepts the large-transfer warning; no more warnings this session. */
    largeTransferWarningAccepted: boolean;
    nextTransferId: number;
};

export const state: AppState = {
    peer: null,
    conn: null,
    encKey: null,
    pendingKey: null,
    pendingOffer: null,
    pendingFiles: [],
    connectedPeerId: null,
    autoConnectTarget: null,
    connectDialogDismissable: false,
    largeTransferWarningAccepted: false,
    nextTransferId: 1,
};

export function resetEncryptionState(): void {
    state.encKey = null;
    state.pendingKey = null;
    state.pendingOffer = null;
}

export function clearConnection(): void {
    state.conn = null;
    state.connectedPeerId = null;
    resetEncryptionState();
}
