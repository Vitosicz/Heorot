import { EventType, KnownMembership } from "matrix-js-sdk/src/matrix";
import { describe, expect, it } from "vitest";

import {
    getActionPowerLevel,
    getBannedMembers,
    getJoinedOrInvitedMembers,
    getPowerLevelsContent,
    getRoomDisplayName,
    getUserPowerLevel,
} from "../../../../src/ui/components/rooms/roomAdminUtils";

function makeRoom(options?: {
    name?: string;
    alias?: string;
    roomId?: string;
    powerLevelsContent?: unknown;
    members?: Array<{
        userId: string;
        membership: string;
        name?: string;
        rawDisplayName?: string;
    }>;
}) {
    return {
        name: options?.name ?? "",
        roomId: options?.roomId ?? "!room:example.org",
        getCanonicalAlias: () => options?.alias ?? "",
        currentState: {
            getStateEvents: (eventType: string) => {
                if (eventType !== EventType.RoomPowerLevels) {
                    return null;
                }
                return {
                    getContent: () => options?.powerLevelsContent ?? {},
                };
            },
            getMembers: () => (options?.members ?? []) as any,
        },
    };
}

describe("roomAdminUtils", () => {
    it("getRoomDisplayName uses name, alias, then room id", () => {
        expect(getRoomDisplayName(makeRoom({ name: "General", alias: "#gen:hs" }) as any)).toBe("General");
        expect(getRoomDisplayName(makeRoom({ name: "", alias: "#gen:hs" }) as any)).toBe("#gen:hs");
        expect(getRoomDisplayName(makeRoom({ name: "", alias: "", roomId: "!r:hs" }) as any)).toBe("!r:hs");
    });

    it("getPowerLevelsContent parses numeric values and ignores invalid user levels", () => {
        const room = makeRoom({
            powerLevelsContent: {
                users: {
                    "@admin:hs": 100,
                    "@invalid:hs": "100",
                    "": 50,
                },
                users_default: 10,
                invite: 20,
                redact: "30",
                kick: 40,
                ban: null,
            },
        });

        expect(getPowerLevelsContent(room as any)).toEqual({
            users: {
                "@admin:hs": 100,
            },
            users_default: 10,
            invite: 20,
            redact: undefined,
            kick: 40,
            ban: undefined,
        });
    });

    it("getUserPowerLevel returns explicit user level or users_default fallback", () => {
        const room = makeRoom({
            powerLevelsContent: {
                users: {
                    "@admin:hs": 100,
                },
                users_default: 5,
            },
        });

        expect(getUserPowerLevel(room as any, "@admin:hs")).toBe(100);
        expect(getUserPowerLevel(room as any, "@member:hs")).toBe(5);
    });

    it("getActionPowerLevel uses defaults when action is missing", () => {
        const room = makeRoom({
            powerLevelsContent: {
                invite: 10,
            },
        });

        expect(getActionPowerLevel(room as any, "invite")).toBe(10);
        expect(getActionPowerLevel(room as any, "redact")).toBe(50);
        expect(getActionPowerLevel(room as any, "kick")).toBe(50);
        expect(getActionPowerLevel(room as any, "ban")).toBe(50);
    });

    it("getJoinedOrInvitedMembers filters and sorts by display name", () => {
        const room = makeRoom({
            members: [
                { userId: "@z:hs", membership: KnownMembership.Join, rawDisplayName: "Zulu" },
                { userId: "@a:hs", membership: KnownMembership.Invite, name: "alpha" },
                { userId: "@b:hs", membership: KnownMembership.Ban, name: "bravo" },
                { userId: "@m:hs", membership: KnownMembership.Join },
            ],
        });

        const members = getJoinedOrInvitedMembers(room as any).map((member) => member.userId);
        expect(members).toEqual(["@m:hs", "@a:hs", "@z:hs"]);
    });

    it("getBannedMembers filters bans and sorts by user id", () => {
        const room = makeRoom({
            members: [
                { userId: "@z:hs", membership: KnownMembership.Ban },
                { userId: "@a:hs", membership: KnownMembership.Ban },
                { userId: "@m:hs", membership: KnownMembership.Join },
            ],
        });

        const members = getBannedMembers(room as any).map((member) => member.userId);
        expect(members).toEqual(["@a:hs", "@z:hs"]);
    });
});
