import { beforeEach, describe, expect, it, vi } from "vitest";

import { PERSONAL_EMOJI_PACK_EVENT_TYPE, REACTION_IMAGE_SETTING_KEY } from "../../../../src/ui/emoji/EmojiPackTypes";

async function loadStore() {
    vi.resetModules();
    return import("../../../../src/ui/emoji/EmojiPackStore");
}

describe("EmojiPackStore", () => {
    beforeEach(() => {
        window.localStorage.removeItem(REACTION_IMAGE_SETTING_KEY);
    });

    it("normalizes emoji shortcodes", async () => {
        const store = await loadStore();

        expect(store.normalizeEmojiShortcode(" PARTY ")).toBe(":party:");
        expect(store.normalizeEmojiShortcode("::mix_ed::")).toBe(":mix_ed:");
        expect(store.normalizeEmojiShortcode("x y")).toBe(":xy:");
    });

    it("uses true as default for reaction image rendering", async () => {
        const store = await loadStore();
        expect(store.getFeatureRenderReactionImages()).toBe(true);
    });

    it("stores and reads reaction image rendering preference", async () => {
        const store = await loadStore();

        store.setFeatureRenderReactionImages(false);
        expect(window.localStorage.getItem(REACTION_IMAGE_SETTING_KEY)).toBe("false");
        expect(store.getFeatureRenderReactionImages()).toBe(false);

        store.setFeatureRenderReactionImages(true);
        expect(window.localStorage.getItem(REACTION_IMAGE_SETTING_KEY)).toBe("true");
        expect(store.getFeatureRenderReactionImages()).toBe(true);
    });

    it("normalizes personal pack payload from account data", async () => {
        const store = await loadStore();
        const client = {
            getAccountData: vi.fn(() => ({
                getContent: () => ({
                    ":fox:": "mxc://hs/fox",
                    " :MiXeD : ": { url: "mxc://hs/mixed", name: "" },
                    ":invalid:": "https://example.org/not-mxc",
                }),
            })),
        };

        const pack = await store.getPersonalPack(client as any);

        expect(pack).toEqual({
            version: 1,
            emojis: {
                ":fox:": {
                    url: "mxc://hs/fox",
                    name: "fox",
                    created_by: undefined,
                    created_ts: undefined,
                },
                ":mixed:": {
                    url: "mxc://hs/mixed",
                    name: "mixed",
                    created_by: undefined,
                    created_ts: undefined,
                },
            },
        });
    });

    it("upserts personal emoji with normalized shortcode and default name", async () => {
        const store = await loadStore();
        const setAccountData = vi.fn(async () => undefined);
        const client = {
            getAccountData: vi.fn(() => null),
            setAccountData,
        };

        const shortcode = await store.upsertPersonalEmoji(client as any, " PARTY ", {
            url: "mxc://hs/party",
        });

        expect(shortcode).toBe(":party:");
        expect(setAccountData).toHaveBeenCalledTimes(1);

        const [eventType, payload] = setAccountData.mock.calls[0] as [string, { version: number; emojis: Record<string, { url: string; name: string }> }];
        expect(eventType).toBe(PERSONAL_EMOJI_PACK_EVENT_TYPE);
        expect(payload.version).toBe(1);
        expect(payload.emojis[":party:"]).toEqual({
            url: "mxc://hs/party",
            name: "party",
            created_by: undefined,
            created_ts: undefined,
        });
    });
});
