import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { useMemo } from "react";

import { SPACE_EMOJI_PACK_EVENT_TYPE } from "../emoji/EmojiPackTypes";

export interface SpacePermissions {
    canEditName: boolean;
    canEditTopic: boolean;
    canEditAvatar: boolean;
    canEditEmojiPack: boolean;
}

const DEFAULT_PERMISSIONS: SpacePermissions = {
    canEditName: false,
    canEditTopic: false,
    canEditAvatar: false,
    canEditEmojiPack: false,
};

function canSendStateEvent(room: Room | null, userId: string | null, eventType: string): boolean {
    if (!room || !userId) {
        return false;
    }

    return room.currentState.maySendStateEvent(eventType, userId);
}

export function getSpacePermissions(client: MatrixClient, room: Room | null): SpacePermissions {
    const userId = client.getUserId();
    return {
        canEditName: canSendStateEvent(room, userId, EventType.RoomName),
        canEditTopic: canSendStateEvent(room, userId, EventType.RoomTopic),
        canEditAvatar: canSendStateEvent(room, userId, EventType.RoomAvatar),
        canEditEmojiPack: canSendStateEvent(room, userId, SPACE_EMOJI_PACK_EVENT_TYPE),
    };
}

export function useSpacePermissions(client: MatrixClient, room: Room | null): SpacePermissions {
    const roomVersion = room?.roomId ?? "";
    const myUserId = client.getUserId() ?? "";

    return useMemo(() => getSpacePermissions(client, room), [client, room, roomVersion, myUserId]);
}

export function getPowerRoleLabel(level: number): "Admin" | "Mod" | "Member" {
    if (level >= 100) {
        return "Admin";
    }

    if (level >= 50) {
        return "Mod";
    }

    return "Member";
}

