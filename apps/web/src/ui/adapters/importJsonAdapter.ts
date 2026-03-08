import { EventType, Preset, type MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    HEOROT_VOICE_CHANNEL_EVENT,
    HEOROT_SPACE_CHILD_CHANNEL_TYPE_KEY,
    HEOROT_SPACE_CHILD_VOICE_KEY,
    MATRIX_CALL_COMPAT_EVENT,
} from "../voice/voiceChannel";
import { getSpacePack, saveSpacePack } from "../emoji/EmojiPackStore";
import { createCategory, writeCategories, writeChannelOrder, type HeorotCategory } from "../stores/CategoryStore";

const CHANNEL_ACCESS_EVENT = "com.heorot.channel_access";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsonExportGuild {
    id: string;
    name: string;
}

export interface JsonExportCategory {
    id: string;
    name: string;
    position: number;
}

export interface JsonExportChannel {
    id: string;
    name: string;
    type: string; // "text" | "voice" | ...
    position: number;
    category_id: string | null;
    topic?: string | null;
    nsfw?: boolean;
    slowmode_delay?: number;
    bitrate?: number;
    user_limit?: number;
}

export interface JsonExportEmoji {
    id: string;
    name: string;
    shortcode: string;
    animated: boolean;
    path: string;
    status: string;
}

export interface JsonExport {
    exported_at: string;
    guild: JsonExportGuild;
    categories: JsonExportCategory[];
    channels: JsonExportChannel[];
    emojis: JsonExportEmoji[];
}

export interface ImportProgress {
    stage: "space" | "channels" | "emojis" | "done";
    current: number;
    total: number;
    message: string;
}

export type ProgressCallback = (progress: ImportProgress) => void;

export interface ImportResult {
    spaceId: string;
    channelsCreated: number;
    emojisUploaded: number;
    errors: string[];
}

// ---------------------------------------------------------------------------
// Rate limiting helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RateLimitState {
    pauseUntil: number;
}

async function withRateLimit<T>(
    fn: () => Promise<T>,
    sharedState?: RateLimitState,
    maxRetries = 6,
): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (sharedState) {
            const waitMs = sharedState.pauseUntil - Date.now();
            if (waitMs > 0) {
                await delay(waitMs);
            }
        }

        try {
            return await fn();
        } catch (err) {
            const httpStatus = (err as { httpStatus?: number }).httpStatus;
            if (httpStatus === 429 && attempt < maxRetries) {
                const retryAfterMs =
                    (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms ?? 5000;
                const retryAt = Date.now() + retryAfterMs + 100;
                if (sharedState) {
                    sharedState.pauseUntil = Math.max(sharedState.pauseUntil, retryAt);
                } else {
                    await delay(retryAfterMs + 100);
                }
                continue;
            }
            throw err;
        }
    }
    throw new Error("Max retries exceeded");
}

async function inParallel<T>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
    let next = 0;
    async function worker(): Promise<void> {
        while (next < items.length) {
            const i = next++;
            await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

export interface ImportSignal {
    cancelled: boolean;
}

export interface ChannelImportConfig {
    minPL: 0 | 50 | 100;
    isPublic: boolean;
    isEncrypted: boolean; // only meaningful for text channels
}

// ---------------------------------------------------------------------------
// Other helpers
// ---------------------------------------------------------------------------

function getViaServer(client: MatrixClient): string | null {
    const userId = client.getUserId();
    if (!userId) return null;
    const sep = userId.indexOf(":");
    if (sep < 0 || sep === userId.length - 1) return null;
    return userId.slice(sep + 1).trim() || null;
}

function getEmojiFilename(path: string): string {
    return path.split("/").pop() ?? path;
}

function guessMimeType(filename: string): string {
    if (filename.endsWith(".gif")) return "image/gif";
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".webp")) return "image/webp";
    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
    return "image/png";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseJsonExport(raw: unknown): JsonExport | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    const guild = obj.guild as Record<string, unknown> | undefined;
    if (!guild || typeof guild.name !== "string") return null;
    if (!Array.isArray(obj.categories) || !Array.isArray(obj.channels) || !Array.isArray(obj.emojis)) return null;
    return raw as JsonExport;
}

