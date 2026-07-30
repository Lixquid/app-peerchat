import type { DataConnection } from "peerjs";
import Peer from "peerjs";
import React, { useEffect, useRef, useState } from "react";

type MessageType = "text" | "file";

interface Message {
    id: string;
    type: MessageType;
    content: string;
    encryptedContent?: string;
    fileName?: string;
    fileSize?: number;
    fileType?: string;
    sender: "me" | "peer";
    timestamp: Date;
    encrypted?: boolean;
}

type ConnectionStatus =
    | "disconnected"
    | "connecting"
    | "connected"
    | "initializing";

const generateChatId = (): string => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = "";
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Encryption utilities
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

const deriveKey = async (
    password: string,
    salt: BufferSource,
): Promise<CryptoKey> => {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        "PBKDF2",
        false,
        ["deriveBits", "deriveKey"],
    );

    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: KEY_LENGTH },
        false,
        ["encrypt", "decrypt"],
    );
};

const encryptData = async (data: string, password: string): Promise<string> => {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const key = await deriveKey(password, salt);
    const dataBuffer = encoder.encode(data);
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        dataBuffer,
    );
    const combined = new Uint8Array(
        salt.length + iv.length + encrypted.byteLength,
    );
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);
    return btoa(String.fromCharCode(...combined));
};

const decryptData = async (
    encryptedData: string,
    password: string,
): Promise<string | null> => {
    try {
        const combined = new Uint8Array(
            atob(encryptedData)
                .split("")
                .map((c) => c.charCodeAt(0)),
        );
        const salt = combined.slice(0, SALT_LENGTH);
        const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
        const data = combined.slice(SALT_LENGTH + IV_LENGTH);
        const key = await deriveKey(password, salt);
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv },
            key,
            data,
        );
        return new TextDecoder().decode(decrypted);
    } catch {
        return null;
    }
};

const linkify = (text: string): React.ReactNode => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return parts.map((part, i) => {
        if (urlRegex.test(part)) {
            return (
                <a
                    key={i}
                    href={part}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="message-link"
                >
                    {part}
                </a>
            );
        }
        const lines = part.split("\n");
        return lines.map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>
                {line}
                {lineIndex < lines.length - 1 && <br />}
            </React.Fragment>
        ));
    });
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isImageFile = (type: string): boolean => type.startsWith("image/");

interface PendingFile {
    file: File;
    base64: string;
}

