export type PresenceState = "online" | "idle" | "dnd" | "offline" | "unknown";

export interface PresenceVm {
    state: PresenceState;
    primaryLabel: string;
    secondaryLabel: string | null;
    isCurrentlyActive: boolean;
    lastActiveAgo: number | null;
}

export interface PresenceSource {
    presence?: string | null;
    currentlyActive?: boolean | null;
    lastActiveAgo?: number | null;
}

const BUSY_PRESENCE_NAMES = new Set(["busy", "org.matrix.msc3026.busy"]);
const UNREACHABLE_PRESENCE_NAME = "io.element.unreachable";

function isBusyPresence(presence: string | null | undefined): boolean {
    return Boolean(presence && BUSY_PRESENCE_NAMES.has(presence));
}

function normalizeLastActiveAgo(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return value;
}

function getPrimaryLabel(state: PresenceState): string {
    switch (state) {
        case "online":
            return "Online";
        case "idle":
            return "Idle";
        case "dnd":
            return "Do Not Disturb";
        case "offline":
        case "unknown":
            return "Offline";
        default:
            return "Offline";
    }
}

export function formatPresenceDuration(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs < 60_000) {
        return "just now";
    }

    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const week = 7 * day;
    const month = 30 * day;
    const year = 365 * day;

    if (durationMs < hour) {
        return `${Math.max(1, Math.floor(durationMs / minute))}m`;
    }
    if (durationMs < day) {
        return `${Math.max(1, Math.floor(durationMs / hour))}h`;
    }
    if (durationMs < week) {
        return `${Math.max(1, Math.floor(durationMs / day))}d`;
    }
    if (durationMs < month) {
        return `${Math.max(1, Math.floor(durationMs / week))}w`;
    }
    if (durationMs < year) {
        return `${Math.max(1, Math.floor(durationMs / month))}mo`;
    }
    return `${Math.max(1, Math.floor(durationMs / year))}y`;
}

function formatAgo(durationMs: number): string {
    const formatted = formatPresenceDuration(durationMs);
    if (formatted === "just now") {
        return "just now";
    }
    return `${formatted} ago`;
}

function mapPresenceState(rawPresence: string | null | undefined): PresenceState {
    if (isBusyPresence(rawPresence)) {
        return "dnd";
    }

    if (rawPresence === "online") {
        return "online";
    }

    if (rawPresence === "unavailable") {
        return "idle";
    }

    if (rawPresence === "offline" || rawPresence === UNREACHABLE_PRESENCE_NAME) {
        return "offline";
    }

    return "unknown";
}

export function buildPresenceVm(source: PresenceSource | null | undefined): PresenceVm {
    const state = mapPresenceState(source?.presence ?? null);
    const isCurrentlyActive = source?.currentlyActive === true;
    const lastActiveAgo = normalizeLastActiveAgo(source?.lastActiveAgo ?? null);
    let secondaryLabel: string | null = null;

    if (!isCurrentlyActive && lastActiveAgo !== null) {
        const ago = formatAgo(lastActiveAgo);
        switch (state) {
            case "online":
                secondaryLabel = `Last seen ${ago}`;
                break;
            case "idle":
                secondaryLabel = `Last active ${ago}`;
                break;
            case "dnd":
                secondaryLabel = `Last active ${ago}`;
                break;
            case "offline":
            case "unknown":
                secondaryLabel = `Last active ${ago}`;
                break;
            default:
                secondaryLabel = `Last active ${ago}`;
                break;
        }
    }

    return {
        state,
        primaryLabel: getPrimaryLabel(state),
        secondaryLabel,
        isCurrentlyActive,
        lastActiveAgo,
    };
}

export function getPresenceSortRank(presence: PresenceVm | null | undefined): number {
    if (!presence) {
        return 3;
    }

    if (presence.isCurrentlyActive) {
        return 0;
    }

    if (presence.state === "online" || presence.state === "idle" || presence.state === "dnd") {
        return 1;
    }

    if (presence.state === "offline") {
        return 2;
    }

    return 3;
}

export function toAvatarPresenceState(
    presence: PresenceVm | null | undefined,
): Exclude<PresenceState, "unknown"> | null {
    if (!presence) {
        return null;
    }

    switch (presence.state) {
        case "online":
        case "idle":
        case "dnd":
        case "offline":
            return presence.state;
        case "unknown":
        default:
            return null;
    }
}

