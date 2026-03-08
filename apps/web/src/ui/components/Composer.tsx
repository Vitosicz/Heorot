import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as encrypt from "matrix-encrypt-attachment";
import {
    EventType,
    MsgType,
    RelationType,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { getDirectRoomIds } from "../adapters/dmAdapter";
import { loadAvailableEmojis, resolveEmojiShortcode } from "../emoji/EmojiResolver";
import { subscribeEmojiPackUpdated } from "../emoji/emojiEvents";
import { normalizeEmojiShortcode } from "../emoji/EmojiPackStore";
import { formatMessageWithEmojis } from "../emoji/formatMessageWithEmojis";
import { useRoomTyping } from "../hooks/useRoomTyping";
import { mediaFromMxc } from "../adapters/media";
import { mxcThumbnailToHttp } from "../utils/mxc";
import { ComposerBar } from "./composer/ComposerBar";
import { EmojiPicker } from "./composer/EmojiPicker";
import { Toast, type ToastState } from "./Toast";
import { TypingIndicator } from "./typing/TypingIndicator";

interface ComposerProps {
    client: MatrixClient;
    room: Room | null;
    activeSpaceId: string | null;
    editingEvent: MatrixEvent | null;
    onCancelEdit: () => void;
    replyToEvent: MatrixEvent | null;
    onCancelReply: () => void;
}

interface ImageDimensions {
    w: number;
    h: number;
}

interface EncryptedAttachmentFile {
    url: string;
    key: encrypt.IEncryptedFileJWK;
    iv: string;
    hashes: Record<string, string>;
    v: string;
}

interface UploadedImage {
    url?: string;
    file?: EncryptedAttachmentFile;
}

type AttachmentMsgType = MsgType.Image | MsgType.Audio | MsgType.Video | MsgType.File;

interface MessageContent {
    msgtype?: unknown;
    body?: unknown;
}

interface OutgoingTextMessageContent {
    msgtype: MsgType.Text;
    body: string;
    format?: "org.matrix.custom.html";
    formatted_body?: string;
    "m.mentions"?: MentionsContent;
}

interface OutgoingMessageContent {
    msgtype: MsgType;
    body: string;
    format?: "org.matrix.custom.html";
    formatted_body?: string;
    info?: {
        mimetype?: string;
        size?: number;
        w?: number;
        h?: number;
        duration?: number;
    };
    url?: string;
    file?: EncryptedAttachmentFile;
    "m.relates_to"?: Record<string, unknown>;
    "m.mentions"?: MentionsContent;
}

interface MentionsContent {
    user_ids?: string[];
    room?: boolean;
}

interface MentionCandidate {
    userId: string;
    displayName: string;
}

interface MentionQueryState {
    start: number;
    end: number;
    query: string;
}

interface EmojiQueryState {
    start: number;
    end: number;
    query: string;
}

interface ComposerCustomEmoji {
    shortcode: string;
    name: string;
    src: string | null;
}

interface EmojiSuggestionCandidate {
    shortcode: string;
    name: string;
    src: string | null;
}

type FormattedMessageResult = Awaited<ReturnType<typeof formatMessageWithEmojis>>;

type UploadStatus = "queued" | "encrypting" | "uploading" | "sending" | "failed" | "cancelled";

interface ComposerUploadItem {
    id: string;
    file: File;
    roomId: string;
    replyToEventId: string | null;
    status: UploadStatus;
    loaded: number;
    total: number;
    error: string | null;
    abortController?: AbortController;
}

interface UploadAttachmentOptions {
    onProgress?: (progress: { loaded: number; total: number }) => void;
    onStageChange?: (stage: "encrypting" | "uploading") => void;
    abortController?: AbortController;
}

class UploadCanceledError extends Error {
    public constructor(message = "Upload canceled") {
        super(message);
        this.name = "UploadCanceledError";
    }
}

const TYPING_START_DEBOUNCE_MS = 350;
const TYPING_IDLE_STOP_MS = 2000;
const TYPING_TIMEOUT_MS = 5000;
const TYPING_MIN_TRUE_INTERVAL_MS = 1000;
const TYPING_REFRESH_MARGIN_MS = 1000;
const CUSTOM_EMOJI_TOKEN_PATTERN = /:[a-zA-Z0-9_+-]{2,}:/g;
const EMOJI_SUGGESTION_LIMIT = 8;

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

function getReplySenderName(room: Room | null, event: MatrixEvent): string {
    const senderId = event.getSender() ?? "unknown";
    const sender = room?.getMember(senderId);
    return sender?.rawDisplayName || sender?.name || senderId;
}

function getReplySnippet(event: MatrixEvent): string {
    const content = event.getContent() as MessageContent;
    const body = typeof content.body === "string" ? stripPlainReplyFallback(content.body).trim() : "";

    if (content.msgtype === MsgType.Image) {
        return body ? `[Image] ${body}` : "[Image]";
    }

    if (content.msgtype === MsgType.Video) {
        return body ? `[Video] ${body}` : "[Video]";
    }

    if (content.msgtype === MsgType.Audio) {
        return body ? `[Audio] ${body}` : "[Audio]";
    }

    if (content.msgtype === MsgType.File) {
        return body ? `[File] ${body}` : "[File]";
    }

    if (!body) {
        return "Message";
    }

    return body.length > 96 ? `${body.slice(0, 93)}...` : body;
}

function attachReplyRelation(content: OutgoingMessageContent, replyEventId: string | null): void {
    if (!replyEventId) {
        return;
    }

    const writable = content as unknown as Record<string, unknown>;
    const existingRelatesTo = writable["m.relates_to"];
    const relatesTo =
        existingRelatesTo && typeof existingRelatesTo === "object"
            ? (existingRelatesTo as Record<string, unknown>)
            : {};

    writable["m.relates_to"] = {
        ...relatesTo,
        "m.in_reply_to": {
            event_id: replyEventId,
        },
    };
}

async function readImageDimensions(file: File): Promise<ImageDimensions | null> {
    const objectUrl = URL.createObjectURL(file);

    try {
        const dimensions = await new Promise<ImageDimensions>((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                resolve({
                    w: image.naturalWidth || image.width,
                    h: image.naturalHeight || image.height,
                });
            };
            image.onerror = () => reject(new Error("Unable to read image dimensions"));
            image.src = objectUrl;
        });
        return dimensions;
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function readAudioDuration(file: File): Promise<number | null> {
    const objectUrl = URL.createObjectURL(file);

    try {
        const durationMs = await new Promise<number>((resolve, reject) => {
            const audio = document.createElement("audio");
            audio.preload = "metadata";
            audio.onloadedmetadata = () => {
                const durationSeconds = Number.isFinite(audio.duration) ? audio.duration : 0;
                resolve(Math.max(0, Math.ceil(durationSeconds * 1000)));
            };
            audio.onerror = () => reject(new Error("Unable to read audio duration"));
            audio.src = objectUrl;
        });
        return durationMs > 0 ? durationMs : null;
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

async function readVideoMetadata(file: File): Promise<(ImageDimensions & { duration: number | null }) | null> {
    const objectUrl = URL.createObjectURL(file);

    try {
        return await new Promise<ImageDimensions & { duration: number | null }>((resolve, reject) => {
            const video = document.createElement("video");
            video.preload = "metadata";
            video.onloadedmetadata = () => {
                const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0;
                resolve({
                    w: video.videoWidth || 0,
                    h: video.videoHeight || 0,
                    duration: durationSeconds > 0 ? Math.ceil(durationSeconds * 1000) : null,
                });
            };
            video.onerror = () => reject(new Error("Unable to read video metadata"));
            video.src = objectUrl;
        });
    } catch {
        return null;
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function resolveAttachmentMsgType(file: File): AttachmentMsgType {
    const mime = file.type.trim().toLowerCase();
    if (mime.startsWith("image/")) {
        return MsgType.Image;
    }
    if (mime.startsWith("audio/")) {
        return MsgType.Audio;
    }
    if (mime.startsWith("video/")) {
        return MsgType.Video;
    }
    return MsgType.File;
}

async function buildAttachmentInfo(file: File): Promise<{ msgtype: AttachmentMsgType; info: OutgoingMessageContent["info"] }> {
    const msgtype = resolveAttachmentMsgType(file);
    const info: NonNullable<OutgoingMessageContent["info"]> = {
        mimetype: file.type || undefined,
        size: file.size,
    };

    if (msgtype === MsgType.Image) {
        const dimensions = await readImageDimensions(file);
        if (dimensions) {
            info.w = dimensions.w;
            info.h = dimensions.h;
        }
    } else if (msgtype === MsgType.Audio) {
        const duration = await readAudioDuration(file);
        if (duration) {
            info.duration = duration;
        }
    } else if (msgtype === MsgType.Video) {
        const metadata = await readVideoMetadata(file);
        if (metadata) {
            if (metadata.w > 0) {
                info.w = metadata.w;
            }
            if (metadata.h > 0) {
                info.h = metadata.h;
            }
            if (metadata.duration) {
                info.duration = metadata.duration;
            }
        }
    }

    return {
        msgtype,
        info,
    };
}

function getAttachmentLabel(msgtype: AttachmentMsgType): string {
    if (msgtype === MsgType.Image) {
        return "image";
    }
    if (msgtype === MsgType.Video) {
        return "video";
    }
    if (msgtype === MsgType.Audio) {
        return "audio";
    }
    return "file";
}

function isAbortError(error: unknown): boolean {
    if (error instanceof UploadCanceledError) {
        return true;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
        return true;
    }

    if (error && typeof error === "object" && "name" in error) {
        return (error as { name?: string }).name === "AbortError";
    }

    return false;
}

function hasTransferFiles(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) {
        return false;
    }

    if (dataTransfer.files && dataTransfer.files.length > 0) {
        return true;
    }

    return Array.from(dataTransfer.types ?? []).includes("Files");
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }

    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function getUploadLabel(upload: ComposerUploadItem): string {
    switch (upload.status) {
        case "queued":
            return "Queued";
        case "encrypting":
            return "Encrypting...";
        case "uploading": {
            const percent = upload.total > 0 ? Math.round((upload.loaded / upload.total) * 100) : 0;
            return `Uploading ${percent}%`;
        }
        case "sending":
            return "Sending message...";
        case "failed":
            return "Upload failed";
        case "cancelled":
            return "Canceled";
    }
}

async function uploadAttachmentLikeElement(
    client: MatrixClient,
    roomId: string,
    file: File,
    options: UploadAttachmentOptions = {},
): Promise<UploadedImage> {
    const abortController = options.abortController ?? new AbortController();
    const isEncryptionEnabled = Boolean(await client.getCrypto()?.isEncryptionEnabledInRoom(roomId));
    if (!isEncryptionEnabled) {
        options.onStageChange?.("uploading");
        const { content_uri: url } = await client.uploadContent(file, {
            abortController,
            progressHandler: options.onProgress,
        });
        return { url };
    }

    options.onStageChange?.("encrypting");
    const data = await file.arrayBuffer();
    if (abortController.signal.aborted) {
        throw new UploadCanceledError();
    }

    const encryptedAttachment = await encrypt.encryptAttachment(data);
    if (abortController.signal.aborted) {
        throw new UploadCanceledError();
    }

    const hashes = encryptedAttachment.info.hashes;
    if (!hashes || typeof hashes.sha256 !== "string") {
        throw new Error("Encrypted attachment metadata is incomplete");
    }

    const encryptedBlob = new Blob([encryptedAttachment.data], { type: "application/octet-stream" });
    options.onStageChange?.("uploading");
    const { content_uri: url } = await client.uploadContent(encryptedBlob, {
        abortController,
        progressHandler: options.onProgress,
        includeFilename: false,
        type: "application/octet-stream",
    });

    return {
        file: {
            key: encryptedAttachment.info.key,
            iv: encryptedAttachment.info.iv,
            hashes: hashes as Record<string, string>,
            v: encryptedAttachment.info.v ?? "v2",
            url,
        },
    };
}

function getEditingInitialText(event: MatrixEvent | null): string {
    if (!event) {
        return "";
    }

    const content = event.getContent() as MessageContent;
    const body = typeof content.body === "string" ? content.body : "";
    return stripPlainReplyFallback(body);
}

function buildTextMessageContent(formattedMessage: FormattedMessageResult): OutgoingTextMessageContent {
    return {
        msgtype: MsgType.Text,
        ...formattedMessage,
    };
}

function buildEditMessageContent(
    originalEventId: string,
    newContent: OutgoingTextMessageContent,
    mentions?: MentionsContent,
): Record<string, unknown> {
    const contentWithMentions: OutgoingTextMessageContent = mentions
        ? {
              ...newContent,
              "m.mentions": mentions,
          }
        : newContent;

    return {
        ...contentWithMentions,
        "m.new_content": {
            ...contentWithMentions,
        },
        "m.relates_to": {
            rel_type: RelationType.Replace,
            event_id: originalEventId,
        },
    };
}

function getDirectMessageTargetName(client: MatrixClient, room: Room): string | null {
    const directRoomIds = getDirectRoomIds(client);
    if (!directRoomIds.has(room.roomId)) {
        return null;
    }

    const ownUserId = client.getUserId();
    const candidates = room
        .getMembers()
        .filter((member) => (member.membership === "join" || member.membership === "invite") && member.userId !== ownUserId)
        .map((member) => member.rawDisplayName || member.name || member.userId)
        .filter((name) => Boolean(name))
        .sort((left, right) =>
            left.localeCompare(right, undefined, {
                sensitivity: "base",
            }),
        );

    return candidates[0] ?? null;
}

function getComposerPlaceholder(client: MatrixClient, room: Room | null): string {
    if (!room) {
        return "Select a room to start chatting";
    }

    const dmTargetName = getDirectMessageTargetName(client, room);
    if (dmTargetName) {
        const normalizedTarget = dmTargetName.startsWith("@") ? dmTargetName : `@${dmTargetName}`;
        return `Message ${normalizedTarget}`;
    }

    return `Message #${room.name || room.roomId}`;
}

const MENTION_BOUNDARY_PUNCTUATION = new Set([
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    "<",
    ">",
    "\"",
    "'",
    "`",
    "~",
    "!",
    "?",
    ",",
    ".",
    ";",
    ":",
    "+",
    "-",
    "/",
    "*",
    "\\",
    "|",
]);
const MENTION_LEADING_TRIM_CHARS = new Set(["(", "[", "{", "<"]);
const MENTION_TRAILING_TRIM_CHARS = new Set([")", "]", "}", ">", ".", ",", "!", "?", ";", ":"]);

function isWhitespaceCharacter(character: string): boolean {
    return character.trim().length === 0;
}

function isMentionBoundaryCharacter(character: string): boolean {
    return isWhitespaceCharacter(character) || MENTION_BOUNDARY_PUNCTUATION.has(character);
}

function containsWhitespace(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (isWhitespaceCharacter(value[index])) {
            return true;
        }
    }

    return false;
}

function getActiveMentionQuery(text: string, caret: number): MentionQueryState | null {
    if (!Number.isFinite(caret) || caret < 0 || caret > text.length) {
        return null;
    }

    const beforeCaret = text.slice(0, caret);
    const atIndex = beforeCaret.lastIndexOf("@");
    if (atIndex < 0) {
        return null;
    }

    if (atIndex > 0 && !isMentionBoundaryCharacter(beforeCaret[atIndex - 1])) {
        return null;
    }

    const token = beforeCaret.slice(atIndex + 1);
    if (containsWhitespace(token) || token.includes(":") || token.length > 64) {
        return null;
    }

    return {
        start: atIndex,
        end: caret,
        query: token,
    };
}

function getActiveEmojiQuery(text: string, caret: number): EmojiQueryState | null {
    if (!Number.isFinite(caret) || caret < 0 || caret > text.length) {
        return null;
    }

    const beforeCaret = text.slice(0, caret);
    const colonIndex = beforeCaret.lastIndexOf(":");
    if (colonIndex < 0) {
        return null;
    }

    if (colonIndex > 0 && !isMentionBoundaryCharacter(beforeCaret[colonIndex - 1])) {
        return null;
    }

    const token = beforeCaret.slice(colonIndex + 1);
    if (containsWhitespace(token) || token.includes(":") || token.length > 64) {
        return null;
    }

    return {
        start: colonIndex,
        end: caret,
        query: token,
    };
}

function tokenizeComposerPreview(
    text: string,
    emojiSourceByShortcode: ReadonlyMap<string, string>,
): { nodes: React.ReactNode[]; hasCustomEmoji: boolean } {
    if (!text) {
        return { nodes: [], hasCustomEmoji: false };
    }

    const nodes: React.ReactNode[] = [];
    let hasCustomEmoji = false;
    let cursor = 0;
    let match: RegExpExecArray | null;

    CUSTOM_EMOJI_TOKEN_PATTERN.lastIndex = 0;
    while ((match = CUSTOM_EMOJI_TOKEN_PATTERN.exec(text)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;

        if (start > cursor) {
            nodes.push(
                <React.Fragment key={`preview_text_${cursor}`}>{text.slice(cursor, start)}</React.Fragment>,
            );
        }

        const normalizedShortcode = normalizeEmojiShortcode(token);
        const source = emojiSourceByShortcode.get(normalizedShortcode);
        if (source) {
            hasCustomEmoji = true;
            nodes.push(
                <img
                    key={`preview_emoji_${start}`}
                    className="composer-inline-custom-emoji"
                    src={source}
                    alt={normalizedShortcode}
                    title={normalizedShortcode}
                    width={20}
                    height={20}
                    loading="lazy"
                    decoding="async"
                />,
            );
        } else {
            nodes.push(<React.Fragment key={`preview_token_${start}`}>{token}</React.Fragment>);
        }

        cursor = end;
    }

    if (cursor < text.length) {
        nodes.push(<React.Fragment key={`preview_tail_${cursor}`}>{text.slice(cursor)}</React.Fragment>);
    }

    if (nodes.length === 0) {
        nodes.push(<React.Fragment key="preview_text_full">{text}</React.Fragment>);
    }

    return {
        nodes,
        hasCustomEmoji,
    };
}

function trimMentionTokenEdges(token: string): string {
    let start = 0;
    let end = token.length;

    while (start < end && MENTION_LEADING_TRIM_CHARS.has(token[start])) {
        start += 1;
    }

    while (end > start && MENTION_TRAILING_TRIM_CHARS.has(token[end - 1])) {
        end -= 1;
    }

    return token.slice(start, end);
}

function normalizeMentionToken(token: string): string {
    return trimMentionTokenEdges(token);
}

function splitOnWhitespace(value: string): string[] {
    const out: string[] = [];
    let tokenStart = -1;

    for (let index = 0; index < value.length; index++) {
        if (isWhitespaceCharacter(value[index])) {
            if (tokenStart >= 0) {
                out.push(value.slice(tokenStart, index));
                tokenStart = -1;
            }
            continue;
        }

        if (tokenStart < 0) {
            tokenStart = index;
        }
    }

    if (tokenStart >= 0) {
        out.push(value.slice(tokenStart));
    }

    return out;
}

function extractMentionedUserIds(rawText: string, room: Room): string[] {
    const mentionedUserIds = new Set<string>();
    const tokens = splitOnWhitespace(rawText).map(normalizeMentionToken);

    for (const token of tokens) {
        if (!token.startsWith("@") || !token.includes(":")) {
            continue;
        }

        const member = room.getMember(token);
        if (!member) {
            continue;
        }

        if (member.membership !== "join" && member.membership !== "invite" && member.membership !== "knock") {
            continue;
        }

        mentionedUserIds.add(token);
    }

    return Array.from(mentionedUserIds);
}

function buildMentionsPayload(rawText: string, room: Room): MentionsContent | undefined {
    const userIds = extractMentionedUserIds(rawText, room);
    if (userIds.length === 0) {
        return undefined;
    }

    return { user_ids: userIds };
}

export function Composer({
    client,
    room,
    activeSpaceId,
    editingEvent,
    onCancelEdit,
    replyToEvent,
    onCancelReply,
}: ComposerProps): React.ReactElement {
    const ownUserId = client.getUserId() ?? "";
    const [text, setText] = useState("");
    const [sendingText, setSendingText] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    const [uploads, setUploads] = useState<ComposerUploadItem[]>([]);
    const [toast, setToast] = useState<ToastState | null>(null);
    const [customEmojis, setCustomEmojis] = useState<ComposerCustomEmoji[]>([]);
    const [mentionQuery, setMentionQuery] = useState<MentionQueryState | null>(null);
    const [mentionSelectionIndex, setMentionSelectionIndex] = useState(0);
    const [emojiQuery, setEmojiQuery] = useState<EmojiQueryState | null>(null);
    const [emojiSelectionIndex, setEmojiSelectionIndex] = useState(0);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const emojiButtonRef = useRef<HTMLButtonElement | null>(null);
    const emojiPickerRef = useRef<HTMLDivElement | null>(null);
    const dragDepthRef = useRef(0);
    const restoreFocusRoomIdRef = useRef<string | null>(null);
    const uploadsRef = useRef<ComposerUploadItem[]>([]);
    const processingUploadsRef = useRef<Set<string>>(new Set());
    const typingStartTimerRef = useRef<number | null>(null);
    const typingStopTimerRef = useRef<number | null>(null);
    const typingRefreshTimerRef = useRef<number | null>(null);
    const isTypingLocalRef = useRef(false);
    const lastTypingTrueSentAtRef = useRef(0);
    const typingRoomIdRef = useRef<string | null>(null);
    const currentRoomIdRef = useRef<string | null>(room?.roomId ?? null);
    const replySenderName = replyToEvent ? getReplySenderName(room, replyToEvent) : null;
    const replySnippet = replyToEvent ? getReplySnippet(replyToEvent) : null;
    const editingEventId = editingEvent?.getId() ?? null;
    const placeholder = useMemo(() => getComposerPlaceholder(client, room), [client, room]);
    const typingUserIds = useRoomTyping(client, room);
    const customEmojiSourceByShortcode = useMemo(() => {
        const sourceByShortcode = new Map<string, string>();
        for (const customEmoji of customEmojis) {
            if (customEmoji.src && !sourceByShortcode.has(customEmoji.shortcode)) {
                sourceByShortcode.set(customEmoji.shortcode, customEmoji.src);
            }
        }
        return sourceByShortcode;
    }, [customEmojis]);
    const composerPreview = useMemo(
        () => tokenizeComposerPreview(text, customEmojiSourceByShortcode),
        [customEmojiSourceByShortcode, text],
    );
    const mentionCandidates = useMemo(() => {
        if (!room || !mentionQuery) {
            return [];
        }

        const normalizedQuery = mentionQuery.query.trim().toLowerCase();
        const byUserId = new Map<string, MentionCandidate>();

        for (const member of room.getMembers()) {
            if (member.userId === ownUserId) {
                continue;
            }
            if (member.membership !== "join" && member.membership !== "invite" && member.membership !== "knock") {
                continue;
            }

            const displayName = member.rawDisplayName || member.name || member.userId;
            const searchableDisplayName = displayName.toLowerCase();
            const searchableUserId = member.userId.toLowerCase();

            if (normalizedQuery) {
                const matchesDisplay = searchableDisplayName.includes(normalizedQuery);
                const matchesUserId = searchableUserId.includes(normalizedQuery);
                if (!matchesDisplay && !matchesUserId) {
                    continue;
                }
            }

            if (!byUserId.has(member.userId)) {
                byUserId.set(member.userId, {
                    userId: member.userId,
                    displayName,
                });
            }
        }

        return Array.from(byUserId.values())
            .sort((left, right) => {
                const byName = left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
                if (byName !== 0) {
                    return byName;
                }
                return left.userId.localeCompare(right.userId, undefined, { sensitivity: "base" });
            })
            .slice(0, 8);
    }, [mentionQuery, ownUserId, room]);
    const emojiCandidates = useMemo<EmojiSuggestionCandidate[]>(() => {
        if (!emojiQuery) {
            return [];
        }

        const normalizedQuery = emojiQuery.query.trim().toLowerCase();
        const queryWithoutColons = normalizedQuery.replace(/^:+/, "").replace(/:+$/, "");

        return customEmojis
            .map((emoji) => {
                const shortcodeLower = emoji.shortcode.toLowerCase();
                const nameLower = emoji.name.toLowerCase();
                const shortcodeWithoutColons = shortcodeLower.replace(/^:+/, "").replace(/:+$/, "");
                let score = 10;

                if (!queryWithoutColons) {
                    score = 0;
                } else if (shortcodeWithoutColons.startsWith(queryWithoutColons)) {
                    score = 0;
                } else if (nameLower.startsWith(queryWithoutColons)) {
                    score = 1;
                } else if (shortcodeWithoutColons.includes(queryWithoutColons)) {
                    score = 2;
                } else if (nameLower.includes(queryWithoutColons)) {
                    score = 3;
                }

                return {
                    shortcode: emoji.shortcode,
                    name: emoji.name,
                    src: emoji.src,
                    score,
                };
            })
            .filter((emoji) => emoji.score < 10)
            .sort((left, right) => {
                if (left.score !== right.score) {
                    return left.score - right.score;
                }
                const byShortcode = left.shortcode.localeCompare(right.shortcode, undefined, { sensitivity: "base" });
                if (byShortcode !== 0) {
                    return byShortcode;
                }
                return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
            })
            .slice(0, EMOJI_SUGGESTION_LIMIT)
            .map((emoji) => ({
                shortcode: emoji.shortcode,
                name: emoji.name,
                src: emoji.src,
            }));
    }, [customEmojis, emojiQuery]);

    const pushToast = useCallback((nextToast: Omit<ToastState, "id">): void => {
        setToast({
            id: Date.now(),
            ...nextToast,
        });
    }, []);

    const syncMentionQuery = useCallback((nextText: string, caret: number | null): void => {
        if (caret === null) {
            setMentionQuery(null);
            return;
        }

        setMentionQuery(getActiveMentionQuery(nextText, caret));
    }, []);

    const syncEmojiQuery = useCallback((nextText: string, caret: number | null): void => {
        if (caret === null) {
            setEmojiQuery(null);
            return;
        }

        setEmojiQuery(getActiveEmojiQuery(nextText, caret));
    }, []);

    const syncComposerQueriesFromCursor = useCallback(
        (caret: number | null): void => {
            syncMentionQuery(text, caret);
            syncEmojiQuery(text, caret);
        },
        [syncEmojiQuery, syncMentionQuery, text],
    );

    useEffect(() => {
        if (!room) {
            setCustomEmojis([]);
            return;
        }

        let cancelled = false;

        const loadCustomEmojis = async (): Promise<void> => {
            try {
                const available = await loadAvailableEmojis(client, room, activeSpaceId);
                if (cancelled) {
                    return;
                }

                setCustomEmojis(
                    available.map((emoji) => ({
                        shortcode: emoji.shortcode,
                        name: emoji.name,
                        src: mxcThumbnailToHttp(client, emoji.url, 24, 24) ?? mediaFromMxc(client, emoji.url),
                    })),
                );
            } catch {
                if (!cancelled) {
                    setCustomEmojis([]);
                }
            }
        };

        void loadCustomEmojis();
        const unsubscribeEmojiPackUpdated = subscribeEmojiPackUpdated(() => {
            void loadCustomEmojis();
        });

        return () => {
            cancelled = true;
            unsubscribeEmojiPackUpdated();
        };
    }, [activeSpaceId, client, room]);

    const clearTypingTimers = useCallback((): void => {
        if (typingStartTimerRef.current !== null) {
            window.clearTimeout(typingStartTimerRef.current);
            typingStartTimerRef.current = null;
        }
        if (typingStopTimerRef.current !== null) {
            window.clearTimeout(typingStopTimerRef.current);
            typingStopTimerRef.current = null;
        }
        if (typingRefreshTimerRef.current !== null) {
            window.clearTimeout(typingRefreshTimerRef.current);
            typingRefreshTimerRef.current = null;
        }
    }, []);

    const sendTypingSafe = useCallback(
        async (roomId: string, isTyping: boolean): Promise<boolean> => {
            if (!roomId) {
                return false;
            }

            try {
                await client.sendTyping(roomId, isTyping, isTyping ? TYPING_TIMEOUT_MS : 0);
                return true;
            } catch {
                return false;
            }
        },
        [client],
    );

    const startLocalTyping = useCallback(
        (roomId: string, force = false): void => {
            const now = Date.now();
            if (!force && now - lastTypingTrueSentAtRef.current < TYPING_MIN_TRUE_INTERVAL_MS) {
                return;
            }

            void (async () => {
                const sent = await sendTypingSafe(roomId, true);
                if (!sent || currentRoomIdRef.current !== roomId) {
                    return;
                }

                isTypingLocalRef.current = true;
                typingRoomIdRef.current = roomId;
                lastTypingTrueSentAtRef.current = Date.now();

                if (typingRefreshTimerRef.current !== null) {
                    window.clearTimeout(typingRefreshTimerRef.current);
                }

                const refreshDelay = Math.max(
                    TYPING_MIN_TRUE_INTERVAL_MS,
                    TYPING_TIMEOUT_MS - TYPING_REFRESH_MARGIN_MS,
                );
                typingRefreshTimerRef.current = window.setTimeout(() => {
                    if (!isTypingLocalRef.current || currentRoomIdRef.current !== roomId) {
                        return;
                    }
                    startLocalTyping(roomId, true);
                }, refreshDelay);
            })();
        },
        [sendTypingSafe],
    );

    const stopLocalTyping = useCallback(
        (roomId?: string): void => {
            clearTypingTimers();

            const targetRoomId = roomId ?? typingRoomIdRef.current ?? currentRoomIdRef.current;
            const wasTyping = isTypingLocalRef.current;

            isTypingLocalRef.current = false;
            typingRoomIdRef.current = null;
            lastTypingTrueSentAtRef.current = 0;

            if (!wasTyping || !targetRoomId) {
                return;
            }

            void sendTypingSafe(targetRoomId, false);
        },
        [clearTypingTimers, sendTypingSafe],
    );

    const scheduleTypingStop = useCallback(
        (roomId: string): void => {
            if (typingStopTimerRef.current !== null) {
                window.clearTimeout(typingStopTimerRef.current);
            }

            typingStopTimerRef.current = window.setTimeout(() => {
                if (currentRoomIdRef.current !== roomId) {
                    return;
                }
                stopLocalTyping(roomId);
            }, TYPING_IDLE_STOP_MS);
        },
        [stopLocalTyping],
    );

    const handleTypingActivity = useCallback(
        (nextText: string): void => {
            const roomId = room?.roomId;
            if (!roomId) {
                return;
            }

            currentRoomIdRef.current = roomId;

            if (!nextText.trim()) {
                scheduleTypingStop(roomId);
                return;
            }

            if (!isTypingLocalRef.current) {
                if (typingStartTimerRef.current !== null) {
                    window.clearTimeout(typingStartTimerRef.current);
                }

                typingStartTimerRef.current = window.setTimeout(() => {
                    typingStartTimerRef.current = null;
                    if (currentRoomIdRef.current !== roomId) {
                        return;
                    }
                    startLocalTyping(roomId);
                }, TYPING_START_DEBOUNCE_MS);
            } else {
                const elapsed = Date.now() - lastTypingTrueSentAtRef.current;
                const nearTimeout = elapsed >= TYPING_TIMEOUT_MS - TYPING_REFRESH_MARGIN_MS;
                if (nearTimeout && elapsed >= TYPING_MIN_TRUE_INTERVAL_MS) {
                    startLocalTyping(roomId, true);
                }
            }

            scheduleTypingStop(roomId);
        },
        [room?.roomId, scheduleTypingStop, startLocalTyping],
    );

    const resizeTextarea = useCallback((): void => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        const minHeight = 24;
        const maxHeight = 220;
        textarea.style.height = "0px";
        const targetHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
        textarea.style.height = `${targetHeight}px`;
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    }, []);

    const insertTokenAtCursor = useCallback(
        (token: string): void => {
            const textarea = textareaRef.current;
            const currentValue = textarea?.value ?? text;
            const start = textarea?.selectionStart ?? currentValue.length;
            const end = textarea?.selectionEnd ?? currentValue.length;
            const nextValue = `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`;
            const nextCaret = start + token.length;

            setText(nextValue);
            handleTypingActivity(nextValue);
            syncMentionQuery(nextValue, nextCaret);
            syncEmojiQuery(nextValue, nextCaret);
            setMentionSelectionIndex(0);
            setEmojiSelectionIndex(0);
            if (error) {
                setError(null);
            }

            requestAnimationFrame(() => {
                const nextTextarea = textareaRef.current;
                if (!nextTextarea) {
                    return;
                }

                nextTextarea.focus();
                nextTextarea.setSelectionRange(nextCaret, nextCaret);
                resizeTextarea();
            });
        },
        [error, handleTypingActivity, resizeTextarea, syncEmojiQuery, syncMentionQuery, text],
    );

    const applyMentionCandidate = useCallback(
        (candidate: MentionCandidate): void => {
            if (!mentionQuery) {
                return;
            }

            const replacement = `${candidate.userId} `;
            let nextText = "";
            const nextCaret = mentionQuery.start + replacement.length;

            setText((current) => {
                const safeStart = Math.max(0, Math.min(mentionQuery.start, current.length));
                const safeEnd = Math.max(safeStart, Math.min(mentionQuery.end, current.length));
                nextText = `${current.slice(0, safeStart)}${replacement}${current.slice(safeEnd)}`;
                return nextText;
            });

            if (nextText) {
                handleTypingActivity(nextText);
            }
            if (error) {
                setError(null);
            }

            setMentionQuery(null);
            setEmojiQuery(null);
            setMentionSelectionIndex(0);
            setEmojiSelectionIndex(0);

            requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) {
                    return;
                }

                textarea.focus();
                textarea.setSelectionRange(nextCaret, nextCaret);
                resizeTextarea();
            });
        },
        [error, handleTypingActivity, mentionQuery, resizeTextarea],
    );

    const applyEmojiCandidate = useCallback(
        (candidate: EmojiSuggestionCandidate): void => {
            if (!emojiQuery) {
                return;
            }

            const replacement = `${candidate.shortcode} `;
            let nextText = "";
            const nextCaret = emojiQuery.start + replacement.length;

            setText((current) => {
                const safeStart = Math.max(0, Math.min(emojiQuery.start, current.length));
                const safeEnd = Math.max(safeStart, Math.min(emojiQuery.end, current.length));
                nextText = `${current.slice(0, safeStart)}${replacement}${current.slice(safeEnd)}`;
                return nextText;
            });

            if (nextText) {
                handleTypingActivity(nextText);
            }
            if (error) {
                setError(null);
            }

            setEmojiQuery(null);
            setMentionQuery(null);
            setEmojiSelectionIndex(0);
            setMentionSelectionIndex(0);

            requestAnimationFrame(() => {
                const textarea = textareaRef.current;
                if (!textarea) {
                    return;
                }

                textarea.focus();
                textarea.setSelectionRange(nextCaret, nextCaret);
                resizeTextarea();
            });
        },
        [emojiQuery, error, handleTypingActivity, resizeTextarea],
    );

    useEffect(() => {
        resizeTextarea();
    }, [resizeTextarea, text]);

    useEffect(() => {
        if (!mentionQuery || mentionCandidates.length === 0) {
            setMentionSelectionIndex(0);
            return;
        }

        setMentionSelectionIndex((current) => Math.min(current, mentionCandidates.length - 1));
    }, [mentionCandidates.length, mentionQuery]);

    useEffect(() => {
        if (!emojiQuery || emojiCandidates.length === 0) {
            setEmojiSelectionIndex(0);
            return;
        }

        setEmojiSelectionIndex((current) => Math.min(current, emojiCandidates.length - 1));
    }, [emojiCandidates.length, emojiQuery]);

    useEffect(() => {
        if (sendingText) {
            return;
        }

        const targetRoomId = restoreFocusRoomIdRef.current;
        if (!targetRoomId || targetRoomId !== room?.roomId) {
            return;
        }

        restoreFocusRoomIdRef.current = null;
        const textarea = textareaRef.current;
        if (!textarea || textarea.disabled) {
            return;
        }

        const activeElement = document.activeElement as HTMLElement | null;
        if (activeElement && activeElement !== document.body && activeElement !== textarea) {
            return;
        }

        textarea.focus();
        const caret = textarea.value.length;
        textarea.setSelectionRange(caret, caret);
    }, [room?.roomId, sendingText]);

    useEffect(() => {
        uploadsRef.current = uploads;
    }, [uploads]);

    useEffect(() => {
        if (!editingEvent) {
            return;
        }

        setText(getEditingInitialText(editingEvent));
        setError(null);
        setEmojiPickerOpen(false);
        setMentionQuery(null);
        setEmojiQuery(null);
        setMentionSelectionIndex(0);
        setEmojiSelectionIndex(0);
    }, [editingEvent, editingEventId]);

    useEffect(() => {
        const nextRoomId = room?.roomId ?? null;
        const previousRoomId = currentRoomIdRef.current;

        if (previousRoomId && previousRoomId !== nextRoomId && isTypingLocalRef.current) {
            void sendTypingSafe(previousRoomId, false);
        }

        clearTypingTimers();
        isTypingLocalRef.current = false;
        typingRoomIdRef.current = null;
        lastTypingTrueSentAtRef.current = 0;
        currentRoomIdRef.current = nextRoomId;

        for (const upload of uploadsRef.current) {
            upload.abortController?.abort();
        }

        processingUploadsRef.current.clear();
        dragDepthRef.current = 0;
        setDragActive(false);
        setUploads([]);
        setEmojiPickerOpen(false);
        setMentionQuery(null);
        setEmojiQuery(null);
        setMentionSelectionIndex(0);
        setEmojiSelectionIndex(0);
    }, [clearTypingTimers, room?.roomId, sendTypingSafe]);

    useEffect(() => {
        return () => {
            stopLocalTyping();
            for (const upload of uploadsRef.current) {
                upload.abortController?.abort();
            }
            processingUploadsRef.current.clear();
        };
    }, [stopLocalTyping]);

    useEffect(() => {
        if (!emojiPickerOpen) {
            return undefined;
        }

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if (emojiPickerRef.current?.contains(target)) {
                return;
            }

            if (emojiButtonRef.current?.contains(target)) {
                return;
            }

            setEmojiPickerOpen(false);
        };

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setEmojiPickerOpen(false);
                textareaRef.current?.focus();
            }
        };

        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKeyDown);

        return () => {
            window.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [emojiPickerOpen]);

    const sendMessage = async (): Promise<void> => {
        if (!room || sendingText) {
            return;
        }

        if (room.getMyMembership() !== "join") {
            setError("Room is not joined yet. Wait for join to finish or press Join.");
            return;
        }

        const rawText = text;
        const hasTextToSend = rawText.trim().length > 0;
        const queuedUploadsForRoom = uploadsRef.current.filter(
            (upload) => upload.roomId === room.roomId && upload.status === "queued",
        );
        const hasQueuedUploads = queuedUploadsForRoom.length > 0;

        if (!hasTextToSend && !hasQueuedUploads) {
            return;
        }

        const wasEditingMessage = Boolean(editingEventId);
        const hadReply = Boolean(replyToEvent) && !wasEditingMessage;
        restoreFocusRoomIdRef.current =
            document.activeElement === textareaRef.current ? room.roomId : null;
        stopLocalTyping(room.roomId);
        setSendingText(true);
        setError(null);
        setText("");
        setEmojiPickerOpen(false);
        setMentionQuery(null);
        setEmojiQuery(null);
        setMentionSelectionIndex(0);
        setEmojiSelectionIndex(0);
        try {
            if (hasTextToSend) {
                const mentions = buildMentionsPayload(rawText, room);
                const formattedMessage = await formatMessageWithEmojis(
                    rawText,
                    {
                        roomId: room.roomId,
                        activeSpaceId,
                    },
                    resolveEmojiShortcode,
                    client,
                );

                const newContent = buildTextMessageContent(formattedMessage);
                if (editingEventId) {
                    const editContent = buildEditMessageContent(editingEventId, newContent, mentions);
                    await client.sendEvent(
                        room.roomId,
                        EventType.RoomMessage,
                        editContent as any,
                        "",
                    );
                } else {
                    const content: OutgoingMessageContent = {
                        ...newContent,
                    };
                    if (mentions) {
                        content["m.mentions"] = mentions;
                    }
                    attachReplyRelation(content, replyToEvent?.getId() ?? null);

                    await client.sendEvent(
                        room.roomId,
                        EventType.RoomMessage,
                        content as any,
                        "",
                    );
                }
            }

            if (wasEditingMessage) {
                onCancelEdit();
                pushToast({
                    type: "success",
                    message: "Message edited.",
                });
            }
            if (hadReply) {
                onCancelReply();
            }

            if (hasQueuedUploads) {
                for (const queuedUpload of queuedUploadsForRoom) {
                    if (processingUploadsRef.current.has(queuedUpload.id)) {
                        continue;
                    }

                    processingUploadsRef.current.add(queuedUpload.id);
                    await processUpload(queuedUpload.id);
                }
            }
        } catch (sendError) {
            let message = sendError instanceof Error ? sendError.message : "Unknown error";
            let fallbackMessage = wasEditingMessage ? "Failed to edit message" : "Failed to send message";

            if (sendError instanceof Error && sendError.message.includes("Event blocked by other events not yet sent")) {
                const blockedEvents = room.getPendingEvents().filter((pendingEvent) => pendingEvent.status === "not_sent");
                for (const blockedEvent of blockedEvents) {
                    try {
                        client.cancelPendingEvent(blockedEvent);
                    } catch {
                        // best-effort recovery of a blocked pending queue
                    }
                }
                fallbackMessage = "Previous unsent message blocked this room. It was cleared.";
                message = "Previous unsent message was cleared. Send again.";
            }

            pushToast({
                type: "error",
                message: fallbackMessage,
            });
            setError(message);
            setText((current) => (current.trim().length === 0 ? rawText : current));
        } finally {
            setSendingText(false);
        }
    };

    const updateUpload = useCallback(
        (uploadId: string, updater: (upload: ComposerUploadItem) => ComposerUploadItem): void => {
            setUploads((currentUploads) =>
                currentUploads.map((upload) => (upload.id === uploadId ? updater(upload) : upload)),
            );
        },
        [],
    );

    const removeUpload = useCallback((uploadId: string): void => {
        setUploads((currentUploads) => currentUploads.filter((upload) => upload.id !== uploadId));
        processingUploadsRef.current.delete(uploadId);
    }, []);

    const enqueueFiles = useCallback(
        (incoming: File[] | FileList | null): void => {
            if (!room || !incoming) {
                return;
            }

            const files = Array.from(incoming);
            if (files.length === 0) {
                return;
            }

            const replyToEventId = replyToEvent?.getId() ?? null;
            const now = Date.now();
            const queuedUploads: ComposerUploadItem[] = files.map((file, index) => ({
                id: `upload_${now}_${index}_${Math.random().toString(36).slice(2, 8)}`,
                file,
                roomId: room.roomId,
                replyToEventId,
                status: "queued",
                loaded: 0,
                total: file.size,
                error: null,
            }));

            setUploads((currentUploads) => [...currentUploads, ...queuedUploads]);
            setError(null);
            setEmojiPickerOpen(false);

            if (replyToEvent) {
                onCancelReply();
            }

            if (editingEvent) {
                onCancelEdit();
            }
        },
        [editingEvent, onCancelEdit, onCancelReply, replyToEvent, room],
    );

    const processUpload = useCallback(
        async (uploadId: string): Promise<void> => {
            const upload = uploadsRef.current.find((entry) => entry.id === uploadId);
            if (!upload || upload.status !== "queued" || !room || upload.roomId !== room.roomId) {
                return;
            }

            const abortController = new AbortController();
            updateUpload(uploadId, (entry) =>
                entry.status === "queued"
                    ? {
                          ...entry,
                          status: "encrypting",
                          error: null,
                          loaded: 0,
                          total: entry.file.size,
                          abortController,
                      }
                    : entry,
            );

            try {
                const uploadedAttachment = await uploadAttachmentLikeElement(client, room.roomId, upload.file, {
                    abortController,
                    onStageChange: (stage) => {
                        updateUpload(uploadId, (entry) =>
                            entry.status === "cancelled"
                                ? entry
                                : {
                                      ...entry,
                                      status: stage,
                                  },
                        );
                    },
                    onProgress: ({ loaded, total }) => {
                        updateUpload(uploadId, (entry) =>
                            entry.status === "cancelled"
                                ? entry
                                : {
                                      ...entry,
                                      status: "uploading",
                                      loaded,
                                      total: total || entry.total,
                                  },
                        );
                    },
                });

                if (abortController.signal.aborted) {
                    throw new UploadCanceledError();
                }

                updateUpload(uploadId, (entry) => ({
                    ...entry,
                    status: "sending",
                    loaded: entry.total,
                    total: entry.total || entry.file.size,
                }));

                const { msgtype, info } = await buildAttachmentInfo(upload.file);
                if (abortController.signal.aborted) {
                    throw new UploadCanceledError();
                }

                const content: OutgoingMessageContent = {
                    msgtype,
                    body: upload.file.name || getAttachmentLabel(msgtype),
                    info,
                    url: uploadedAttachment.url,
                    file: uploadedAttachment.file,
                };
                attachReplyRelation(content, upload.replyToEventId);

                await client.sendEvent(
                    room.roomId,
                    EventType.RoomMessage,
                    content as any,
                    "",
                );

                removeUpload(uploadId);
            } catch (uploadError) {
                if (isAbortError(uploadError) || abortController.signal.aborted) {
                    updateUpload(uploadId, (entry) => ({
                        ...entry,
                        status: "cancelled",
                        abortController: undefined,
                        error: null,
                    }));
                    return;
                }

                const attachmentLabel = getAttachmentLabel(resolveAttachmentMsgType(upload.file));
                const message = uploadError instanceof Error ? uploadError.message : `Failed to send ${attachmentLabel}`;
                updateUpload(uploadId, (entry) => ({
                    ...entry,
                    status: "failed",
                    abortController: undefined,
                    error: message,
                }));
            } finally {
                processingUploadsRef.current.delete(uploadId);
            }
        },
        [client, removeUpload, room, updateUpload],
    );

    const cancelUpload = useCallback((uploadId: string): void => {
        const current = uploadsRef.current.find((upload) => upload.id === uploadId);
        if (!current) {
            return;
        }

        current.abortController?.abort();
        updateUpload(uploadId, (upload) => ({
            ...upload,
            status: "cancelled",
            error: null,
            abortController: undefined,
        }));
    }, [updateUpload]);

    const retryUpload = useCallback((uploadId: string): void => {
        updateUpload(uploadId, (upload) => ({
            ...upload,
            status: "queued",
            loaded: 0,
            total: upload.file.size,
            error: null,
            abortController: undefined,
        }));
    }, [updateUpload]);

    const handleFileSelection = (files: FileList | null): void => {
        enqueueFiles(files);

        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    const handleTextareaPaste = useCallback(
        (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
            if (!hasTransferFiles(event.clipboardData)) {
                return;
            }

            event.preventDefault();
            enqueueFiles(event.clipboardData.files);
        },
        [enqueueFiles],
    );

    const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
        if (!hasTransferFiles(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
    }, []);

    const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
        if (!hasTransferFiles(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    }, []);

    const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
        if (!hasTransferFiles(event.dataTransfer)) {
            return;
        }

        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setDragActive(false);
        }
    }, []);

    const handleDrop = useCallback(
        (event: React.DragEvent<HTMLDivElement>): void => {
            if (!hasTransferFiles(event.dataTransfer)) {
                return;
            }

            event.preventDefault();
            dragDepthRef.current = 0;
            setDragActive(false);
            enqueueFiles(event.dataTransfer.files);
        },
        [enqueueFiles],
    );

    const handleTextKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (mentionQuery && mentionCandidates.length > 0) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionSelectionIndex((current) => (current + 1) % mentionCandidates.length);
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionSelectionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length);
                return;
            }

            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const selectedMention = mentionCandidates[Math.min(mentionSelectionIndex, mentionCandidates.length - 1)];
                if (selectedMention) {
                    applyMentionCandidate(selectedMention);
                }
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setMentionQuery(null);
                setMentionSelectionIndex(0);
                return;
            }
        }

        if (emojiQuery && emojiCandidates.length > 0) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setEmojiSelectionIndex((current) => (current + 1) % emojiCandidates.length);
                return;
            }

            if (event.key === "ArrowUp") {
                event.preventDefault();
                setEmojiSelectionIndex((current) => (current - 1 + emojiCandidates.length) % emojiCandidates.length);
                return;
            }

            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const selectedEmoji = emojiCandidates[Math.min(emojiSelectionIndex, emojiCandidates.length - 1)];
                if (selectedEmoji) {
                    applyEmojiCandidate(selectedEmoji);
                }
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setEmojiQuery(null);
                setEmojiSelectionIndex(0);
                return;
            }
        }

        if (event.key === "Escape" && editingEventId) {
            event.preventDefault();
            setText("");
            setError(null);
            setEmojiPickerOpen(false);
            setMentionQuery(null);
            setEmojiQuery(null);
            setMentionSelectionIndex(0);
            setEmojiSelectionIndex(0);
            onCancelEdit();
            return;
        }

        if (event.key !== "Enter" || event.shiftKey) {
            return;
        }

        event.preventDefault();
        void sendMessage();
    };

    const handleTextBlur = useCallback((event: React.FocusEvent<HTMLTextAreaElement>): void => {
        const nextFocusedElement = event.relatedTarget as HTMLElement | null;
        stopLocalTyping(room?.roomId ?? undefined);
        setMentionQuery(null);
        setEmojiQuery(null);
        setMentionSelectionIndex(0);
        setEmojiSelectionIndex(0);

        if (nextFocusedElement && nextFocusedElement !== document.body) {
            return;
        }

        requestAnimationFrame(() => {
            const textarea = textareaRef.current;
            if (!textarea || textarea.disabled) {
                return;
            }

            const activeElement = document.activeElement as HTMLElement | null;
            if (activeElement && activeElement !== document.body && activeElement !== textarea) {
                return;
            }

            textarea.focus();
            const caret = textarea.value.length;
            textarea.setSelectionRange(caret, caret);
        });
    }, [room?.roomId, stopLocalTyping]);

    return (
        <div className="composer-wrap">
            {replyToEvent ? (
                <div className="composer-reply-preview">
                    <div className="composer-reply-content">
                        <span className="composer-reply-corner" aria-hidden="true" />
                        <span className="composer-reply-author">@{replySenderName}</span>
                        <span className="composer-reply-snippet">{replySnippet}</span>
                    </div>
                    <button
                        type="button"
                        className="composer-reply-cancel"
                        onClick={onCancelReply}
                        aria-label="Cancel reply"
                        title="Cancel reply"
                    >
                        x
                    </button>
                </div>
            ) : null}
            {editingEvent ? (
                <div className="composer-editing-preview">
                    <div className="composer-editing-content">
                        <span className="composer-editing-label">Editing message</span>
                        <span className="composer-editing-note">Press Enter to save, Esc to cancel</span>
                    </div>
                    <button
                        type="button"
                        className="composer-editing-cancel"
                        onClick={onCancelEdit}
                        aria-label="Cancel editing"
                        title="Cancel editing"
                    >
                        x
                    </button>
                </div>
            ) : null}
            <TypingIndicator client={client} room={room} typingUserIds={typingUserIds} />
            <ComposerBar
                disabled={!room}
                dragActive={dragActive}
                value={text}
                placeholder={placeholder}
                textareaRef={textareaRef}
                emojiButtonRef={emojiButtonRef}
                onChange={(value, caret) => {
                    setText(value);
                    if (error) {
                        setError(null);
                    }
                    handleTypingActivity(value);
                    syncMentionQuery(value, caret);
                    syncEmojiQuery(value, caret);
                }}
                onCursorActivity={syncComposerQueriesFromCursor}
                onBlur={handleTextBlur}
                onKeyDown={handleTextKeyDown}
                onPaste={handleTextareaPaste}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onAttach={() => fileInputRef.current?.click()}
                onToggleEmoji={() => setEmojiPickerOpen((open) => !open)}
                emojiPicker={
                    emojiPickerOpen && room ? (
                        <div ref={emojiPickerRef} className="composer-emoji-picker-popover">
                            <EmojiPicker
                                client={client}
                                room={room}
                                activeSpaceId={activeSpaceId}
                                onClose={() => setEmojiPickerOpen(false)}
                                onSelect={(token) => {
                                    insertTokenAtCursor(token);
                                    setEmojiPickerOpen(false);
                                }}
                            />
                        </div>
                    ) : null
                }
            />
            {composerPreview.hasCustomEmoji ? (
                <div className="composer-live-preview" role="status" aria-live="polite">
                    <span className="composer-live-preview-label">Preview</span>
                    <div className="composer-live-preview-body">{composerPreview.nodes}</div>
                </div>
            ) : null}
            {mentionQuery && mentionCandidates.length > 0 ? (
                <div className="composer-mentions-popover" role="listbox" aria-label="Mention suggestions">
                    {mentionCandidates.map((candidate, index) => (
                        <button
                            type="button"
                            key={candidate.userId}
                            className={`composer-mention-item${index === mentionSelectionIndex ? " is-active" : ""}`}
                            role="option"
                            aria-selected={index === mentionSelectionIndex}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                applyMentionCandidate(candidate);
                            }}
                        >
                            <span className="composer-mention-name">{candidate.displayName}</span>
                            <span className="composer-mention-id">{candidate.userId}</span>
                        </button>
                    ))}
                </div>
            ) : null}
            {!mentionQuery && emojiQuery && emojiCandidates.length > 0 ? (
                <div className="composer-emojis-popover" role="listbox" aria-label="Custom emoji suggestions">
                    {emojiCandidates.map((candidate, index) => (
                        <button
                            type="button"
                            key={candidate.shortcode}
                            className={`composer-emoji-shortcode-item${index === emojiSelectionIndex ? " is-active" : ""}`}
                            role="option"
                            aria-selected={index === emojiSelectionIndex}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                applyEmojiCandidate(candidate);
                            }}
                        >
                            <span className="composer-emoji-shortcode-visual">
                                {candidate.src ? (
                                    <img src={candidate.src} alt={candidate.shortcode} loading="lazy" decoding="async" />
                                ) : (
                                    candidate.shortcode
                                )}
                            </span>
                            <span className="composer-emoji-shortcode-meta">
                                <span className="composer-emoji-shortcode-code">{candidate.shortcode}</span>
                                <span className="composer-emoji-shortcode-name">{candidate.name}</span>
                            </span>
                        </button>
                    ))}
                </div>
            ) : null}
            <input
                ref={fileInputRef}
                className="composer-file-input"
                type="file"
                multiple
                onChange={(event) => {
                    handleFileSelection(event.target.files);
                }}
                disabled={!room}
            />
            {uploads.length > 0 ? (
                <div className="composer-upload-list" role="status" aria-live="polite">
                    {uploads.map((upload) => {
                        const canCancel =
                            upload.status === "queued" || upload.status === "encrypting" || upload.status === "uploading";
                        const canRetry = upload.status === "failed" || upload.status === "cancelled";
                        const progressPercent = upload.total > 0 ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;

                        return (
                            <div key={upload.id} className={`composer-upload-item is-${upload.status}`}>
                                <div className="composer-upload-row">
                                    <div className="composer-upload-main">
                                        <span className="composer-upload-name" title={upload.file.name}>
                                            {upload.file.name}
                                        </span>
                                        <span className="composer-upload-meta">
                                            {getUploadLabel(upload)} . {formatBytes(upload.total || upload.file.size)}
                                        </span>
                                    </div>
                                    <div className="composer-upload-actions">
                                        {canRetry ? (
                                            <button
                                                type="button"
                                                className="composer-upload-action"
                                                onClick={() => retryUpload(upload.id)}
                                            >
                                                Retry
                                            </button>
                                        ) : null}
                                        {canCancel ? (
                                            <button
                                                type="button"
                                                className="composer-upload-action"
                                                onClick={() => cancelUpload(upload.id)}
                                            >
                                                Cancel
                                            </button>
                                        ) : null}
                                        {upload.status === "failed" || upload.status === "cancelled" ? (
                                            <button
                                                type="button"
                                                className="composer-upload-action"
                                                onClick={() => removeUpload(upload.id)}
                                            >
                                                Remove
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                                {upload.status === "uploading" || upload.status === "sending" ? (
                                    <div className="composer-upload-progress">
                                        <span style={{ width: `${progressPercent}%` }} />
                                    </div>
                                ) : null}
                                {upload.error ? <p className="composer-upload-item-error">{upload.error}</p> : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {error ? <p className="composer-error">{error}</p> : null}
            <Toast toast={toast} onClose={() => setToast(null)} />
        </div>
    );
}
