import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import {
    type EmojiDefinition,
    type EmojiPackContent,
    PERSONAL_EMOJI_PACK_EVENT_TYPE,
    REACTION_IMAGE_SETTING_KEY,
    SPACE_EMOJI_PACK_EVENT_TYPE,
} from "./EmojiPackTypes";
import { emitEmojiPackUpdated } from "./emojiEvents";

const EMPTY_PACK: EmojiPackContent = {
    version: 1,
    emojis: {},
};

const spacePackCache = new Map<string, EmojiPackContent | null>();
let personalPackCache: EmojiPackContent | null | undefined;

function clonePack(pack: EmojiPackContent | null): EmojiPackContent | null {
    if (!pack) {
        return null;
    }

    return {
        version: 1,
        emojis: { ...pack.emojis },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidShortcodeBodyChar(character: string): boolean {
    if (character.length !== 1) {
        return false;
    }

    const code = character.charCodeAt(0);
    const isLowercaseLetter = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    return isLowercaseLetter || isDigit || character === "_" || character === "+" || character === "-";
}

function isValidNormalizedShortcode(value: string): boolean {
    if (value.length < 3 || !value.startsWith(":") || !value.endsWith(":")) {
        return false;
    }

    for (let index = 1; index < value.length - 1; index++) {
        if (!isValidShortcodeBodyChar(value[index])) {
            return false;
        }
    }

    return true;
}

function normalizePackShortcode(raw: string): string | null {
    const normalized = normalizeShortcode(raw);
    return isValidNormalizedShortcode(normalized) ? normalized : null;
}

function normalizeEmojiEntry(
    value: unknown,
    fallbackShortcode: string,
): Omit<EmojiDefinition, "name"> & { name?: string } | null {
    if (typeof value === "string") {
        if (!value.startsWith("mxc://")) {
            return null;
        }

        return { url: value };
    }

    if (!isRecord(value)) {
        return null;
    }

    const rawUrl = value.url ?? value.mxc ?? value.src;
    if (typeof rawUrl !== "string" || !rawUrl.startsWith("mxc://")) {
        return null;
    }

    return {
        url: rawUrl,
        name: typeof value.name === "string" && value.name.trim() ? value.name : fallbackShortcode.slice(1, -1),
        created_by: typeof value.created_by === "string" ? value.created_by : undefined,
        created_ts: typeof value.created_ts === "number" ? value.created_ts : undefined,
    };
}

function mergeEmojiMap(
    target: Record<string, EmojiDefinition>,
    source: Record<string, unknown>,
    requireShortcodeKeys: boolean,
): void {
    for (const [rawShortcode, rawEntry] of Object.entries(source)) {
        const shortcode = normalizePackShortcode(rawShortcode);
        if (!shortcode) {
            if (requireShortcodeKeys) {
                continue;
            }

            if (!isRecord(rawEntry) || typeof rawEntry.shortcode !== "string") {
                continue;
            }
        }

        const candidateShortcode =
            shortcode ??
            (isRecord(rawEntry) && typeof rawEntry.shortcode === "string"
                ? normalizePackShortcode(rawEntry.shortcode)
                : null);
        if (!candidateShortcode) {
            continue;
        }

        const normalizedEntry = normalizeEmojiEntry(rawEntry, candidateShortcode);
        if (!normalizedEntry) {
            continue;
        }

        target[candidateShortcode] = {
            url: normalizedEntry.url,
            name:
                typeof normalizedEntry.name === "string" && normalizedEntry.name.trim()
                    ? normalizedEntry.name
                    : candidateShortcode.slice(1, -1),
            created_by: normalizedEntry.created_by,
            created_ts: normalizedEntry.created_ts,
        };
    }
}

function mergeEmojiArray(target: Record<string, EmojiDefinition>, source: unknown[]): void {
    for (const item of source) {
        if (!isRecord(item) || typeof item.shortcode !== "string") {
            continue;
        }

        const shortcode = normalizePackShortcode(item.shortcode);
        if (!shortcode) {
            continue;
        }

        const normalizedEntry = normalizeEmojiEntry(item, shortcode);
        if (!normalizedEntry) {
            continue;
        }

        target[shortcode] = {
            url: normalizedEntry.url,
            name: typeof normalizedEntry.name === "string" && normalizedEntry.name.trim() ? normalizedEntry.name : shortcode.slice(1, -1),
            created_by: normalizedEntry.created_by,
            created_ts: normalizedEntry.created_ts,
        };
    }
}

function mergeEmojiCollection(
    target: Record<string, EmojiDefinition>,
    source: unknown,
    requireShortcodeKeys: boolean,
): void {
    if (Array.isArray(source)) {
        mergeEmojiArray(target, source);
        return;
    }

    if (isRecord(source)) {
        mergeEmojiMap(target, source, requireShortcodeKeys);
    }
}

function normalizePackContent(raw: unknown): EmojiPackContent | null {
    if (!isRecord(raw)) {
        return null;
    }

    const content = raw as Record<string, unknown>;
    const normalized: Record<string, EmojiDefinition> = {};

    const hasVersionMarker = content.version === 1;
    const hasEmojiCollection = Object.prototype.hasOwnProperty.call(content, "emojis");

    if (hasEmojiCollection) {
        mergeEmojiCollection(normalized, content.emojis, true);
    }

    if (Object.keys(normalized).length === 0) {
        mergeEmojiMap(normalized, content, false);
    }

    const hasLegacyShortcodeKeys = Object.keys(content).some((key) => {
        const normalizedKey = normalizePackShortcode(key);
        return Boolean(normalizedKey);
    });

    if (!hasVersionMarker && !hasEmojiCollection && !hasLegacyShortcodeKeys && Object.keys(normalized).length === 0) {
        return null;
    }

    return {
        version: 1,
        emojis: normalized,
    };
}

function normalizeShortcode(raw: string): string {
    const trimmed = raw.trim().toLowerCase();
    let withoutWhitespace = "";

    for (let index = 0; index < trimmed.length; index++) {
        const character = trimmed[index];
        if (character.trim().length === 0) {
            continue;
        }

        withoutWhitespace += character;
    }

    let start = 0;
    let end = withoutWhitespace.length;
    while (start < end && withoutWhitespace[start] === ":") {
        start += 1;
    }
    while (end > start && withoutWhitespace[end - 1] === ":") {
        end -= 1;
    }

    const stripped = withoutWhitespace.slice(start, end);
    return `:${stripped}:`;
}

function sanitizePack(pack: EmojiPackContent): EmojiPackContent {
    return normalizePackContent(pack) ?? clonePack(EMPTY_PACK)!;
}

export function canEditSpacePack(client: MatrixClient, room: Room | null): boolean {
    if (!room) {
        return false;
    }

    const userId = client.getUserId();
    if (!userId) {
        return false;
    }

    return room.currentState.maySendStateEvent(SPACE_EMOJI_PACK_EVENT_TYPE, userId);
}

export async function getSpacePack(client: MatrixClient, spaceId: string): Promise<EmojiPackContent | null> {
    const room = client.getRoom(spaceId);
    if (!room) {
        spacePackCache.set(spaceId, null);
        return null;
    }

    if (spacePackCache.has(spaceId)) {
        return clonePack(spacePackCache.get(spaceId) ?? null);
    }

    const stateEvent = room.currentState.getStateEvents(SPACE_EMOJI_PACK_EVENT_TYPE, "");
    const pack = normalizePackContent(stateEvent?.getContent());
    spacePackCache.set(spaceId, pack);
    return clonePack(pack);
}

export async function getPersonalPack(client: MatrixClient): Promise<EmojiPackContent | null> {
    if (personalPackCache !== undefined) {
        return clonePack(personalPackCache ?? null);
    }

    const accountData = client.getAccountData(PERSONAL_EMOJI_PACK_EVENT_TYPE as any);
    const pack = normalizePackContent(accountData?.getContent());
    personalPackCache = pack;
    return clonePack(pack);
}

export async function saveSpacePack(client: MatrixClient, spaceId: string, pack: EmojiPackContent): Promise<void> {
    const sanitized = sanitizePack(pack);
    await client.sendStateEvent(spaceId, SPACE_EMOJI_PACK_EVENT_TYPE as any, sanitized as any, "");
    spacePackCache.set(spaceId, sanitized);
    emitEmojiPackUpdated({ kind: "space", spaceId });
}

export async function savePersonalPack(client: MatrixClient, pack: EmojiPackContent): Promise<void> {
    const sanitized = sanitizePack(pack);
    await client.setAccountData(PERSONAL_EMOJI_PACK_EVENT_TYPE as any, sanitized as any);
    personalPackCache = sanitized;
    emitEmojiPackUpdated({ kind: "personal" });
}

export async function upsertSpaceEmoji(
    client: MatrixClient,
    spaceId: string,
    shortcodeInput: string,
    emoji: Omit<EmojiDefinition, "name"> & { name?: string },
): Promise<string> {
    const shortcode = normalizeShortcode(shortcodeInput);
    const current = (await getSpacePack(client, spaceId)) ?? clonePack(EMPTY_PACK)!;
    current.emojis[shortcode] = {
        url: emoji.url,
        name: emoji.name ?? shortcode.slice(1, -1),
        created_by: emoji.created_by,
        created_ts: emoji.created_ts,
    };
    await saveSpacePack(client, spaceId, current);
    return shortcode;
}

export async function upsertPersonalEmoji(
    client: MatrixClient,
    shortcodeInput: string,
    emoji: Omit<EmojiDefinition, "name"> & { name?: string },
): Promise<string> {
    const shortcode = normalizeShortcode(shortcodeInput);
    const current = (await getPersonalPack(client)) ?? clonePack(EMPTY_PACK)!;
    current.emojis[shortcode] = {
        url: emoji.url,
        name: emoji.name ?? shortcode.slice(1, -1),
        created_by: emoji.created_by,
        created_ts: emoji.created_ts,
    };
    await savePersonalPack(client, current);
    return shortcode;
}

export function resetEmojiPackCache(spaceId?: string): void {
    if (spaceId) {
        spacePackCache.delete(spaceId);
        return;
    }

    spacePackCache.clear();
    personalPackCache = undefined;
}

export function getFeatureRenderReactionImages(): boolean {
    if (typeof window === "undefined") {
        return true;
    }

    const raw = window.localStorage.getItem(REACTION_IMAGE_SETTING_KEY);
    if (raw === null) {
        return true;
    }

    return raw === "true";
}

export function setFeatureRenderReactionImages(enabled: boolean): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(REACTION_IMAGE_SETTING_KEY, enabled ? "true" : "false");
}

export function normalizeEmojiShortcode(input: string): string {
    return normalizeShortcode(input);
}
