import { describe, expect, it } from "vitest";

import {
    buildPresenceVm,
    formatPresenceDuration,
    getPresenceSortRank,
    toAvatarPresenceState,
} from "../../../../src/ui/presence/buildPresenceVm";

describe("formatPresenceDuration", () => {
    it("returns 'just now' for non-positive and sub-minute durations", () => {
        expect(formatPresenceDuration(0)).toBe("just now");
        expect(formatPresenceDuration(59_999)).toBe("just now");
    });

    it("formats minutes, hours, days and months", () => {
        expect(formatPresenceDuration(61_000)).toBe("1m");
        expect(formatPresenceDuration(2 * 60 * 60_000)).toBe("2h");
        expect(formatPresenceDuration(3 * 24 * 60 * 60_000)).toBe("3d");
        expect(formatPresenceDuration(31 * 24 * 60 * 60_000)).toBe("1mo");
    });
});

describe("buildPresenceVm", () => {
    it("maps busy presence to dnd and keeps active flag", () => {
        const vm = buildPresenceVm({
            presence: "busy",
            currentlyActive: true,
            lastActiveAgo: 120_000,
        });

        expect(vm.state).toBe("dnd");
        expect(vm.primaryLabel).toBe("Do Not Disturb");
        expect(vm.isCurrentlyActive).toBe(true);
        expect(vm.secondaryLabel).toBeNull();
    });

    it("generates secondary label for inactive users", () => {
        const vm = buildPresenceVm({
            presence: "online",
            currentlyActive: false,
            lastActiveAgo: 5 * 60_000,
        });

        expect(vm.secondaryLabel).toBe("Last seen 5m ago");
    });
});

describe("presence helpers", () => {
    it("returns expected sorting ranks", () => {
        const active = buildPresenceVm({ presence: "online", currentlyActive: true });
        const offline = buildPresenceVm({ presence: "offline", currentlyActive: false });
        const unknown = buildPresenceVm({ presence: "mystery" });

        expect(getPresenceSortRank(active)).toBe(0);
        expect(getPresenceSortRank(offline)).toBe(2);
        expect(getPresenceSortRank(unknown)).toBe(3);
    });

    it("maps presence to avatar presence state", () => {
        expect(toAvatarPresenceState(buildPresenceVm({ presence: "online" }))).toBe("online");
        expect(toAvatarPresenceState(buildPresenceVm({ presence: "unavailable" }))).toBe("idle");
        expect(toAvatarPresenceState(buildPresenceVm({ presence: "mystery" }))).toBeNull();
        expect(toAvatarPresenceState(null)).toBeNull();
    });
});
