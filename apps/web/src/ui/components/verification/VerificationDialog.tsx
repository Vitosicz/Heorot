import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

export interface VerificationTarget {
    userId: string;
    deviceId?: string;
}

interface VerificationDialogProps {
    client: MatrixClient;
    open: boolean;
    target?: VerificationTarget | null;
    onClose: () => void;
    onCompleted?: () => void;
}

type PendingAction =
    | "accept"
    | "start_sas"
    | "start_scan"
    | "cancel"
    | "confirm_sas"
    | "mismatch_sas"
    | "confirm_reciprocate"
    | "copy_qr"
    | null;

const VERIFICATION_REQUEST_RECEIVED_EVENT = "crypto.verificationRequestReceived";
const VERIFICATION_REQUEST_CHANGE_EVENT = "change";
const VERIFIER_SHOW_SAS_EVENT = "show_sas";
const VERIFIER_SHOW_RECIPROCATE_QR_EVENT = "show_reciprocate_qr";
const VERIFIER_CANCEL_EVENT = "cancel";
const VERIFICATION_METHOD_SAS = "m.sas.v1";

const VerificationPhase = {
    Unsent: 1,
    Requested: 2,
    Ready: 3,
    Started: 4,
    Cancelled: 5,
    Done: 6,
} as const;

type VerificationPhaseValue = (typeof VerificationPhase)[keyof typeof VerificationPhase];

interface ShowSasCallbacks {
    sas: {
        decimal?: [number, number, number];
        emoji?: Array<[string, string]>;
    };
    confirm: () => Promise<void>;
    mismatch: () => void;
    cancel: () => void;
}

interface ShowQrCodeCallbacks {
    confirm: () => void;
    cancel: () => void;
}

