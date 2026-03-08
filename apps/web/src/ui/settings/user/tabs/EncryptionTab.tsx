import React, { useEffect, useMemo, useRef, useState } from "react";
import type { GeneratedSecretStorageKey } from "matrix-js-sdk/src/crypto-api";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    bootstrapSecretStorageSetup,
    createSecretStorageSetupKey,
} from "../../../adapters/securityRecoveryAdapter";
import { useMatrix } from "../../../providers/MatrixProvider";

interface EncryptionTabProps {
    client: MatrixClient;
    verificationNonce: number;
    onOpenVerification: () => void;
}

export function EncryptionTab({ client, verificationNonce, onOpenVerification }: EncryptionTabProps): React.ReactElement {
    const matrix = useMatrix();
    const [crossSigningReady, setCrossSigningReady] = useState(false);
    const [backupVersion, setBackupVersion] = useState<string | null>(null);
    const [hasRecoveryKey, setHasRecoveryKey] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [setupNonce, setSetupNonce] = useState(0);

    const [setupOpen, setSetupOpen] = useState(false);
    const [setupGeneratedKey, setSetupGeneratedKey] = useState("");
    const [setupCopied, setSetupCopied] = useState(false);
    const [setupDownloaded, setSetupDownloaded] = useState(false);
    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState<string | null>(null);
    const [setupSuccess, setSetupSuccess] = useState<string | null>(null);
    const pendingSetupKeyRef = useRef<GeneratedSecretStorageKey | null>(null);

    const clearPendingSetupKey = (): void => {
        const pendingSetupKey = pendingSetupKeyRef.current;
        if (!pendingSetupKey) {
            return;
        }

        pendingSetupKey.privateKey.fill(0);
        pendingSetupKeyRef.current = null;
    };

    useEffect(() => {
        let canceled = false;

        const loadCryptoStatus = async (): Promise<void> => {
            const crypto = client.getCrypto();
            if (!crypto) {
                setCrossSigningReady(false);
                setBackupVersion(null);
                setHasRecoveryKey(false);
                return;
            }

            setLoading(true);
            setError(null);
            try {
                const [isCrossSigningReady, activeBackupVersion, defaultRecoveryKeyId] = await Promise.all([
                    crypto.isCrossSigningReady(),
                    crypto.getActiveSessionBackupVersion(),
                    client.secretStorage.getDefaultKeyId(),
                ]);

                if (!canceled) {
                    setCrossSigningReady(Boolean(isCrossSigningReady));
                    setBackupVersion(activeBackupVersion);
                    setHasRecoveryKey(Boolean(defaultRecoveryKeyId));
                }
            } catch (loadError) {
                if (!canceled) {
                    setError(loadError instanceof Error ? loadError.message : "Failed to read encryption status.");
                }
            } finally {
                if (!canceled) {
                    setLoading(false);
                }
            }
        };

        void loadCryptoStatus();
        return () => {
            canceled = true;
        };
    }, [client, matrix.localDeviceVerified, verificationNonce, setupNonce]);

    useEffect(() => {
        return () => {
            clearPendingSetupKey();
        };
    }, []);

    const canGenerateSetup = !setupBusy;
    const canFinishSetup = useMemo(() => {
        if (setupBusy || setupGeneratedKey.trim().length === 0) {
            return false;
        }

        return setupCopied || setupDownloaded;
    }, [setupBusy, setupGeneratedKey, setupCopied, setupDownloaded]);

    const resetSetupForm = (): void => {
        clearPendingSetupKey();
        setSetupGeneratedKey("");
        setSetupCopied(false);
        setSetupDownloaded(false);
        setSetupBusy(false);
        setSetupError(null);
    };

    const handleGenerateSetupKey = async (): Promise<void> => {
        if (!canGenerateSetup) {
            return;
        }

        setSetupBusy(true);
        setSetupError(null);
        setSetupSuccess(null);
        try {
            const generatedKey = await createSecretStorageSetupKey(client);
            const encodedKey = generatedKey.encodedPrivateKey?.trim();
            if (!encodedKey) {
                generatedKey.privateKey.fill(0);
                throw new Error("Failed to generate security key.");
            }

            clearPendingSetupKey();
            pendingSetupKeyRef.current = generatedKey;
            setSetupGeneratedKey(encodedKey);
            setSetupCopied(false);
            setSetupDownloaded(false);
        } catch (generationError) {
            setSetupError(generationError instanceof Error ? generationError.message : "Failed to generate security key.");
        } finally {
            setSetupBusy(false);
        }
    };

    const handleCopySetupKey = async (): Promise<void> => {
        if (setupGeneratedKey.trim().length === 0) {
            return;
        }

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(setupGeneratedKey);
            } else {
                const helper = document.createElement("textarea");
                helper.value = setupGeneratedKey;
                helper.setAttribute("readonly", "");
                helper.style.position = "absolute";
                helper.style.left = "-9999px";
                document.body.appendChild(helper);
                helper.select();
                document.execCommand("copy");
                document.body.removeChild(helper);
            }
            setSetupCopied(true);
        } catch {
            setSetupError("Unable to copy security key. Copy it manually from the field.");
        }
    };

    const handleDownloadSetupKey = (): void => {
        if (setupGeneratedKey.trim().length === 0) {
            return;
        }

        const blob = new Blob([setupGeneratedKey], { type: "text/plain;charset=us-ascii" });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = "security-key.txt";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(objectUrl);
        setSetupDownloaded(true);
    };

    const handleFinishSetup = async (): Promise<void> => {
        if (!canFinishSetup) {
            return;
        }

        const setupKey = pendingSetupKeyRef.current;
        if (!setupKey) {
            setSetupError("Security key was not generated. Generate a new key first.");
            return;
        }

        setSetupBusy(true);
        setSetupError(null);
        setSetupSuccess(null);
        try {
            await bootstrapSecretStorageSetup(client, setupKey);
            clearPendingSetupKey();
            setSetupGeneratedKey("");
            setSetupCopied(false);
            setSetupDownloaded(false);
            setSetupOpen(false);
            setSetupSuccess(hasRecoveryKey ? "Recovery key changed." : "Recovery key set up.");
            setSetupNonce((value) => value + 1);
        } catch (completeError) {
            setSetupError(completeError instanceof Error ? completeError.message : "Failed to set up secure backup.");
        } finally {
            setSetupBusy(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Encryption & Recovery</h2>
            <p className="settings-tab-description">
                Surface existing verification and key backup flows without changing crypto primitives.
            </p>

            {loading ? <p className="settings-inline-note">Loading encryption status...</p> : null}
            {error ? <p className="settings-inline-error">{error}</p> : null}

            <div className="settings-info-grid">
                <div className="settings-info-item">
                    <span className="settings-info-label">Cross-signing</span>
                    <strong>{crossSigningReady ? "Ready" : "Not ready"}</strong>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Active key backup</span>
                    <strong>{backupVersion ?? "Not enabled"}</strong>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">This device verified</span>
                    <strong>{matrix.localDeviceVerified ? "Yes" : "No"}</strong>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Force verification policy</span>
                    <strong>{matrix.forceVerificationEnabled ? "Enabled" : "Disabled"}</strong>
                </div>
            </div>

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button"
                    onClick={onOpenVerification}
                >
                    Verify this device
                </button>
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => void matrix.refreshDeviceVerification()}
                >
                    Refresh trust status
                </button>
            </div>

            <div className="settings-section-card settings-recovery-card">
                <div className="settings-recovery-header">
                    <h3>Secure Backup</h3>
                    <span className={`settings-recovery-badge${hasRecoveryKey ? " is-ready" : " is-missing"}`}>
                        {hasRecoveryKey ? "Configured" : "Recommended"}
                    </span>
                </div>

                <p className="settings-inline-note">
                    {hasRecoveryKey
                        ? "Your account has a recovery key configured. You can rotate it if needed."
                        : "Set up a recovery key to restore encrypted history on new sessions and devices."}
                </p>

                {setupSuccess ? <p className="settings-inline-note settings-recovery-success">{setupSuccess}</p> : null}

                <div className="settings-actions-row">
                    <button
                        type="button"
                        className="settings-button"
                        onClick={() => {
                            setSetupOpen((previous) => {
                                if (previous) {
                                    resetSetupForm();
                                }
                                return !previous;
                            });
                            setSetupError(null);
                            setSetupSuccess(null);
                        }}
                        disabled={setupBusy}
                    >
                        {setupOpen ? "Hide recovery setup" : hasRecoveryKey ? "Change recovery key" : "Set up recovery key"}
                    </button>
                </div>

                {setupOpen ? (
                    <div className="settings-recovery-setup">
                        {setupGeneratedKey ? (
                            <div className="settings-recovery-key-box">
                                <p className="settings-inline-note settings-recovery-key-label">Security key</p>
                                <code>{setupGeneratedKey}</code>
                                <p className="settings-inline-note">
                                    Save this key offline. You will need it to unlock encrypted history later.
                                </p>
                                <div className="settings-actions-row">
                                    <button
                                        type="button"
                                        className="settings-button settings-button-secondary"
                                        onClick={() => void handleCopySetupKey()}
                                        disabled={setupBusy}
                                    >
                                        {setupCopied ? "Copied" : "Copy key"}
                                    </button>
                                    <button
                                        type="button"
                                        className="settings-button settings-button-secondary"
                                        onClick={handleDownloadSetupKey}
                                        disabled={setupBusy}
                                    >
                                        {setupDownloaded ? "Downloaded" : "Download .txt"}
                                    </button>
                                </div>
                            </div>
                        ) : null}

                        {setupError ? <p className="settings-inline-error">{setupError}</p> : null}

                        <div className="settings-actions-row">
                            {setupGeneratedKey ? (
                                <button
                                    type="button"
                                    className="settings-button"
                                    onClick={() => void handleFinishSetup()}
                                    disabled={!canFinishSetup}
                                >
                                    {setupBusy ? "Finishing..." : "Finish secure backup"}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="settings-button"
                                    onClick={() => void handleGenerateSetupKey()}
                                    disabled={!canGenerateSetup}
                                >
                                    {setupBusy ? "Generating..." : "Generate security key"}
                                </button>
                            )}
                            <button
                                type="button"
                                className="settings-button settings-button-secondary"
                                onClick={() => {
                                    resetSetupForm();
                                    setSetupOpen(false);
                                    setSetupSuccess(null);
                                }}
                                disabled={setupBusy}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>

            <p className="settings-inline-note">
                Backup recovery still opens automatically during login when encrypted history needs a recovery credential.
            </p>
        </div>
    );
}