export function getSupportedChannels(exportData: JsonExport): JsonExportChannel[] {
    return exportData.channels.filter((ch) => ch.type === "text" || ch.type === "voice");
}

export async function runJsonImport(
    client: MatrixClient,
    exportData: JsonExport,
    emojiFiles: Map<string, File>,
    onProgress: ProgressCallback,
    signal: ImportSignal,
    channelConfig: Record<string, ChannelImportConfig> = {},
): Promise<ImportResult> {
    const errors: string[] = [];
    const viaServer = getViaServer(client);
    const via = viaServer ? [viaServer] : undefined;
    const supportedChannels = getSupportedChannels(exportData);
    const sourceToMatrix = new Map<string, string>();
    const rateLimitState: RateLimitState = { pauseUntil: 0 };
    let lastProgressTs = 0;

    const emitProgress = (progress: ImportProgress, force = false): void => {
        const now = Date.now();
        if (!force && now - lastProgressTs < 150) {
            return;
        }
        lastProgressTs = now;
        onProgress(progress);
    };

    // 1. Create main space
    onProgress({ stage: "space", current: 0, total: 1, message: `Creating space "${exportData.guild.name}"...` });
    const spaceResponse = await withRateLimit(() =>
        client.createRoom({
            name: exportData.guild.name,
            preset: Preset.PrivateChat,
            creation_content: { type: "m.space" },
            initial_state: [
                {
                    type: EventType.RoomJoinRules,
                    state_key: "",
                    content: { join_rule: "invite" },
                },
            ],
        }),
        rateLimitState,
    );
    const spaceId = spaceResponse.room_id;
    emitProgress({ stage: "space", current: 1, total: 1, message: "Space created." }, true);

    // 2. Create channels
    const CHANNEL_CONCURRENCY = 5;
    let channelsCreated = 0;
    await inParallel(supportedChannels, CHANNEL_CONCURRENCY, async (channel) => {
        if (signal.cancelled) return;
        const isVoice = channel.type === "voice";

        try {
            const cfg: ChannelImportConfig = channelConfig[channel.id] ?? {
                minPL: 0,
                isPublic: false,
                isEncrypted: !isVoice,
            };
            const initialState: Array<{ type: string; state_key: string; content: Record<string, unknown> }> = [];

            if (cfg.isPublic) {
                initialState.push({
                    type: EventType.RoomJoinRules,
                    state_key: "",
                    content: { join_rule: "public" },
                });
            }

            if (!isVoice) {
                if (cfg.isEncrypted) {
                    initialState.push({
                        type: EventType.RoomEncryption,
                        state_key: "",
                        content: { algorithm: "m.megolm.v1.aes-sha2" },
                    });
                }
            } else {
                initialState.push({
                    type: HEOROT_VOICE_CHANNEL_EVENT,
                    state_key: "",
                    content: { enabled: true, version: 1, chat_suppressed: true },
                });
                initialState.push({
                    type: MATRIX_CALL_COMPAT_EVENT,
                    state_key: "",
                    content: { type: "voice", intent: "voice", chat_suppressed: true },
                });
            }

            if (cfg.minPL > 0) {
                initialState.push({
                    type: EventType.RoomPowerLevels,
                    state_key: "",
                    content: { events_default: cfg.minPL },
                });
                initialState.push({
                    type: CHANNEL_ACCESS_EVENT,
                    state_key: "",
                    content: { min_power_level: cfg.minPL },
                });
            }

            // SpaceParent included in initial_state to save a separate API call
            initialState.push({
                type: EventType.SpaceParent,
                state_key: spaceId,
                content: { canonical: true, ...(via ? { via } : {}) },
            });

            const roomResponse = await withRateLimit(() =>
                client.createRoom({
                    name: channel.name,
                    topic: channel.topic ?? undefined,
                    preset: Preset.PrivateChat,
                    initial_state: initialState,
                }),
            rateLimitState,
            );

            const childContent: Record<string, unknown> = { suggested: true };
            if (via) childContent.via = via;
            if (isVoice) {
                childContent[HEOROT_SPACE_CHILD_CHANNEL_TYPE_KEY] = "voice";
                childContent[HEOROT_SPACE_CHILD_VOICE_KEY] = true;
            }

            await withRateLimit(() =>
                client.sendStateEvent(spaceId, EventType.SpaceChild, childContent, roomResponse.room_id),
            rateLimitState,
            );

            sourceToMatrix.set(channel.id, roomResponse.room_id);
            channelsCreated += 1;
            emitProgress({
                stage: "channels",
                current: channelsCreated,
                total: supportedChannels.length,
                message: `Created ${isVoice ? "voice" : "text"} channel "${channel.name}"`,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Channel "${channel.name}": ${msg}`);
        }
    });
    emitProgress({
        stage: "channels",
        current: supportedChannels.length,
        total: supportedChannels.length,
        message: "Channels done.",
    }, true);

    // 3. Write categories and channel order
    if (!signal.cancelled) {
        const categoryIds = new Set(exportData.categories.map((c) => c.id));
        const sortedCategories = [...exportData.categories].sort((a, b) => a.position - b.position);

        const uncategorized = supportedChannels
            .filter((ch) => !ch.category_id || !categoryIds.has(ch.category_id))
            .sort((a, b) => a.position - b.position);

        const globalOrder: string[] = [];
        const heorotCategories: HeorotCategory[] = [];

        for (const ch of uncategorized) {
            const roomId = sourceToMatrix.get(ch.id);
            if (roomId) globalOrder.push(roomId);
        }

        for (const cat of sortedCategories) {
            const channelsInCat = supportedChannels
                .filter((ch) => ch.category_id === cat.id)
                .sort((a, b) => a.position - b.position);
            const roomIds = channelsInCat
                .map((ch) => sourceToMatrix.get(ch.id))
                .filter((id): id is string => Boolean(id));
            if (roomIds.length === 0) continue;

            const heorotCat = createCategory(cat.name);
            heorotCat.roomIds = roomIds;
            heorotCategories.push(heorotCat);
            globalOrder.push(...roomIds);
        }

        if (heorotCategories.length > 0) {
            await withRateLimit(() => writeCategories(client, spaceId, heorotCategories), rateLimitState);
        }
        if (globalOrder.length > 0) {
            await withRateLimit(() => writeChannelOrder(client, spaceId, globalOrder), rateLimitState);
        }
    }

    // 4. Upload emojis
    const emojisToUpload = exportData.emojis.filter((e) => {
        if (e.status !== "ok") return false;
        return emojiFiles.has(getEmojiFilename(e.path));
    });

    let emojisUploaded = 0;

    if (emojisToUpload.length > 0) {
        const EMOJI_CONCURRENCY = 5;
        const emojiPack = (await getSpacePack(client, spaceId)) ?? { version: 1 as const, emojis: {} };

        await inParallel(emojisToUpload, EMOJI_CONCURRENCY, async (emojiMeta) => {
            if (signal.cancelled) return;
            const filename = getEmojiFilename(emojiMeta.path);
            const file = emojiFiles.get(filename);
            if (!file) return;

            try {
                const mimeType = guessMimeType(filename);
                const uploadResponse = await withRateLimit(() =>
                    client.uploadContent(file, {
                        includeFilename: true,
                        type: mimeType,
                        name: filename,
                    }),
            rateLimitState,
            );
                const mxcUrl = uploadResponse.content_uri;
                const shortcode = emojiMeta.shortcode.startsWith(":") ? emojiMeta.shortcode : `:${emojiMeta.shortcode}:`;
                emojiPack.emojis[shortcode] = {
                    url: mxcUrl,
                    name: emojiMeta.name,
                    created_ts: Date.now(),
                };
                emojisUploaded += 1;
                emitProgress({
                    stage: "emojis",
                    current: emojisUploaded,
                    total: emojisToUpload.length,
                    message: `Uploaded emoji "${emojiMeta.name}"`,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`Emoji "${emojiMeta.name}": ${msg}`);
            }
        });

        if (emojisUploaded > 0) {
            await withRateLimit(() => saveSpacePack(client, spaceId, emojiPack), rateLimitState);
        }
    }

    emitProgress({
        stage: "done",
        current: emojisToUpload.length,
        total: emojisToUpload.length,
        message: "Import complete!",
    }, true);

    return { spaceId, channelsCreated, emojisUploaded, errors };
}