export function Chat() {
    const [myPeerId, setMyPeerId] = useState<string>("");
    const [peerIdToConnect, setPeerIdToConnect] = useState<string>("");
    const [connectedPeerId, setConnectedPeerId] = useState<string | null>(null);
    const [connectionStatus, setConnectionStatus] =
        useState<ConnectionStatus>("initializing");
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputMessage, setInputMessage] = useState<string>("");
    const [error, setError] = useState<string | null>(null);
    const [peerInitialized, setPeerInitialized] = useState(false);
    const [copied, setCopied] = useState(false);
    const [fileInputKey, setFileInputKey] = useState(0);
    const [pendingFile, setPendingFile] = useState<PendingFile | null>(null);
    const [encryptionPassword, setEncryptionPassword] = useState<string>("");
    const [encryptionEnabled, setEncryptionEnabled] = useState(false);
    const [showEncryptionModal, setShowEncryptionModal] = useState(false);
    const [encryptionInput, setEncryptionInput] = useState<string>("");
    const [showAboutModal, setShowAboutModal] = useState(false);
    const [showDecryptionPrompt, setShowDecryptionPrompt] = useState(false);
    const [decryptionInput, setDecryptionInput] = useState<string>("");
    const [decryptionError, setDecryptionError] = useState<string | null>(null);

    const peerRef = useRef<Peer | null>(null);
    const connRef = useRef<DataConnection | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const processFile = (file: File) => {
        if (file.size > MAX_FILE_SIZE) {
            setError(
                `File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}`,
            );
            return;
        }
        if (!connRef.current || connectionStatus !== "connected") {
            setError("Not connected to a peer");
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            const base64Data = event.target?.result as string;
            setPendingFile({ file, base64: base64Data });
        };
        reader.readAsDataURL(file);
    };

    const initializePeer = () => {
        if (peerRef.current) {
            peerRef.current.destroy();
        }
        setConnectionStatus("initializing");
        setError(null);
        setMyPeerId("");
        setPeerInitialized(false);
        setEncryptionEnabled(false);
        setEncryptionPassword("");
        setMessages([]);

        const peerId = generateChatId();
        const peer = new Peer(peerId, {
            debug: 2,
            config: {
                iceServers: [
                    { urls: "stun:stun.l.google.com:19302" },
                    { urls: "stun:stun1.l.google.com:19302" },
                    { urls: "stun:stun2.l.google.com:19302" },
                    {
                        urls: "turn:openrelay.metered.ca:80",
                        username: "openrelayproject",
                        credential: "openrelayproject",
                    },
                    {
                        urls: "turn:openrelay.metered.ca:443",
                        username: "openrelayproject",
                        credential: "openrelayproject",
                    },
                ],
            },
        });
        peerRef.current = peer;

        peer.on("open", (id) => {
            setMyPeerId(id);
            setError(null);
            setConnectionStatus("disconnected");
            setPeerInitialized(true);
        });
        peer.on("connection", (conn) => {
            setupConnection(conn);
        });
        peer.on("error", (err: Error) => {
            setError(err.message);
            setConnectionStatus("disconnected");
            setPeerInitialized(false);
        });
        peer.on("disconnected", () => {
            setConnectionStatus("disconnected");
            setConnectedPeerId(null);
            if (peerRef.current && peerRef.current.id) {
                peerRef.current.reconnect();
            }
        });
        peer.on("close", () => {
            setConnectionStatus("disconnected");
            setConnectedPeerId(null);
            setPeerInitialized(false);
        });
    };

    useEffect(() => {
        initializePeer();
        return () => {
            peerRef.current?.destroy();
        };
    }, []);

    // Decrypt messages when encryption password changes
    const decryptCache = useRef<Map<string, string>>(new Map());

    useEffect(() => {
        if (!encryptionEnabled || !encryptionPassword) return;

        messages.forEach((msg) => {
            if (!msg.encrypted || !msg.encryptedContent) return;
            if (decryptCache.current.has(msg.id)) return;

            decryptData(msg.encryptedContent, encryptionPassword).then(
                (decrypted) => {
                    decryptCache.current.set(
                        msg.id,
                        decrypted ?? "[Encrypted - wrong password]",
                    );
                    setMessages((current) =>
                        current.map((m) =>
                            m.id === msg.id
                                ? {
                                      ...m,
                                      content:
                                          decrypted ??
                                          "[Encrypted - wrong password]",
                                  }
                                : m,
                        ),
                    );
                },
            );
        });
    }, [encryptionPassword, encryptionEnabled, messages]);

    const setupConnection = (conn: DataConnection) => {
        connRef.current = conn;
        conn.on("open", () => {
            setConnectionStatus("connected");
            setConnectedPeerId(conn.peer);
            setError(null);
            // Reset encryption state for new connection
            setEncryptionEnabled(false);
            setEncryptionPassword("");
            setShowDecryptionPrompt(false);
            setDecryptionInput("");
            setDecryptionError(null);
            decryptCache.current.clear();
            setMessages([]);
        });
        conn.on("data", async (data: unknown) => {
            if (typeof data === "string") {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed && parsed.type && parsed.content) {
                        const isEncrypted = parsed.encrypted === true;
                        const newMessage: Message = {
                            id: crypto.randomUUID(),
                            type: parsed.type,
                            content: isEncrypted
                                ? "[Encrypted - enter password to decrypt]"
                                : parsed.content,
                            encryptedContent: isEncrypted ? parsed.content : undefined,
                            fileName: parsed.fileName,
                            fileSize: parsed.fileSize,
                            fileType: parsed.fileType,
                            sender: "peer",
                            timestamp: new Date(),
                            encrypted: isEncrypted,
                        };
                        setMessages((prev) => [...prev, newMessage]);

                        // If we received an encrypted message but encryption is not enabled locally,
                        // force the decryption prompt
                        if (isEncrypted && !encryptionEnabled) {
                            setShowDecryptionPrompt(true);
                            setDecryptionError(null);
                        }
                    } else {
                        const newMessage: Message = {
                            id: crypto.randomUUID(),
                            type: "text",
                            content: data,
                            sender: "peer",
                            timestamp: new Date(),
                        };
                        setMessages((prev) => [...prev, newMessage]);
                    }
                } catch {
                    const newMessage: Message = {
                        id: crypto.randomUUID(),
                        type: "text",
                        content: data,
                        sender: "peer",
                        timestamp: new Date(),
                    };
                    setMessages((prev) => [...prev, newMessage]);
                }
            }
        });
        conn.on("close", () => {
            setConnectionStatus("disconnected");
            setConnectedPeerId(null);
            connRef.current = null;
            // Reset encryption state on disconnect
            setEncryptionEnabled(false);
            setEncryptionPassword("");
            setShowDecryptionPrompt(false);
            setDecryptionInput("");
            setDecryptionError(null);
            decryptCache.current.clear();
            setMessages([]);
        });
        conn.on("error", (err: Error) => {
            setError(err.message);
            setConnectionStatus("disconnected");
        });
    };

    const connectToPeer = () => {
        if (!peerIdToConnect.trim() || !peerRef.current || !peerInitialized)
            return;
        setConnectionStatus("connecting");
        setError(null);
        // Reset encryption state when connecting to a new peer
        setEncryptionEnabled(false);
        setEncryptionPassword("");
        setShowDecryptionPrompt(false);
        setDecryptionInput("");
        setDecryptionError(null);
        decryptCache.current.clear();
        setMessages([]);
        const conn = peerRef.current.connect(peerIdToConnect.trim(), {
            reliable: true,
        });
        setupConnection(conn);
    };

    const sendMessage = async () => {
        if (!connRef.current || connectionStatus !== "connected") return;

        if (pendingFile) {
            const { file, base64 } = pendingFile;
            let content = base64;
            if (encryptionEnabled && encryptionPassword) {
                content = await encryptData(base64, encryptionPassword);
            }
            const messageData = JSON.stringify({
                type: "file",
                content,
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type,
                encrypted: encryptionEnabled,
            });
            connRef.current.send(messageData);
            const newMessage: Message = {
                id: crypto.randomUUID(),
                type: "file",
                content: base64,
                fileName: file.name,
                fileSize: file.size,
                fileType: file.type,
                sender: "me",
                timestamp: new Date(),
                encrypted: encryptionEnabled,
            };
            setMessages((prev) => [...prev, newMessage]);
            setPendingFile(null);
            setFileInputKey((k) => k + 1);
            return;
        }

        if (!inputMessage.trim()) return;
        let content = inputMessage.trim();
        if (encryptionEnabled && encryptionPassword) {
            content = await encryptData(content, encryptionPassword);
        }
        const messageData = JSON.stringify({
            type: "text",
            content,
            encrypted: encryptionEnabled,
        });
        connRef.current.send(messageData);
        const newMessage: Message = {
            id: crypto.randomUUID(),
            type: "text",
            content: inputMessage.trim(),
            sender: "me",
            timestamp: new Date(),
            encrypted: encryptionEnabled,
        };
        setMessages((prev) => [...prev, newMessage]);
        setInputMessage("");
    };

    useEffect(() => {
        const handleGlobalKeydown = (e: KeyboardEvent) => {
            if (connectionStatus !== "connected" || !connRef.current) return;
            if (e.key !== "Enter") return;
            if (!pendingFile) return;
            const target = e.target as HTMLElement;
            if (
                target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable
            ) {
                return;
            }
            e.preventDefault();
            sendMessage();
        };
        window.addEventListener("keydown", handleGlobalKeydown);
        return () => {
            window.removeEventListener("keydown", handleGlobalKeydown);
        };
    }, [connectionStatus, pendingFile, sendMessage]);

    useEffect(() => {
        const handleGlobalPaste = (e: ClipboardEvent) => {
            if (connectionStatus !== "connected" || !connRef.current) return;
            const target = e.target as HTMLElement;
            if (
                target.tagName === "INPUT" ||
                target.tagName === "TEXTAREA" ||
                target.isContentEditable
            ) {
                return;
            }
            const clipboardData = e.clipboardData;
            if (!clipboardData) return;
            const items = clipboardData.items;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind === "file" || item.type.startsWith("image/")) {
                    const file = item.getAsFile();
                    if (file) {
                        e.preventDefault();
                        processFile(file);
                        break;
                    }
                }
            }
        };
        window.addEventListener("paste", handleGlobalPaste);
        return () => {
            window.removeEventListener("paste", handleGlobalPaste);
        };
    }, [connectionStatus, processFile]);

    useEffect(() => {
        const handleDragOver = (e: DragEvent) => e.preventDefault();
        const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            if (connectionStatus !== "connected" || !connRef.current) return;
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                processFile(files[0]);
            }
        };
        window.addEventListener("dragover", handleDragOver);
        window.addEventListener("drop", handleDrop);
        return () => {
            window.removeEventListener("dragover", handleDragOver);
            window.removeEventListener("drop", handleDrop);
        };
    }, [connectionStatus, processFile]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        processFile(file);
    };

    const handlePaste = (e: React.ClipboardEvent | ClipboardEvent) => {
        if (connectionStatus !== "connected" || !connRef.current) return;
        const clipboardData = e.clipboardData || (window as any).clipboardData;
        if (!clipboardData) return;
        const items = clipboardData.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === "file" || item.type.startsWith("image/")) {
                const file = item.getAsFile();
                if (file) {
                    e.preventDefault();
                    processFile(file);
                    break;
                }
            }
        }
    };

    const removePendingFile = () => {
        setPendingFile(null);
        setFileInputKey((k) => k + 1);
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const copyMyPeerId = () => {
        navigator.clipboard.writeText(myPeerId);
    };

    const handlePeerIdClick = () => {
        navigator.clipboard.writeText(myPeerId);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const shortPeerId = (id: string) => id.slice(0, 8).toUpperCase();

    const handleEncryptionEnable = () => {
        if (!encryptionInput.trim()) {
            return;
        }
        if (encryptionInput.length < 8) {
            return;
        }
        setEncryptionPassword(encryptionInput);
        setEncryptionEnabled(true);
        setEncryptionInput("");
        setShowEncryptionModal(false);
    };

    const handleEncryptionDisable = () => {
        setEncryptionEnabled(false);
        setEncryptionPassword("");
    };

    const handleDecryptionSubmit = async () => {
        if (!decryptionInput.trim()) return;
        
        // Find an encrypted message to test the password
        const encryptedMsg = messages.find((m) => m.encrypted && m.encryptedContent);
        if (!encryptedMsg) {
            setDecryptionError("No encrypted message to verify");
            return;
        }

        const decrypted = await decryptData(encryptedMsg.encryptedContent!, decryptionInput);
        if (decrypted === null) {
            setDecryptionError("Incorrect password. Try again or disconnect.");
            return;
        }

        // Password is correct - enable encryption and decrypt all messages
        setEncryptionPassword(decryptionInput);
        setEncryptionEnabled(true);
        setShowDecryptionPrompt(false);
        setDecryptionInput("");
        setDecryptionError(null);
        decryptCache.current.clear();

        // Re-decrypt all messages with the correct password
        setMessages((current) =>
            current.map((m) => {
                if (!m.encrypted || !m.encryptedContent) return m;
                return {
                    ...m,
                    content: decrypted, // This will be updated properly by the useEffect
                };
            }),
        );
        // The useEffect will handle actual decryption
    };

    const handleDecryptionDisconnect = () => {
        connRef.current?.close();
        setShowDecryptionPrompt(false);
        setDecryptionInput("");
        setDecryptionError(null);
    };

    const handleEncryptionModalKey = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            handleEncryptionEnable();
        }
    };

    const handleDecryptionKey = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            handleDecryptionSubmit();
        }
    };

    const renderMessageContent = (msg: Message) => {
        const isEncryptedNotDecrypted = msg.encrypted && (!encryptionEnabled || !encryptionPassword);
        if (msg.type === "file" && msg.fileName && msg.fileType) {
            const isImage = isImageFile(msg.fileType);
            const fileUrl = msg.content;
            return (
                <div className={"message-file" + (isEncryptedNotDecrypted ? " encrypted" : "")}>
                    {isEncryptedNotDecrypted && (
                        <div className="message-file-encrypted-overlay" onClick={() => setShowDecryptionPrompt(true)}>
                            <span className="encrypted-overlay-icon">🔒</span>
                            <span className="encrypted-overlay-text">Encrypted file</span>
                            <span className="encrypted-overlay-action">Click to decrypt</span>
                        </div>
                    )}
                    {isImage ? (
                        <a
                            href={fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="message-file-image-link"
                        >
                            <img
                                src={fileUrl}
                                alt={msg.fileName}
                                className="message-file-image"
                            />
                        </a>
                    ) : (
                        <div className="message-file-info">
                            <span className="message-file-name">
                                {msg.fileName}
                            </span>
                            <div className="message-file-details">
                                <a
                                    href={fileUrl}
                                    download={msg.fileName}
                                    className="message-file-download"
                                >
                                    Download
                                </a>
                                <span className="message-file-size">
                                    {formatFileSize(msg.fileSize || 0)}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            );
        }
        const displayContent = isEncryptedNotDecrypted
            ? "[Encrypted - enter password to decrypt]"
            : msg.content;
        return (
            <>
                <p className="message-text">{linkify(displayContent)}</p>
                {isEncryptedNotDecrypted && (
                    <button
                        className="decrypt-message-btn"
                        onClick={() => setShowDecryptionPrompt(true)}
                        title="Enter decryption password"
                    >
                        <span>🔒</span> Enter password to decrypt
                    </button>
                )}
            </>
        );
    };

    return (
        <div className="peerchat-app">
            <header className="chat-header">
                <div className="header-left">
                    <span
                        className="app-title"
                        onClick={() => setShowAboutModal(true)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) =>
                            e.key === "Enter" && setShowAboutModal(true)
                        }
                        title="About PeerChat"
                    >
                        PeerChat
                    </span>
                    <span
                        className={`peer-id-badge ${copied ? "copied" : ""}`}
                        onClick={handlePeerIdClick}
                        title="Click to copy"
                    >
                        <code>{shortPeerId(myPeerId)}</code>
                        <span className="copy-tooltip">Copied!</span>
                    </span>
                </div>
                <div className="header-right">
                    {connectionStatus === "connected" && connectedPeerId && (
                        <span
                            className={
                                encryptionEnabled
                                    ? "connection-status encrypted"
                                    : "connection-status connected"
                            }
                        >
                            <span className="status-dot"></span>
                            <span>
                                {encryptionEnabled
                                    ? "ENCRYPTED TO"
                                    : "Connected to"}{" "}
                                {shortPeerId(connectedPeerId)}
                            </span>
                        </span>
                    )}
                    {connectionStatus === "connecting" && (
                        <span className="connection-status connecting">
                            <span className="status-dot"></span>
                            <span>Connecting</span>
                        </span>
                    )}
                    {connectionStatus === "disconnected" && peerInitialized && (
                        <span className="connection-status disconnected">
                            <span className="status-dot"></span>
                            <span>Disconnected</span>
                        </span>
                    )}
                    {connectionStatus === "initializing" && (
                        <span className="connection-status initializing">
                            <span className="status-dot"></span>
                            <span>Initializing</span>
                        </span>
                    )}
                    {connectionStatus === "connected" && (
                        <button
                            className="attach-btn"
                            onClick={() => setShowEncryptionModal(true)}
                            title={
                                encryptionEnabled
                                    ? "Disable encryption"
                                    : "Enable encryption"
                            }
                        >
                            <svg
                                width="18"
                                height="18"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                            >
                                {encryptionEnabled ? (
                                    <>
                                        <rect
                                            x="3"
                                            y="11"
                                            width="18"
                                            height="11"
                                            rx="2"
                                            ry="2"
                                        ></rect>
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                    </>
                                ) : (
                                    <>
                                        <rect
                                            x="3"
                                            y="11"
                                            width="18"
                                            height="11"
                                            rx="2"
                                            ry="2"
                                        ></rect>
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                        <line
                                            x1="1"
                                            y1="1"
                                            x2="23"
                                            y2="23"
                                        ></line>
                                    </>
                                )}
                            </svg>
                        </button>
                    )}
                </div>
            </header>

            <main className="chat-main">
                {connectionStatus === "connected" && messages.length === 0 && (
                    <div className="empty-state">
                        <span className="empty-text">
                            {encryptionEnabled
                                ? "Encryption enabled — start chatting securely"
                                : "Connected — start chatting"}
                        </span>
                    </div>
                )}

                <div className="messages-area" role="log" aria-live="polite">
                    {messages.map((msg) => {
                        const isEncryptedNotDecrypted = msg.encrypted && (!encryptionEnabled || !encryptionPassword);
                        return (
                            <div
                                key={msg.id}
                                className={`message ${msg.sender === "me" ? "sent" : "received"} ${msg.encrypted ? "encrypted" : ""} ${isEncryptedNotDecrypted ? "not-decrypted" : ""}`}
                            >
                                <div className="message-bubble">
                                    {renderMessageContent(msg)}
                                    <span className="message-time">
                                        {formatTime(msg.timestamp)}
                                        {msg.encrypted && (
                                            <span className="encrypted-badge">
                                                🔒
                                            </span>
                                        )}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                    <div ref={messagesEndRef} className="messages-end" />
                </div>

                {connectionStatus !== "connected" && peerInitialized && (
                    <div className="center-panel">
                        <div className="connect-card">
                            <p className="connect-title">
                                Enter an ID to connect to
                            </p>
                            <div className="connect-form">
                                <div className="peer-input-wrapper">
                                    <input
                                        type="text"
                                        placeholder="ABCD"
                                        value={peerIdToConnect}
                                        onChange={(e) =>
                                            setPeerIdToConnect(
                                                e.target.value.toUpperCase(),
                                            )
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter")
                                                connectToPeer();
                                        }}
                                        className="peer-input"
                                        maxLength={8}
                                        autoFocus
                                    />
                                </div>
                                <button
                                    onClick={connectToPeer}
                                    disabled={
                                        !peerIdToConnect.trim() ||
                                        !peerRef.current ||
                                        !peerInitialized ||
                                        connectionStatus === "connecting"
                                    }
                                    className="connect-btn"
                                >
                                    {connectionStatus === "connecting"
                                        ? "Connecting..."
                                        : "Connect"}
                                </button>
                            </div>
                            {error && (
                                <div className="error-message">{error}</div>
                            )}
                        </div>
                    </div>
                )}

                {connectionStatus === "initializing" && (
                    <div className="center-panel">
                        <div className="initializing-card">
                            <div className="spinner"></div>
                            <p>Connecting to signaling server...</p>
                        </div>
                    </div>
                )}
            </main>

            {connectionStatus === "connected" && (
                <footer className="chat-footer">
                    <div className="input-wrapper">
                        <input
                            type="file"
                            ref={fileInputRef}
                            key={fileInputKey}
                            onChange={handleFileSelect}
                            className="file-input"
                            accept="image/*,video/*,audio/*,application/pdf,.txt,.json"
                            style={{ display: "none" }}
                        />
                        <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            className="attach-btn"
                            title="Attach file"
                            disabled={!!pendingFile}
                        >
                            <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49"></path>
                            </svg>
                        </button>
                        {pendingFile ? (
                            <div className="pending-file">
                                <span className="pending-file-name">
                                    {pendingFile.file.name}
                                </span>
                                <span className="pending-file-size">
                                    {formatFileSize(pendingFile.file.size)}
                                </span>
                                <button
                                    type="button"
                                    onClick={removePendingFile}
                                    className="pending-file-remove"
                                    title="Remove file"
                                >
                                    <svg
                                        width="16"
                                        height="16"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <line
                                            x1="18"
                                            y1="6"
                                            x2="6"
                                            y2="18"
                                        ></line>
                                        <line
                                            x1="6"
                                            y1="6"
                                            x2="18"
                                            y2="18"
                                        ></line>
                                    </svg>
                                </button>
                            </div>
                        ) : (
                            <textarea
                                value={inputMessage}
                                onChange={(e) =>
                                    setInputMessage(e.target.value)
                                }
                                onKeyDown={handleKeyPress}
                                onPaste={handlePaste}
                                placeholder={
                                    encryptionEnabled
                                        ? "Type a secure message..."
                                        : "Type a message..."
                                }
                                rows={1}
                                className="message-input"
                            />
                        )}
                        <button
                            onClick={sendMessage}
                            disabled={!inputMessage.trim() && !pendingFile}
                            className="send-btn"
                        >
                            Send
                        </button>
                    </div>
                </footer>
            )}

            <div className="copy-hint">
                Your ID: <code>{myPeerId}</code>{" "}
                <button
                    onClick={copyMyPeerId}
                    className="copy-btn"
                    disabled={!myPeerId}
                >
                    Copy
                </button>
            </div>

            {showEncryptionModal && (
                <div
                    className="modal-overlay"
                    onClick={() => setShowEncryptionModal(false)}
                >
                    <div
                        className="modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {!encryptionEnabled ? (
                            <div>
                                <p className="connect-title">
                                    Enable Encryption
                                </p>
                                <p
                                    style={{
                                        marginBottom: "16px",
                                        color: "var(--text-secondary)",
                                        fontSize: "13px",
                                    }}
                                >
                                    Enter a password to encrypt all messages and
                                    files. Both peers must use the same
                                    password.
                                </p>
                                <div className="connect-form">
                                    <input
                                        type="password"
                                        value={encryptionInput}
                                        onChange={(e) =>
                                            setEncryptionInput(e.target.value)
                                        }
                                        onKeyDown={handleEncryptionModalKey}
                                        placeholder="Password (min 8 chars)"
                                        className="peer-input"
                                        autoFocus
                                        maxLength={64}
                                    />
                                    <button
                                        onClick={handleEncryptionEnable}
                                        className="connect-btn"
                                        disabled={
                                            !encryptionInput.trim() ||
                                            encryptionInput.length < 8
                                        }
                                    >
                                        Enable
                                    </button>
                                    <button
                                        onClick={() =>
                                            setShowEncryptionModal(false)
                                        }
                                        className="connect-btn"
                                        style={{
                                            background: "var(--bg-input)",
                                            color: "var(--text-secondary)",
                                            border: "1px solid var(--border-primary)",
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div>
                                <p className="connect-title">
                                    Disable Encryption
                                </p>
                                <p
                                    style={{
                                        marginBottom: "16px",
                                        color: "var(--text-secondary)",
                                        fontSize: "13px",
                                    }}
                                >
                                    Disable encryption? This will clear all
                                    messages and start a new unencrypted
                                    session.
                                </p>
                                <div className="connect-form">
                                    <button
                                        onClick={handleEncryptionDisable}
                                        className="connect-btn"
                                        style={{
                                            background: "var(--error-bg)",
                                            color: "var(--error)",
                                            border: "1px solid var(--error-border)",
                                        }}
                                    >
                                        Disable
                                    </button>
                                    <button
                                        onClick={() =>
                                            setShowEncryptionModal(false)
                                        }
                                        className="connect-btn"
                                        style={{
                                            background: "var(--bg-input)",
                                            color: "var(--text-secondary)",
                                            border: "1px solid var(--border-primary)",
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {showAboutModal && (
                <div
                    className="modal-overlay"
                    onClick={() => setShowAboutModal(false)}
                >
                    <div
                        className="modal-card"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 className="connect-title">PeerChat</h2>
                        <p
                            style={{
                                marginBottom: "16px",
                                color: "var(--text-secondary)",
                                fontSize: "14px",
                                lineHeight: 1.6,
                            }}
                        >
                            Peer to peer chat with WebRTC and PeerJS.
                        </p>
                        <p
                            style={{
                                marginBottom: "24px",
                                color: "var(--text-secondary)",
                                fontSize: "13px",
                            }}
                        >
                            <a
                                href="https://github.com/Lixquid/app-peerchat"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="message-link"
                            >
                                Source Code
                            </a>
                        </p>
                        <div className="connect-form">
                            <button
                                onClick={() => setShowAboutModal(false)}
                                className="connect-btn"
                                style={{
                                    background: "var(--bg-input)",
                                    color: "var(--text-secondary)",
                                    border: "1px solid var(--border-primary)",
                                    width: "100%",
                                }}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showDecryptionPrompt && (
                <div className="modal-overlay decryption-modal-overlay">
                    <div className="modal-card decryption-modal-card">
                        <div className="decryption-icon">🔒</div>
                        <h2 className="connect-title">Encrypted Message Received</h2>
                        <p
                            style={{
                                marginBottom: "16px",
                                color: "var(--text-secondary)",
                                fontSize: "13px",
                                lineHeight: 1.5,
                            }}
                        >
                            Your peer has sent an encrypted message, but you haven’t
                            entered the decryption password yet. You must enter the
                            correct password to decrypt messages, or disconnect the
                            session.
                        </p>
                        {decryptionError && (
                            <p
                                className="decryption-error"
                                style={{
                                    color: "var(--error)",
                                    marginBottom: "16px",
                                    fontSize: "13px",
                                    textAlign: "center",
                                }}
                            >
                                {decryptionError}
                            </p>
                        )}
                        <div className="connect-form">
                            <input
                                type="password"
                                value={decryptionInput}
                                onChange={(e) => setDecryptionInput(e.target.value)}
                                onKeyDown={handleDecryptionKey}
                                placeholder="Enter decryption password"
                                className="peer-input"
                                autoFocus
                                maxLength={64}
                            />
                            <button
                                onClick={handleDecryptionSubmit}
                                className="connect-btn"
                                disabled={!decryptionInput.trim()}
                            >
                                Decrypt
                            </button>
                            <button
                                onClick={handleDecryptionDisconnect}
                                className="connect-btn"
                                style={{
                                    background: "var(--error-bg)",
                                    color: "var(--error)",
                                    border: "1px solid var(--error-border)",
                                }}
                            >
                                Disconnect
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
