import { EventType } from "matrix-js-sdk/src/matrix";
import { describe, expect, it } from "vitest";

import { SPACE_EMOJI_PACK_EVENT_TYPE } from "../../../../src/ui/emoji/EmojiPackTypes";
import { getPowerRoleLabel, getSpacePermissions } from "../../../../src/ui/settings/useSpacePermissions";

describe("getSpacePermissions", () => {
    it("returns false permissions when room is missing", () => {
        const permissions = getSpacePermissions({ getUserId: () => "@me:example.org" } as any, null);
        expect(permissions).toEqual({
            canEditName: false,
            canEditTopic: false,
            canEditAvatar: false,
            canEditEmojiPack: false,
        });
    });

    it("returns false permissions when user id is missing", () => {
        const room = {
            currentState: {
                maySendStateEvent: () => true,
            },
        };

        const permissions = getSpacePermissions({ getUserId: () => null } as any, room as any);
        expect(permissions).toEqual({
            canEditName: false,
            canEditTopic: false,
            canEditAvatar: false,
            canEditEmojiPack: false,
        });
    });

    it("maps maySendStateEvent checks to each permission field", () => {
        const allowed = new Set<string>([EventType.RoomName, EventType.RoomAvatar]);
        const room = {
            currentState: {
                maySendStateEvent: (eventType: string) => allowed.has(eventType),
            },
        };

        const permissions = getSpacePermissions({ getUserId: () => "@me:example.org" } as any, room as any);
        expect(permissions).toEqual({
            canEditName: true,
            canEditTopic: false,
            canEditAvatar: true,
            canEditEmojiPack: false,
        });

        allowed.add(SPACE_EMOJI_PACK_EVENT_TYPE);
        const withEmoji = getSpacePermissions({ getUserId: () => "@me:example.org" } as any, room as any);
        expect(withEmoji.canEditEmojiPack).toBe(true);
    });
});

describe("getPowerRoleLabel", () => {
    it("labels admin and mod thresholds correctly", () => {
        expect(getPowerRoleLabel(100)).toBe("Admin");
        expect(getPowerRoleLabel(99)).toBe("Mod");
        expect(getPowerRoleLabel(50)).toBe("Mod");
        expect(getPowerRoleLabel(49)).toBe("Member");
    });
});
