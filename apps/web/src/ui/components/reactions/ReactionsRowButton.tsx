import React, { useMemo } from "react";
import { EventType, RelationType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import {
    REACTION_SHORTCODE_FIELD_STABLE,
    REACTION_SHORTCODE_FIELD_UNSTABLE,
} from "../../emoji/EmojiPackTypes";
import { mxcToHttp } from "../../utils/mxc";

function readReactionShortcode(reactionEvent: MatrixEvent): string | null {
    const content = reactionEvent.getContent() as Record<string, unknown>;
    const stable = content[REACTION_SHORTCODE_FIELD_STABLE];
    if (typeof stable === "string" && stable.trim()) {
        return stable;
    }

    const unstable = content[REACTION_SHORTCODE_FIELD_UNSTABLE];
    if (typeof unstable === "string" && unstable.trim()) {
        return unstable;
    }

    return null;
}

function formatReactors(names: string[]): string {
    if (names.length === 0) {
        return "Reaction";
    }

    if (names.length === 1) {
        return names[0];
    }

    if (names.length === 2) {
        return `${names[0]} and ${names[1]}`;
    }

    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface ReactionsRowButtonProps {
    client: MatrixClient;
    room: Room;
    mxEvent: MatrixEvent;
    content: string;
    count: number;
    reactionEvents: MatrixEvent[];
    myReactionEvent: MatrixEvent | null;
    customReactionImagesEnabled: boolean;
    disabled?: boolean;
}

export function ReactionsRowButton({
    client,
    room,
    mxEvent,
    content,
    count,
    reactionEvents,
    myReactionEvent,
    customReactionImagesEnabled,
    disabled = false,
}: ReactionsRowButtonProps): React.ReactElement {
    const customReactionName = useMemo(() => {
        for (const reactionEvent of reactionEvents) {
            const shortcode = readReactionShortcode(reactionEvent);
            if (shortcode) {
                return shortcode;
            }
        }

        return null;
    }, [reactionEvents]);

    const tooltipLabel = useMemo(() => {
        const senderNames = reactionEvents.map((reactionEvent) => {
            const senderId = reactionEvent.getSender() ?? "unknown";
            const member = room.getMember(senderId);
            return member?.name || senderId;
        });
        const reactionLabel = customReactionName || content;
        return `${formatReactors(senderNames)} reacted with ${reactionLabel}`;
    }, [content, customReactionName, reactionEvents, room]);

    const imageSrc = useMemo(
        () => (customReactionImagesEnabled && content.startsWith("mxc://") ? mxcToHttp(client, content) : null),
        [client, content, customReactionImagesEnabled],
    );

    const onClick = async (): Promise<void> => {
        if (disabled) {
            return;
        }

        const eventId = mxEvent.getId();
        if (!eventId) {
            return;
        }

        if (myReactionEvent) {
            const myReactionEventId = myReactionEvent.getId();
            if (myReactionEventId) {
                await client.redactEvent(room.roomId, myReactionEventId);
            }
            return;
        }

        const payload: Record<string, unknown> = {
            "m.relates_to": {
                rel_type: RelationType.Annotation,
                event_id: eventId,
                key: content,
            },
        };

        if (content.startsWith("mxc://") && customReactionName) {
            payload[REACTION_SHORTCODE_FIELD_STABLE] = customReactionName;
            payload[REACTION_SHORTCODE_FIELD_UNSTABLE] = customReactionName;
        }

        await client.sendEvent(room.roomId, EventType.Reaction, payload as any, "");
    };

    return (
        <button
            type="button"
            className={`reactions-row-button${myReactionEvent ? " is-selected" : ""}`}
            onClick={() => {
                void onClick();
            }}
            aria-label={tooltipLabel}
            title={tooltipLabel}
            disabled={disabled}
        >
            {imageSrc ? (
                <img
                    className="reactions-row-button-image"
                    src={imageSrc}
                    alt={customReactionName || "reaction image"}
                    loading="lazy"
                    decoding="async"
                />
            ) : (
                <span className="reactions-row-button-content">{content}</span>
            )}
            <span className="reactions-row-button-count">{count}</span>
        </button>
    );
}
