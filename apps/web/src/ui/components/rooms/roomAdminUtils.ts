import { EventType, KnownMembership, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

interface PowerLevelsContent {
    users?: Record<string, number>;
    users_default?: number;
    invite?: number;
    redact?: number;
    kick?: number;
    ban?: number;
}

function parseNumberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsers(content: unknown): Record<string, number> {
    if (!content || typeof content !== "object") {
        return {};
    }

    const parsed: Record<string, number> = {};
    for (const [userId, level] of Object.entries(content as Record<string, unknown>)) {
        if (typeof userId !== "string" || userId.length === 0) {
            continue;
        }

        if (typeof level === "number" && Number.isFinite(level)) {
            parsed[userId] = level;
        }
    }

    return parsed;
}

export function getRoomDisplayName(room: Room): string {
    return room.name || room.getCanonicalAlias() || room.roomId;
}

export function getPowerLevelsContent(room: Room): PowerLevelsContent {
    const event = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    const content = (event?.getContent() ?? {}) as Record<string, unknown>;

    return {
        users: parseUsers(content.users),
        users_default: parseNumberOrUndefined(content.users_default) ?? 0,
        invite: parseNumberOrUndefined(content.invite),
        redact: parseNumberOrUndefined(content.redact),
        kick: parseNumberOrUndefined(content.kick),
        ban: parseNumberOrUndefined(content.ban),
    };
}

export function getUserPowerLevel(room: Room, userId: string): number {
    const powerLevels = getPowerLevelsContent(room);
    const userLevel = powerLevels.users?.[userId];
    if (typeof userLevel === "number") {
        return userLevel;
    }
    return powerLevels.users_default ?? 0;
}

export function getActionPowerLevel(room: Room, action: "invite" | "redact" | "kick" | "ban"): number {
    const powerLevels = getPowerLevelsContent(room);
    const value = powerLevels[action];
    if (typeof value === "number") {
        return value;
    }

    if (action === "invite") {
        return 0;
    }

    return 50;
}

export function getJoinedOrInvitedMembers(room: Room): RoomMember[] {
    return room.currentState
        .getMembers()
        .filter((member) => member.membership === KnownMembership.Join || member.membership === KnownMembership.Invite)
        .sort((left, right) => {
            const leftName = left.rawDisplayName || left.name || left.userId;
            const rightName = right.rawDisplayName || right.name || right.userId;
            return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
        });
}

export function getBannedMembers(room: Room): RoomMember[] {
    return room.currentState
        .getMembers()
        .filter((member) => member.membership === KnownMembership.Ban)
        .sort((left, right) => left.userId.localeCompare(right.userId));
}
