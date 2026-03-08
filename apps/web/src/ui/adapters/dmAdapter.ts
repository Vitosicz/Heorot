import {
    EventType,
    Preset,
    type MatrixClient,
    type Room,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";

const MATRIX_USER_ID_PATTERN = /^@[^:\s]+:[^\s]+$/;

export interface DirectChatResult {
    roomId: string;
    created: boolean;
}

type MDirectContent = Record<string, string[]>;

function isActiveMembership(membership: string | null | undefined): boolean {
    return membership === "join" || membership === "invite" || membership === "knock";
}

function sanitizeMDirectContent(raw: unknown): MDirectContent {
    if (!raw || typeof raw !== "object") {
        return {};
    }

    const sanitized: MDirectContent = {};
    for (const [userId, roomIds] of Object.entries(raw)) {
        if (typeof userId !== "string" || !Array.isArray(roomIds)) {
            continue;
        }

        const validRoomIds = roomIds.filter((roomId): roomId is string => typeof roomId === "string");
        if (validRoomIds.length === 0) {
            continue;
        }

        sanitized[userId] = [...new Set(validRoomIds)];
    }

    return sanitized;
}

function getRoomLastTimestamp(room: Room): number {
    const roomAsExtended = room as Room & { getLastActiveTimestamp?: () => number };
    return roomAsExtended.getLastActiveTimestamp?.() ?? 0;
}

function sanitizeTargetUserIds(targetUserIds: string[]): string[] {
    return [...new Set(targetUserIds.map((userId) => userId.trim()).filter((userId) => userId.length > 0))];
}

function assertValidDirectTargets(client: MatrixClient, targetUserIds: string[]): { ownUserId: string; targets: string[] } {
    const ownUserId = client.getUserId() ?? "";
    if (!ownUserId) {
        throw new Error("Matrix client is not ready.");
    }

    const targets = sanitizeTargetUserIds(targetUserIds);
    if (targets.length === 0) {
        throw new Error("Select at least one user.");
    }

    for (const targetUserId of targets) {
        if (!isValidMatrixUserId(targetUserId)) {
            throw new Error("Enter a valid Matrix user ID (example: @alice:example.org).");
        }

        if (targetUserId === ownUserId) {
            throw new Error("You cannot create a direct chat with yourself.");
        }
    }

    return { ownUserId, targets };
}

function getActiveMembers(room: Room): RoomMember[] {
    return room.currentState.getMembers().filter((member) => isActiveMembership(member.membership));
}

function pickLikelyDmTarget(room: Room, ownUserId: string): string | null {
    const otherMembers = getActiveMembers(room).filter((member) => member.userId !== ownUserId);
    if (otherMembers.length === 0) {
        return null;
    }

    if (otherMembers.length === 1) {
        return otherMembers[0].userId;
    }

    let oldestMember: RoomMember | null = null;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const member of otherMembers) {
        const timestamp = (member as RoomMember & { events?: { member?: { getTs?: () => number } } }).events
            ?.member?.getTs?.();
        if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp < oldestTimestamp) {
            oldestTimestamp = timestamp;
            oldestMember = member;
        }
    }

    return oldestMember?.userId ?? otherMembers[0].userId;
}

function patchSelfMappedDirectRooms(client: MatrixClient, content: MDirectContent): MDirectContent {
    const ownUserId = client.getUserId();
    if (!ownUserId) {
        return content;
    }

    const selfMapped = content[ownUserId];
    if (!selfMapped || selfMapped.length === 0) {
        return content;
    }

    const patched: MDirectContent = Object.fromEntries(
        Object.entries(content).map(([userId, roomIds]) => [userId, [...roomIds]]),
    );
    const stillSelfMapped: string[] = [];

    for (const roomId of selfMapped) {
        const room = client.getRoom(roomId);
        if (!room) {
            stillSelfMapped.push(roomId);
            continue;
        }

        const guessedTarget = pickLikelyDmTarget(room, ownUserId);
        if (!guessedTarget || guessedTarget === ownUserId) {
            stillSelfMapped.push(roomId);
            continue;
        }

        patched[guessedTarget] = patched[guessedTarget] ?? [];
        if (!patched[guessedTarget].includes(roomId)) {
            patched[guessedTarget].push(roomId);
        }
    }

    if (stillSelfMapped.length > 0) {
        patched[ownUserId] = [...new Set(stillSelfMapped)];
    } else {
        delete patched[ownUserId];
    }

    return patched;
}

