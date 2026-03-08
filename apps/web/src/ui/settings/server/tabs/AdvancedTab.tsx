import React from "react";
import { EventType, type Room } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../../../components/Toast";

interface AdvancedTabProps {
    spaceRoom: Room;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

function readCanonicalAlias(room: Room): string {
    const event = room.currentState.getStateEvents(EventType.RoomCanonicalAlias, "");
    const content = event?.getContent() as { alias?: unknown } | undefined;
    return typeof content?.alias === "string" ? content.alias : "";
}

function readCreateEvent(room: Room): { creator: string; roomVersion: string; roomType: string } {
    const event = room.currentState.getStateEvents(EventType.RoomCreate, "");
    const content = event?.getContent() as { creator?: unknown; room_version?: unknown; type?: unknown } | undefined;
    const creator = typeof content?.creator === "string" ? content.creator : "";
    const roomVersion = typeof content?.room_version === "string" ? content.room_version : "1";
    const roomType = typeof content?.type === "string" ? content.type : "m.space";
    return { creator, roomVersion, roomType };
}

async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
}

export function AdvancedTab({ spaceRoom, onToast }: AdvancedTabProps): React.ReactElement {
    const canonicalAlias = readCanonicalAlias(spaceRoom);
    const createInfo = readCreateEvent(spaceRoom);

    const handleCopy = (value: string, label: string): void => {
        if (!value) {
            return;
        }
        void copyText(value)
            .then(() => onToast({ type: "success", message: `Copied ${label}.` }))
            .catch((copyError: unknown) =>
                onToast({
                    type: "error",
                    message: copyError instanceof Error ? copyError.message : `Failed to copy ${label}.`,
                }),
            );
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Advanced</h2>
            <p className="settings-tab-description">Low-level Space metadata and diagnostics.</p>

            <div className="settings-info-grid">
                <div className="settings-info-item">
                    <span className="settings-info-label">Space ID</span>
                    <code>{spaceRoom.roomId}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Canonical alias</span>
                    <code>{canonicalAlias || "Not set"}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Room version</span>
                    <code>{createInfo.roomVersion}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Creator</span>
                    <code>{createInfo.creator || "Unknown"}</code>
                </div>
                <div className="settings-info-item">
                    <span className="settings-info-label">Type</span>
                    <code>{createInfo.roomType}</code>
                </div>
            </div>

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => handleCopy(spaceRoom.roomId, "Space ID")}
                >
                    Copy Space ID
                </button>
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    disabled={!canonicalAlias}
                    onClick={() => handleCopy(canonicalAlias, "canonical alias")}
                >
                    Copy canonical alias
                </button>
            </div>
        </div>
    );
}
