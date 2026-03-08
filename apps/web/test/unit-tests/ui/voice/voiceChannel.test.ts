import { describe, expect, it } from "vitest";

import {
    HEOROT_VOICE_CHANNEL_EVENT,
    MATRIX_CALL_COMPAT_EVENT,
    isVoiceChannelRoom,
} from "../../../../src/ui/voice/voiceChannel";

interface MockStateEvent {
    getContent: () => unknown;
}

function makeStateEvent(content: unknown): MockStateEvent {
    return {
        getContent: () => content,
    };
}

function makeRoom(options: { heorotContent?: unknown; callContent?: unknown } = {}): {
    currentState: {
        getStateEvents: (eventType: string, stateKey: string) => MockStateEvent | null;
    };
} {
    return {
        currentState: {
            getStateEvents: (eventType: string): MockStateEvent | null => {
                if (eventType === HEOROT_VOICE_CHANNEL_EVENT) {
                    return options.heorotContent === undefined ? null : makeStateEvent(options.heorotContent);
                }

                if (eventType === MATRIX_CALL_COMPAT_EVENT) {
                    return options.callContent === undefined ? null : makeStateEvent(options.callContent);
                }

                return null;
            },
        },
    };
}

describe("isVoiceChannelRoom", () => {
    it("returns false for null room", () => {
        expect(isVoiceChannelRoom(null)).toBe(false);
    });

    it("returns true for Heorot voice state event", () => {
        const room = makeRoom({
            heorotContent: { enabled: true },
        });

        expect(isVoiceChannelRoom(room as any)).toBe(true);
    });

    it("falls back to matrix call event by intent", () => {
        const room = makeRoom({
            heorotContent: { enabled: false },
            callContent: { intent: "VOICE" },
        });

        expect(isVoiceChannelRoom(room as any)).toBe(true);
    });

    it("falls back to matrix call event by type", () => {
        const room = makeRoom({
            callContent: { type: "voice" },
        });

        expect(isVoiceChannelRoom(room as any)).toBe(true);
    });

    it("returns false when events are missing or invalid", () => {
        const room = makeRoom({
            heorotContent: "not-an-object",
            callContent: { intent: "video", type: "video" },
        });

        expect(isVoiceChannelRoom(room as any)).toBe(false);
    });
});
