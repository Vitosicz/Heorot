import { useMemo } from "react";
import { EventType, MsgType, RelationType, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import { REACTION_SHORTCODE_FIELD_STABLE, REACTION_SHORTCODE_FIELD_UNSTABLE } from "../emoji/EmojiPackTypes";
import type { ReactionSelection } from "../components/ReactionPicker";
import { buildMatrixToEventPermalink } from "../utils/permalink";

interface UseMessageActionsArgs {
    client: MatrixClient;
    room: Room;
    event: MatrixEvent;
}

function stripPlainReplyFallback(body: string): string {
    const lines = body.split("\n");
    while (lines.length && lines[0].startsWith("> ")) {
        lines.shift();
    }
    if (lines[0] === "") {
        lines.shift();
    }
    return lines.join("\n");
}

function getPlainTextBody(event: MatrixEvent): string | null {
    const content = event.getContent() as { body?: unknown };
    if (typeof content.body !== "string") {
        return null;
    }

    const relation = event.getRelation();
    if (relation?.["m.in_reply_to"]) {
        return stripPlainReplyFallback(content.body);
    }

    return content.body;
}

export function useMessageActions({ client, room, event }: UseMessageActionsArgs): {
    isMine: boolean;
    canEdit: boolean;
    canDelete: boolean;
    plainTextBody: string | null;
    eventId: string | null;
    copyLink: () => Promise<void>;
    copyText: () => Promise<void>;
    copyEventId: () => Promise<void>;
    deleteMessage: () => Promise<void>;
    react: (selection: ReactionSelection) => Promise<void>;
} {
    const eventId = event.getId() ?? null;
    const userId = client.getUserId();

    const isMine = Boolean(userId && event.getSender() === userId);
    const plainTextBody = useMemo(() => getPlainTextBody(event), [event]);
    const content = event.getContent() as { msgtype?: unknown };
    const canEdit = isMine && !event.isRedacted() && event.getType() === EventType.RoomMessage && content.msgtype === MsgType.Text;
    const canDelete = isMine;

    const copyToClipboard = async (value: string): Promise<void> => {
        if (!navigator.clipboard?.writeText) {
            throw new Error("Clipboard API is not available.");
        }

        await navigator.clipboard.writeText(value);
    };

    const copyLink = async (): Promise<void> => {
        if (!eventId) {
            throw new Error("Cannot copy link for pending event.");
        }
        await copyToClipboard(buildMatrixToEventPermalink(room.roomId, eventId));
    };

    const copyText = async (): Promise<void> => {
        if (!plainTextBody || plainTextBody.trim().length === 0) {
            throw new Error("No text content to copy.");
        }
        await copyToClipboard(plainTextBody);
    };

    const copyEventId = async (): Promise<void> => {
        if (!eventId) {
            throw new Error("Event ID unavailable.");
        }
        await copyToClipboard(eventId);
    };

    const deleteMessage = async (): Promise<void> => {
        if (!eventId) {
            throw new Error("Cannot delete pending event.");
        }
        await client.redactEvent(room.roomId, eventId);
    };

    const react = async (selection: ReactionSelection): Promise<void> => {
        if (!eventId || !userId) {
            throw new Error("Cannot react before the message is synced.");
        }

        const relations =
            room.relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction) ?? null;
        const myAnnotations = relations?.getAnnotationsBySender()?.[userId] ?? new Set<MatrixEvent>();
        const existing = [...myAnnotations].find(
            (reactionEvent) => !reactionEvent.isRedacted() && reactionEvent.getRelation()?.key === selection.key,
        );

        if (existing) {
            const existingId = existing.getId();
            if (!existingId) {
                return;
            }

            await client.redactEvent(room.roomId, existingId);
            return;
        }

        const payload: Record<string, unknown> = {
            "m.relates_to": {
                rel_type: RelationType.Annotation,
                event_id: eventId,
                key: selection.key,
            },
        };

        if (selection.key.startsWith("mxc://") && selection.shortcode) {
            payload[REACTION_SHORTCODE_FIELD_STABLE] = selection.shortcode;
            payload[REACTION_SHORTCODE_FIELD_UNSTABLE] = selection.shortcode;
        }

        await client.sendEvent(room.roomId, EventType.Reaction, payload as any, "");
    };

    return {
        isMine,
        canEdit,
        canDelete,
        plainTextBody,
        eventId,
        copyLink,
        copyText,
        copyEventId,
        deleteMessage,
        react,
    };
}
