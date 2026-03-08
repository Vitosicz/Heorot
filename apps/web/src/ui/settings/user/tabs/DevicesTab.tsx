import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    DeviceVerification,
    type IMyDevice,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";

interface DevicesTabProps {
    client: MatrixClient;
    verificationNonce: number;
    onOpenOwnVerification: () => void;
    onOpenDeviceVerification: (target: { userId: string; deviceId: string }) => void;
}

interface DeviceRow extends IMyDevice {
    trustedState: "verified" | "blocked" | "unverified" | "unknown";
}

interface SignOutState {
    device: DeviceRow;
    pending: boolean;
    needsPassword: boolean;
    session: string | null;
    password: string;
    error: string | null;
}

interface InteractiveAuthErrorData {
    session?: unknown;
    flows?: Array<{
        stages?: unknown;
    }>;
    error?: unknown;
}

interface MatrixErrorLike {
    message?: unknown;
    errcode?: unknown;
    data?: InteractiveAuthErrorData;
}

function formatLastSeen(timestamp?: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) {
        return "Unknown";
    }

    return new Date(timestamp).toLocaleString();
}

function trustedStateLabel(state: DeviceRow["trustedState"]): string {
    switch (state) {
        case "verified":
            return "Verified";
        case "blocked":
            return "Blocked";
        case "unverified":
            return "Unverified";
        default:
            return "Unknown";
    }
}

function parseInteractiveAuthError(error: unknown): {
    message: string;
    session: string | null;
    supportsPassword: boolean;
} {
    const fallbackMessage = error instanceof Error ? error.message : String(error);

    if (!error || typeof error !== "object") {
        return {
            message: fallbackMessage,
            session: null,
            supportsPassword: false,
        };
    }

    const matrixError = error as MatrixErrorLike;
    const session = typeof matrixError.data?.session === "string" ? matrixError.data.session : null;
    const flows = Array.isArray(matrixError.data?.flows) ? matrixError.data.flows : [];
    const supportsPassword = flows.some((flow) => {
        if (!Array.isArray(flow.stages)) {
            return false;
        }

        return flow.stages.some((stage) => stage === "m.login.password");
    });

    const messageFromData = typeof matrixError.data?.error === "string" ? matrixError.data.error : null;
    const messageFromMatrix = typeof matrixError.message === "string" ? matrixError.message : null;
    const message = messageFromData ?? messageFromMatrix ?? fallbackMessage;

    return {
        message,
        session,
        supportsPassword,
    };
}

function buildPasswordAuth(userId: string, password: string, session: string): Record<string, unknown> {
    return {
        type: "m.login.password",
        identifier: {
            type: "m.id.user",
            user: userId,
        },
        user: userId,
        password,
        session,
    };
}