function toComparableShape(content: MDirectContent): Record<string, string[]> {
    return Object.fromEntries(
        Object.keys(content)
            .sort()
            .map((userId) => [userId, [...new Set(content[userId])].sort()]),
    );
}

function isDirectContentEqual(left: MDirectContent, right: MDirectContent): boolean {
    return JSON.stringify(toComparableShape(left)) === JSON.stringify(toComparableShape(right));
}

function isRoomMappedDmCandidate(room: Room, targetUserId: string): boolean {
    if (room.isSpaceRoom()) {
        return false;
    }

    const myMembership = room.getMyMembership();
    if (!isActiveMembership(myMembership)) {
        return false;
    }

    const targetMember = room.getMember(targetUserId);
    return Boolean(targetMember && isActiveMembership(targetMember.membership));
}

function isRoomUsableAsDmFallback(room: Room, targetUserId: string, ownUserId: string): boolean {
    if (!isRoomMappedDmCandidate(room, targetUserId)) {
        return false;
    }

    const activeMembers = getActiveMembers(room).filter((member) => member.userId !== ownUserId);
    return activeMembers.length === 1 && activeMembers[0].userId === targetUserId;
}

function sortRoomsByActivity(rooms: Room[]): Room[] {
    return [...rooms].sort((left, right) => getRoomLastTimestamp(right) - getRoomLastTimestamp(left));
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

function buildSpaceChildRoomIdSet(client: MatrixClient): Set<string> {
    const childRoomIds = new Set<string>();
    const spaces = client.getRooms().filter((candidate) => candidate.isSpaceRoom());

    for (const space of spaces) {
        const childEvents = toStateEventsArray(space.currentState.getStateEvents(EventType.SpaceChild));
        for (const childEvent of childEvents) {
            const childRoomId = childEvent.getStateKey();
            if (typeof childRoomId === "string" && childRoomId.length > 0) {
                childRoomIds.add(childRoomId);
            }
        }
    }

    return childRoomIds;
}

function hasSpaceParent(room: Room): boolean {
    const parentEvents = toStateEventsArray(room.currentState.getStateEvents(EventType.SpaceParent));
    return parentEvents.some((event) => {
        const parentRoomId = event.getStateKey();
        return typeof parentRoomId === "string" && parentRoomId.length > 0;
    });
}

function findMappedDirectRoomId(client: MatrixClient, targetUserId: string): string | null {
    const rawDirectContent = client.getAccountData(EventType.Direct)?.getContent();
    const sanitized = patchSelfMappedDirectRooms(client, sanitizeMDirectContent(rawDirectContent));
    const mappedRoomIds = sanitized[targetUserId];
    if (!mappedRoomIds || mappedRoomIds.length === 0) {
        return null;
    }

    const mappedRooms = sortRoomsByActivity(
        mappedRoomIds
            .map((roomId) => client.getRoom(roomId))
            .filter((room): room is Room => Boolean(room))
            .filter((room) => isRoomMappedDmCandidate(room, targetUserId)),
    );

    return mappedRooms[0]?.roomId ?? null;
}

function findFallbackDirectRoomId(client: MatrixClient, targetUserId: string, ownUserId: string): string | null {
    const candidates = sortRoomsByActivity(
        client
            .getRooms()
            .filter((room) => isRoomUsableAsDmFallback(room, targetUserId, ownUserId)),
    );
    return candidates[0]?.roomId ?? null;
}

function intersectMappedRoomIds(content: MDirectContent, targetUserIds: string[]): string[] {
    const roomLists = targetUserIds.map((targetUserId) => content[targetUserId] ?? []);
    if (roomLists.some((roomIds) => roomIds.length === 0)) {
        return [];
    }

    const sharedRoomIds = new Set(roomLists[0]);
    for (let index = 1; index < roomLists.length; index += 1) {
        const candidateSet = new Set(roomLists[index]);
        for (const roomId of [...sharedRoomIds]) {
            if (!candidateSet.has(roomId)) {
                sharedRoomIds.delete(roomId);
            }
        }
    }

    return Array.from(sharedRoomIds);
}

function isRoomMappedGroupCandidate(room: Room, targetUserIds: string[], ownUserId: string): boolean {
    if (room.isSpaceRoom()) {
        return false;
    }

    if (!isActiveMembership(room.getMyMembership())) {
        return false;
    }

    for (const targetUserId of targetUserIds) {
        const targetMember = room.getMember(targetUserId);
        if (!targetMember || !isActiveMembership(targetMember.membership)) {
            return false;
        }
    }

    const activeMembers = getActiveMembers(room).filter((member) => member.userId !== ownUserId);
    if (activeMembers.length !== targetUserIds.length) {
        return false;
    }

    const targetSet = new Set(targetUserIds);
    return activeMembers.every((member) => targetSet.has(member.userId));
}

function isRoomUsableAsGroupDmFallback(room: Room, targetUserIds: string[], ownUserId: string): boolean {
    return isRoomMappedGroupCandidate(room, targetUserIds, ownUserId);
}

function findMappedDirectGroupRoomId(client: MatrixClient, targetUserIds: string[], ownUserId: string): string | null {
    const rawDirectContent = client.getAccountData(EventType.Direct)?.getContent();
    const sanitized = patchSelfMappedDirectRooms(client, sanitizeMDirectContent(rawDirectContent));
    const mappedRoomIds = intersectMappedRoomIds(sanitized, targetUserIds);
    if (mappedRoomIds.length === 0) {
        return null;
    }

    const mappedRooms = sortRoomsByActivity(
        mappedRoomIds
            .map((roomId) => client.getRoom(roomId))
            .filter((room): room is Room => Boolean(room))
            .filter((room) => isRoomMappedGroupCandidate(room, targetUserIds, ownUserId)),
    );

    return mappedRooms[0]?.roomId ?? null;
}

function findFallbackDirectGroupRoomId(client: MatrixClient, targetUserIds: string[], ownUserId: string): string | null {
    const candidates = sortRoomsByActivity(
        client
            .getRooms()
            .filter((room) => isRoomUsableAsGroupDmFallback(room, targetUserIds, ownUserId)),
    );
    return candidates[0]?.roomId ?? null;
}

export function isValidMatrixUserId(userId: string): boolean {
    return MATRIX_USER_ID_PATTERN.test(userId.trim());
}

export function getDirectRoomIds(client: MatrixClient): Set<string> {
    const rawContent = client.getAccountData(EventType.Direct)?.getContent();
    const sanitized = patchSelfMappedDirectRooms(client, sanitizeMDirectContent(rawContent));
    const roomIds = new Set<string>();
    const spaceChildRoomIds = buildSpaceChildRoomIdSet(client);

    for (const mapped of Object.values(sanitized)) {
        for (const roomId of mapped) {
            const room = client.getRoom(roomId);
            if (!room || room.isSpaceRoom()) {
                continue;
            }
            if (spaceChildRoomIds.has(roomId) || hasSpaceParent(room)) {
                continue;
            }
            roomIds.add(roomId);
        }
    }

    return roomIds;
}

export function findExistingDirectRoomId(client: MatrixClient, targetUserId: string): string | null {
    const ownUserId = client.getUserId();
    if (!ownUserId) {
        return null;
    }

    return findMappedDirectRoomId(client, targetUserId) ?? findFallbackDirectRoomId(client, targetUserId, ownUserId);
}

export function findExistingDirectGroupRoomId(client: MatrixClient, targetUserIds: string[]): string | null {
    const ownUserId = client.getUserId();
    if (!ownUserId) {
        return null;
    }

    const normalizedTargets = sanitizeTargetUserIds(targetUserIds);
    if (normalizedTargets.length < 2) {
        return null;
    }

    return findMappedDirectGroupRoomId(client, normalizedTargets, ownUserId) ??
        findFallbackDirectGroupRoomId(client, normalizedTargets, ownUserId);
}

export async function ensureDirectRoomMapping(
    client: MatrixClient,
    roomId: string,
    targetUserId: string,
): Promise<void> {
    await ensureDirectRoomMappings(client, roomId, [targetUserId]);
}

export async function ensureDirectRoomMappings(
    client: MatrixClient,
    roomId: string,
    targetUserIds: string[],
    options?: {
        replaceExisting?: boolean;
    },
): Promise<void> {
    if (client.isGuest()) {
        return;
    }

    const normalizedTargets = sanitizeTargetUserIds(targetUserIds).filter(isValidMatrixUserId);
    if (normalizedTargets.length === 0) {
        return;
    }

    const rawContent = client.getAccountData(EventType.Direct)?.getContent();
    const original = sanitizeMDirectContent(rawContent);
    const patchedOriginal = patchSelfMappedDirectRooms(client, original);
    const next: MDirectContent = Object.fromEntries(
        Object.entries(patchedOriginal).map(([userId, roomIds]) => [userId, [...roomIds]]),
    );

    const replaceExisting = options?.replaceExisting !== false;
    if (replaceExisting) {
        for (const userId of Object.keys(next)) {
            next[userId] = next[userId].filter((mappedRoomId) => mappedRoomId !== roomId);
            if (next[userId].length === 0) {
                delete next[userId];
            }
        }
    }

    for (const targetUserId of normalizedTargets) {
        next[targetUserId] = next[targetUserId] ?? [];
        if (!next[targetUserId].includes(roomId)) {
            next[targetUserId].push(roomId);
        }
    }

    if (isDirectContentEqual(patchedOriginal, next)) {
        return;
    }

    await client.setAccountData(EventType.Direct, next);
}

export async function createOrReuseDirectChat(
    client: MatrixClient,
    targetUserId: string,
): Promise<DirectChatResult> {
    const { targets } = assertValidDirectTargets(client, [targetUserId]);
    const trimmedTarget = targets[0];

    const existingRoomId = findExistingDirectRoomId(client, trimmedTarget);
    if (existingRoomId) {
        await ensureDirectRoomMappings(client, existingRoomId, [trimmedTarget]).catch(() => undefined);
        return { roomId: existingRoomId, created: false };
    }

    const response = await client.createRoom({
        is_direct: true,
        invite: [trimmedTarget],
        preset: Preset.TrustedPrivateChat,
    } as any);

    await ensureDirectRoomMappings(client, response.room_id, [trimmedTarget]).catch(() => undefined);
    return { roomId: response.room_id, created: true };
}

export async function createOrReuseDirectGroupChat(
    client: MatrixClient,
    targetUserIds: string[],
): Promise<DirectChatResult> {
    const { targets } = assertValidDirectTargets(client, targetUserIds);
    if (targets.length < 2) {
        throw new Error("Add at least two users to start a group chat.");
    }

    const existingRoomId = findExistingDirectGroupRoomId(client, targets);
    if (existingRoomId) {
        await ensureDirectRoomMappings(client, existingRoomId, targets, { replaceExisting: false }).catch(() => undefined);
        return { roomId: existingRoomId, created: false };
    }

    const response = await client.createRoom({
        invite: targets,
        preset: Preset.PrivateChat,
    } as any);

    await ensureDirectRoomMappings(client, response.room_id, targets, { replaceExisting: false }).catch(() => undefined);
    return { roomId: response.room_id, created: true };
}
