import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    fetchLiveKitToken,
    fetchVoiceParticipants,
    isVoiceFeatureEnabled,
} from "../../../../src/ui/adapters/voiceAdapter";

describe("voiceAdapter", () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("enables voice by default unless explicitly disabled", () => {
        expect(isVoiceFeatureEnabled({ voice_enabled: true } as any)).toBe(true);
        expect(isVoiceFeatureEnabled({ voice_enabled: false } as any)).toBe(false);
        expect(isVoiceFeatureEnabled(null)).toBe(true);
    });

    it("fetchLiveKitToken uses logged-in homeserver domain when discovery is not available", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                token: "jwt",
                wsUrl: "wss://lk.example",
                livekitRoom: "room-1",
                expiresAt: "2026-01-01T00:00:00.000Z",
            }),
        }));
        globalThis.fetch = fetchMock as any;

        const result = await fetchLiveKitToken(
            {
                getAccessToken: () => "abc123",
                getHomeserverUrl: () => "https://matrix.example.com/",
            } as any,
            null,
            "!room:example.org",
        );

        expect(result.token).toBe("jwt");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://matrix.example.com/voice/livekit/token");
        expect(init.method).toBe("POST");
        expect(init.headers).toEqual({
            Authorization: "Bearer abc123",
            "Content-Type": "application/json",
        });
        expect(init.body).toBe(JSON.stringify({ matrixRoomId: "!room:example.org" }));
    });

    it("fetchLiveKitToken falls back to config voice_service_url when homeserver URL is unavailable", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                token: "jwt",
                wsUrl: "wss://lk.example",
                livekitRoom: "room-1",
                expiresAt: "2026-01-01T00:00:00.000Z",
            }),
        }));
        globalThis.fetch = fetchMock as any;

        await fetchLiveKitToken(
            { getAccessToken: () => "abc123" } as any,
            { voice_service_url: "https://voice.example///" } as any,
            "!room:example.org",
        );

        const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://voice.example/voice/livekit/token");
    });

    it("fetchLiveKitToken fails when discovery/home URL/config are all unavailable", async () => {
        await expect(fetchLiveKitToken({ getAccessToken: () => "abc" } as any, null, "!room:example.org")).rejects.toThrow(
            "Voice service unavailable: discovery failed and homeserver URL is unavailable.",
        );
    });

    it("fetchLiveKitToken fails when Matrix access token is missing", async () => {
        await expect(
            fetchLiveKitToken(
                {
                    getAccessToken: () => "",
                    getHomeserverUrl: () => "https://matrix.example.com",
                } as any,
                null,
                "!room:example.org",
            ),
        ).rejects.toThrow("Missing Matrix access token in current session.");
    });

    it("fetchLiveKitToken returns backend error message for non-ok response", async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            status: 403,
            json: async () => ({ error: "forbidden" }),
        })) as any;

        await expect(
            fetchLiveKitToken(
                {
                    getAccessToken: () => "abc",
                    getHomeserverUrl: () => "https://matrix.example.com",
                } as any,
                null,
                "!room:example.org",
            ),
        ).rejects.toThrow("Unable to fetch LiveKit token: forbidden");
    });

    it("fetchLiveKitToken falls back to HTTP status when error body is unavailable", async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => {
                throw new Error("invalid-json");
            },
        })) as any;

        await expect(
            fetchLiveKitToken(
                {
                    getAccessToken: () => "abc",
                    getHomeserverUrl: () => "https://matrix.example.com",
                } as any,
                null,
                "!room:example.org",
            ),
        ).rejects.toThrow("Unable to fetch LiveKit token: HTTP 500");
    });

    it("fetchVoiceParticipants sends GET request with encoded matrixRoomId", async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            json: async () => ({
                matrixRoomId: "!room:example.org",
                participants: [{ identity: "@alice:example.org" }],
                count: 1,
            }),
        }));
        globalThis.fetch = fetchMock as any;

        const result = await fetchVoiceParticipants(
            {
                getAccessToken: () => "abc",
                getHomeserverUrl: () => "https://matrix.example.com",
            } as any,
            null,
            "!room/with space:example.org",
        );

        expect(result.count).toBe(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "https://matrix.example.com/voice/livekit/participants?matrixRoomId=!room%2Fwith%20space%3Aexample.org",
        );
        expect(init.method).toBe("GET");
        expect(init.headers).toEqual({
            Authorization: "Bearer abc",
        });
    });

    it("fetchVoiceParticipants reports backend errors", async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: false,
            status: 429,
            json: async () => ({ error: "rate_limited" }),
        })) as any;

        await expect(
            fetchVoiceParticipants(
                {
                    getAccessToken: () => "abc",
                    getHomeserverUrl: () => "https://matrix.example.com",
                } as any,
                null,
                "!room:example.org",
            ),
        ).rejects.toThrow("Unable to fetch voice participants: rate_limited");
    });
});