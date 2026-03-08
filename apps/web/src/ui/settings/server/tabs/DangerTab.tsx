import React, { useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../../../components/Toast";

interface DangerTabProps {
    client: MatrixClient;
    spaceRoom: Room;
    onLeftSpace: (spaceId: string) => void;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

export function DangerTab({ client, spaceRoom, onLeftSpace, onToast }: DangerTabProps): React.ReactElement {
    const [leaving, setLeaving] = useState(false);
    const spaceName = spaceRoom.name || spaceRoom.getCanonicalAlias() || spaceRoom.roomId;

    const leaveSpace = async (): Promise<void> => {
        const confirmed = window.confirm(`Leave "${spaceName}"?`);
        if (!confirmed) {
            return;
        }

        setLeaving(true);
        try {
            await client.leave(spaceRoom.roomId);
            onLeftSpace(spaceRoom.roomId);
            onToast({ type: "success", message: `Left ${spaceName}.` });
        } catch (error) {
            onToast({
                type: "error",
                message: error instanceof Error ? error.message : "Failed to leave server.",
            });
        } finally {
            setLeaving(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Danger zone</h2>
            <p className="settings-tab-description">Irreversible actions for this server.</p>

            <div className="settings-danger-card">
                <div>
                    <h3>Leave server</h3>
                    <p>
                        You will leave this Space and lose quick access to its channels until invited again or re-joined.
                    </p>
                </div>
                <button
                    type="button"
                    className="settings-button settings-button-danger"
                    onClick={() => void leaveSpace()}
                    disabled={leaving}
                >
                    {leaving ? "Leaving..." : "Leave server"}
                </button>
            </div>

            <div className="settings-danger-card">
                <div>
                    <h3>Delete server (TODO)</h3>
                    <p>Not implemented in UI yet.</p>
                </div>
                <button type="button" className="settings-button settings-button-secondary" disabled>
                    Delete server
                </button>
            </div>
        </div>
    );
}
