import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { isValidMatrixUserId } from "../dm/directChats";
import {
    getMatrixErrorCode,
    getMatrixErrorMessage,
    getMatrixErrorStatus,
    getMatrixRetryAfterMs,
} from "./matrixError";

export interface InviteFailure {
    userId: string;
    message: string;
}

export interface InviteUsersResult {
    invited: string[];
    failed: InviteFailure[];
}

interface ParentSpaceInviteFailure {
    spaceId: string;
    message: string;
}

const INVITE_SPLIT_PATTERN = /[\s,;]+/;

function normalizeReason(reason: string): string | undefined {
    const normalized = reason.trim();
    if (!normalized) {
        return undefined;
    }
    return normalized;
}

function describeInviteError(error: unknown): string {
    const status = getMatrixErrorStatus(error);
    const errcode = getMatrixErrorCode(error);
    const message = getMatrixErrorMessage(error);

    if (status === 403 || errcode === "M_FORBIDDEN") {
        return "You do not have permission to invite this user.";
    }

    if (status === 404 || errcode === "M_NOT_FOUND") {
        return "User was not found on the homeserver.";
    }

    if (status === 409 || errcode === "M_BAD_STATE") {
        return "User is already in this room.";
    }

    if (status === 429 || errcode === "M_LIMIT_EXCEEDED") {
        const retryAfterMs = getMatrixRetryAfterMs(error);
        if (retryAfterMs && retryAfterMs > 0) {
            const retryAfterSeconds = Math.max(1, Math.round(retryAfterMs / 1000));
            return `Invite rate limit reached. Try again in ${retryAfterSeconds}s.`;
        }
        return "Invite rate limit reached. Try again in a moment.";
    }

    if (status !== null && status >= 500) {
        return "Homeserver returned an error while inviting.";
    }

    if (message.length > 0) {
        return message;
    }

    return "Failed to invite user.";
}

function toStateEventsArray(rawEvents: unknown): Array<{ getStateKey: () => string | undefined | null }> {
    if (Array.isArray(rawEvents)) {
        return rawEvents as Array<{ getStateKey: () => string | undefined | null }>;
    }
    if (rawEvents) {
        return [rawEvents as { getStateKey: () => string | undefined | null }];
    }
    return [];
}

function getRoomDisplayName(room: Room | null, fallbackRoomId: string): string {
    if (!room) {
        return fallbackRoomId;
    }
    return room.name || room.getCanonicalAlias() || room.roomId;
}

function getInvitableParentSpaceIds(client: MatrixClient, roomId: string): string[] {
    const room = client.getRoom(roomId);
    if (!room || room.isSpaceRoom()) {
        return [];
    }

    const parentEvents = toStateEventsArray(room.currentState.getStateEvents(EventType.SpaceParent));
    const spaceIds = new Set<string>();

    for (const parentEvent of parentEvents) {
        const parentSpaceId = parentEvent.getStateKey();
        if (typeof parentSpaceId !== "string" || parentSpaceId.length === 0) {
            continue;
        }

        const parentSpace = client.getRoom(parentSpaceId);
        if (!parentSpace || !parentSpace.isSpaceRoom()) {
            continue;
        }

        spaceIds.add(parentSpaceId);
    }

    return Array.from(spaceIds);
}

function isAlreadyInRoomError(error: unknown): boolean {
    const status = getMatrixErrorStatus(error);
    const errcode = getMatrixErrorCode(error);
    if (status === 409 || errcode === "M_BAD_STATE") {
        return true;
    }

    const message = getMatrixErrorMessage(error).toLowerCase();
    return message.includes("already in") || message.includes("already joined");
}

async function inviteUserToParentSpaces(
    client: MatrixClient,
    parentSpaceIds: string[],
    targetUserId: string,
    reason?: string,
): Promise<ParentSpaceInviteFailure[]> {
    const failures: ParentSpaceInviteFailure[] = [];

    for (const parentSpaceId of parentSpaceIds) {
        try {
            await client.invite(parentSpaceId, targetUserId, reason);
        } catch (inviteError) {
            if (isAlreadyInRoomError(inviteError)) {
                continue;
            }

            failures.push({
                spaceId: parentSpaceId,
                message: describeInviteError(inviteError),
            });
        }
    }

    return failures;
}

export function parseInviteUserIds(rawInput: string): string[] {
    const tokens = rawInput
        .split(INVITE_SPLIT_PATTERN)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    return [...new Set(tokens)];
}

export async function inviteUsersToRoom(
    client: MatrixClient,
    roomId: string,
    rawInput: string,
    reason = "",
): Promise<InviteUsersResult> {
    const targetUserIds = parseInviteUserIds(rawInput);
    if (targetUserIds.length === 0) {
        throw new Error("Enter at least one Matrix user ID (example: @alice:example.org).");
    }

    const normalizedReason = normalizeReason(reason);
    const parentSpaceIds = getInvitableParentSpaceIds(client, roomId);
    const invited: string[] = [];
    const failed: InviteFailure[] = [];

    for (const targetUserId of targetUserIds) {
        if (!isValidMatrixUserId(targetUserId)) {
            failed.push({
                userId: targetUserId,
                message: "Invalid Matrix user ID format.",
            });
            continue;
        }

        try {
            await client.invite(roomId, targetUserId, normalizedReason);
            invited.push(targetUserId);

            if (parentSpaceIds.length > 0) {
                const parentInviteFailures = await inviteUserToParentSpaces(
                    client,
                    parentSpaceIds,
                    targetUserId,
                    normalizedReason,
                );
                if (parentInviteFailures.length > 0) {
                    const firstFailure = parentInviteFailures[0];
                    const parentSpace = client.getRoom(firstFailure.spaceId);
                    failed.push({
                        userId: targetUserId,
                        message: `Invited to channel, but failed to invite to server "${getRoomDisplayName(
                            parentSpace,
                            firstFailure.spaceId,
                        )}" (${firstFailure.message}).`,
                    });
                }
            }
        } catch (inviteError) {
            failed.push({
                userId: targetUserId,
                message: describeInviteError(inviteError),
            });
        }
    }

    return { invited, failed };
}

