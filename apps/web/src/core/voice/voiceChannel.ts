import type { Room } from "matrix-js-sdk/src/matrix";

export const HEOROT_VOICE_CHANNEL_EVENT = "org.heorot.voice_channel";
export const MATRIX_CALL_COMPAT_EVENT = "org.matrix.msc3401.call";
export const HEOROT_SPACE_CHILD_CHANNEL_TYPE_KEY = "org.heorot.channel_type";
export const HEOROT_SPACE_CHILD_VOICE_KEY = "org.heorot.voice_channel";

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVoiceLabel(value: unknown): boolean {
    return typeof value === "string" && value.trim().toLowerCase() === "voice";
}

export function isVoiceChannelHintContent(content: unknown): boolean {
    if (!isObject(content)) {
        return false;
    }

    if (content[HEOROT_SPACE_CHILD_VOICE_KEY] === true) {
        return true;
    }

    if (isVoiceLabel(content[HEOROT_SPACE_CHILD_CHANNEL_TYPE_KEY])) {
        return true;
    }

    // Legacy/fallback generic key support.
    return isVoiceLabel(content.channel_type);
}

export function isVoiceChannelRoom(room: Room | null): boolean {
    if (!room) {
        return false;
    }

    const heorotEvent = room.currentState.getStateEvents(HEOROT_VOICE_CHANNEL_EVENT, "");
    const heorotContent = heorotEvent?.getContent();
    if (isObject(heorotContent) && heorotContent.enabled === true) {
        return true;
    }

    // MSC3401-style compatibility fallback.
    const callEvent = room.currentState.getStateEvents(MATRIX_CALL_COMPAT_EVENT, "");
    const callContent = callEvent?.getContent();
    if (!isObject(callContent)) {
        return false;
    }

    const intent = typeof callContent.intent === "string" ? callContent.intent.toLowerCase() : "";
    const callType = typeof callContent.type === "string" ? callContent.type.toLowerCase() : "";
    return intent === "voice" || callType === "voice";
}
