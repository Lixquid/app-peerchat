import { randomBytes } from "./crypto";

export const ID_PREFIX = "com_lixquid_peerchat-";
export const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_LENGTH = 4;
// Values at or above this threshold are rejected during sampling to keep the
// distribution uniform across ID_ALPHABET (rejection sampling, no modulo bias).
const REJECT_ABOVE = 256 - (256 % ID_ALPHABET.length);

export function generateId(): string {
    const bytes = randomBytes(ID_LENGTH);
    while (bytes.some((b) => b >= REJECT_ABOVE)) {
        crypto.getRandomValues(bytes);
    }
    return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/** Short display form of a peer ID (without the signaling prefix). */
export function shortPeerId(fullId: string): string {
    return fullId.startsWith(ID_PREFIX) ? fullId.slice(ID_PREFIX.length) : fullId;
}

export function buildConnectUrl(id: string): string {
    return `${window.location.origin}${window.location.pathname}#connectTo=${id}`;
}

export function readConnectHash(): string | null {
    const match = /^#connectTo=([A-Za-z]{4})$/.exec(window.location.hash);
    return match ? match[1].toUpperCase() : null;
}

export function clearConnectHash(): void {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url);
}
