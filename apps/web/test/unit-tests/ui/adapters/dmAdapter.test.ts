import { EventType } from "matrix-js-sdk/src/matrix";
import { describe, expect, it, vi } from "vitest";

import {
    ensureDirectRoomMapping,
    ensureDirectRoomMappings,
    getDirectRoomIds,
    isValidMatrixUserId,
} from "../../../../src/ui/adapters/dmAdapter";

interface MockClientOptions {
    ownUserId?: string;
    isGuest?: boolean;
    directContent?: unknown;
}

function makeClient(options: MockClientOptions = {}) {
    const setAccountData = vi.fn(async () => undefined);

    return {
        getUserId: () => options.ownUserId ?? "@me:example.org",
        isGuest: () => options.isGuest === true,
        getAccountData: (eventType: string) => {
            if (eventType !== EventType.Direct) {
                return null;
            }

            return {
                getContent: () => options.directContent ?? {},
            };
        },
        setAccountData,
        getRoom: () => null,
        getRooms: () => [],
    };
}

describe("dmAdapter", () => {
    it("isValidMatrixUserId validates matrix user IDs", () => {
        expect(isValidMatrixUserId("@alice:example.org")).toBe(true);
        expect(isValidMatrixUserId("  @alice:example.org ")).toBe(true);
        expect(isValidMatrixUserId("alice:example.org")).toBe(false);
        expect(isValidMatrixUserId("@alice")).toBe(false);
    });

    it("getDirectRoomIds sanitizes m.direct content and deduplicates room IDs", () => {
        const client = makeClient({
            directContent: {
                "@alice:example.org": ["!a:hs", "!a:hs", "!b:hs"],
                "@bob:example.org": ["!b:hs"],
                "@ignored:example.org": [42, null],
                invalid: "string",
            },
        });
        const roomById = new Map(
            ["!a:hs", "!b:hs"].map((roomId) => [
                roomId,
                {
                    roomId,
                    isSpaceRoom: () => false,
                    currentState: {
                        getStateEvents: () => [],
                    },
                },
            ]),
        );
        (client as any).getRoom = (roomId: string) => roomById.get(roomId) ?? null;

        const roomIds = getDirectRoomIds(client as any);
        expect([...roomIds].sort((left, right) => left.localeCompare(right))).toEqual(["!a:hs", "!b:hs"]);
    });

    it("ensureDirectRoomMappings is no-op for guest clients", async () => {
        const client = makeClient({
            isGuest: true,
            directContent: {
                "@alice:example.org": ["!a:hs"],
            },
        });

        await ensureDirectRoomMappings(client as any, "!a:hs", ["@bob:example.org"]);
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("ensureDirectRoomMappings ignores invalid targets", async () => {
        const client = makeClient({
            directContent: {
                "@alice:example.org": ["!a:hs"],
            },
        });

        await ensureDirectRoomMappings(client as any, "!a:hs", ["not-a-user-id", ""]);
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("ensureDirectRoomMappings replaces previous mapping by default", async () => {
        const client = makeClient({
            directContent: {
                "@alice:example.org": ["!old:hs"],
                "@bob:example.org": ["!target:hs"],
            },
        });

        await ensureDirectRoomMappings(client as any, "!target:hs", ["@alice:example.org"]);
        expect(client.setAccountData).toHaveBeenCalledTimes(1);

        const [eventType, content] = client.setAccountData.mock.calls[0] as [string, Record<string, string[]>];
        expect(eventType).toBe(EventType.Direct);
        expect(content).toEqual({
            "@alice:example.org": ["!old:hs", "!target:hs"],
        });
    });

    it("ensureDirectRoomMappings keeps previous mapping when replaceExisting is false", async () => {
        const client = makeClient({
            directContent: {
                "@alice:example.org": ["!old:hs"],
                "@bob:example.org": ["!target:hs"],
            },
        });

        await ensureDirectRoomMappings(client as any, "!target:hs", ["@alice:example.org"], { replaceExisting: false });
        expect(client.setAccountData).toHaveBeenCalledTimes(1);

        const [, content] = client.setAccountData.mock.calls[0] as [string, Record<string, string[]>];
        expect(content).toEqual({
            "@alice:example.org": ["!old:hs", "!target:hs"],
            "@bob:example.org": ["!target:hs"],
        });
    });

    it("ensureDirectRoomMappings does not write account data when content is unchanged", async () => {
        const client = makeClient({
            directContent: {
                "@alice:example.org": ["!target:hs"],
            },
        });

        await ensureDirectRoomMappings(client as any, "!target:hs", ["@alice:example.org"]);
        expect(client.setAccountData).not.toHaveBeenCalled();
    });

    it("ensureDirectRoomMapping wraps ensureDirectRoomMappings for single target", async () => {
        const client = makeClient({
            directContent: {},
        });

        await ensureDirectRoomMapping(client as any, "!target:hs", "@alice:example.org");
        expect(client.setAccountData).toHaveBeenCalledTimes(1);
    });
});
