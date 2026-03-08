import React, { useMemo } from "react";
import { EventType, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

interface PinsPanelProps {
    room: Room;
}

interface PinnedItem {
    eventId: string;
    senderLabel: string;
    body: string;
    ts: number;
}

function getPinnedEventIds(room: Room): string[] {
    const pinnedEvent = room.currentState.getStateEvents(EventType.RoomPinnedEvents, "");
    const content = (pinnedEvent?.getContent() ?? {}) as { pinned?: unknown };
    if (!Array.isArray(content.pinned)) {
        return [];
    }

    return content.pinned.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function getBody(event: MatrixEvent): string {
    if (event.getType() === EventType.RoomMessage) {
        const content = event.getContent() as { body?: unknown };
        if (typeof content.body === "string" && content.body.length > 0) {
            return content.body;
        }
    }

    return event.getType();
}

function getPinnedItems(room: Room): PinnedItem[] {
    return getPinnedEventIds(room)
        .map((eventId) => room.findEventById(eventId))
        .filter((event): event is MatrixEvent => Boolean(event))
        .map((event) => {
            const senderId = event.getSender() ?? "unknown";
            const member = room.getMember(senderId);
            return {
                eventId: event.getId() ?? `${senderId}-${event.getTs()}`,
                senderLabel: member?.rawDisplayName || member?.name || senderId,
                body: getBody(event),
                ts: event.getTs(),
            };
        })
        .sort((left, right) => right.ts - left.ts);
}

export function PinsPanel({ room }: PinsPanelProps): React.ReactElement {
    const pinnedItems = useMemo(() => getPinnedItems(room), [room]);

    return (
        <div className="rs-panel">
            <div className="rs-panel-header">
                <h2 className="rs-panel-title">Pinned messages</h2>
            </div>
            <div className="rs-pins-list">
                {pinnedItems.length === 0 ? (
                    <div className="rs-empty-state">No pinned messages in this channel yet.</div>
                ) : (
                    pinnedItems.map((item) => (
                        <div className="rs-pin-item" key={item.eventId}>
                            <div className="rs-pin-head">
                                <span className="rs-pin-sender">{item.senderLabel}</span>
                                <span className="rs-pin-time">
                                    {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                            </div>
                            <p className="rs-pin-body">{item.body}</p>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

