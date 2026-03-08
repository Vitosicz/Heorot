import { useCallback, useEffect, useState } from "react";
import { RoomMemberEvent, type MatrixClient, type MatrixEvent, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

function getTypingUserIds(room: Room | null, ownUserId: string | null): string[] {
    if (!room) {
        return [];
    }

    const typingMembers = room
        .getMembers()
        .filter(
            (member) =>
                member.typing &&
                (member.membership === "join" || member.membership === "invite") &&
                member.userId !== ownUserId,
        )
        .sort((left, right) => {
            const leftName = left.rawDisplayName || left.name || left.userId;
            const rightName = right.rawDisplayName || right.name || right.userId;
            return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
        });

    return typingMembers.map((member) => member.userId);
}

export function useRoomTyping(client: MatrixClient, room: Room | null): string[] {
    const ownUserId = client.getUserId();
    const [typingUserIds, setTypingUserIds] = useState<string[]>(() => getTypingUserIds(room, ownUserId));

    const refreshTyping = useCallback((): void => {
        setTypingUserIds(getTypingUserIds(room, ownUserId));
    }, [room, ownUserId]);

    useEffect(() => {
        refreshTyping();
    }, [refreshTyping]);

    useEffect(() => {
        if (!room) {
            setTypingUserIds([]);
            return undefined;
        }

        const onTypingChanged = (_event: MatrixEvent, member: RoomMember): void => {
            if (member.roomId !== room.roomId) {
                return;
            }
            refreshTyping();
        };

        client.on(RoomMemberEvent.Typing, onTypingChanged);
        return () => {
            client.removeListener(RoomMemberEvent.Typing, onTypingChanged);
        };
    }, [client, refreshTyping, room]);

    return typingUserIds;
}