export function DevicesTab({
    client,
    verificationNonce,
    onOpenOwnVerification,
    onOpenDeviceVerification,
}: DevicesTabProps): React.ReactElement {
    const [devices, setDevices] = useState<DeviceRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [signOutState, setSignOutState] = useState<SignOutState | null>(null);

    const loadDevices = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            const response = await client.getDevices();
            const userId = client.getUserId();
            const trustedByDeviceId = new Map<string, DeviceRow["trustedState"]>();

            if (userId) {
                const crypto = client.getCrypto();
                if (crypto) {
                    const userDevices = await crypto.getUserDeviceInfo([userId], false);
                    const knownDevices = userDevices.get(userId);
                    if (knownDevices) {
                        for (const [deviceId, device] of knownDevices.entries()) {
                            if (device.verified === DeviceVerification.Verified) {
                                trustedByDeviceId.set(deviceId, "verified");
                            } else if (device.verified === DeviceVerification.Blocked) {
                                trustedByDeviceId.set(deviceId, "blocked");
                            } else {
                                trustedByDeviceId.set(deviceId, "unverified");
                            }
                        }
                    }
                }
            }

            const merged = response.devices
                .map((device) => ({
                    ...device,
                    trustedState: trustedByDeviceId.get(device.device_id) ?? "unknown",
                }))
                .sort((left, right) => {
                    const leftTs = left.last_seen_ts ?? 0;
                    const rightTs = right.last_seen_ts ?? 0;
                    return rightTs - leftTs;
                });

            setDevices(merged);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load devices.");
        } finally {
            setLoading(false);
        }
    }, [client]);

    useEffect(() => {
        void loadDevices();
    }, [loadDevices, verificationNonce]);

    const currentDeviceId = client.getDeviceId() ?? "";
    const currentUserId = client.getUserId() ?? "";
    const hasDevices = devices.length > 0;
    const knownTrustedCount = useMemo(
        () => devices.filter((device) => device.trustedState === "verified").length,
        [devices],
    );

    const openSignOut = useCallback((device: DeviceRow): void => {
        setSignOutState({
            device,
            pending: false,
            needsPassword: false,
            session: null,
            password: "",
            error: null,
        });
    }, []);

    const submitSignOut = useCallback(async (): Promise<void> => {
        if (!signOutState) {
            return;
        }

        const currentState = signOutState;
        setSignOutState((previous) => (previous ? { ...previous, pending: true, error: null } : previous));

        try {
            if (!currentUserId) {
                throw new Error("Missing user id for interactive authentication.");
            }

            if (currentState.needsPassword) {
                if (currentState.password.trim().length === 0) {
                    throw new Error("Account password is required.");
                }

                if (!currentState.session) {
                    throw new Error("Interactive authentication session is missing.");
                }

                const auth = buildPasswordAuth(currentUserId, currentState.password, currentState.session);
                await client.deleteDevice(currentState.device.device_id, auth as any);
            } else {
                await client.deleteDevice(currentState.device.device_id);
            }

            setSignOutState(null);
            await loadDevices();
        } catch (removeError) {
            const parsed = parseInteractiveAuthError(removeError);

            if (!currentState.needsPassword && parsed.session) {
                setSignOutState((previous) => {
                    if (!previous || previous.device.device_id !== currentState.device.device_id) {
                        return previous;
                    }

                    return {
                        ...previous,
                        pending: false,
                        needsPassword: true,
                        session: parsed.session,
                        error: parsed.supportsPassword ? null : "Homeserver requires a UIA stage not supported by this UI.",
                    };
                });
                return;
            }

            setSignOutState((previous) => {
                if (!previous || previous.device.device_id !== currentState.device.device_id) {
                    return previous;
                }

                return {
                    ...previous,
                    pending: false,
                    error: parsed.message,
                };
            });
        }
    }, [client, currentUserId, loadDevices, signOutState]);

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Devices</h2>
            <p className="settings-tab-description">Active sessions overview.</p>

            <div className="settings-actions-row">
                <button type="button" className="settings-button settings-button-secondary" onClick={onOpenOwnVerification}>
                    Verify this device
                </button>
            </div>

            <p className="settings-inline-note">
                Verified sessions: {knownTrustedCount} / {devices.length}
            </p>

            {loading ? <p className="settings-inline-note">Loading devices...</p> : null}
            {error ? <p className="settings-inline-error">{error}</p> : null}

            {signOutState ? (
                <div className="settings-section-card settings-devices-signout">
                    <h3>Sign out device</h3>
                    <p className="settings-inline-note">
                        {signOutState.device.display_name || "Unnamed device"} ({signOutState.device.device_id})
                    </p>
                    {signOutState.needsPassword ? (
                        <label className="settings-field">
                            Account password
                            <input
                                type="password"
                                value={signOutState.password}
                                onChange={(event) =>
                                    setSignOutState((previous) =>
                                        previous
                                            ? {
                                                  ...previous,
                                                  password: event.target.value,
                                              }
                                            : previous,
                                    )
                                }
                                autoComplete="current-password"
                            />
                        </label>
                    ) : (
                        <p className="settings-inline-note">
                            This removes the selected session from your account on the homeserver.
                        </p>
                    )}
                    {signOutState.error ? <p className="settings-inline-error">{signOutState.error}</p> : null}
                    <div className="settings-actions-row">
                        <button
                            type="button"
                            className="settings-button settings-button-danger"
                            onClick={() => void submitSignOut()}
                            disabled={signOutState.pending}
                        >
                            {signOutState.pending ? "Processing..." : "Confirm sign out"}
                        </button>
                        <button
                            type="button"
                            className="settings-button settings-button-secondary"
                            onClick={() => setSignOutState(null)}
                            disabled={signOutState.pending}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="settings-devices-list">
                {hasDevices ? (
                    devices.map((device) => {
                        const isCurrent = device.device_id === currentDeviceId;
                        const disableActions = signOutState?.pending ?? false;
                        return (
                            <div className="settings-devices-item" key={device.device_id}>
                                <div className="settings-devices-main">
                                    <span className="settings-devices-title">
                                        {device.display_name || "Unnamed device"} {isCurrent ? "(This device)" : ""}
                                    </span>
                                    <span className="settings-devices-meta">Device ID: {device.device_id}</span>
                                    <span className="settings-devices-meta">Last seen: {formatLastSeen(device.last_seen_ts)}</span>
                                    {device.last_seen_ip ? <span className="settings-devices-meta">IP: {device.last_seen_ip}</span> : null}
                                </div>
                                <div className="settings-devices-actions">
                                    <span className={`settings-role-badge settings-role-${device.trustedState}`}>
                                        {trustedStateLabel(device.trustedState)}
                                    </span>
                                    <button
                                        type="button"
                                        className="settings-button settings-button-secondary"
                                        disabled={disableActions || !currentUserId}
                                        onClick={() =>
                                            isCurrent
                                                ? onOpenOwnVerification()
                                                : onOpenDeviceVerification({
                                                      userId: currentUserId,
                                                      deviceId: device.device_id,
                                                  })
                                        }
                                    >
                                        {isCurrent ? "Verify current" : "Verify"}
                                    </button>
                                    <button
                                        type="button"
                                        className="settings-button settings-button-danger"
                                        disabled={disableActions || isCurrent}
                                        title={isCurrent ? "Use global sign out for current device." : undefined}
                                        onClick={() => openSignOut(device)}
                                    >
                                        Sign out
                                    </button>
                                </div>
                            </div>
                        );
                    })
                ) : (
                    <div className="settings-empty">No devices found.</div>
                )}
            </div>
        </div>
    );
}

