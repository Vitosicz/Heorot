import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { getPersonalPack, getSpacePack, normalizeEmojiShortcode } from "./EmojiPackStore";
import { type ResolvedEmoji } from "./EmojiPackTypes";

function appendUnique(target: string[], value: string | null | undefined): void {
    if (!value || target.includes(value)) {
        return;
    }

    target.push(value);
}

function appendParentSpaces(target: string[], room: Room): void {
    const parentEvents = room.currentState.getStateEvents(EventType.SpaceParent);
    const parents = Array.isArray(parentEvents) ? parentEvents : parentEvents ? [parentEvents] : [];

    for (const parentEvent of parents) {
        appendUnique(target, parentEvent.getStateKey());
    }
}

function appendContainingSpaces(target: string[], client: MatrixClient, roomId: string): void {
    const candidateSpaces = client.getRooms().filter((candidate) => candidate.isSpaceRoom());

    for (const candidateSpace of candidateSpaces) {
        const childEvents = candidateSpace.currentState.getStateEvents(EventType.SpaceChild);
        const children = Array.isArray(childEvents) ? childEvents : childEvents ? [childEvents] : [];
        if (children.some((childEvent) => childEvent.getStateKey() === roomId)) {
            appendUnique(target, candidateSpace.roomId);
        }
    }
}

function resolveSpaceIdsForRoom(client: MatrixClient, room: Room, activeSpaceId: string | null): string[] {
    const candidates: string[] = [];
    appendUnique(candidates, activeSpaceId);
    appendParentSpaces(candidates, room);
    appendContainingSpaces(candidates, client, room.roomId);
    return candidates;
}

function toResolvedList(emojis: Record<string, { url: string; name: string }>): ResolvedEmoji[] {
    return Object.entries(emojis)
        .map(([shortcode, emoji]) => ({
            shortcode,
            url: emoji.url,
            name: emoji.name,
        }))
        .sort((left, right) => left.shortcode.localeCompare(right.shortcode));
}

export async function resolveEmojiShortcode(
    client: MatrixClient,
    room: Room,
    shortcodeInput: string,
    activeSpaceId: string | null,
): Promise<ResolvedEmoji | null> {
    const shortcode = normalizeEmojiShortcode(shortcodeInput);
    const spaceIds = resolveSpaceIdsForRoom(client, room, activeSpaceId);
    for (const spaceId of spaceIds) {
        const spacePack = await getSpacePack(client, spaceId);
        const found = spacePack?.emojis[shortcode];
        if (found) {
            return {
                shortcode,
                url: found.url,
                name: found.name,
            };
        }
    }

    const personalPack = await getPersonalPack(client);
    const personal = personalPack?.emojis[shortcode];
    if (!personal) {
        return null;
    }

    return {
        shortcode,
        url: personal.url,
        name: personal.name,
    };
}

export async function loadAvailableEmojis(
    client: MatrixClient,
    room: Room | null,
    activeSpaceId: string | null,
): Promise<ResolvedEmoji[]> {
    if (!room) {
        const personalPack = await getPersonalPack(client);
        return personalPack ? toResolvedList(personalPack.emojis) : [];
    }

    const merged = new Map<string, ResolvedEmoji>();
    const spaceIds = resolveSpaceIdsForRoom(client, room, activeSpaceId);
    for (const spaceId of spaceIds) {
        const spacePack = await getSpacePack(client, spaceId);
        for (const emoji of toResolvedList(spacePack?.emojis ?? {})) {
            if (!merged.has(emoji.shortcode)) {
                merged.set(emoji.shortcode, emoji);
            }
        }
    }

    const personalPack = await getPersonalPack(client);
    for (const emoji of toResolvedList(personalPack?.emojis ?? {})) {
        if (!merged.has(emoji.shortcode)) {
            merged.set(emoji.shortcode, emoji);
        }
    }

    return [...merged.values()].sort((left, right) => left.shortcode.localeCompare(right.shortcode));
}
