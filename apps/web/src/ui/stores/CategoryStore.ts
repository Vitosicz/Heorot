import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

export const CATEGORY_STATE_EVENT = "com.heorot.categories";

const COLLAPSED_KEY = "heorot.categoryCollapsed.v1";
const DEFAULT_CATEGORY_NAME = "New Category";
const MAX_CATEGORY_NAME_LENGTH = 32;

export interface HeorotCategory {
    id: string;
    name: string;
    roomIds: string[];
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function createCategoryId(): string {
    return `cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// localStorage helpers (collapsed state)
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function readCollapsed(): Record<string, Record<string, boolean>> {
    const s = getStorage();
    if (!s) return {};
    try {
        const raw = s.getItem(COLLAPSED_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return parsed as Record<string, Record<string, boolean>>;
    } catch {
        return {};
    }
}

function writeCollapsed(data: Record<string, Record<string, boolean>>): void {
    const s = getStorage();
    if (!s) return;
    try {
        s.setItem(COLLAPSED_KEY, JSON.stringify(data));
    } catch {
        // ignore
    }
}

export function getCategoryCollapsed(spaceId: string, catId: string): boolean {
    return readCollapsed()[spaceId]?.[catId] === true;
}

export function setCategoryCollapsed(spaceId: string, catId: string, value: boolean): void {
    const data = readCollapsed();
    if (!data[spaceId]) data[spaceId] = {};
    if (value) {
        data[spaceId][catId] = true;
    } else {
        delete data[spaceId][catId];
    }
    writeCollapsed(data);
}

// ---------------------------------------------------------------------------
// Sanitize
// ---------------------------------------------------------------------------

function sanitizeCategories(raw: unknown): HeorotCategory[] {
    if (!Array.isArray(raw)) return [];
    const result: HeorotCategory[] = [];
    const seenIds = new Set<string>();
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        let id = typeof obj.id === "string" ? obj.id.trim() : "";
        if (!id || seenIds.has(id)) id = createCategoryId();
        const name =
            typeof obj.name === "string" && obj.name.trim().length > 0
                ? obj.name.trim().slice(0, MAX_CATEGORY_NAME_LENGTH)
                : DEFAULT_CATEGORY_NAME;
        const roomIds = Array.isArray(obj.roomIds)
            ? obj.roomIds.filter((r): r is string => typeof r === "string" && r.length > 0)
            : [];
        seenIds.add(id);
        result.push({ id, name, roomIds });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Matrix state event API
// ---------------------------------------------------------------------------

export const CHANNEL_ORDER_STATE_EVENT = "com.heorot.channelOrder";

interface StateSnapshotEvent {
    type?: unknown;
    state_key?: unknown;
    content?: unknown;
}

function isRootStateEvent(event: StateSnapshotEvent, eventType: string): boolean {
    if (event.type !== eventType) {
        return false;
    }
    const stateKey = typeof event.state_key === "string" ? event.state_key : "";
    return stateKey === "";
}

export function readCategoriesFromStateSnapshot(stateEvents: StateSnapshotEvent[]): HeorotCategory[] {
    for (const event of stateEvents) {
        if (!isRootStateEvent(event, CATEGORY_STATE_EVENT)) {
            continue;
        }

        if (!event.content || typeof event.content !== "object" || Array.isArray(event.content)) {
            return [];
        }

        const content = event.content as { categories?: unknown };
        return sanitizeCategories(content.categories);
    }

    return [];
}

export function readChannelOrderFromStateSnapshot(stateEvents: StateSnapshotEvent[]): string[] {
    for (const event of stateEvents) {
        if (!isRootStateEvent(event, CHANNEL_ORDER_STATE_EVENT)) {
            continue;
        }

        if (!event.content || typeof event.content !== "object" || Array.isArray(event.content)) {
            return [];
        }

        const content = event.content as { order?: unknown };
        if (!Array.isArray(content.order)) {
            return [];
        }

        return content.order.filter((value): value is string => typeof value === "string" && value.length > 0);
    }

    return [];
}

export function readCategories(room: Room): HeorotCategory[] {
    const event = room.currentState.getStateEvents(CATEGORY_STATE_EVENT, "");
    if (!event) return [];
    const content = event.getContent() as Record<string, unknown>;
    return sanitizeCategories(content.categories);
}

export async function writeCategories(
    client: MatrixClient,
    spaceId: string,
    categories: HeorotCategory[],
): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.sendStateEvent(spaceId, CATEGORY_STATE_EVENT as any, { categories }, "");
}

export function canManageCategories(room: Room, userId: string): boolean {
    return room.currentState.maySendStateEvent(CATEGORY_STATE_EVENT, userId);
}

export function readChannelOrder(room: Room): string[] {
    const event = room.currentState.getStateEvents(CHANNEL_ORDER_STATE_EVENT, "");
    if (!event) return [];
    const content = event.getContent() as Record<string, unknown>;
    if (!Array.isArray(content.order)) return [];
    return content.order.filter((r): r is string => typeof r === "string" && r.length > 0);
}

export async function writeChannelOrder(
    client: MatrixClient,
    spaceId: string,
    order: string[],
): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.sendStateEvent(spaceId, CHANNEL_ORDER_STATE_EVENT as any, { order }, "");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCategory(name = DEFAULT_CATEGORY_NAME): HeorotCategory {
    const trimmed = name.trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
    return {
        id: createCategoryId(),
        name: trimmed.length > 0 ? trimmed : DEFAULT_CATEGORY_NAME,
        roomIds: [],
    };
}
