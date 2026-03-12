import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as encrypt from "matrix-encrypt-attachment";
import {
    ClientEvent,
    EventType,
    MatrixEventEvent,
    MsgType,
    RelationType,
    RoomEvent,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { memberAvatarSources } from "../adapters/avatar";
import { mediaFromMxc } from "../adapters/media";
import { normalizeEmojiShortcode, resetPersonalEmojiPackCache, resetSpaceEmojiPackCache } from "../emoji/EmojiPackStore";
import { PERSONAL_EMOJI_PACK_EVENT_TYPE, SPACE_EMOJI_PACK_EVENT_TYPE } from "../emoji/EmojiPackTypes";
import { loadAvailableEmojis } from "../emoji/EmojiResolver";
import { mxidLocalpart, tokenizeMatrixMentions } from "../mentions/mentionTokens";
import { mxcThumbnailToHttp } from "../utils/mxc";
import { Avatar } from "./Avatar";
import { MessageRenderer } from "./MessageRenderer";
import { MessageActionsBar } from "./messages/MessageActionsBar";
import { Toast, type ToastState } from "./Toast";
import { ReactionsRow } from "./reactions/ReactionsRow";

interface TimelineProps {
    client: MatrixClient;
    room: Room | null;
    focusBottomNonce?: number;
    replyToEventId: string | null;
    onReply: (event: MatrixEvent) => void;
    onEdit: (event: MatrixEvent) => void;
    onSelectUser?: (userId: string) => void;
    activeSpaceId: string | null;
    customReactionImagesEnabled: boolean;
    showReadReceipts: boolean;
}

interface LightboxState {
    src: string;
    alt: string;
    zoomed: boolean;
}

interface RenderEvent {
    event: MatrixEvent;
    content: MessageContent;
    edited: boolean;
    showHeader: boolean;
    body: string;
    reply: ReplySummary | null;
    senderName: string;
    senderAvatarUrl: string | null;
    senderAvatarSources: string[];
    timeLabel: string;
}

interface ReplySummary {
    eventId: string;
    senderId: string;
    senderName: string;
    senderAvatarUrl: string | null;
    senderAvatarSources: string[];
    body: string;
}

interface ReadReceiptEntry {
    userId: string;
    name: string;
    avatarUrl: string | null;
    avatarSources: string[];
    ts: number;
}

interface TextSegment {
    type: "text";
    value: string;
}

interface LinkSegment {
    type: "link";
    value: string;
    href: string;
}

type MessageSegment = TextSegment | LinkSegment;

interface UrlPreviewData {
    url: string;
    title: string | null;
    description: string | null;
    imageUrl: string | null;
    siteName: string | null;
    host: string | null;
}

interface DecryptQueueItem {
    key: string;
    encryptedFile: EncryptedAttachmentFile;
    mimeType: string;
    timestamp: number;
    priority: number;
}

interface MessageContent {
    msgtype?: unknown;
    body?: unknown;
    format?: unknown;
    formatted_body?: unknown;
    url?: unknown;
    "m.new_content"?: unknown;
    "m.relates_to"?: unknown;
    file?: EncryptedAttachmentFile | null;
    info?: {
        mimetype?: unknown;
        size?: unknown;
        w?: unknown;
        h?: unknown;
        duration?: unknown;
    } | null;
}

type EncryptedAttachmentFile = encrypt.IEncryptedFile & { url: string };
type MediaMsgType = MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File;

const MESSAGE_LINK_PATTERN = /((?:https?:\/\/|ftp:\/\/|mailto:|matrix:)[^\s<>()]+|www\.[^\s<>()]+)/gi;
const SHORTCODE_TOKEN_PATTERN = /:[a-zA-Z0-9_+-]{2,}:/g;
const TRAILING_URL_PUNCTUATION = ".,!?;:";
const DEFAULT_DECRYPT_CONCURRENCY = 3;
const DEFAULT_DECRYPT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_DECRYPT_FETCH_RETRIES = 2;
const DEFAULT_DECRYPT_AUTOPREFETCH_COUNT = 20;
const DEFAULT_DECRYPT_MAX_QUEUE_SIZE = 80;
const DEFAULT_DECRYPT_VIEWPORT_ENQUEUE_THROTTLE_MS = 180;
const DEFAULT_DECRYPT_MAX_CACHE_ENTRIES = 180;
const DEFAULT_DECRYPT_FAILURE_TTL_MS = 60_000;
const MAX_READ_RECEIPT_AVATARS_PLUS_N = 3;
const MAX_READ_RECEIPT_AVATARS = MAX_READ_RECEIPT_AVATARS_PLUS_N + 1;
const READ_RECEIPT_PUBLIC_TYPE = "m.read";
const READ_RECEIPT_PRIVATE_TYPE = "m.read.private";
const READ_MARK_BOTTOM_THRESHOLD_PX = 80;

interface DecryptTuning {
    concurrency: number;
    fetchTimeoutMs: number;
    fetchRetries: number;
    autoPrefetchCount: number;
    maxQueueSize: number;
    viewportEnqueueThrottleMs: number;
    maxCacheEntries: number;
    failureTtlMs: number;
}

function readTuningNumber(storageKey: string, fallback: number, min: number, max: number): number {
    if (typeof window === "undefined") {
        return fallback;
    }

    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
        return fallback;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function loadDecryptTuning(): DecryptTuning {
    return {
        concurrency: readTuningNumber("heorot.decrypt.concurrency", DEFAULT_DECRYPT_CONCURRENCY, 1, 8),
        fetchTimeoutMs: readTuningNumber("heorot.decrypt.fetchTimeoutMs", DEFAULT_DECRYPT_FETCH_TIMEOUT_MS, 3000, 60_000),
        fetchRetries: readTuningNumber("heorot.decrypt.fetchRetries", DEFAULT_DECRYPT_FETCH_RETRIES, 0, 6),
        autoPrefetchCount: readTuningNumber("heorot.decrypt.autoPrefetchCount", DEFAULT_DECRYPT_AUTOPREFETCH_COUNT, 0, 200),
        maxQueueSize: readTuningNumber("heorot.decrypt.maxQueueSize", DEFAULT_DECRYPT_MAX_QUEUE_SIZE, 4, 500),
        viewportEnqueueThrottleMs: readTuningNumber(
            "heorot.decrypt.viewportThrottleMs",
            DEFAULT_DECRYPT_VIEWPORT_ENQUEUE_THROTTLE_MS,
            0,
            2000,
        ),
        maxCacheEntries: readTuningNumber("heorot.decrypt.maxCacheEntries", DEFAULT_DECRYPT_MAX_CACHE_ENTRIES, 20, 1000),
        failureTtlMs: readTuningNumber("heorot.decrypt.failureTtlMs", DEFAULT_DECRYPT_FAILURE_TTL_MS, 0, 10 * 60 * 1000),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function withImageRetryCacheBuster(url: string): string {
    const hashIndex = url.indexOf("#");
    const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
    const baseUrl = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}__heorot_retry=${Date.now()}${hash}`;
}

function retryImageLoadOnce(event: React.SyntheticEvent<HTMLImageElement>): void {
    const image = event.currentTarget;
    if (image.dataset.heorotRetryAttempted === "1") {
        return;
    }

    const currentSource = image.currentSrc || image.src;
    if (!currentSource) {
        return;
    }

    image.dataset.heorotRetryAttempted = "1";
    image.src = withImageRetryCacheBuster(currentSource);
}

async function fetchEncryptedArrayBufferWithRetry(
    url: string,
    options: {
        signal?: AbortSignal;
        timeoutMs: number;
        retries: number;
    },
): Promise<ArrayBuffer> {
    const { signal, timeoutMs, retries } = options;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (signal?.aborted) {
            throw new DOMException("Decrypt download aborted", "AbortError");
        }

        const controller = new AbortController();
        const onAbort = (): void => {
            controller.abort();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`Failed to download media (${response.status})`);
            }
            return await response.arrayBuffer();
        } catch (error) {
            lastError = error;
            if (signal?.aborted) {
                throw new DOMException("Decrypt download aborted", "AbortError");
            }
            if (attempt < retries) {
                const backoffMs = Math.min(1200, 300 * 2 ** attempt);
                await delay(backoffMs);
            }
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener("abort", onAbort);
        }
    }

    if (lastError instanceof Error) {
        throw lastError;
    }
    throw new Error("Failed to download encrypted media");
}

function getMessageContent(event: MatrixEvent): MessageContent {
    return event.getContent() as MessageContent;
}

function getTextBody(content: MessageContent): string | null {
    return typeof content.body === "string" ? content.body : null;
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

function getReplyEventId(event: MatrixEvent): string | null {
    const replyEventId = (event as MatrixEvent & { replyEventId?: string }).replyEventId;
    return typeof replyEventId === "string" && replyEventId.length > 0 ? replyEventId : null;
}

function isMediaMessageType(value: unknown): value is MediaMsgType {
    return value === MsgType.Image || value === MsgType.Audio || value === MsgType.Video || value === MsgType.File;
}

function mediaTypeLabel(msgtype: MediaMsgType): string {
    if (msgtype === MsgType.Image) {
        return "Image";
    }
    if (msgtype === MsgType.Video) {
        return "Video";
    }
    if (msgtype === MsgType.Audio) {
        return "Audio";
    }
    return "File";
}

function normalizeSnippet(text: string): string {
    const singleLine = text.replace(/\s+/g, " ").trim();
    if (!singleLine) {
        return "Message";
    }
    return singleLine.length > 96 ? `${singleLine.slice(0, 93)}...` : singleLine;
}

function toReplyPreviewBody(content: MessageContent): string {
    const body = typeof content.body === "string" ? stripPlainReplyFallback(content.body) : "";
    if (isMediaMessageType(content.msgtype)) {
        const label = mediaTypeLabel(content.msgtype);
        return body.trim() ? normalizeSnippet(`[${label}] ${body}`) : `[${label}]`;
    }
    return normalizeSnippet(body);
}

function getUnencryptedMediaMxc(content: MessageContent): string | null {
    if (!isMediaMessageType(content.msgtype) || typeof content.url !== "string") {
        return null;
    }

    return content.url;
}

function getEncryptedMediaFile(content: MessageContent): EncryptedAttachmentFile | null {
    if (!isMediaMessageType(content.msgtype) || !content.file || typeof content.file.url !== "string") {
        return null;
    }

    return content.file;
}

function mediaMimeType(content: MessageContent): string {
    if (typeof content.info?.mimetype === "string") {
        const mime = content.info.mimetype.split(";")[0].trim().toLowerCase();
        if (mime.length > 0) {
            return mime;
        }
    }

    if (content.msgtype === MsgType.Image) {
        return "image/jpeg";
    }

    if (content.msgtype === MsgType.Video) {
        return "video/mp4";
    }

    if (content.msgtype === MsgType.Audio) {
        return "audio/mpeg";
    }

    return "application/octet-stream";
}

function formatFileSize(size: unknown): string | null {
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        return null;
    }

    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(durationMs: unknown): string | null {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
        return null;
    }

    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) {
        return `${seconds}s`;
    }
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function eventKey(event: MatrixEvent): string {
    return event.getId() || `${event.getTs()}_${event.getSender()}`;
}

function toDecryptQueueItem(
    event: MatrixEvent,
    content: MessageContent,
    encryptedFile: EncryptedAttachmentFile,
): DecryptQueueItem {
    return {
        key: eventKey(event),
        encryptedFile,
        mimeType: mediaMimeType(content),
        timestamp: event.getTs(),
        priority: 1,
    };
}

function isRenderableMessageContent(content: MessageContent): boolean {
    return getTextBody(content) !== null || getUnencryptedMediaMxc(content) !== null || getEncryptedMediaFile(content) !== null;
}

function getReplaceTargetEventId(event: MatrixEvent): string | null {
    const relation = event.getRelation() as { rel_type?: unknown; event_id?: unknown } | null;
    if (relation?.rel_type === RelationType.Replace && typeof relation.event_id === "string" && relation.event_id.length > 0) {
        return relation.event_id;
    }

    const content = getMessageContent(event);
    const relatesToRaw = content["m.relates_to"];
    if (!relatesToRaw || typeof relatesToRaw !== "object") {
        return null;
    }

    const relatesTo = relatesToRaw as { rel_type?: unknown; event_id?: unknown };
    if (relatesTo.rel_type !== RelationType.Replace || typeof relatesTo.event_id !== "string" || relatesTo.event_id.length === 0) {
        return null;
    }

    return relatesTo.event_id;
}

function isEditEvent(event: MatrixEvent): boolean {
    return getReplaceTargetEventId(event) !== null;
}

function resolveEditedMessageContent(editEvent: MatrixEvent): MessageContent | null {
    const editContent = getMessageContent(editEvent);
    const newContentRaw = editContent["m.new_content"];
    if (newContentRaw && typeof newContentRaw === "object") {
        const newContent = newContentRaw as MessageContent;
        if (isRenderableMessageContent(newContent)) {
            return newContent;
        }
    }

    if (isRenderableMessageContent(editContent)) {
        return editContent;
    }

    return null;
}

function getDisplayContentForEvent(
    event: MatrixEvent,
    latestEditEventsByTarget: Map<string, MatrixEvent>,
): { content: MessageContent; edited: boolean } {
    const baseContent = getMessageContent(event);
    const eventId = event.getId();
    if (!eventId) {
        return {
            content: baseContent,
            edited: false,
        };
    }

    const latestEditEvent = latestEditEventsByTarget.get(eventId);
    if (!latestEditEvent) {
        return {
            content: baseContent,
            edited: false,
        };
    }

    return {
        content: resolveEditedMessageContent(latestEditEvent) ?? baseContent,
        edited: true,
    };
}

function collectLatestEditEventsByTarget(room: Room | null): Map<string, MatrixEvent> {
    const latestEditEventsByTarget = new Map<string, MatrixEvent>();
    if (!room) {
        return latestEditEventsByTarget;
    }

    const liveEvents = room.getLiveTimeline()?.getEvents() ?? room.timeline;
    for (const event of liveEvents) {
        if (event.getType() !== EventType.RoomMessage || event.isRedacted()) {
            continue;
        }

        const targetEventId = getReplaceTargetEventId(event);
        if (!targetEventId) {
            continue;
        }

        const existing = latestEditEventsByTarget.get(targetEventId);
        if (!existing || event.getTs() > existing.getTs()) {
            latestEditEventsByTarget.set(targetEventId, event);
            continue;
        }

        if (event.getTs() === existing.getTs()) {
            const eventId = event.getId() ?? "";
            const existingEventId = existing.getId() ?? "";
            if (eventId > existingEventId) {
                latestEditEventsByTarget.set(targetEventId, event);
            }
        }
    }

    return latestEditEventsByTarget;
}

function isRenderableMessage(event: MatrixEvent): boolean {
    if (event.getType() !== EventType.RoomMessage || event.isRedacted()) {
        return false;
    }

    if (isEditEvent(event)) {
        return false;
    }

    const content = getMessageContent(event);
    return isRenderableMessageContent(content);
}

function extractMessageEvents(room: Room | null): MatrixEvent[] {
    if (!room) {
        return [];
    }

    const liveEvents = room.getLiveTimeline()?.getEvents() ?? room.timeline;
    return liveEvents.filter(isRenderableMessage);
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
    });
}

function getSenderMetadata(
    client: MatrixClient,
    room: Room | null,
    event: MatrixEvent,
    avatarSize: number,
): { name: string; avatarUrl: string | null; avatarSources: string[] } {
    const senderId = event.getSender() ?? "unknown";
    const sender = room?.getMember(senderId);
    const name = sender?.rawDisplayName || sender?.name || senderId;
    const avatarSources = memberAvatarSources(client, sender, avatarSize, "crop");
    const avatarUrl = avatarSources[0] ?? null;

    return {
        name,
        avatarUrl,
        avatarSources,
    };
}

function isSupportedReadReceiptType(type: unknown): boolean {
    return type === READ_RECEIPT_PUBLIC_TYPE || type === READ_RECEIPT_PRIVATE_TYPE;
}

function getReadReceiptTimestamp(data: unknown, fallbackTimestamp: number): number {
    if (typeof data !== "object" || !data) {
        return fallbackTimestamp;
    }

    const ts = (data as { ts?: unknown }).ts;
    return typeof ts === "number" && Number.isFinite(ts) ? ts : fallbackTimestamp;
}

function getReadReceiptUserMetadata(
    client: MatrixClient,
    room: Room,
    userId: string,
    avatarSize: number,
): { name: string; avatarUrl: string | null; avatarSources: string[] } {
    const member = room.getMember(userId);
    const user = client.getUser(userId);
    const name = member?.rawDisplayName || member?.name || user?.displayName || userId;

    const memberSources = memberAvatarSources(client, member, avatarSize, "crop");
    const userSources =
        typeof user?.avatarUrl === "string" && user.avatarUrl.length > 0
            ? [
                  mxcThumbnailToHttp(client, user.avatarUrl, avatarSize, avatarSize),
                  mediaFromMxc(client, user.avatarUrl),
              ].filter((source): source is string => Boolean(source))
            : [];

    const avatarSources = memberSources.length > 0 ? memberSources : userSources;
    return {
        name,
        avatarUrl: avatarSources[0] ?? null,
        avatarSources,
    };
}

function collectReadReceiptsByEventId(
    client: MatrixClient,
    room: Room,
    events: MatrixEvent[],
    ownUserId: string | null,
): Map<string, ReadReceiptEntry[]> {
    if (!ownUserId || events.length === 0) {
        return new Map();
    }

    const eventOrderById = new Map<string, number>();
    events.forEach((event, index) => {
        const eventId = event.getId();
        if (eventId) {
            eventOrderById.set(eventId, index);
        }
    });

    const latestReceiptByUserId = new Map<string, { eventId: string; eventOrder: number; ts: number }>();

    for (const event of events) {
        const eventId = event.getId();
        if (!eventId) {
            continue;
        }

        const eventOrder = eventOrderById.get(eventId) ?? -1;
        const receipts = (room.getReceiptsForEvent(event) ?? []) as Array<{
            userId?: unknown;
            type?: unknown;
            data?: unknown;
        }>;

        for (const receipt of receipts) {
            const userId = typeof receipt.userId === "string" ? receipt.userId : "";
            if (!userId || userId === ownUserId) {
                continue;
            }
            if (!isSupportedReadReceiptType(receipt.type)) {
                continue;
            }

            const receiptTimestamp = getReadReceiptTimestamp(receipt.data, event.getTs());
            const existing = latestReceiptByUserId.get(userId);
            if (
                !existing ||
                receiptTimestamp > existing.ts ||
                (receiptTimestamp === existing.ts && eventOrder > existing.eventOrder)
            ) {
                latestReceiptByUserId.set(userId, {
                    eventId,
                    eventOrder,
                    ts: receiptTimestamp,
                });
            }
        }
    }

    const readReceiptsByEventId = new Map<string, ReadReceiptEntry[]>();
    for (const [userId, { eventId, ts }] of latestReceiptByUserId.entries()) {
        const metadata = getReadReceiptUserMetadata(client, room, userId, 32);
        const existing = readReceiptsByEventId.get(eventId) ?? [];
        existing.push({
            userId,
            name: metadata.name,
            avatarUrl: metadata.avatarUrl,
            avatarSources: metadata.avatarSources,
            ts,
        });
        readReceiptsByEventId.set(eventId, existing);
    }

    for (const receipts of readReceiptsByEventId.values()) {
        receipts.sort((left, right) => {
            if (right.ts !== left.ts) {
                return right.ts - left.ts;
            }

            return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        });
    }

    return readReceiptsByEventId;
}

function getReplySummary(
    client: MatrixClient,
    room: Room | null,
    event: MatrixEvent,
    latestEditEventsByTarget: Map<string, MatrixEvent>,
): ReplySummary | null {
    const replyEventId = getReplyEventId(event);
    if (!replyEventId || !room) {
        return null;
    }

    const replyEvent = room.findEventById(replyEventId);
    if (!replyEvent) {
        return {
            eventId: replyEventId,
            senderId: "unknown",
            senderName: "unknown",
            senderAvatarUrl: null,
            senderAvatarSources: [],
            body: "Original message unavailable",
        };
    }

    const sender = getSenderMetadata(client, room, replyEvent, 48);
    const { content } = getDisplayContentForEvent(replyEvent, latestEditEventsByTarget);
    return {
        eventId: replyEvent.getId() ?? replyEventId,
        senderId: replyEvent.getSender() ?? "unknown",
        senderName: sender.name,
        senderAvatarUrl: sender.avatarUrl,
        senderAvatarSources: sender.avatarSources,
        body: toReplyPreviewBody(content),
    };
}

function toRenderEvents(
    client: MatrixClient,
    room: Room | null,
    events: MatrixEvent[],
    latestEditEventsByTarget: Map<string, MatrixEvent>,
): RenderEvent[] {
    return events.map((event, index) => {
        const previous = events[index - 1];
        const sender = getSenderMetadata(client, room, event, 84);
        const { content, edited } = getDisplayContentForEvent(event, latestEditEventsByTarget);
        const rawBody = getTextBody(content) ?? "";
        const body = getReplyEventId(event) ? stripPlainReplyFallback(rawBody) : rawBody;

        let showHeader = true;
        if (previous) {
            const sameSender = previous.getSender() === event.getSender();
            const sameWindow = Math.abs(event.getTs() - previous.getTs()) <= 5 * 60 * 1000;
            showHeader = !(sameSender && sameWindow);
        }
        if (edited) {
            showHeader = true;
        }

        return {
            event,
            content,
            edited,
            showHeader,
            body,
            reply: getReplySummary(client, room, event, latestEditEventsByTarget),
            senderName: sender.name,
            senderAvatarUrl: sender.avatarUrl,
            senderAvatarSources: sender.avatarSources,
            timeLabel: formatTime(event.getTs()),
        };
    });
}

function splitTrailingUrlDecoration(candidate: string): { url: string; suffix: string } {
    let cutIndex = candidate.length;

    while (cutIndex > 0) {
        const char = candidate.charAt(cutIndex - 1);
        if (TRAILING_URL_PUNCTUATION.includes(char)) {
            cutIndex -= 1;
            continue;
        }

        if (char === ")") {
            const prefix = candidate.slice(0, cutIndex);
            const openingParens = (prefix.match(/\(/g) ?? []).length;
            const closingParens = (prefix.match(/\)/g) ?? []).length;
            if (closingParens > openingParens) {
                cutIndex -= 1;
                continue;
            }
        }

        break;
    }

    return {
        url: candidate.slice(0, cutIndex),
        suffix: candidate.slice(cutIndex),
    };
}

function toLinkHref(urlText: string): string {
    return urlText.startsWith("www.") ? `https://${urlText}` : urlText;
}

function tokenizeMessage(body: string): MessageSegment[] {
    const segments: MessageSegment[] = [];
    let nextStart = 0;
    let match: RegExpExecArray | null;

    MESSAGE_LINK_PATTERN.lastIndex = 0;
    while ((match = MESSAGE_LINK_PATTERN.exec(body)) !== null) {
        const rawMatch = match[0];
        const matchStart = match.index;

        if (matchStart > nextStart) {
            segments.push({ type: "text", value: body.slice(nextStart, matchStart) });
        }

        const { url, suffix } = splitTrailingUrlDecoration(rawMatch);
        if (url) {
            segments.push({
                type: "link",
                value: url,
                href: toLinkHref(url),
            });
        }

        if (suffix) {
            segments.push({ type: "text", value: suffix });
        }

        nextStart = matchStart + rawMatch.length;
    }

    if (nextStart < body.length) {
        segments.push({ type: "text", value: body.slice(nextStart) });
    }

    return segments;
}

function getFirstPreviewableUrl(body: string): string | null {
    const segments = tokenizeMessage(body);
    for (const segment of segments) {
        if (segment.type === "link" && /^https?:\/\//i.test(segment.href)) {
            return segment.href;
        }
    }

    return null;
}

function toHost(url: string): string | null {
    try {
        return new URL(url).host || null;
    } catch {
        return null;
    }
}

function readPreviewField(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolvePreviewImageUrl(client: MatrixClient, payload: Record<string, unknown>): string | null {
    const candidate =
        readPreviewField(payload, "og:image") ||
        readPreviewField(payload, "og:image:url") ||
        readPreviewField(payload, "image");

    if (!candidate) {
        return null;
    }

    if (/^mxc:\/\//i.test(candidate)) {
        return mediaFromMxc(client, candidate);
    }

    if (/^https?:\/\//i.test(candidate)) {
        return candidate;
    }

    return null;
}

function normalizeUrlPreview(
    client: MatrixClient,
    url: string,
    payload: Record<string, unknown>,
): UrlPreviewData | null {
    const title = readPreviewField(payload, "og:title") || readPreviewField(payload, "title");
    const description = readPreviewField(payload, "og:description") || readPreviewField(payload, "description");
    const siteName = readPreviewField(payload, "og:site_name");
    const imageUrl = resolvePreviewImageUrl(client, payload);
    const host = toHost(url);

    if (!title && !description && !siteName && !imageUrl) {
        return null;
    }

    return {
        url,
        title,
        description,
        imageUrl,
        siteName,
        host,
    };
}

function renderTextSegmentWithCustomEmojis(
    value: string,
    keyPrefix: string,
    emojiSourcesByShortcode: ReadonlyMap<string, string>,
): React.ReactNode[] {
    if (emojiSourcesByShortcode.size === 0) {
        return [<React.Fragment key={`${keyPrefix}_text`}>{value}</React.Fragment>];
    }

    const rendered: React.ReactNode[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    SHORTCODE_TOKEN_PATTERN.lastIndex = 0;

    while ((match = SHORTCODE_TOKEN_PATTERN.exec(value)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;

        if (start > cursor) {
            rendered.push(
                <React.Fragment key={`${keyPrefix}_text_${cursor}`}>{value.slice(cursor, start)}</React.Fragment>,
            );
        }

        const normalized = normalizeEmojiShortcode(token);
        const source = emojiSourcesByShortcode.get(normalized);
        if (source) {
            rendered.push(
                <img
                    key={`${keyPrefix}_emoji_${start}`}
                    src={source}
                    alt={normalized}
                    title={normalized}
                    width={24}
                    height={24}
                    loading="lazy"
                    decoding="async"
                    className="message-renderer-emoticon"
                    data-mx-emoticon="true"
                />,
            );
        } else {
            rendered.push(<React.Fragment key={`${keyPrefix}_token_${start}`}>{token}</React.Fragment>);
        }

        cursor = end;
    }

    if (cursor < value.length) {
        rendered.push(<React.Fragment key={`${keyPrefix}_tail_${cursor}`}>{value.slice(cursor)}</React.Fragment>);
    }

    if (rendered.length === 0) {
        rendered.push(<React.Fragment key={`${keyPrefix}_text`}>{value}</React.Fragment>);
    }

    return rendered;
}

function resolveMentionDisplayName(
    client: MatrixClient,
    room: Room,
    mentionedUserId: string,
): string {
    const member = room.getMember(mentionedUserId);
    const user = client.getUser(mentionedUserId);
    const displayName = member?.rawDisplayName || member?.name || user?.displayName || mxidLocalpart(mentionedUserId);
    return displayName.startsWith("@") ? displayName.slice(1) : displayName;
}

function renderMentionPill(
    client: MatrixClient,
    room: Room,
    mentionedUserId: string,
    ownUserId: string | null,
    key: string,
): React.ReactNode {
    const isDirectMention = Boolean(ownUserId && mentionedUserId === ownUserId);

    return (
        <span
            key={key}
            className={`message-renderer-mention${isDirectMention ? " is-direct" : ""}`}
            data-mention-user-id={mentionedUserId}
        >
            @{resolveMentionDisplayName(client, room, mentionedUserId)}
        </span>
    );
}

function renderTextSegmentWithMentionsAndCustomEmojis(
    client: MatrixClient,
    room: Room,
    ownUserId: string | null,
    value: string,
    segmentIndex: number,
    emojiSourcesByShortcode: ReadonlyMap<string, string>,
): React.ReactNode[] {
    const mentionSegments = tokenizeMatrixMentions(value);
    const rendered: React.ReactNode[] = [];

    mentionSegments.forEach((segment, mentionIndex) => {
        const keyPrefix = `seg_${segmentIndex}_mention_${mentionIndex}`;
        if (segment.type === "text") {
            rendered.push(
                ...renderTextSegmentWithCustomEmojis(
                    segment.value,
                    `${keyPrefix}_text`,
                    emojiSourcesByShortcode,
                ),
            );
            return;
        }

        rendered.push(
            renderMentionPill(
                client,
                room,
                segment.userId,
                ownUserId,
                `${keyPrefix}_pill`,
            ),
        );
    });

    return rendered;
}

function renderMessageBody(
    client: MatrixClient,
    room: Room,
    ownUserId: string | null,
    body: string,
    emojiSourcesByShortcode: ReadonlyMap<string, string>,
): React.ReactNode {
    const segments = tokenizeMessage(body);
    const rendered: React.ReactNode[] = [];

    segments.forEach((segment, segmentIndex) => {
        if (segment.type === "link") {
            rendered.push(
                <a
                    key={`link_${segmentIndex}`}
                    className="timeline-link"
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {segment.value}
                </a>
            );
            return;
        }

        rendered.push(
            ...renderTextSegmentWithMentionsAndCustomEmojis(
                client,
                room,
                ownUserId,
                segment.value,
                segmentIndex,
                emojiSourcesByShortcode,
            ),
        );
    });

    return rendered;
}

function containsDirectMention(body: string, ownUserId: string | null): boolean {
    if (!ownUserId) {
        return false;
    }

    return tokenizeMatrixMentions(body).some(
        (segment) => segment.type === "mention" && segment.userId === ownUserId,
    );
}

function findTimelineEventElement(container: HTMLElement, eventId: string): HTMLElement | null {
    const eventNodes = container.querySelectorAll<HTMLElement>(".timeline-event[data-event-id]");
    for (const eventNode of eventNodes) {
        if (eventNode.dataset.eventId === eventId) {
            return eventNode;
        }
    }

    return null;
}

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

export function Timeline({
    client,
    room,
    focusBottomNonce,
    replyToEventId,
    onReply,
    onEdit,
    onSelectUser,
    activeSpaceId,
    customReactionImagesEnabled,
    showReadReceipts,
}: TimelineProps): React.ReactElement {
    const decryptTuning = useMemo<DecryptTuning>(() => loadDecryptTuning(), []);
    const [events, setEvents] = useState<MatrixEvent[]>(() => extractMessageEvents(room));
    const [emojiSourcesByShortcode, setEmojiSourcesByShortcode] = useState<ReadonlyMap<string, string>>(
        () => new Map(),
    );
    const [paginating, setPaginating] = useState(false);
    const [lightbox, setLightbox] = useState<LightboxState | null>(null);
    const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
    const [contextMenuState, setContextMenuState] = useState<{ eventKey: string; x: number; y: number } | null>(null);
    const [toast, setToast] = useState<ToastState | null>(null);
    const [replyJumpTargetEventId, setReplyJumpTargetEventId] = useState<string | null>(null);
    const [, setLinkPreviewRerenderTick] = useState(0);
    const [decryptRerenderTick, setDecryptRerenderTick] = useState(0);

    const scrollContainerRef = useRef<HTMLDivElement | null>(null);
    const stickToBottomRef = useRef(true);
    const decryptedMediaUrlsRef = useRef<Record<string, string | null>>({});
    const inFlightDecryptionsRef = useRef<Set<string>>(new Set());
    const queuedDecryptionsRef = useRef<Set<string>>(new Set());
    const decryptQueueRef = useRef<DecryptQueueItem[]>([]);
    const activeDecryptCountRef = useRef(0);
    const failedDecryptUntilRef = useRef<Record<string, number>>({});
    const decryptCacheAccessRef = useRef<Map<string, number>>(new Map());
    const decryptAbortControllersRef = useRef<Record<string, AbortController>>({});
    const lastViewportEnqueueAtRef = useRef(0);
    const linkPreviewByUrlRef = useRef<Record<string, UrlPreviewData | null>>({});
    const inFlightLinkPreviewUrlsRef = useRef<Set<string>>(new Set());
    const replyJumpResetTimeoutRef = useRef<number | null>(null);
    const lastReadEventIdByRoomRef = useRef<Map<string, string>>(new Map());
    const readMarkerInFlightByRoomRef = useRef<Set<string>>(new Set());

    const refreshEvents = useCallback(() => {
        setEvents(extractMessageEvents(room));
    }, [room]);

    const latestEditEventsByTarget = useMemo(() => collectLatestEditEventsByTarget(room), [events, room]);
    const encryptedDecryptCandidatesByKey = useMemo(() => {
        const map = new Map<string, DecryptQueueItem>();
        for (const event of events) {
            const content = getMessageContent(event);
            const encryptedFile = getEncryptedMediaFile(content);
            if (!encryptedFile) {
                continue;
            }

            const item = toDecryptQueueItem(event, content, encryptedFile);
            map.set(item.key, item);
        }
        return map;
    }, [events]);

    const pushToast = useCallback((nextToast: Omit<ToastState, "id">): void => {
        setToast({
            id: Date.now(),
            ...nextToast,
        });
    }, []);

    const focusEventById = useCallback((eventId: string, behavior: ScrollBehavior): boolean => {
        const container = scrollContainerRef.current;
        if (!container) {
            return false;
        }

        const eventElement = findTimelineEventElement(container, eventId);
        if (!eventElement) {
            return false;
        }

        eventElement.scrollIntoView({
            behavior,
            block: "center",
        });

        if (replyJumpResetTimeoutRef.current !== null) {
            window.clearTimeout(replyJumpResetTimeoutRef.current);
        }

        setReplyJumpTargetEventId(eventId);
        replyJumpResetTimeoutRef.current = window.setTimeout(() => {
            setReplyJumpTargetEventId((current) => (current === eventId ? null : current));
            replyJumpResetTimeoutRef.current = null;
        }, 2200);

        return true;
    }, []);

    const jumpToReplySource = useCallback(
        async (eventId: string): Promise<void> => {
            if (!room || paginating) {
                return;
            }

            if (focusEventById(eventId, "smooth")) {
                return;
            }

            const maxScrollbackAttempts = 8;
            setPaginating(true);
            try {
                for (let attempt = 0; attempt < maxScrollbackAttempts; attempt += 1) {
                    await client.scrollback(room, 40);
                    refreshEvents();
                    await nextAnimationFrame();

                    if (focusEventById(eventId, "smooth")) {
                        return;
                    }
                }
            } catch {
                // no-op: handled below with a toast if target is still unavailable
            } finally {
                setPaginating(false);
            }

            pushToast({
                type: "info",
                message: "Original message is not available in this timeline yet.",
            });
        },
        [client, focusEventById, paginating, pushToast, refreshEvents, room],
    );

    const enqueueDecrypt = useCallback((item: DecryptQueueItem, force = false): void => {
        if (decryptedMediaUrlsRef.current[item.key] !== undefined && !force) {
            return;
        }

        if (inFlightDecryptionsRef.current.has(item.key)) {
            return;
        }

        if (queuedDecryptionsRef.current.has(item.key)) {
            if (!force) {
                return;
            }

            let updated = false;
            decryptQueueRef.current = decryptQueueRef.current.map((queuedItem) => {
                if (queuedItem.key !== item.key) {
                    return queuedItem;
                }

                updated = true;
                return {
                    ...queuedItem,
                    priority: Math.max(queuedItem.priority, 2),
                    timestamp: Math.max(queuedItem.timestamp, item.timestamp),
                };
            });

            if (updated) {
                decryptQueueRef.current.sort((left, right) => {
                    if (left.priority !== right.priority) {
                        return right.priority - left.priority;
                    }
                    return right.timestamp - left.timestamp;
                });
                setDecryptRerenderTick((tick) => tick + 1);
            }
            return;
        }

        const failedUntilTs = failedDecryptUntilRef.current[item.key];
        if (!force && typeof failedUntilTs === "number" && failedUntilTs > Date.now()) {
            return;
        }

        if (force) {
            delete failedDecryptUntilRef.current[item.key];
            if (decryptedMediaUrlsRef.current[item.key] === null) {
                delete decryptedMediaUrlsRef.current[item.key];
            }
        }

        const queueLoad = decryptQueueRef.current.length + inFlightDecryptionsRef.current.size;
        if (!force && queueLoad >= decryptTuning.maxQueueSize) {
            return;
        }

        decryptQueueRef.current.push({
            ...item,
            priority: force ? 2 : item.priority,
        });
        decryptQueueRef.current.sort((left, right) => {
            if (left.priority !== right.priority) {
                return right.priority - left.priority;
            }
            return right.timestamp - left.timestamp;
        });
        queuedDecryptionsRef.current.add(item.key);
        setDecryptRerenderTick((tick) => tick + 1);
    }, [decryptTuning.maxQueueSize]);

    useEffect(() => {
        refreshEvents();
    }, [refreshEvents]);

    useEffect(() => {
        if (!room) {
            setEmojiSourcesByShortcode(new Map());
            return;
        }

        let cancelled = false;

        const loadEmojiSources = async (): Promise<void> => {
            try {
                const emojis = await loadAvailableEmojis(client, room, activeSpaceId);
                if (cancelled) {
                    return;
                }

                const next = new Map<string, string>();
                for (const emoji of emojis) {
                    const source = mxcThumbnailToHttp(client, emoji.url, 24, 24) ?? mediaFromMxc(client, emoji.url);
                    if (!source) {
                        continue;
                    }

                    const shortcode = normalizeEmojiShortcode(emoji.shortcode);
                    if (!next.has(shortcode)) {
                        next.set(shortcode, source);
                    }
                }

                setEmojiSourcesByShortcode(next);
            } catch {
                if (!cancelled) {
                    setEmojiSourcesByShortcode(new Map());
                }
            }
        };

        void loadEmojiSources();

        const onTimeline = (event: MatrixEvent): void => {
            if (event.getType() !== SPACE_EMOJI_PACK_EVENT_TYPE) {
                return;
            }

            const updatedSpaceId = typeof event.getRoomId === "function" ? event.getRoomId() : undefined;
            resetSpaceEmojiPackCache(typeof updatedSpaceId === "string" ? updatedSpaceId : undefined);
            void loadEmojiSources();
        };

        const onAccountData = (event: MatrixEvent): void => {
            if (event.getType() !== PERSONAL_EMOJI_PACK_EVENT_TYPE) {
                return;
            }

            resetPersonalEmojiPackCache();
            void loadEmojiSources();
        };

        client.on(RoomEvent.Timeline, onTimeline);
        client.on(ClientEvent.AccountData, onAccountData);

        return () => {
            cancelled = true;
            client.removeListener(RoomEvent.Timeline, onTimeline);
            client.removeListener(ClientEvent.AccountData, onAccountData);
        };
    }, [activeSpaceId, client, room]);

    useEffect(() => {
        let cancelled = false;

        const evictDecryptedMediaCacheIfNeeded = (): void => {
            const accessMap = decryptCacheAccessRef.current;
            while (accessMap.size > decryptTuning.maxCacheEntries) {
                let oldestKey: string | null = null;
                let oldestTs = Number.POSITIVE_INFINITY;

                for (const [key, ts] of accessMap.entries()) {
                    if (ts < oldestTs) {
                        oldestTs = ts;
                        oldestKey = key;
                    }
                }

                if (!oldestKey) {
                    break;
                }

                const cached = decryptedMediaUrlsRef.current[oldestKey];
                if (typeof cached === "string") {
                    URL.revokeObjectURL(cached);
                }
                delete decryptedMediaUrlsRef.current[oldestKey];
                delete failedDecryptUntilRef.current[oldestKey];
                accessMap.delete(oldestKey);
                queuedDecryptionsRef.current.delete(oldestKey);
                inFlightDecryptionsRef.current.delete(oldestKey);
            }
        };

        const nowTs = Date.now();
        const eventKeysInScope = new Set(events.map((event) => eventKey(event)));
        decryptQueueRef.current = decryptQueueRef.current.filter((item) => eventKeysInScope.has(item.key));
        queuedDecryptionsRef.current = new Set(
            Array.from(queuedDecryptionsRef.current).filter((key) => eventKeysInScope.has(key)),
        );

        for (const [key, untilTs] of Object.entries(failedDecryptUntilRef.current)) {
            if (untilTs <= nowTs) {
                delete failedDecryptUntilRef.current[key];
            }
        }

        const decryptMedia = async (item: DecryptQueueItem): Promise<void> => {
            const { key, encryptedFile, mimeType } = item;
            const abortController = new AbortController();
            decryptAbortControllersRef.current[key] = abortController;
            try {
                const sourceUrl = mediaFromMxc(client, encryptedFile.url);
                if (!sourceUrl) {
                    throw new Error("Unable to resolve media URL");
                }

                const encryptedData = await fetchEncryptedArrayBufferWithRetry(sourceUrl, {
                    signal: abortController.signal,
                    timeoutMs: decryptTuning.fetchTimeoutMs,
                    retries: decryptTuning.fetchRetries,
                });
                const decryptedData = await encrypt.decryptAttachment(encryptedData, encryptedFile);
                const objectUrl = URL.createObjectURL(new Blob([decryptedData], { type: mimeType }));

                if (cancelled) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }

                const previous = decryptedMediaUrlsRef.current[key];
                if (previous) {
                    URL.revokeObjectURL(previous);
                }
                decryptedMediaUrlsRef.current[key] = objectUrl;
                delete failedDecryptUntilRef.current[key];
                decryptCacheAccessRef.current.set(key, Date.now());
                evictDecryptedMediaCacheIfNeeded();
            } catch {
                if (!cancelled) {
                    decryptedMediaUrlsRef.current[key] = null;
                    failedDecryptUntilRef.current[key] = Date.now() + decryptTuning.failureTtlMs;
                    decryptCacheAccessRef.current.delete(key);
                }
            } finally {
                activeDecryptCountRef.current = Math.max(0, activeDecryptCountRef.current - 1);
                inFlightDecryptionsRef.current.delete(key);
                delete decryptAbortControllersRef.current[key];
                if (!cancelled) {
                    setDecryptRerenderTick((tick) => tick + 1);
                    pumpDecryptQueue();
                }
            }
        };

        const currentQueuedOrInFlight = decryptQueueRef.current.length + inFlightDecryptionsRef.current.size;
        const availableQueueSlots = Math.max(0, decryptTuning.autoPrefetchCount - currentQueuedOrInFlight);
        const candidates: DecryptQueueItem[] = [];

        for (const event of events) {
            const key = eventKey(event);
            const content = getMessageContent(event);
            const encryptedFile = getEncryptedMediaFile(content);
            if (!encryptedFile) {
                continue;
            }

            if (
                decryptedMediaUrlsRef.current[key] !== undefined ||
                inFlightDecryptionsRef.current.has(key) ||
                queuedDecryptionsRef.current.has(key)
            ) {
                continue;
            }

            const failedUntilTs = failedDecryptUntilRef.current[key];
            if (typeof failedUntilTs === "number" && failedUntilTs > Date.now()) {
                continue;
            }

            candidates.push(toDecryptQueueItem(event, content, encryptedFile));
        }

        candidates.sort((left, right) => right.timestamp - left.timestamp);
        for (const item of candidates.slice(0, availableQueueSlots)) {
            decryptQueueRef.current.push(item);
            queuedDecryptionsRef.current.add(item.key);
        }

        decryptQueueRef.current.sort((left, right) => {
            if (left.priority !== right.priority) {
                return right.priority - left.priority;
            }
            return right.timestamp - left.timestamp;
        });

        function pumpDecryptQueue(): void {
            if (cancelled) {
                return;
            }

            while (activeDecryptCountRef.current < decryptTuning.concurrency) {
                const item = decryptQueueRef.current.shift();
                if (!item) {
                    return;
                }

                queuedDecryptionsRef.current.delete(item.key);
                if (decryptedMediaUrlsRef.current[item.key] !== undefined || inFlightDecryptionsRef.current.has(item.key)) {
                    continue;
                }

                activeDecryptCountRef.current += 1;
                inFlightDecryptionsRef.current.add(item.key);
                void decryptMedia(item);
            }
        }

        pumpDecryptQueue();

        return () => {
            cancelled = true;
        };
    }, [client, decryptRerenderTick, decryptTuning, events]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container || encryptedDecryptCandidatesByKey.size === 0) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) {
                        continue;
                    }

                    const eventKeyFromDom = (entry.target as HTMLElement).dataset.eventKey;
                    if (!eventKeyFromDom) {
                        continue;
                    }

                    const item = encryptedDecryptCandidatesByKey.get(eventKeyFromDom);
                    if (!item) {
                        continue;
                    }

                    const now = Date.now();
                    if (now - lastViewportEnqueueAtRef.current < decryptTuning.viewportEnqueueThrottleMs) {
                        continue;
                    }

                    const queueLoad = decryptQueueRef.current.length + inFlightDecryptionsRef.current.size;
                    if (queueLoad >= decryptTuning.maxQueueSize) {
                        continue;
                    }

                    lastViewportEnqueueAtRef.current = now;
                    enqueueDecrypt(item, false);
                }
            },
            {
                root: container,
                threshold: 0.2,
            },
        );

        const encryptedNodes = container.querySelectorAll<HTMLElement>("[data-encrypted-media='true'][data-event-key]");
        for (const node of encryptedNodes) {
            observer.observe(node);
        }

        return () => {
            observer.disconnect();
        };
    }, [decryptTuning.maxQueueSize, decryptTuning.viewportEnqueueThrottleMs, encryptedDecryptCandidatesByKey, enqueueDecrypt]);

    useEffect(() => {
        return () => {
            const decryptedUrls = Object.values(decryptedMediaUrlsRef.current);
            for (const url of decryptedUrls) {
                if (typeof url === "string") {
                    URL.revokeObjectURL(url);
                }
            }
            decryptedMediaUrlsRef.current = {};
            inFlightDecryptionsRef.current.clear();
            queuedDecryptionsRef.current.clear();
            decryptQueueRef.current = [];
            activeDecryptCountRef.current = 0;
            failedDecryptUntilRef.current = {};
            decryptCacheAccessRef.current.clear();
            for (const controller of Object.values(decryptAbortControllersRef.current)) {
                controller.abort();
            }
            decryptAbortControllersRef.current = {};
            linkPreviewByUrlRef.current = {};
            inFlightLinkPreviewUrlsRef.current.clear();
        };
    }, [room?.roomId]);

    useEffect(() => {
        let cancelled = false;

        const fetchLinkPreview = async (url: string): Promise<void> => {
            try {
                const payload = await client.getUrlPreview(url, Date.now());
                if (cancelled) {
                    return;
                }

                linkPreviewByUrlRef.current[url] = normalizeUrlPreview(client, url, payload as Record<string, unknown>);
            } catch {
                if (!cancelled) {
                    linkPreviewByUrlRef.current[url] = null;
                }
            } finally {
                inFlightLinkPreviewUrlsRef.current.delete(url);
                if (!cancelled) {
                    setLinkPreviewRerenderTick((tick) => tick + 1);
                }
            }
        };

        for (const event of events) {
            const { content } = getDisplayContentForEvent(event, latestEditEventsByTarget);
            if (isMediaMessageType(content.msgtype)) {
                continue;
            }
            const rawBody = getTextBody(content);
            const body = rawBody ? (getReplyEventId(event) ? stripPlainReplyFallback(rawBody) : rawBody) : null;
            if (!body) {
                continue;
            }

            const previewUrl = getFirstPreviewableUrl(body);
            if (!previewUrl) {
                continue;
            }

            if (
                linkPreviewByUrlRef.current[previewUrl] !== undefined ||
                inFlightLinkPreviewUrlsRef.current.has(previewUrl)
            ) {
                continue;
            }

            inFlightLinkPreviewUrlsRef.current.add(previewUrl);
            void fetchLinkPreview(previewUrl);
        }

        return () => {
            cancelled = true;
        };
    }, [client, events, latestEditEventsByTarget]);

    useEffect(() => {
        if (!room) {
            return;
        }

        const decryptAllEvents = (room as Room & { decryptAllEvents?: () => void }).decryptAllEvents;
        decryptAllEvents?.call(room);
    }, [room]);

    useEffect(() => {
        stickToBottomRef.current = true;
        setLightbox(null);
        setHoveredMessageId(null);
        setContextMenuState(null);
        setToast(null);
        setReplyJumpTargetEventId(null);
    }, [room?.roomId]);

    useEffect(
        () => () => {
            if (replyJumpResetTimeoutRef.current !== null) {
                window.clearTimeout(replyJumpResetTimeoutRef.current);
            }
        },
        [],
    );

    useEffect(() => {
        if (!room) {
            return undefined;
        }

        const onTimeline = (_event: MatrixEvent, eventRoom?: Room): void => {
            if (eventRoom?.roomId !== room.roomId) {
                return;
            }

            refreshEvents();
        };

        const onEventDecrypted = (event: MatrixEvent): void => {
            if (event.getRoomId() !== room.roomId) {
                return;
            }

            refreshEvents();
        };

        client.on(RoomEvent.Timeline, onTimeline);
        client.on(MatrixEventEvent.Decrypted, onEventDecrypted);

        return () => {
            client.removeListener(RoomEvent.Timeline, onTimeline);
            client.removeListener(MatrixEventEvent.Decrypted, onEventDecrypted);
        };
    }, [client, refreshEvents, room]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container || !stickToBottomRef.current) {
            return;
        }

        container.scrollTop = container.scrollHeight;
    }, [events]);

    useEffect(() => {
        if (!scrollContainerRef.current) {
            return;
        }

        stickToBottomRef.current = true;
        const scrollToBottom = (): void => {
            const container = scrollContainerRef.current;
            if (!container) {
                return;
            }
            container.scrollTop = container.scrollHeight;
        };

        scrollToBottom();
        const rafId = window.requestAnimationFrame(scrollToBottom);
        const timeoutId = window.setTimeout(scrollToBottom, 80);
        return () => {
            window.cancelAnimationFrame(rafId);
            window.clearTimeout(timeoutId);
        };
    }, [focusBottomNonce, room?.roomId]);

    const markActiveRoomReadToLatest = useCallback(async (): Promise<void> => {
        if (!room || events.length === 0) {
            return;
        }

        const ownUserId = client.getUserId();
        if (!ownUserId) {
            return;
        }

        const latestEvent = events[events.length - 1];
        const latestEventId = latestEvent?.getId();
        if (!latestEvent || !latestEventId) {
            return;
        }

        if (room.hasUserReadEvent(ownUserId, latestEventId)) {
            lastReadEventIdByRoomRef.current.set(room.roomId, latestEventId);
            return;
        }
        if (lastReadEventIdByRoomRef.current.get(room.roomId) === latestEventId) {
            return;
        }
        if (readMarkerInFlightByRoomRef.current.has(room.roomId)) {
            return;
        }

        readMarkerInFlightByRoomRef.current.add(room.roomId);
        try {
            await client.setRoomReadMarkers(room.roomId, latestEventId, latestEvent);
            lastReadEventIdByRoomRef.current.set(room.roomId, latestEventId);
        } catch {
            try {
                await client.sendReadReceipt(latestEvent, undefined, true);
                lastReadEventIdByRoomRef.current.set(room.roomId, latestEventId);
            } catch {
                // Ignore transient receipt failures; next scroll/focus-at-bottom will retry.
            }
        } finally {
            readMarkerInFlightByRoomRef.current.delete(room.roomId);
        }
    }, [client, events, room]);

    useEffect(() => {
        const container = scrollContainerRef.current;
        if (!container || !room || events.length === 0) {
            return;
        }

        const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
        if (stickToBottomRef.current || distanceFromBottom <= READ_MARK_BOTTOM_THRESHOLD_PX) {
            void markActiveRoomReadToLatest();
        }
    }, [events, markActiveRoomReadToLatest, room]);

    const handleScroll = async (event: React.UIEvent<HTMLDivElement>): Promise<void> => {
        const container = event.currentTarget;

        if (contextMenuState) {
            setContextMenuState(null);
        }

        const distanceFromBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
        stickToBottomRef.current = distanceFromBottom < 100;
        if (distanceFromBottom <= READ_MARK_BOTTOM_THRESHOLD_PX) {
            void markActiveRoomReadToLatest();
        }

        if (!room || paginating || container.scrollTop > 24) {
            return;
        }

        setPaginating(true);
        const previousHeight = container.scrollHeight;

        try {
            await client.scrollback(room, 30);
            refreshEvents();

            requestAnimationFrame(() => {
                const nextHeight = container.scrollHeight;
                container.scrollTop = nextHeight - previousHeight + container.scrollTop;
            });
        } finally {
            setPaginating(false);
        }
    };

    useEffect(() => {
        if (!lightbox) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setLightbox(null);
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [lightbox]);

    const renderEvents = useMemo(
        () => toRenderEvents(client, room, events, latestEditEventsByTarget),
        [client, events, latestEditEventsByTarget, room],
    );
    const ownUserId = client.getUserId() ?? null;
    const readReceiptsByEventId = useMemo<Map<string, ReadReceiptEntry[]>>(
        () =>
            showReadReceipts && room
                ? collectReadReceiptsByEventId(client, room, events, ownUserId)
                : new Map<string, ReadReceiptEntry[]>(),
        [client, events, ownUserId, room, showReadReceipts],
    );

    if (!room) {
        return <div className="timeline-empty">Pick a room to start chatting.</div>;
    }

    return (
        <>
            <div className="timeline" ref={scrollContainerRef} onScroll={(event) => void handleScroll(event)}>
                {paginating ? <div className="timeline-paginating">Loading older messages...</div> : null}
                {renderEvents.map(({ event, content, edited, showHeader, body, reply, senderName, senderAvatarUrl, senderAvatarSources, timeLabel }) => {
                    const key = eventKey(event);
                    const eventId = event.getId();
                    const senderId = event.getSender();
                    const mediaMsgType = isMediaMessageType(content.msgtype) ? content.msgtype : null;
                    const encryptedMediaFile = getEncryptedMediaFile(content);
                    const decryptQueueItem =
                        encryptedMediaFile !== null ? toDecryptQueueItem(event, content, encryptedMediaFile) : null;
                    const unencryptedMediaMxc = getUnencryptedMediaMxc(content);
                    const unencryptedMediaUrl =
                        unencryptedMediaMxc !== null ? mediaFromMxc(client, unencryptedMediaMxc) : null;
                    const decryptedMediaUrl = decryptedMediaUrlsRef.current[key];
                    const mediaUrl = unencryptedMediaUrl ?? (typeof decryptedMediaUrl === "string" ? decryptedMediaUrl : null);
                    const decryptingEncryptedMedia =
                        Boolean(encryptedMediaFile) &&
                        decryptedMediaUrl === undefined &&
                        (queuedDecryptionsRef.current.has(key) || inFlightDecryptionsRef.current.has(key));
                    const failedToDecryptEncryptedMedia = Boolean(encryptedMediaFile) && decryptedMediaUrl === null;
                    const hasTextBody = body.trim().length > 0;
                    const imageAlt = hasTextBody ? body : "image";
                    const previewUrl = hasTextBody && !mediaMsgType ? getFirstPreviewableUrl(body) : null;
                    const linkPreview = previewUrl ? linkPreviewByUrlRef.current[previewUrl] : null;
                    const format = typeof content.format === "string" ? content.format : undefined;
                    const formattedBody = typeof content.formatted_body === "string" ? content.formatted_body : undefined;
                    const hasFormattedBody = format === "org.matrix.custom.html" && typeof formattedBody === "string";
                    const mediaSize = formatFileSize(content.info?.size);
                    const mediaDuration = formatDuration(content.info?.duration);
                    const mediaLabel = mediaMsgType ? mediaTypeLabel(mediaMsgType) : "Attachment";
                    const mediaName = hasTextBody ? body : `${mediaLabel.toLowerCase()}`;
                    const isActiveReplyTarget = Boolean(
                        (replyToEventId && replyToEventId === eventId) ||
                            (replyJumpTargetEventId && replyJumpTargetEventId === eventId),
                    );
                    const isDirectMentionEvent =
                        hasTextBody && senderId !== ownUserId && containsDirectMention(body, ownUserId);
                    const replySenderLabel =
                        reply && reply.senderName.startsWith("@") ? reply.senderName : reply ? `@${reply.senderName}` : null;
                    const messageKey = event.getId() ?? key;
                    const readReceipts = showReadReceipts && messageKey ? (readReceiptsByEventId.get(messageKey) ?? []) : [];
                    const hasMoreReadReceipts = readReceipts.length > MAX_READ_RECEIPT_AVATARS;
                    const visibleReadReceipts = hasMoreReadReceipts
                        ? readReceipts.slice(0, MAX_READ_RECEIPT_AVATARS_PLUS_N)
                        : readReceipts.slice(0, MAX_READ_RECEIPT_AVATARS);
                    const hiddenReadReceiptsCount = readReceipts.length - visibleReadReceipts.length;
                    const contextMenuPosition =
                        contextMenuState?.eventKey === messageKey
                            ? {
                                  x: contextMenuState.x,
                                  y: contextMenuState.y,
                              }
                            : null;

                    return (
                        <div
                            className={`timeline-event${isActiveReplyTarget ? " timeline-event-reply-target" : ""}${isDirectMentionEvent ? " timeline-event-direct-mention" : ""}`}
                            key={key}
                            data-event-key={key}
                            data-event-id={eventId ?? undefined}
                            data-encrypted-media={encryptedMediaFile ? "true" : "false"}
                            tabIndex={0}
                            onMouseEnter={() => setHoveredMessageId(messageKey)}
                            onMouseLeave={() => {
                                setHoveredMessageId((current) => (current === messageKey ? null : current));
                            }}
                            onFocus={() => setHoveredMessageId(messageKey)}
                            onBlur={() => {
                                setHoveredMessageId((current) => (current === messageKey ? null : current));
                            }}
                            onContextMenu={(contextMenuEvent) => {
                                contextMenuEvent.preventDefault();
                                setContextMenuState({
                                    eventKey: messageKey,
                                    x: contextMenuEvent.clientX,
                                    y: contextMenuEvent.clientY,
                                });
                            }}
                        >
                            <MessageActionsBar
                                client={client}
                                room={room}
                                event={event}
                                activeSpaceId={activeSpaceId}
                                visible={hoveredMessageId === messageKey}
                                contextMenuPosition={contextMenuPosition}
                                onRequestContextMenu={(position) =>
                                    setContextMenuState({
                                        eventKey: messageKey,
                                        x: position.x,
                                        y: position.y,
                                    })
                                }
                                onCloseContextMenu={() =>
                                    setContextMenuState((current) =>
                                        current?.eventKey === messageKey ? null : current,
                                    )
                                }
                                onReply={onReply}
                                onEdit={onEdit}
                                onToast={pushToast}
                            />
                            {reply ? (
                                <button
                                    type="button"
                                    className={`timeline-reply-reference${showHeader ? "" : " timeline-reply-reference-grouped"}`}
                                    onClick={() => void jumpToReplySource(reply.eventId)}
                                    title="Jump to original message"
                                    aria-label="Jump to original message"
                                >
                                    <span className="timeline-reply-reference-branch" aria-hidden="true" />
                                    <Avatar
                                        className="timeline-reply-avatar"
                                        name={reply.senderName}
                                        src={reply.senderAvatarUrl}
                                        sources={reply.senderAvatarSources}
                                        seed={reply.senderId}
                                        userId={reply.senderId}
                                    />
                                    <span className="timeline-reply-reference-author">{replySenderLabel}</span>
                                    <span className="timeline-reply-reference-body">{reply.body}</span>
                                </button>
                            ) : null}
                            {showHeader ? (
                                <div className="timeline-event-header">
                                    <button
                                        type="button"
                                        className="timeline-user-trigger"
                                        onClick={() => {
                                            if (senderId) {
                                                onSelectUser?.(senderId);
                                            }
                                        }}
                                        disabled={!senderId || !onSelectUser}
                                    >
                                        <Avatar
                                            className="timeline-avatar"
                                            name={senderName}
                                            src={senderAvatarUrl}
                                            sources={senderAvatarSources}
                                            seed={senderId || undefined}
                                            userId={senderId || undefined}
                                        />
                                        <span className="timeline-sender">{senderName}</span>
                                    </button>
                                    <span className="timeline-time">{timeLabel}</span>
                                    {edited ? <span className="timeline-edited">(edited)</span> : null}
                                </div>
                            ) : null}
                            {mediaMsgType === MsgType.Image && mediaUrl ? (
                                <div className={`timeline-image-wrap${showHeader ? "" : " timeline-image-wrap-grouped"}`}>
                                    <button
                                        type="button"
                                        className="timeline-image-button"
                                        onClick={() => setLightbox({ src: mediaUrl, alt: imageAlt, zoomed: false })}
                                        title="Open image"
                                        aria-label="Open image"
                                    >
                                        <img
                                            className="timeline-image"
                                            src={mediaUrl}
                                            alt={imageAlt}
                                            title={imageAlt}
                                            loading="lazy"
                                            decoding="async"
                                            onError={retryImageLoadOnce}
                                        />
                                    </button>
                                </div>
                            ) : mediaMsgType === MsgType.Video && mediaUrl ? (
                                <div className={`timeline-media-wrap${showHeader ? "" : " timeline-media-wrap-grouped"}`}>
                                    <video className="timeline-video" controls preload="metadata" src={mediaUrl}>
                                        Your browser cannot play this video.
                                    </video>
                                    <div className="timeline-media-meta">
                                        <span className="timeline-media-name" title={mediaName}>
                                            {mediaName}
                                        </span>
                                        <span className="timeline-media-details">
                                            {[mediaDuration, mediaSize].filter(Boolean).join(" . ")}
                                        </span>
                                    </div>
                                </div>
                            ) : mediaMsgType === MsgType.Audio && mediaUrl ? (
                                <div className={`timeline-media-wrap${showHeader ? "" : " timeline-media-wrap-grouped"}`}>
                                    <audio className="timeline-audio" controls preload="metadata" src={mediaUrl}>
                                        Your browser cannot play this audio.
                                    </audio>
                                    <div className="timeline-media-meta">
                                        <span className="timeline-media-name" title={mediaName}>
                                            {mediaName}
                                        </span>
                                        <span className="timeline-media-details">
                                            {[mediaDuration, mediaSize].filter(Boolean).join(" . ")}
                                        </span>
                                    </div>
                                </div>
                            ) : mediaMsgType === MsgType.File && mediaUrl ? (
                                <a
                                    className={`timeline-file-card${showHeader ? "" : " timeline-file-card-grouped"}`}
                                    href={mediaUrl}
                                    download={mediaName || undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <span className="timeline-file-icon" aria-hidden="true">
                                        FILE
                                    </span>
                                    <span className="timeline-file-content">
                                        <span className="timeline-file-name" title={mediaName}>
                                            {mediaName}
                                        </span>
                                        <span className="timeline-file-meta">
                                            {[mediaLabel, mediaSize].filter(Boolean).join(" . ")}
                                        </span>
                                    </span>
                                </a>
                            ) : decryptingEncryptedMedia ? (
                                <div className={`timeline-media-status${showHeader ? "" : " timeline-media-status-grouped"}`}>
                                    Decrypting {mediaLabel.toLowerCase()}...
                                </div>
                            ) : failedToDecryptEncryptedMedia ? (
                                <button
                                    type="button"
                                    className={`timeline-media-status timeline-media-status-error${showHeader ? "" : " timeline-media-status-grouped"}`}
                                    onClick={() => {
                                        if (decryptQueueItem) {
                                            enqueueDecrypt(decryptQueueItem, true);
                                        }
                                    }}
                                >
                                    Retry decrypting {mediaLabel.toLowerCase()}
                                </button>
                            ) : mediaMsgType && decryptQueueItem ? (
                                <button
                                    type="button"
                                    className={`timeline-media-status${showHeader ? "" : " timeline-media-status-grouped"}`}
                                    onClick={() => enqueueDecrypt(decryptQueueItem, false)}
                                >
                                    Decrypt {mediaLabel.toLowerCase()}
                                </button>
                            ) : mediaMsgType ? (
                                <div
                                    className={`timeline-media-status timeline-media-status-error${showHeader ? "" : " timeline-media-status-grouped"}`}
                                >
                                    {mediaLabel} unavailable
                                </div>
                            ) : null}
                            {!mediaMsgType ? (
                                <>
                                    {hasTextBody ? (
                                        <div
                                            className={`timeline-body${showHeader ? "" : " timeline-body-grouped"}`}
                                        >
                                            {hasFormattedBody ? (
                                                <MessageRenderer
                                                    body={body}
                                                    format={format}
                                                    formattedBody={formattedBody}
                                                    ownUserId={ownUserId}
                                                    resolveMentionDisplayName={(mentionedUserId) =>
                                                        resolveMentionDisplayName(client, room, mentionedUserId)
                                                    }
                                                    resolveImageSource={(src, width, height) => {
                                                        if (!/^mxc:\/\//i.test(src)) {
                                                            return src;
                                                        }

                                                        return (
                                                            mxcThumbnailToHttp(client, src, width, height) ??
                                                            mediaFromMxc(client, src)
                                                        );
                                                    }}
                                                />
                                            ) : (
                                                renderMessageBody(
                                                    client,
                                                    room,
                                                    ownUserId,
                                                    body,
                                                    emojiSourcesByShortcode,
                                                )
                                            )}
                                        </div>
                                    ) : null}
                                    {linkPreview ? (
                                        <a
                                            className={`timeline-link-preview${showHeader ? "" : " timeline-link-preview-grouped"}`}
                                            href={linkPreview.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {linkPreview.imageUrl ? (
                                                <img
                                                    className="timeline-link-preview-image"
                                                    src={linkPreview.imageUrl}
                                                    alt=""
                                                    loading="lazy"
                                                    decoding="async"
                                                    onError={retryImageLoadOnce}
                                                />
                                            ) : null}
                                            <span className="timeline-link-preview-body">
                                                {linkPreview.siteName ? (
                                                    <span className="timeline-link-preview-site">{linkPreview.siteName}</span>
                                                ) : null}
                                                <span className="timeline-link-preview-title">
                                                    {linkPreview.title || linkPreview.host || linkPreview.url}
                                                </span>
                                                {linkPreview.description ? (
                                                    <span className="timeline-link-preview-description">
                                                        {linkPreview.description}
                                                    </span>
                                                ) : null}
                                                <span className="timeline-link-preview-host">
                                                    {linkPreview.host || linkPreview.url}
                                                </span>
                                            </span>
                                        </a>
                                    ) : null}
                                </>
                            ) : null}
                            <ReactionsRow
                                client={client}
                                room={room}
                                mxEvent={event}
                                customReactionImagesEnabled={customReactionImagesEnabled}
                            />
                            {visibleReadReceipts.length > 0 ? (
                                <div
                                    className={`timeline-read-receipts${showHeader ? "" : " timeline-read-receipts-grouped"}`}
                                    role="group"
                                    aria-label="Read receipts"
                                >
                                    <span className="timeline-read-receipts-avatars">
                                        {visibleReadReceipts.map((readReceipt) => (
                                            <span
                                                key={readReceipt.userId}
                                                className="timeline-read-receipt-avatar-wrap"
                                                title={readReceipt.name}
                                            >
                                                <Avatar
                                                    className="timeline-read-receipt-avatar"
                                                    name={readReceipt.name}
                                                    src={readReceipt.avatarUrl}
                                                    sources={readReceipt.avatarSources}
                                                    seed={readReceipt.userId}
                                                    userId={readReceipt.userId}
                                                />
                                            </span>
                                        ))}
                                    </span>
                                    {hiddenReadReceiptsCount > 0 ? (
                                        <span className="timeline-read-receipts-more">+{hiddenReadReceiptsCount}</span>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
            {lightbox ? (
                <div
                    className="timeline-lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Image preview"
                    onClick={() => setLightbox(null)}
                >
                    <button
                        type="button"
                        className="timeline-lightbox-close"
                        onClick={() => setLightbox(null)}
                        aria-label="Close image preview"
                    >
                        x
                    </button>
                    <img
                        className={`timeline-lightbox-image${lightbox.zoomed ? " is-zoomed" : ""}`}
                        src={lightbox.src}
                        alt={lightbox.alt}
                        onClick={(event) => {
                            event.stopPropagation();
                            setLightbox((current) => (current ? { ...current, zoomed: !current.zoomed } : current));
                        }}
                    />
                </div>
            ) : null}
            <Toast toast={toast} onClose={() => setToast(null)} />
        </>
    );
}
