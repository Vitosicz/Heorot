import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClientEvent, EventType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";
import { getDirectRoomIds } from "../../../adapters/dmAdapter";
import {
    getRoomNotificationMode,
    RoomNotificationMode,
    setRoomNotificationMode,
} from "../../../adapters/roomNotificationAdapter";

interface InfoPanelProps {
    client: MatrixClient;
    room: Room;
    onOpenRoomSettings: () => void;
    onCopyRoomLink: () => Promise<void>;
    onLeaveRoom: () => Promise<void>;
}

const ROOM_NOTIFICATION_MODE_OPTIONS: Array<{ mode: RoomNotificationMode; label: string }> = [
    { mode: RoomNotificationMode.Default, label: "Default" },
    { mode: RoomNotificationMode.AllMessages, label: "All messages" },
    { mode: RoomNotificationMode.MentionsOnly, label: "Mentions only" },
    { mode: RoomNotificationMode.Mute, label: "Mute" },
];

function roomNotificationModeSummary(mode: RoomNotificationMode): string {
    switch (mode) {
        case RoomNotificationMode.AllMessages:
            return "All messages";
        case RoomNotificationMode.MentionsOnly:
            return "Mentions only";
        case RoomNotificationMode.Mute:
            return "Muted";
        default:
            return "Default";
    }
}

function getRoomTopic(room: Room): string {
    const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
    const content = (topicEvent?.getContent() ?? {}) as { topic?: unknown };
    return typeof content.topic === "string" ? content.topic : "";
}

function isEncrypted(room: Room): boolean {
    return Boolean(room.currentState.getStateEvents(EventType.RoomEncryption, ""));
}

function isDirectMessage(client: MatrixClient, roomId: string): boolean {
    return getDirectRoomIds(client).has(roomId);
}

export function InfoPanel({
    client,
    room,
    onOpenRoomSettings,
    onCopyRoomLink,
    onLeaveRoom,
}: InfoPanelProps): React.ReactElement {
    const ownUserId = client.getUserId() ?? "";
    const topic = getRoomTopic(room);
    const encrypted = isEncrypted(room);
    const dm = useMemo(() => isDirectMessage(client, room.roomId), [client, room.roomId]);
    const canEditTopic = Boolean(ownUserId && room.currentState.maySendStateEvent(EventType.RoomTopic, ownUserId));
    const [notificationMode, setNotificationModeState] = useState<RoomNotificationMode>(RoomNotificationMode.Default);
    const [notificationModePending, setNotificationModePending] = useState(false);
    const [notificationModeError, setNotificationModeError] = useState<string | null>(null);

    const refreshRoomNotificationMode = useCallback((): void => {
        setNotificationModeState(getRoomNotificationMode(client, room.roomId));
    }, [client, room.roomId]);

    useEffect(() => {
        refreshRoomNotificationMode();
    }, [refreshRoomNotificationMode]);

    useEffect(() => {
        const onAccountData = (event: MatrixEvent): void => {
            if (event.getType() !== EventType.PushRules) {
                return;
            }
            refreshRoomNotificationMode();
        };
        client.on(ClientEvent.AccountData, onAccountData);
        return () => {
            client.removeListener(ClientEvent.AccountData, onAccountData);
        };
    }, [client, refreshRoomNotificationMode]);

    const updateRoomNotificationMode = useCallback(
        async (mode: RoomNotificationMode): Promise<void> => {
            if (notificationModePending || mode === notificationMode) {
                return;
            }

            setNotificationModePending(true);
            setNotificationModeError(null);
            try {
                await setRoomNotificationMode(client, room.roomId, mode);
                setNotificationModeState(mode);
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to update channel notifications.";
                setNotificationModeError(message);
                refreshRoomNotificationMode();
            } finally {
                setNotificationModePending(false);
            }
        },
        [client, notificationMode, notificationModePending, refreshRoomNotificationMode, room.roomId],
    );

    return (
        <div className="rs-panel">
            <div className="rs-panel-header">
                <h2 className="rs-panel-title">Channel info</h2>
            </div>

            <section className="rs-section">
                <div className="rs-section-head">
                    <h3 className="rs-section-title">About</h3>
                    {canEditTopic ? (
                        <button type="button" className="rs-inline-button" onClick={onOpenRoomSettings}>
                            Edit
                        </button>
                    ) : null}
                </div>
                <p className={`rs-about-text${topic.trim() ? "" : " is-empty"}`}>
                    {topic.trim() || "No topic set for this channel."}
                </p>
                <div className="rs-meta-row">
                    <span>Encryption</span>
                    <span className={`rs-chip ${encrypted ? "is-encrypted" : ""}`}>{encrypted ? "Encrypted" : "Unencrypted"}</span>
                </div>
            </section>

            <section className="rs-section">
                <div className="rs-section-head">
                    <h3 className="rs-section-title">Notifications</h3>
                    <span className="rs-chip">{roomNotificationModeSummary(notificationMode)}</span>
                </div>
                <div className="rs-notification-modes">
                    {ROOM_NOTIFICATION_MODE_OPTIONS.map((option) => (
                        <button
                            key={option.mode}
                            type="button"
                            className={`rs-notification-mode${notificationMode === option.mode ? " is-active" : ""}`}
                            onClick={() => {
                                void updateRoomNotificationMode(option.mode);
                            }}
                            disabled={notificationModePending}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
                {notificationModeError ? (
                    <p className="rs-notification-error">{notificationModeError}</p>
                ) : (
                    <p className="rs-notification-hint">Applies to this channel for your account.</p>
                )}
            </section>

            <section className="rs-section">
                <button type="button" className="rs-row-action" onClick={onOpenRoomSettings}>
                    Open channel settings
                </button>
                <button type="button" className="rs-row-action" onClick={() => void onCopyRoomLink()}>
                    Copy link
                </button>
            </section>

            <section className="rs-section rs-section-danger">
                <button type="button" className="rs-row-action rs-row-action-danger" onClick={() => void onLeaveRoom()}>
                    {dm ? "Leave conversation" : "Leave room"}
                </button>
            </section>
        </div>
    );
}

