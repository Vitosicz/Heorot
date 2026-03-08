import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import type { ResolvedEmoji } from "./EmojiPackTypes";
import { mxcThumbnailToHttp, mxcToHttp } from "../utils/mxc";

const TOKEN_PATTERN = /:[a-zA-Z0-9_+-]{2,}:/g;
const URL_PATTERN = /(?:https?:\/\/|ftp:\/\/|mailto:|matrix:|www\.)[^\s<>()]+/gi;
const TRAILING_URL_PUNCTUATION = ".,!?;:";

export interface EmojiFormattingContext {
    roomId: string;
    activeSpaceId?: string | null;
}

export type EmojiShortcodeResolver = (
    client: MatrixClient,
    room: Room,
    shortcodeInput: string,
    activeSpaceId: string | null,
) => Promise<ResolvedEmoji | null>;

export type FormattedTextMessageContent =
    | {
          body: string;
      }
    | {
          body: string;
          format: "org.matrix.custom.html";
          formatted_body: string;
      };

interface Span {
    start: number;
    end: number;
}

interface TokenOccurrence {
    token: string;
    start: number;
    end: number;
}

interface ResolvedToken {
    shortcode: string;
    src: string;
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

function collectUrlSpans(text: string): Span[] {
    const spans: Span[] = [];

    URL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_PATTERN.exec(text)) !== null) {
        const rawMatch = match[0];
        const { url } = splitTrailingUrlDecoration(rawMatch);
        if (!url) {
            continue;
        }

        spans.push({
            start: match.index,
            end: match.index + url.length,
        });
    }

    return spans;
}

function collectEligibleTokenOccurrences(text: string, urlSpans: Span[]): TokenOccurrence[] {
    const occurrences: TokenOccurrence[] = [];
    let spanIndex = 0;

    TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;

        while (spanIndex < urlSpans.length && urlSpans[spanIndex].end <= start) {
            spanIndex += 1;
        }

        const currentSpan = urlSpans[spanIndex];
        const insideUrl = Boolean(currentSpan && start >= currentSpan.start && end <= currentSpan.end);
        if (insideUrl) {
            continue;
        }

        occurrences.push({
            token,
            start,
            end,
        });
    }

    return occurrences;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeTextSegmentToHtml(text: string): string {
    return escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");
}

function toEmojiImageTag(src: string, shortcode: string): string {
    const escapedShortcode = escapeHtml(shortcode);
    const escapedSrc = escapeHtml(src);
    return `<img data-mx-emoticon="true" alt="${escapedShortcode}" title="${escapedShortcode}" height="24" width="24" src="${escapedSrc}" />`;
}

async function resolveTokens(
    client: MatrixClient,
    room: Room,
    activeSpaceId: string | null,
    resolver: EmojiShortcodeResolver,
    tokens: string[],
): Promise<Map<string, ResolvedToken>> {
    const resolvedMap = new Map<string, ResolvedToken>();

    const resolutions = await Promise.all(
        tokens.map(async (token) => {
            const resolved = await resolver(client, room, token, activeSpaceId);
            if (!resolved) {
                return null;
            }

            const src = mxcThumbnailToHttp(client, resolved.url, 24, 24) ?? mxcToHttp(client, resolved.url);
            if (!src) {
                return null;
            }

            return {
                token,
                shortcode: resolved.shortcode,
                src,
            };
        }),
    );

    for (const resolution of resolutions) {
        if (!resolution) {
            continue;
        }

        resolvedMap.set(resolution.token, {
            shortcode: resolution.shortcode,
            src: resolution.src,
        });
    }

    return resolvedMap;
}

export async function formatMessageWithEmojis(
    rawText: string,
    context: EmojiFormattingContext,
    resolver: EmojiShortcodeResolver,
    client: MatrixClient,
): Promise<FormattedTextMessageContent> {
    const room = client.getRoom(context.roomId);
    if (!room) {
        return { body: rawText };
    }

    const urlSpans = collectUrlSpans(rawText);
    const occurrences = collectEligibleTokenOccurrences(rawText, urlSpans);
    if (occurrences.length === 0) {
        return { body: rawText };
    }

    const uniqueTokens = [...new Set(occurrences.map((occurrence) => occurrence.token))];
    const resolvedMap = await resolveTokens(client, room, context.activeSpaceId ?? null, resolver, uniqueTokens);
    if (resolvedMap.size === 0) {
        return { body: rawText };
    }

    let cursor = 0;
    let hasReplacement = false;
    let formattedBody = "";

    for (const occurrence of occurrences) {
        if (occurrence.start > cursor) {
            formattedBody += escapeTextSegmentToHtml(rawText.slice(cursor, occurrence.start));
        }

        const resolved = resolvedMap.get(occurrence.token);
        if (resolved) {
            hasReplacement = true;
            formattedBody += toEmojiImageTag(resolved.src, resolved.shortcode);
        } else {
            formattedBody += escapeTextSegmentToHtml(rawText.slice(occurrence.start, occurrence.end));
        }

        cursor = occurrence.end;
    }

    if (cursor < rawText.length) {
        formattedBody += escapeTextSegmentToHtml(rawText.slice(cursor));
    }

    if (!hasReplacement) {
        return { body: rawText };
    }

    return {
        body: rawText,
        format: "org.matrix.custom.html",
        formatted_body: formattedBody,
    };
}
