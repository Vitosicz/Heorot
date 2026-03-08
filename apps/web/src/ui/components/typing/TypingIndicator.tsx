import React, { useMemo } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

interface TypingIndicatorProps {
    client: MatrixClient;
    room: Room | null;
    typingUserIds: string[];
}

function mxidLocalpart(userId: string): string {
    const normalized = userId.startsWith("@") ? userId.slice(1) : userId;
    const colonIndex = normalized.indexOf(":");
    return (colonIndex >= 0 ? normalized.slice(0, colonIndex) : normalized) || userId;
}

function getTypingDisplayNames(room: Room | null, typingUserIds: string[]): string[] {
    return typingUserIds.map((userId) => {
        const member = room?.getMember(userId);
        return member?.rawDisplayName || member?.name || mxidLocalpart(userId);
    });
}

function formatTypingText(names: string[]): string {
    if (names.length === 1) {
        return `${names[0]} is typing...`;
    }
    if (names.length === 2) {
        return `${names[0]} and ${names[1]} are typing...`;
    }
    if (names.length === 3) {
        return `${names[0]}, ${names[1]}, and ${names[2]} are typing...`;
    }

    const [first, second, third] = names;
    const remaining = names.length - 3;
    return `${first}, ${second}, and ${third} and ${remaining} more are typing...`;
}

export function TypingIndicator({ client, room, typingUserIds }: TypingIndicatorProps): React.ReactElement | null {
    const ownUserId = client.getUserId();
    const text = useMemo(() => {
        const filteredUserIds = typingUserIds.filter((userId) => userId !== ownUserId).slice(0, 32);
        if (filteredUserIds.length === 0) {
            return null;
        }

        const names = getTypingDisplayNames(room, filteredUserIds);
        return formatTypingText(names);
    }, [ownUserId, room, typingUserIds]);

    if (!text) {
        return null;
    }

    return (
        <div className="typing-indicator" role="status" aria-live="polite">
            {text}
        </div>
    );
}
