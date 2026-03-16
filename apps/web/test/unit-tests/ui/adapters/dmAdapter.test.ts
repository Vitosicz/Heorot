import { EventType } from "matrix-js-sdk/src/matrix";
import { describe, expect, it, vi } from "vitest";

import {
    ensureDirectRoomMapping,
    ensureDirectRoomMappings,
    findExistingDirectGroupRoomId,
    findExistingDirectRoomId,
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

function makeMember(userId: string, membership = "join") {
    return {
        userId,
        membership,
    };
}

function makeRoom(options: {
    roomId: string;
    ownUserId: string;
    targetUserId?: string;
    extraUserIds?: string[];
    myMembership?: string;
    dmInviterUserId?: string;
}) {
    const ownMembership = options.myMembership ?? "join";
    const members = [makeMember(options.ownUserId, ownMembership)];

    if (options.targetUserId) {
        members.push(makeMember(options.targetUserId, "join"));
    }

    for (const extraUserId of options.extraUserIds ?? []) {
        members.push(makeMember(extraUserId, "join"));
    }

    return {
        roomId: options.roomId,
        isSpaceRoom: () => false,
        getMyMembership: () => ownMembership,
        getDMInviter: () => options.dmInviterUserId,
        getMember: (userId: string) => members.find((member) => member.userId === userId) ?? null,
        currentState: {
            getMembers: () => members,
            getStateEvents: () => [],
        },
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

    it("getDirectRoomIds includes direct invites hinted by getDMInviter even without m.direct", () => {
        const ownUserId = "@me:example.org";
        const targetUserId = "@alice:example.org";
        const room = makeRoom({
            roomId: "!invite-dm:hs",
            ownUserId,
            targetUserId,
            myMembership: "invite",
            dmInviterUserId: targetUserId,
        });

        const client = makeClient({ ownUserId, directContent: {} });
        (client as any).getRooms = () => [room];
        (client as any).getRoom = (roomId: string) => (roomId === room.roomId ? room : null);

        const roomIds = getDirectRoomIds(client as any);
        expect(roomIds.has(room.roomId)).toBe(true);
    });

    it("findExistingDirectRoomId does not fallback to arbitrary rooms outside m.direct", () => {
        const ownUserId = "@me:example.org";
        const targetUserId = "@alice:example.org";
        const room = makeRoom({
            roomId: "!not-mapped:hs",
            ownUserId,
            targetUserId,
        });

        const client = makeClient({ ownUserId, directContent: {} });
        (client as any).getRooms = () => [room];
        (client as any).getRoom = () => room;

        expect(findExistingDirectRoomId(client as any, targetUserId)).toBeNull();
    });

    it("findExistingDirectRoomId reuses direct invite hinted by getDMInviter", () => {
        const ownUserId = "@me:example.org";
        const targetUserId = "@alice:example.org";
        const inviteRoom = makeRoom({
            roomId: "!invite-dm:hs",
            ownUserId,
            targetUserId,
            myMembership: "invite",
            dmInviterUserId: targetUserId,
        });

        const client = makeClient({ ownUserId, directContent: {} });
        (client as any).getRooms = () => [inviteRoom];
        (client as any).getRoom = (roomId: string) => (roomId === inviteRoom.roomId ? inviteRoom : null);

        expect(findExistingDirectRoomId(client as any, targetUserId)).toBe(inviteRoom.roomId);
    });

    it("findExistingDirectRoomId ignores mapped rooms that are not 1:1 DMs", () => {
        const ownUserId = "@me:example.org";
        const targetUserId = "@alice:example.org";
        const mappedRoom = makeRoom({
            roomId: "!mapped:hs",
            ownUserId,
            targetUserId,
            extraUserIds: ["@extra:example.org"],
        });

        const client = makeClient({
            ownUserId,
            directContent: {
                [targetUserId]: [mappedRoom.roomId],
            },
        });
        (client as any).getRoom = (roomId: string) => (roomId === mappedRoom.roomId ? mappedRoom : null);

        expect(findExistingDirectRoomId(client as any, targetUserId)).toBeNull();
    });
    it("findExistingDirectGroupRoomId does not fallback to arbitrary rooms outside m.direct", () => {
        const ownUserId = "@me:example.org";
        const targetUserIds = ["@alice:example.org", "@bob:example.org"];
        const room = makeRoom({
            roomId: "!not-mapped-group:hs",
            ownUserId,
            targetUserId: "@alice:example.org",
            extraUserIds: ["@bob:example.org"],
        });

        const client = makeClient({ ownUserId, directContent: {} });
        (client as any).getRooms = () => [room];
        (client as any).getRoom = () => room;

        expect(findExistingDirectGroupRoomId(client as any, targetUserIds)).toBeNull();
    });

    it("findExistingDirectGroupRoomId ignores mapped rooms that do not match exact members", () => {
        const ownUserId = "@me:example.org";
        const targetUserIds = ["@alice:example.org", "@bob:example.org"];
        const mappedRoom = makeRoom({
            roomId: "!mapped-group:hs",
            ownUserId,
            targetUserId: "@alice:example.org",
            extraUserIds: ["@bob:example.org", "@extra:example.org"],
        });

        const client = makeClient({
            ownUserId,
            directContent: {
                "@alice:example.org": [mappedRoom.roomId],
                "@bob:example.org": [mappedRoom.roomId],
            },
        });
        (client as any).getRoom = (roomId: string) => (roomId === mappedRoom.roomId ? mappedRoom : null);

        expect(findExistingDirectGroupRoomId(client as any, targetUserIds)).toBeNull();
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
