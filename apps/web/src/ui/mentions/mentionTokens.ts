export interface MentionTextSegment {
    type: "text";
    value: string;
}

export interface MentionUserSegment {
    type: "mention";
    userId: string;
}

export type MentionSegment = MentionTextSegment | MentionUserSegment;

const MATRIX_MENTION_PATTERN = /@[A-Za-z0-9._=+/-]+:[^\s<>()\[\]{}"']+/g;
const TRAILING_MENTION_PUNCTUATION = ".,!?;:)]}";

function splitTrailingMentionDecoration(candidate: string): { mention: string; suffix: string } {
    let cutIndex = candidate.length;

    while (cutIndex > 0 && TRAILING_MENTION_PUNCTUATION.includes(candidate.charAt(cutIndex - 1))) {
        cutIndex -= 1;
    }

    return {
        mention: candidate.slice(0, cutIndex),
        suffix: candidate.slice(cutIndex),
    };
}

export function mxidLocalpart(userId: string): string {
    const normalized = userId.startsWith("@") ? userId.slice(1) : userId;
    const colonIndex = normalized.indexOf(":");
    return (colonIndex >= 0 ? normalized.slice(0, colonIndex) : normalized) || userId;
}

export function tokenizeMatrixMentions(text: string): MentionSegment[] {
    const segments: MentionSegment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    MATRIX_MENTION_PATTERN.lastIndex = 0;
    while ((match = MATRIX_MENTION_PATTERN.exec(text)) !== null) {
        const rawMatch = match[0];
        const { mention, suffix } = splitTrailingMentionDecoration(rawMatch);
        if (!mention) {
            continue;
        }

        if (match.index > cursor) {
            segments.push({
                type: "text",
                value: text.slice(cursor, match.index),
            });
        }

        segments.push({
            type: "mention",
            userId: mention,
        });

        if (suffix) {
            segments.push({
                type: "text",
                value: suffix,
            });
        }

        cursor = match.index + rawMatch.length;
    }

    if (cursor < text.length) {
        segments.push({
            type: "text",
            value: text.slice(cursor),
        });
    }

    if (segments.length === 0) {
        segments.push({
            type: "text",
            value: text,
        });
    }

    return segments;
}
