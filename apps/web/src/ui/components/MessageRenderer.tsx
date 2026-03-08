import React, { useMemo } from "react";
import { mxidLocalpart, tokenizeMatrixMentions } from "../mentions/mentionTokens";

interface MessageRendererProps {
    body: string;
    format?: string;
    formattedBody?: string;
    resolveImageSource?: (src: string, width: number, height: number) => string | null;
    resolveMentionDisplayName?: (userId: string) => string | null;
    ownUserId?: string | null;
}

const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_TEXT_ATTR_LENGTH = 256;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;

function normalizeAllowedImageSource(src: string): string | null {
    const candidate = src.trim();
    if (!candidate || candidate.length > MAX_IMAGE_URL_LENGTH) {
        return null;
    }

    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
        return null;
    }

    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return null;
        }

        if (!parsed.hostname || parsed.username || parsed.password) {
            return null;
        }

        return parsed.toString();
    } catch {
        return null;
    }
}

function sanitizeDimension(value: string | null, fallback: number): number {
    if (!value) {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.max(8, Math.min(parsed, 256));
}

function sanitizeText(value: string | null, fallback = ""): string {
    if (!value) {
        return fallback;
    }

    const sanitized = value.replace(CONTROL_CHAR_PATTERN, "").trim();
    if (!sanitized) {
        return fallback;
    }

    return sanitized.slice(0, MAX_TEXT_ATTR_LENGTH);
}

function sanitizeTextNode(value: string): string {
    return value.replace(CONTROL_CHAR_PATTERN, "");
}

function normalizeMentionDisplayName(value: string): string {
    const trimmed = sanitizeText(value, "");
    if (!trimmed) {
        return "";
    }

    return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function renderMentionPill(
    userId: string,
    key: string,
    resolveMentionDisplayName?: (userId: string) => string | null,
    ownUserId?: string | null,
): React.ReactNode {
    const fallbackName = mxidLocalpart(userId);
    const resolvedName = resolveMentionDisplayName?.(userId);
    const displayName = normalizeMentionDisplayName(resolvedName ?? fallbackName) || fallbackName;
    const isDirectMention = Boolean(ownUserId && userId === ownUserId);

    return (
        <span
            key={key}
            className={`message-renderer-mention${isDirectMention ? " is-direct" : ""}`}
            data-mention-user-id={userId}
        >
            @{displayName}
        </span>
    );
}

function renderTextNodeWithMentions(
    value: string,
    keyPrefix: string,
    resolveMentionDisplayName?: (userId: string) => string | null,
    ownUserId?: string | null,
): React.ReactNode[] {
    const sanitized = sanitizeTextNode(value);
    const segments = tokenizeMatrixMentions(sanitized);
    const rendered: React.ReactNode[] = [];

    segments.forEach((segment, index) => {
        const key = `${keyPrefix}_text_${index}`;
        if (segment.type === "text") {
            rendered.push(<React.Fragment key={key}>{segment.value}</React.Fragment>);
            return;
        }

        rendered.push(
            renderMentionPill(
                segment.userId,
                `${keyPrefix}_mention_${index}`,
                resolveMentionDisplayName,
                ownUserId,
            ),
        );
    });

    return rendered;
}

function hasMatrixEmoticonMarker(element: HTMLElement): boolean {
    const marker = element.getAttribute("data-mx-emoticon");
    if (marker === null) {
        return false;
    }

    const normalized = marker.trim().toLowerCase();
    return normalized === "" || normalized === "true" || normalized === "1";
}

function sanitizeNodes(
    nodes: NodeListOf<ChildNode>,
    keyPrefix: string,
    resolveImageSource?: (src: string, width: number, height: number) => string | null,
    resolveMentionDisplayName?: (userId: string) => string | null,
    ownUserId?: string | null,
): React.ReactNode[] {
    const rendered: React.ReactNode[] = [];

    nodes.forEach((node, index) => {
        const key = `${keyPrefix}_${index}`;
        if (node.nodeType === Node.TEXT_NODE) {
            rendered.push(
                ...renderTextNodeWithMentions(
                    node.textContent ?? "",
                    key,
                    resolveMentionDisplayName,
                    ownUserId,
                ),
            );
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
        }

        const element = node as HTMLElement;
        const tagName = element.tagName.toLowerCase();

        if (tagName === "br") {
            rendered.push(<br key={key} />);
            return;
        }

        if (tagName === "img") {
            if (!hasMatrixEmoticonMarker(element)) {
                return;
            }

            const src = element.getAttribute("src");
            if (!src) {
                return;
            }

            const width = sanitizeDimension(element.getAttribute("width"), 24);
            const height = sanitizeDimension(element.getAttribute("height"), 24);
            const resolvedSrc = resolveImageSource?.(src, width, height);
            const normalizedSrc = normalizeAllowedImageSource(resolvedSrc ?? src);
            if (!normalizedSrc) {
                return;
            }

            const alt = sanitizeText(element.getAttribute("alt"), "");
            const title = sanitizeText(element.getAttribute("title"), alt);

            rendered.push(
                <img
                    key={key}
                    src={normalizedSrc}
                    alt={alt}
                    title={title}
                    width={width}
                    height={height}
                    loading="lazy"
                    decoding="async"
                    className="message-renderer-emoticon"
                    data-mx-emoticon="true"
                />,
            );
            return;
        }

        rendered.push(
            ...sanitizeNodes(
                element.childNodes as NodeListOf<ChildNode>,
                `${key}_child`,
                resolveImageSource,
                resolveMentionDisplayName,
                ownUserId,
            ),
        );
    });

    return rendered;
}

function renderSanitizedFormattedBody(
    formattedBody: string,
    resolveImageSource?: (src: string, width: number, height: number) => string | null,
    resolveMentionDisplayName?: (userId: string) => string | null,
    ownUserId?: string | null,
): React.ReactNode[] | null {
    if (typeof DOMParser === "undefined") {
        return null;
    }

    try {
        const parser = new DOMParser();
        const document = parser.parseFromString(formattedBody, "text/html");
        return sanitizeNodes(
            document.body.childNodes,
            "message_html",
            resolveImageSource,
            resolveMentionDisplayName,
            ownUserId,
        );
    } catch {
        return null;
    }
}

export function MessageRenderer({
    body,
    format,
    formattedBody,
    resolveImageSource,
    resolveMentionDisplayName,
    ownUserId,
}: MessageRendererProps): React.ReactElement {
    const sanitizedNodes = useMemo(() => {
        if (format !== "org.matrix.custom.html" || typeof formattedBody !== "string") {
            return null;
        }

        const nodes = renderSanitizedFormattedBody(
            formattedBody,
            resolveImageSource,
            resolveMentionDisplayName,
            ownUserId,
        );
        if (!nodes || nodes.length === 0) {
            return null;
        }

        return nodes;
    }, [format, formattedBody, ownUserId, resolveImageSource, resolveMentionDisplayName]);

    if (sanitizedNodes) {
        return <>{sanitizedNodes}</>;
    }

    return <>{renderTextNodeWithMentions(body, "message_plain", resolveMentionDisplayName, ownUserId)}</>;
}
