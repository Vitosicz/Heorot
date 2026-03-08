import React, { useEffect, useMemo, useState } from "react";

import { isRecoveryKeyValid, type SecurityRecoveryFlow } from "../adapters/securityRecoveryAdapter";

interface SecurityRecoveryViewProps {
    flow: SecurityRecoveryFlow;
    error: string | null;
    onPrepareSetup: () => Promise<string>;
    onCompleteSetup: () => Promise<void>;
    onRestore: (credential: string) => Promise<void>;
    onSkip: () => void;
}

export function SecurityRecoveryView({
    flow,
    error,
    onPrepareSetup,
    onCompleteSetup,
    onRestore,
    onSkip,
}: SecurityRecoveryViewProps): React.ReactElement {
    const [credential, setCredential] = useState("");
    const [showCredential, setShowCredential] = useState(false);

    const [generatedSetupKey, setGeneratedSetupKey] = useState("");
    const [setupCopied, setSetupCopied] = useState(false);
    const [setupDownloaded, setSetupDownloaded] = useState(false);
    const [setupBusy, setSetupBusy] = useState(false);
    const [setupError, setSetupError] = useState<string | null>(null);

    useEffect(() => {
        if (flow !== "restore") {
            return;
        }

        setCredential("");
    }, [flow]);

    useEffect(() => {
        if (flow !== "setup") {
            return;
        }

        setGeneratedSetupKey("");
        setSetupCopied(false);
        setSetupDownloaded(false);
        setSetupBusy(false);
        setSetupError(null);
    }, [flow]);

    const recoveryKeyValid = useMemo(() => {
        if (credential.length === 0) {
            return true;
        }
        return isRecoveryKeyValid(credential.trim());
    }, [credential]);

    const canSubmit = useMemo(() => credential.trim().length > 0 && recoveryKeyValid, [credential, recoveryKeyValid]);

    const canGenerateSetupKey = !setupBusy;
    const canCompleteSetup = useMemo(() => {
        if (generatedSetupKey.trim().length === 0 || setupBusy) {
            return false;
        }

        return setupCopied || setupDownloaded;
    }, [generatedSetupKey, setupBusy, setupCopied, setupDownloaded]);

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        if (!canSubmit) {
            return;
        }

        await onRestore(credential);
    };

    const handleGenerateSetupKey = async (): Promise<void> => {
        if (!canGenerateSetupKey) {
            return;
        }

        setSetupBusy(true);
        setSetupError(null);
        try {
            const encodedKey = await onPrepareSetup();
            if (!encodedKey || encodedKey.trim().length === 0) {
                throw new Error("Failed to generate security key.");
            }
            setGeneratedSetupKey(encodedKey.trim());
            setSetupCopied(false);
            setSetupDownloaded(false);
        } catch (generationError) {
            setSetupError(generationError instanceof Error ? generationError.message : String(generationError));
        } finally {
            setSetupBusy(false);
        }
    };

    const handleCopySetupKey = async (): Promise<void> => {
        if (generatedSetupKey.trim().length === 0) {
            return;
        }

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(generatedSetupKey);
            } else {
                const helper = document.createElement("textarea");
                helper.value = generatedSetupKey;
                helper.setAttribute("readonly", "");
                helper.style.position = "absolute";
                helper.style.left = "-9999px";
                document.body.appendChild(helper);
                helper.select();
                document.execCommand("copy");
                document.body.removeChild(helper);
            }
            setSetupCopied(true);
            setSetupError(null);
        } catch {
            setSetupError("Unable to copy security key automatically. Copy it manually from the box.");
        }
    };

    const handleDownloadSetupKey = (): void => {
        if (generatedSetupKey.trim().length === 0) {
            return;
        }

        const blob = new Blob([generatedSetupKey], { type: "text/plain;charset=us-ascii" });
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

    const handleCompleteSetup = async (): Promise<void> => {
        if (!canCompleteSetup) {
            return;
        }

        setSetupBusy(true);
        setSetupError(null);
        try {
            await onCompleteSetup();
        } finally {
            setSetupBusy(false);
        }
    };

    if (flow === "setup") {
        const effectiveSetupError = setupError ?? error;

        return (
            <div className="login-view">
                <div className="login-card security-card">
                    <h1>Set up secure backup</h1>
                    <p className="login-subtitle">
                        Use a security key so encrypted history can be restored on new sessions.
                    </p>

                    {generatedSetupKey ? (
                        <div className="security-generated-key">
                            <p className="security-generated-key-label">Security key</p>
                            <code>{generatedSetupKey}</code>
                            <p className="security-generated-key-hint">
                                Save this key offline. You will need it to restore encrypted history if this session is lost.
                            </p>
                            <div className="security-generated-key-actions">
                                <button type="button" className="security-skip" onClick={() => void handleCopySetupKey()} disabled={setupBusy}>
                                    {setupCopied ? "Copied" : "Copy key"}
                                </button>
                                <button type="button" className="security-skip" onClick={handleDownloadSetupKey} disabled={setupBusy}>
                                    {setupDownloaded ? "Downloaded" : "Download .txt"}
                                </button>
                            </div>
                        </div>
                    ) : null}

                    {effectiveSetupError ? <p className="login-error">{effectiveSetupError}</p> : null}

                    <div className="security-actions">
                        {generatedSetupKey ? (
                            <button type="button" disabled={!canCompleteSetup} onClick={() => void handleCompleteSetup()}>
                                {setupBusy ? "Finishing setup..." : "Finish setup"}
                            </button>
                        ) : (
                            <button type="button" disabled={!canGenerateSetupKey} onClick={() => void handleGenerateSetupKey()}>
                                {setupBusy ? "Generating..." : "Generate security key"}
                            </button>
                        )}

                        {generatedSetupKey ? (
                            <button
                                type="button"
                                className="security-skip"
                                onClick={() => {
                                    setGeneratedSetupKey("");
                                    setSetupCopied(false);
                                    setSetupDownloaded(false);
                                    setSetupError(null);
                                }}
                                disabled={setupBusy}
                            >
                                Generate different key
                            </button>
                        ) : null}

                        <button type="button" className="security-skip" onClick={onSkip} disabled={setupBusy}>
                            Skip for now
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="login-view">
            <form className="login-card security-card" onSubmit={handleSubmit}>
                <h1>Recover encrypted history</h1>
                <p className="login-subtitle">This account has encrypted key backup. Enter your security key to decrypt older messages.</p>

                <label>
                    Security key
                    <input
                        type={showCredential ? "text" : "password"}
                        value={credential}
                        onChange={(event) => setCredential(event.target.value)}
                        placeholder="EsTc ..."
                        autoComplete="off"
                    />
                </label>

                <label className="login-checkbox">
                    <input
                        type="checkbox"
                        checked={showCredential}
                        onChange={(event) => setShowCredential(event.target.checked)}
                    />
                    <span>Show security key</span>
                </label>

                {credential.length > 0 ? (
                    <p className={recoveryKeyValid ? "security-key-valid" : "security-key-invalid"}>
                        {recoveryKeyValid ? "Security key format is valid." : "Security key format is invalid."}
                    </p>
                ) : null}

                {error ? <p className="login-error">{error}</p> : null}

                <div className="security-actions">
                    <button type="submit" disabled={!canSubmit}>
                        Restore keys
                    </button>
                    <button type="button" className="security-skip" onClick={onSkip}>
                        Skip for now
                    </button>
                </div>
            </form>
        </div>
    );
}
