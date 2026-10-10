type Bytes = Uint8Array<ArrayBuffer>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Known plaintext used to verify both sides derived the same key. */
export const HANDSHAKE_PLAINTEXT = "peerchat-encrypted-mode-handshake-v1";

export const PBKDF2_ITERATIONS = 150_000;

export async function deriveKey(password: string, salt: Bytes): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as BufferSource,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

export async function encryptData(
    key: CryptoKey,
    plaintext: Bytes,
): Promise<{ iv: Bytes; data: Bytes }> {
    const iv: Bytes = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)) as Bytes;
    return { iv, data };
}

export async function decryptData(
    key: CryptoKey,
    iv: Bytes,
    data: Bytes,
): Promise<Bytes> {
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return new Uint8Array(plaintext) as Bytes;
}

export async function encryptString(key: CryptoKey, text: string): Promise<{ iv: Bytes; data: Bytes }> {
    return encryptData(key, textEncoder.encode(text));
}

export async function decryptToString(key: CryptoKey, iv: Bytes, data: Bytes): Promise<string> {
    return textDecoder.decode(await decryptData(key, iv, data));
}

export function randomBytes(length: number): Bytes {
    return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    for (const byte of view) binary += String.fromCharCode(byte);
    return btoa(binary);
}

export function fromBase64(text: string): Bytes {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
