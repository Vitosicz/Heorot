import React from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../../../components/Toast";

interface MyAccountTabProps {
    client: MatrixClient;
    onToast: (toast: Omit<ToastState, "id">) => void;
    onSignOut: () => Promise<void>;
}

function getHomeserverDomain(client: MatrixClient): string {
    const homeserverUrl = client.getHomeserverUrl();
    if (!homeserverUrl) {
        return "Unknown";
    }

    try {
        return new URL(homeserverUrl).host;
    } catch {
        return homeserverUrl;
    }
}

async function copyText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = value;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
}

export function MyAccountTab({ client, onToast, onSignOut }: MyAccountTabProps): React.ReactElement {
    const userId = client.getUserId() ?? "Unknown";
    const deviceId = client.getDeviceId() ?? "Unknown";
    const homeserverDomain = getHomeserverDomain(client);

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">My Account</h2>
            <p className="settings-tab-description">Current account and session identifiers.</p>

            <div className="settings-info-grid">
                <div className="settings-info-item">
                    <span className="settings-info-label">MXID</span>
                    <code>{userId}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Homeserver</span>
                    <code>{homeserverDomain}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Device ID</span>
                    <code>{deviceId}</code>
                </div>
            </div>

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() =>
                        void copyText(userId)
                            .then(() => onToast({ type: "success", message: "Copied MXID." }))
                            .catch((error: unknown) =>
                                onToast({
                                    type: "error",
                                    message: error instanceof Error ? error.message : "Failed to copy MXID.",
                                }),
                            )
                    }
                >
                    Copy MXID
                </button>
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() =>
                        void copyText(deviceId)
                            .then(() => onToast({ type: "success", message: "Copied device ID." }))
                            .catch((error: unknown) =>
                                onToast({
                                    type: "error",
                                    message: error instanceof Error ? error.message : "Failed to copy device ID.",
                                }),
                            )
                    }
                >
                    Copy device ID
                </button>
                <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={() => void onSignOut()}
                >
                    Sign out
                </button>
            </div>
        </div>
    );
}
