import React, { useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import { VerificationDialog } from "./verification/VerificationDialog";

interface DeviceVerificationViewProps {
    client: MatrixClient;
    error: string | null;
    localDeviceVerified: boolean;
    canSkip: boolean;
    onRefreshStatus: () => Promise<void>;
    onSkip: () => Promise<void>;
    onLogout: () => Promise<void>;
}

type ActionState = "refresh" | "skip" | "logout" | null;

export function DeviceVerificationView({
    client,
    error,
    localDeviceVerified,
    canSkip,
    onRefreshStatus,
    onSkip,
    onLogout,
}: DeviceVerificationViewProps): React.ReactElement {
    const [pendingAction, setPendingAction] = useState<ActionState>(null);
    const [verificationOpen, setVerificationOpen] = useState(false);

    const runAction = async (action: ActionState, callback: () => Promise<void>): Promise<void> => {
        setPendingAction(action);
        try {
            await callback();
        } finally {
            setPendingAction(null);
        }
    };

    return (
        <div className="login-view">
            <div className="login-card security-card verification-gate-card">
                <div className="verification-gate-banner">
                    <h1>Secure Session Check</h1>
                    <p>Trust gate: verify this device before full access.</p>
                </div>

                <div className="verification-gate-body">
                    <p className={localDeviceVerified ? "security-key-valid" : "security-key-invalid"}>
                        {localDeviceVerified
                            ? "Cross-signing trust detected for your account."
                            : "This session is not yet trusted by cross-signing."}
                    </p>

                    {error ? <p className="login-error">{error}</p> : null}
                </div>

                <div className="security-actions verification-gate-actions">
                    <button
                        type="button"
                        onClick={() => setVerificationOpen(true)}
                        disabled={pendingAction !== null}
                    >
                        Start Verification
                    </button>
                    <button
                        type="button"
                        className="security-skip"
                        onClick={() => void runAction("refresh", onRefreshStatus)}
                        disabled={pendingAction !== null}
                    >
                        {pendingAction === "refresh" ? "Checking..." : "Continue"}
                    </button>
                    {canSkip ? (
                        <button
                            type="button"
                            className="security-skip"
                            onClick={() => void runAction("skip", onSkip)}
                            disabled={pendingAction !== null}
                        >
                            {pendingAction === "skip" ? "Skipping..." : "Skip for now"}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="security-skip"
                        onClick={() => void runAction("logout", onLogout)}
                        disabled={pendingAction !== null}
                    >
                        {pendingAction === "logout" ? "Signing out..." : "Sign out"}
                    </button>
                </div>
            </div>
            <VerificationDialog
                client={client}
                open={verificationOpen}
                onClose={() => setVerificationOpen(false)}
                onCompleted={() => {
                    setVerificationOpen(false);
                    void runAction("refresh", onRefreshStatus);
                }}
            />
        </div>
    );
}
