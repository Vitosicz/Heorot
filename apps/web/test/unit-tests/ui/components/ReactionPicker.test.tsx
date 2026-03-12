import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ClientEvent, RoomEvent, type MatrixEvent } from "matrix-js-sdk/src/matrix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReactionPicker } from "../../../../src/ui/components/ReactionPicker";
import { PERSONAL_EMOJI_PACK_EVENT_TYPE, SPACE_EMOJI_PACK_EVENT_TYPE } from "../../../../src/ui/emoji/EmojiPackTypes";
import { loadAvailableEmojis } from "../../../../src/ui/emoji/EmojiResolver";
import { resetPersonalEmojiPackCache, resetSpaceEmojiPackCache } from "../../../../src/ui/emoji/EmojiPackStore";

vi.mock("../../../../src/ui/emoji/EmojiResolver", () => ({
    loadAvailableEmojis: vi.fn(),
    resolveEmojiShortcode: vi.fn(async () => null),
}));

vi.mock("../../../../src/ui/emoji/EmojiPackStore", () => ({
    resetPersonalEmojiPackCache: vi.fn(),
    resetSpaceEmojiPackCache: vi.fn(),
}));

vi.mock("../../../../src/ui/emoji/emojiEvents", () => ({
    subscribeEmojiPackUpdated: vi.fn(() => () => {}),
}));

vi.mock("../../../../src/ui/utils/mxc", () => ({
    mxcThumbnailToHttp: vi.fn((_client, mxc: string | null | undefined) => (mxc ? `https://cdn.test/${mxc.slice(6)}` : null)),
}));

type Listener = (event: MatrixEvent) => void;

type MockClient = {
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    emit: (eventName: string, event: MatrixEvent) => void;
};

function createMockClient(): MockClient {
    const listeners = new Map<string, Set<Listener>>();

    const on = vi.fn((eventName: string, handler: Listener) => {
        if (!listeners.has(eventName)) {
            listeners.set(eventName, new Set());
        }
        listeners.get(eventName)!.add(handler);
    });

    const removeListener = vi.fn((eventName: string, handler: Listener) => {
        listeners.get(eventName)?.delete(handler);
    });

    const emit = (eventName: string, event: MatrixEvent): void => {
        for (const handler of listeners.get(eventName) ?? []) {
            handler(event);
        }
    };

    return { on, removeListener, emit };
}

async function flushAsyncUpdates(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe("ReactionPicker", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        vi.mocked(loadAvailableEmojis).mockReset();
        vi.mocked(resetSpaceEmojiPackCache).mockClear();
        vi.mocked(resetPersonalEmojiPackCache).mockClear();
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it("reloads custom emojis on space emoji timeline event", async () => {
        const client = createMockClient();
        const room = { roomId: "!room:test" } as any;
        const activeSpaceId = "!space:test";
        let current = [{ shortcode: ":fox:", name: "fox", url: "mxc://test/fox" }];

        vi.mocked(loadAvailableEmojis).mockImplementation(async () => current as any);

        await act(async () => {
            root.render(
                <ReactionPicker
                    client={client as any}
                    room={room}
                    activeSpaceId={activeSpaceId}
                    onSelect={() => {}}
                    onFinished={() => {}}
                />,
            );
        });
        await flushAsyncUpdates();

        expect(container.querySelector('button[title=":fox:"]')).not.toBeNull();

        current = [{ shortcode: ":wolf:", name: "wolf", url: "mxc://test/wolf" }];
        client.emit(RoomEvent.Timeline, {
            getType: () => SPACE_EMOJI_PACK_EVENT_TYPE,
            getRoomId: () => activeSpaceId,
        } as unknown as MatrixEvent);

        await flushAsyncUpdates();

        expect(vi.mocked(resetSpaceEmojiPackCache)).toHaveBeenCalledWith(activeSpaceId);
        expect(container.querySelector('button[title=":wolf:"]')).not.toBeNull();
        expect(container.querySelector('button[title=":fox:"]')).toBeNull();
    });

    it("reloads custom emojis on personal emoji account-data event", async () => {
        const client = createMockClient();
        const room = { roomId: "!room:test" } as any;
        let current = [{ shortcode: ":cat:", name: "cat", url: "mxc://test/cat" }];

        vi.mocked(loadAvailableEmojis).mockImplementation(async () => current as any);

        await act(async () => {
            root.render(
                <ReactionPicker
                    client={client as any}
                    room={room}
                    activeSpaceId={null}
                    onSelect={() => {}}
                    onFinished={() => {}}
                />,
            );
        });
        await flushAsyncUpdates();

        expect(container.querySelector('button[title=":cat:"]')).not.toBeNull();

        current = [{ shortcode: ":dog:", name: "dog", url: "mxc://test/dog" }];
        client.emit(ClientEvent.AccountData, {
            getType: () => PERSONAL_EMOJI_PACK_EVENT_TYPE,
        } as unknown as MatrixEvent);

        await flushAsyncUpdates();

        expect(vi.mocked(resetPersonalEmojiPackCache)).toHaveBeenCalledTimes(1);
        expect(container.querySelector('button[title=":dog:"]')).not.toBeNull();
        expect(container.querySelector('button[title=":cat:"]')).toBeNull();
    });
});
