import React, { useMemo } from "react";
import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { getDirectRoomIds } from "../../../adapters/dmAdapter";

interface InfoPanelProps {
    client: MatrixClient;
    room: Room;
    onOpenRoomSettings: () => void;
    onCopyRoomLink: () => Promise<void>;
    onLeaveRoom: () => Promise<void>;
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