interface Verifier {
    verify: () => Promise<void>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface VerificationRequest {
    initiatedByMe: boolean;
    phase: VerificationPhaseValue;
    verifier?: Verifier;
    cancellationCode: string | null;
    accept: () => Promise<void>;
    cancel: (params?: { reason?: string; code?: string }) => Promise<void>;
    startVerification: (method: string) => Promise<Verifier>;
    scanQRCode: (qrCodeData: Uint8ClampedArray) => Promise<Verifier>;
    generateQRCode: () => Promise<Uint8ClampedArray | undefined>;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (error && typeof error === "object") {
        const value = error as { message?: unknown; reason?: unknown };
        if (typeof value.message === "string" && value.message.length > 0) {
            return value.message;
        }
        if (typeof value.reason === "string" && value.reason.length > 0) {
            return value.reason;
        }
    }

    return String(error);
}

function phaseLabel(phase: VerificationPhaseValue): string {
    switch (phase) {
        case VerificationPhase.Unsent:
            return "Not sent";
        case VerificationPhase.Requested:
            return "Request sent";
        case VerificationPhase.Ready:
            return "Ready";
        case VerificationPhase.Started:
            return "In progress";
        case VerificationPhase.Cancelled:
            return "Cancelled";
        case VerificationPhase.Done:
            return "Verified";
        default:
            return "Pending";
    }
}

function encodeBytesToBase64(bytes: Uint8ClampedArray): string {
    const chunkSize = 0x4000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

function decodeBase64ToBytes(encoded: string): Uint8ClampedArray {
    const normalized = encoded.trim().replace(/\s+/g, "");
    const binary = atob(normalized);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
}

export function VerificationDialog({
    client,
    open,
    target,
    onClose,
    onCompleted,
}: VerificationDialogProps): React.ReactElement | null {
    const [request, setRequest] = useState<VerificationRequest | null>(null);
    const [verifier, setVerifier] = useState<Verifier | null>(null);
    const [phase, setPhase] = useState<VerificationPhaseValue | null>(null);
    const [pendingAction, setPendingAction] = useState<PendingAction>(null);
    const [loading, setLoading] = useState(false);
    const [completed, setCompleted] = useState(false);
    const [statusMessage, setStatusMessage] = useState("Preparing verification...");
    const [error, setError] = useState<string | null>(null);
    const [sas, setSas] = useState<ShowSasCallbacks | null>(null);
    const [reciprocateQr, setReciprocateQr] = useState<ShowQrCodeCallbacks | null>(null);
    const [qrPayload, setQrPayload] = useState<string | null>(null);
    const [scanQrInput, setScanQrInput] = useState("");
    const completionReportedRef = useRef(false);

    const notifyCompleted = useCallback((): void => {
        if (completionReportedRef.current) {
            return;
        }

        completionReportedRef.current = true;
        setCompleted(true);
        setError(null);
        setStatusMessage("Verification completed.");
        onCompleted?.();
    }, [onCompleted]);

    const targetLabel = useMemo(() => {
        if (!target?.deviceId) {
            return "This account";
        }

        return `${target.userId} (${target.deviceId})`;
    }, [target]);

    const resetState = useCallback((): void => {
        completionReportedRef.current = false;
        setRequest(null);
        setVerifier(null);
        setPhase(null);
        setPendingAction(null);
        setLoading(false);
        setCompleted(false);
        setStatusMessage("Preparing verification...");
        setError(null);
        setSas(null);
        setReciprocateQr(null);
        setQrPayload(null);
        setScanQrInput("");
    }, []);

    const attachVerifier = useCallback(
        (nextVerifier: Verifier): void => {
            setVerifier((currentVerifier) => {
                if (currentVerifier === nextVerifier) {
                    return currentVerifier;
                }

                return nextVerifier;
            });
        },
        [],
    );

    useEffect(() => {
        if (!open) {
            resetState();
            return;
        }

        let cancelled = false;

        const start = async (): Promise<void> => {
            setLoading(true);
            setStatusMessage("Sending verification request...");
            setError(null);
            setCompleted(false);
            setSas(null);
            setReciprocateQr(null);
            setQrPayload(null);
            setScanQrInput("");

            try {
                const crypto = client.getCrypto();
                if (!crypto) {
                    throw new Error("Encryption is not available for this session.");
                }

                const createdRequest =
                    target?.deviceId && target.userId
                        ? ((await crypto.requestDeviceVerification(target.userId, target.deviceId)) as VerificationRequest)
                        : ((await crypto.requestOwnUserVerification()) as VerificationRequest);

                if (cancelled) {
                    return;
                }

                setRequest(createdRequest);
                setPhase(createdRequest.phase);
                setStatusMessage("Waiting for the other device...");
            } catch (startError) {
                if (cancelled) {
                    return;
                }

                setError(toErrorMessage(startError));
                setStatusMessage("Unable to start verification.");
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void start();

        return () => {
            cancelled = true;
        };
    }, [client, open, resetState, target]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const onIncomingRequest = (incomingRequest: VerificationRequest): void => {
            setRequest((currentRequest) => currentRequest ?? incomingRequest);
            setStatusMessage((currentMessage) =>
                currentMessage.startsWith("Unable") ? currentMessage : "Incoming verification request received.",
            );
        };

        client.on(VERIFICATION_REQUEST_RECEIVED_EVENT as any, onIncomingRequest as any);
        return () => {
            client.removeListener(VERIFICATION_REQUEST_RECEIVED_EVENT as any, onIncomingRequest as any);
        };
    }, [client, open]);

    useEffect(() => {
        if (!request) {
            return;
        }

        let isDisposed = false;

        const refreshState = async (): Promise<void> => {
            if (isDisposed) {
                return;
            }

            setPhase(request.phase);
            setStatusMessage(`Status: ${phaseLabel(request.phase)}`);

            if (request.phase === VerificationPhase.Ready) {
                try {
                    const generatedQr = await request.generateQRCode();
                    if (!generatedQr || isDisposed) {
                        return;
                    }

                    setQrPayload(encodeBytesToBase64(generatedQr));
                } catch {
                    // QR generation is optional and best-effort.
                }
            }

            if (request.phase === VerificationPhase.Started && request.verifier) {
                attachVerifier(request.verifier);
            }

            if (request.phase === VerificationPhase.Cancelled) {
                const cancellationCode = request.cancellationCode;
                setError(cancellationCode ? `Verification cancelled (${cancellationCode}).` : "Verification cancelled.");
            }

            if (request.phase === VerificationPhase.Done) {
                notifyCompleted();
            }
        };

        const onRequestChange = (): void => {
            void refreshState();
        };

        request.on(VERIFICATION_REQUEST_CHANGE_EVENT, onRequestChange);
        void refreshState();

        return () => {
            isDisposed = true;
            request.off(VERIFICATION_REQUEST_CHANGE_EVENT, onRequestChange);
        };
    }, [attachVerifier, notifyCompleted, request]);

    useEffect(() => {
        if (!verifier) {
            return;
        }

        let isDisposed = false;

        const onShowSas = (callbacks: ShowSasCallbacks): void => {
            if (isDisposed) {
                return;
            }

            setSas(callbacks);
            setReciprocateQr(null);
            setStatusMessage("Compare the emoji with your other device.");
        };

        const onShowReciprocateQr = (callbacks: ShowQrCodeCallbacks): void => {
            if (isDisposed) {
                return;
            }

            setReciprocateQr(callbacks);
            setSas(null);
            setStatusMessage("Confirm that the other device scanned your QR code.");
        };

        const onVerifierCancel = (cancelError: Error | { toString?: () => string }): void => {
            if (isDisposed) {
                return;
            }

            setError(toErrorMessage(cancelError));
            setStatusMessage("Verification cancelled.");
            setPendingAction(null);
        };

        verifier.on(VERIFIER_SHOW_SAS_EVENT, onShowSas as any);
        verifier.on(VERIFIER_SHOW_RECIPROCATE_QR_EVENT, onShowReciprocateQr as any);
        verifier.on(VERIFIER_CANCEL_EVENT, onVerifierCancel as any);

        void verifier
            .verify()
            .then(() => {
                if (isDisposed) {
                    return;
                }

                notifyCompleted();
            })
            .catch((verifyError) => {
                if (isDisposed) {
                    return;
                }

                setError(toErrorMessage(verifyError));
                setStatusMessage("Verification failed.");
            })
            .finally(() => {
                if (isDisposed) {
                    return;
                }

                setPendingAction((currentAction) => (currentAction === "start_sas" ? null : currentAction));
            });

        return () => {
            isDisposed = true;
            verifier.off(VERIFIER_SHOW_SAS_EVENT, onShowSas as any);
            verifier.off(VERIFIER_SHOW_RECIPROCATE_QR_EVENT, onShowReciprocateQr as any);
            verifier.off(VERIFIER_CANCEL_EVENT, onVerifierCancel as any);
        };
    }, [notifyCompleted, verifier]);

    const handleClose = useCallback((): void => {
        if (
            request &&
            request.phase !== VerificationPhase.Cancelled &&
            request.phase !== VerificationPhase.Done
        ) {
            void request.cancel().catch(() => undefined);
        }

        onClose();
    }, [onClose, request]);

    useEffect(() => {
        if (!open) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                handleClose();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [handleClose, open]);

    const runRequestAction = useCallback(
        async (action: PendingAction, callback: () => Promise<void>): Promise<void> => {
            setPendingAction(action);
            setError(null);

            try {
                await callback();
            } catch (actionError) {
                setError(toErrorMessage(actionError));
            } finally {
                setPendingAction(null);
            }
        },
        [],
    );

    const acceptRequest = useCallback(async (): Promise<void> => {
        if (!request) {
            return;
        }

        await runRequestAction("accept", async () => {
            await request.accept();
            setStatusMessage("Request accepted. Choose a verification method.");
        });
    }, [request, runRequestAction]);

    const startSasVerification = useCallback(async (): Promise<void> => {
        if (!request) {
            return;
        }

        await runRequestAction("start_sas", async () => {
            if (!request.initiatedByMe && request.phase < VerificationPhase.Ready) {
                await request.accept();
            }

            const createdVerifier = await request.startVerification(VERIFICATION_METHOD_SAS);
            setSas(null);
            setReciprocateQr(null);
            setStatusMessage("Waiting for SAS challenge...");
            attachVerifier(createdVerifier);
        });
    }, [attachVerifier, request, runRequestAction]);

    const startQrScanVerification = useCallback(async (): Promise<void> => {
        if (!request) {
            return;
        }

        await runRequestAction("start_scan", async () => {
            if (scanQrInput.trim().length === 0) {
                throw new Error("Paste QR payload first.");
            }

            if (!request.initiatedByMe && request.phase < VerificationPhase.Ready) {
                await request.accept();
            }

            const payload = decodeBase64ToBytes(scanQrInput);
            const createdVerifier = await request.scanQRCode(payload);
            setStatusMessage("QR payload accepted. Waiting for confirmation...");
            attachVerifier(createdVerifier);
        });
    }, [attachVerifier, request, runRequestAction, scanQrInput]);

    const cancelVerification = useCallback(async (): Promise<void> => {
        if (!request) {
            handleClose();
            return;
        }

        await runRequestAction("cancel", async () => {
            await request.cancel();
            setStatusMessage("Verification cancelled.");
        });
    }, [handleClose, request, runRequestAction]);

    const copyQrPayload = useCallback(async (): Promise<void> => {
        if (!qrPayload || !navigator.clipboard?.writeText) {
            return;
        }

        await runRequestAction("copy_qr", async () => {
            await navigator.clipboard.writeText(qrPayload);
            setStatusMessage("QR payload copied.");
        });
    }, [qrPayload, runRequestAction]);

    const confirmSas = useCallback(async (): Promise<void> => {
        if (!sas) {
            return;
        }

        await runRequestAction("confirm_sas", async () => {
            await sas.confirm();
            setStatusMessage("SAS confirmed. Finalizing verification...");
        });
    }, [runRequestAction, sas]);

    const mismatchSas = useCallback(async (): Promise<void> => {
        if (!sas) {
            return;
        }

        await runRequestAction("mismatch_sas", async () => {
            sas.mismatch();
            setStatusMessage("SAS mismatch reported.");
        });
    }, [runRequestAction, sas]);

    const confirmReciprocatedQr = useCallback(async (): Promise<void> => {
        if (!reciprocateQr) {
            return;
        }

        await runRequestAction("confirm_reciprocate", async () => {
            reciprocateQr.confirm();
            setStatusMessage("QR confirmation sent. Finalizing verification...");
        });
    }, [reciprocateQr, runRequestAction]);

    if (!open) {
        return null;
    }

    return (
        <div className="verification-dialog-overlay" role="dialog" aria-modal="true" aria-label="Device verification">
            <div className="verification-dialog">
                <header className="verification-dialog-header">
                    <div className="verification-dialog-title-wrap">
                        <h2>Verify Session</h2>
                        <p className="verification-dialog-subtitle">{targetLabel}</p>
                    </div>
                    <button
                        type="button"
                        className="verification-dialog-close"
                        onClick={handleClose}
                        aria-label="Close verification dialog"
                    >
                        x
                    </button>
                </header>

                <div className="verification-dialog-body">
                    <div className="verification-status-chip">
                        {phase === null ? "Pending" : phaseLabel(phase)}
                    </div>
                    <p className="verification-status-message">{statusMessage}</p>
                    {loading ? <p className="verification-status-message">Waiting for crypto handshake...</p> : null}
                    {error ? <p className="verification-error">{error}</p> : null}

                    {request && phase === VerificationPhase.Requested && !request.initiatedByMe ? (
                        <div className="verification-actions-row">
                            <button
                                type="button"
                                className="verification-primary"
                                onClick={() => void acceptRequest()}
                                disabled={pendingAction !== null}
                            >
                                {pendingAction === "accept" ? "Accepting..." : "Accept Request"}
                            </button>
                            <button
                                type="button"
                                className="verification-secondary"
                                onClick={() => void cancelVerification()}
                                disabled={pendingAction !== null}
                            >
                                {pendingAction === "cancel" ? "Cancelling..." : "Decline"}
                            </button>
                        </div>
                    ) : null}

                    {request &&
                    (phase === VerificationPhase.Requested || phase === VerificationPhase.Ready || phase === VerificationPhase.Started) ? (
                        <div className="verification-method-card">
                            <h3>Methods</h3>
                            <div className="verification-actions-row">
                                <button
                                    type="button"
                                    className="verification-primary"
                                    onClick={() => void startSasVerification()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    {pendingAction === "start_sas" ? "Starting..." : "Start Emoji Verification"}
                                </button>
                                <button
                                    type="button"
                                    className="verification-secondary"
                                    onClick={() => void cancelVerification()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    {pendingAction === "cancel" ? "Cancelling..." : "Cancel Flow"}
                                </button>
                            </div>

                            {qrPayload ? (
                                <div className="verification-qr-section">
                                    <h4>QR Payload</h4>
                                    <p className="verification-inline-note">
                                        Paste this payload into your scanner helper or another trusted client.
                                    </p>
                                    <textarea value={qrPayload} readOnly className="verification-textarea" rows={3} />
                                    <button
                                        type="button"
                                        className="verification-secondary"
                                        onClick={() => void copyQrPayload()}
                                        disabled={pendingAction !== null || !navigator.clipboard?.writeText}
                                    >
                                        {pendingAction === "copy_qr" ? "Copying..." : "Copy QR Payload"}
                                    </button>
                                </div>
                            ) : null}

                            <div className="verification-qr-section">
                                <h4>Scan QR Payload</h4>
                                <p className="verification-inline-note">Paste a scanned payload and continue verification.</p>
                                <textarea
                                    value={scanQrInput}
                                    onChange={(event) => setScanQrInput(event.target.value)}
                                    className="verification-textarea"
                                    placeholder="Paste base64 payload..."
                                    rows={3}
                                />
                                <button
                                    type="button"
                                    className="verification-secondary"
                                    onClick={() => void startQrScanVerification()}
                                    disabled={pendingAction !== null || scanQrInput.trim().length === 0 || completed}
                                >
                                    {pendingAction === "start_scan" ? "Starting..." : "Start QR Scan Flow"}
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {sas ? (
                        <div className="verification-sas-card">
                            <h3>Compare Security Code</h3>
                            <p className="verification-inline-note">
                                Confirm the emoji and numbers match on both devices.
                            </p>
                            {sas.sas.emoji?.length ? (
                                <div className="verification-emoji-grid">
                                    {sas.sas.emoji.map(([emoji, label]) => (
                                        <div key={`${emoji}-${label}`} className="verification-emoji-item">
                                            <span className="verification-emoji">{emoji}</span>
                                            <span className="verification-emoji-label">{label}</span>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            {sas.sas.decimal ? <div className="verification-decimal-code">{sas.sas.decimal.join(" | ")}</div> : null}
                            <div className="verification-actions-row">
                                <button
                                    type="button"
                                    className="verification-primary"
                                    onClick={() => void confirmSas()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    {pendingAction === "confirm_sas" ? "Confirming..." : "Code Matches"}
                                </button>
                                <button
                                    type="button"
                                    className="verification-danger"
                                    onClick={() => void mismatchSas()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    {pendingAction === "mismatch_sas" ? "Sending..." : "Code Does Not Match"}
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {reciprocateQr ? (
                        <div className="verification-sas-card">
                            <h3>Confirm QR Scan</h3>
                            <p className="verification-inline-note">
                                Another device scanned your code. Confirm only if you initiated this flow.
                            </p>
                            <div className="verification-actions-row">
                                <button
                                    type="button"
                                    className="verification-primary"
                                    onClick={() => void confirmReciprocatedQr()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    {pendingAction === "confirm_reciprocate" ? "Confirming..." : "Confirm Scan"}
                                </button>
                                <button
                                    type="button"
                                    className="verification-secondary"
                                    onClick={() => void cancelVerification()}
                                    disabled={pendingAction !== null || completed}
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {completed ? <p className="verification-success">Verification complete. You can close this window.</p> : null}
                </div>
            </div>
        </div>
    );
}
