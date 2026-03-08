import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ClientEvent,
    EventType,
    JoinRule,
    MatrixEventEvent,
    RoomEvent,
    RoomStateEvent,
    type HierarchyRoom,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { getDirectRoomIds } from "../adapters/dmAdapter";
import { describeJoinError, joinRoomWithRetry } from "../adapters/joinAdapter";
import { mediaFromMxc, thumbnailFromMxc } from "../adapters/media";
import { Composer } from "./Composer";
import { EmojiUploadDialog } from "./EmojiUploadDialog";
import { ChannelHeader } from "./header/ChannelHeader";
import { RightPanel } from "./rightPanel/RightPanel";
import { RoomList, type DiscoverableSpaceChannel } from "./RoomList";
import { Timeline } from "./Timeline";
import { Toast, type ToastState } from "./Toast";
import { Avatar } from "./Avatar";
import { CreateRoomDialog } from "./rooms/CreateRoomDialog";
import { CreateSpaceDialog } from "./rooms/CreateSpaceDialog";
import { ImportJsonWizard } from "./rooms/ImportJsonWizard";
import { CreateDirectChatDialog } from "./rooms/CreateDirectChatDialog";
import { InviteDialog } from "./rooms/InviteDialog";
import { JoinRoomDialog } from "./rooms/JoinRoomDialog";
import { RoomModerationDialog } from "./rooms/RoomModerationDialog";
import { RoomSettingsDialog } from "./rooms/RoomSettingsDialog";
import { SettingsOverlay, type SettingsMode } from "../settings/SettingsOverlay";
import {
    applyAppearanceTheme,
    loadUserLocalSettings,
    saveUserLocalSettings,
    type UserLocalSettings,
} from "../settings/user/settingsStore";
import {
    getFeatureRenderReactionImages,
    setFeatureRenderReactionImages,
} from "../emoji/EmojiPackStore";
import type { EmojiPackTarget } from "../emoji/EmojiPackTypes";
import { useSelectedUser } from "../hooks/useSelectedUser";
import { useElementLikeNotifications } from "../notifications/useElementLikeNotifications";
import { buildMatrixToRoomPermalink } from "../utils/permalink";
import type { RightSidebarMode } from "./rightPanel/types";
import { VoiceRoom, type VoiceControlState, type VoiceRoomHandle, type VoiceSessionStatus } from "./voice/VoiceRoom";
import {
    MATRIX_CALL_COMPAT_EVENT,
    HEOROT_VOICE_CHANNEL_EVENT,
    isVoiceChannelHintContent,
    isVoiceChannelRoom,
} from "../voice/voiceChannel";
import { clearVoiceDiscovery, initVoiceDiscovery } from "../voice/voiceDiscovery";
import { CHANNEL_ORDER_STATE_EVENT, readChannelOrder, writeChannelOrder } from "../stores/CategoryStore";

interface AppShellProps {
    client: MatrixClient;
    onLogout: () => Promise<void>;
}

interface SpaceChildOrder {
    index: number;
    order?: string;
    viaServers: string[];
    isVoiceChannel: boolean;
}

interface SpaceChildStateSnapshotEvent {
    type?: unknown;
    state_key?: unknown;
    content?: unknown;
}

interface SettingsState {
    mode: SettingsMode;
    tab: string;
}

const PEOPLE_SPACE_ID = "people-space";
const RIGHT_SIDEBAR_MODE_STORAGE_KEY = "heorot.ui.rightSidebarMode";
const CHANNELS_PANE_WIDTH_KEY = "heorot.ui.channelsPaneWidth";
const CHANNELS_PANE_MIN = 180;
const CHANNELS_PANE_MAX = 480;
const CHANNELS_PANE_DEFAULT = 280;
const DEFAULT_VOICE_CONTROL_STATE: VoiceControlState = {
    joining: false,
    connected: false,
    micMuted: true,
    audioMuted: false,
};

function readChannelsPaneWidth(): number {
    try {
        const raw = window.localStorage.getItem(CHANNELS_PANE_WIDTH_KEY);
        if (raw) {
            const n = Number(raw);
            if (Number.isFinite(n)) return Math.min(CHANNELS_PANE_MAX, Math.max(CHANNELS_PANE_MIN, n));
        }
    } catch { /* ignore */ }
    return CHANNELS_PANE_DEFAULT;
}

function readStoredRightSidebarMode(): RightSidebarMode {
    if (typeof window === "undefined") {
        return "members";
    }

    const raw = window.localStorage.getItem(RIGHT_SIDEBAR_MODE_STORAGE_KEY);
    if (raw === "members" || raw === "search" || raw === "pins" || raw === "info" || raw === "closed") {
        return raw;
    }

    return "members";
}

function getRoomName(room: Room): string {
    return room.name || room.getCanonicalAlias() || room.roomId;
}

function isVisibleMembership(room: Room): boolean {
    const membership = room.getMyMembership();
    return membership === "join" || membership === "invite" || membership === "knock";
}

function compareRoomsByName(left: Room, right: Room): number {
    const nameComparison = getRoomName(left).localeCompare(getRoomName(right), undefined, {
        sensitivity: "base",
    });
    if (nameComparison !== 0) {
        return nameComparison;
    }

    return left.roomId.localeCompare(right.roomId);
}

function sortRoomsByName(rooms: Room[]): Room[] {
    return [...rooms].sort(compareRoomsByName);
}

function getRoomLastTimestamp(room: Room): number {
    const liveEvents = room.getLiveTimeline()?.getEvents() ?? room.timeline;
    const lastEvent = liveEvents[liveEvents.length - 1];
    if (lastEvent) {
        return lastEvent.getTs();
    }

    const roomAsExtended = room as Room & {
        getLastActiveTimestamp?: () => number;
    };
    return roomAsExtended.getLastActiveTimestamp?.() ?? 0;
}

function sortRoomsByActivity(rooms: Room[]): Room[] {
    return [...rooms].sort((left, right) => {
        const delta = getRoomLastTimestamp(right) - getRoomLastTimestamp(left);
        if (delta !== 0) {
            return delta;
        }

        return compareRoomsByName(left, right);
    });
}

function areStringSetsEqual(left: Set<string> | undefined, right: Set<string>): boolean {
    if (!left) {
        return right.size === 0;
    }
    if (left.size !== right.size) {
        return false;
    }
    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }
    return true;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

interface SpaceParentCandidate {
    spaceId: string;
    viaServers: string[];
    canonical: boolean;
}

function toStateEventsArray(
    rawEvents: unknown,
): Array<{ getStateKey: () => string | undefined | null; getContent: () => Record<string, unknown> }> {
    if (Array.isArray(rawEvents)) {
        return rawEvents as Array<{ getStateKey: () => string | undefined | null; getContent: () => Record<string, unknown> }>;
    }
    if (rawEvents) {
        return [rawEvents as { getStateKey: () => string | undefined | null; getContent: () => Record<string, unknown> }];
    }
    return [];
}

function normalizeViaServers(rawVia: unknown): string[] {
    if (!Array.isArray(rawVia)) {
        return [];
    }

    return [
        ...new Set(
            rawVia
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter((value) => value.length > 0),
        ),
    ];
}

function readSpaceParentCandidates(room: Room): SpaceParentCandidate[] {
    const parentEvents = toStateEventsArray(room.currentState.getStateEvents(EventType.SpaceParent));
    const bySpaceId = new Map<string, SpaceParentCandidate>();

    for (const parentEvent of parentEvents) {
        const parentSpaceId = parentEvent.getStateKey();
        if (typeof parentSpaceId !== "string" || parentSpaceId.length === 0) {
            continue;
        }

        const content = (parentEvent.getContent() ?? {}) as { via?: unknown; canonical?: unknown };
        const nextViaServers = normalizeViaServers(content.via);
        const existing = bySpaceId.get(parentSpaceId);

        if (!existing) {
            bySpaceId.set(parentSpaceId, {
                spaceId: parentSpaceId,
                viaServers: nextViaServers,
                canonical: content.canonical === true,
            });
            continue;
        }

        const mergedViaServers = new Set([...existing.viaServers, ...nextViaServers]);
        bySpaceId.set(parentSpaceId, {
            spaceId: parentSpaceId,
            viaServers: Array.from(mergedViaServers),
            canonical: existing.canonical || content.canonical === true,
        });
    }

    return Array.from(bySpaceId.values()).sort((left, right) => {
        if (left.canonical !== right.canonical) {
            return left.canonical ? -1 : 1;
        }
        return left.spaceId.localeCompare(right.spaceId);
    });
}

function getViaServersForParentSpace(client: MatrixClient, parentSpaceId: string): string[] {
    const viaServers = new Set<string>();
    const visibleRooms = client.getRooms().filter((room) => !room.isSpaceRoom() && isVisibleMembership(room));

    for (const room of visibleRooms) {
        const candidates = readSpaceParentCandidates(room);
        for (const candidate of candidates) {
            if (candidate.spaceId !== parentSpaceId) {
                continue;
            }
            for (const viaServer of candidate.viaServers) {
                viaServers.add(viaServer);
            }
        }
    }

    return Array.from(viaServers);
}

async function ensureRoomParentSpacesJoined(
    client: MatrixClient,
    room: Room,
    preferredSpaceId: string | null | undefined,
): Promise<string | null> {
    const candidates = readSpaceParentCandidates(room);
    if (candidates.length === 0 && !preferredSpaceId) {
        return null;
    }

    const bySpaceId = new Map(candidates.map((candidate) => [candidate.spaceId, candidate] as const));
    if (preferredSpaceId && !bySpaceId.has(preferredSpaceId)) {
        bySpaceId.set(preferredSpaceId, {
            spaceId: preferredSpaceId,
            viaServers: getViaServersForParentSpace(client, preferredSpaceId),
            canonical: true,
        });
    }

    const orderedCandidates = [
        ...(preferredSpaceId ? [bySpaceId.get(preferredSpaceId)].filter((value): value is SpaceParentCandidate => Boolean(value)) : []),
        ...Array.from(bySpaceId.values()).filter((candidate) => candidate.spaceId !== preferredSpaceId),
    ];

    for (const candidate of orderedCandidates) {
        const existingParent = client.getRoom(candidate.spaceId);
        if (existingParent?.isSpaceRoom() && existingParent.getMyMembership() === "join") {
            return candidate.spaceId;
        }

        try {
            const joinedParent = await joinRoomWithRetry(client, candidate.spaceId, {
                viaServers: candidate.viaServers,
                maxAttempts: 1,
            });
            if (joinedParent.isSpaceRoom() && joinedParent.getMyMembership() === "join") {
                return joinedParent.roomId;
            }
        } catch {
            // Best-effort: some users can join channel without permission to join parent space.
        }
    }

    return null;
}
function updateRoomIdentitySetMap(
    current: Map<string, Set<string>>,
    roomId: string,
    nextValues: Set<string>,
): Map<string, Set<string>> {
    const currentValues = current.get(roomId);
    if (nextValues.size === 0) {
        if (!currentValues) {
            return current;
        }
        const next = new Map(current);
        next.delete(roomId);
        return next;
    }
    if (areStringSetsEqual(currentValues, nextValues)) {
        return current;
    }
    const next = new Map(current);
    next.set(roomId, nextValues);
    return next;
}

function readSpaceChildOrderFromStateSnapshot(stateEvents: SpaceChildStateSnapshotEvent[]): Map<string, SpaceChildOrder> {
    const orderByRoomId = new Map<string, SpaceChildOrder>();
    let childIndex = 0;

    stateEvents.forEach((event) => {
        if (event.type !== EventType.SpaceChild) {
            return;
        }

        const childRoomId = typeof event.state_key === "string" ? event.state_key : "";
        if (!childRoomId || orderByRoomId.has(childRoomId)) {
            return;
        }

        const content = (event.content ?? {}) as { order?: unknown; via?: unknown; [key: string]: unknown };
        const order =
            typeof content.order === "string" && content.order.length > 0 && content.order.length <= 50
                ? content.order
                : undefined;
        const viaServers = Array.isArray(content.via)
            ? content.via
                  .filter((value): value is string => typeof value === "string")
                  .map((value) => value.trim())
                  .filter((value) => value.length > 0)
            : [];
        const isVoiceChannel = isVoiceChannelHintContent(content);

        orderByRoomId.set(childRoomId, { index: childIndex, order, viaServers, isVoiceChannel });
        childIndex += 1;
    });

    return orderByRoomId;
}
function readChannelOrderFromStateSnapshot(stateEvents: SpaceChildStateSnapshotEvent[]): string[] {
    for (const event of stateEvents) {
        if (event.type !== CHANNEL_ORDER_STATE_EVENT) {
            continue;
        }

        const stateKey = typeof event.state_key === "string" ? event.state_key : "";
        if (stateKey !== "") {
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
function isVoiceChannelFromStateSnapshot(stateEvents: SpaceChildStateSnapshotEvent[]): boolean {
    for (const event of stateEvents) {
        const eventType = typeof event.type === "string" ? event.type : "";
        const content = event.content;

        if (eventType === HEOROT_VOICE_CHANNEL_EVENT) {
            if (
                content &&
                typeof content === "object" &&
                !Array.isArray(content) &&
                (content as { enabled?: unknown }).enabled === true
            ) {
                return true;
            }
            continue;
        }

        if (eventType !== MATRIX_CALL_COMPAT_EVENT || !content || typeof content !== "object" || Array.isArray(content)) {
            continue;
        }

        const callContent = content as { intent?: unknown; type?: unknown };
        const intent = typeof callContent.intent === "string" ? callContent.intent.trim().toLowerCase() : "";
        const callType = typeof callContent.type === "string" ? callContent.type.trim().toLowerCase() : "";
        if (intent === "voice" || callType === "voice") {
            return true;
        }
    }

    return false;
}

function readSpaceChildOrder(spaceRoom: Room): Map<string, SpaceChildOrder> {
    const rawEvents = spaceRoom.currentState.getStateEvents(EventType.SpaceChild);
    const events = Array.isArray(rawEvents) ? rawEvents : rawEvents ? [rawEvents] : [];
    const snapshotEvents = events.map((event) => ({
        type: EventType.SpaceChild,
        state_key: event.getStateKey(),
        content: event.getContent(),
    }));

    return readSpaceChildOrderFromStateSnapshot(snapshotEvents);
}

function buildCustomChannelOrderIndex(spaceRoom: Room, orderOverride?: string[]): Map<string, number> {
    const byRoomId = new Map<string, number>();
    const order = Array.isArray(orderOverride) ? orderOverride : readChannelOrder(spaceRoom);

    order.forEach((roomId, index) => {
        if (!byRoomId.has(roomId)) {
            byRoomId.set(roomId, index);
        }
    });

    return byRoomId;
}

function getSpaceChannels(spaceRoom: Room, roomById: Map<string, Room>): Room[] {
    const childOrder = readSpaceChildOrder(spaceRoom);
    const customOrderByRoomId = buildCustomChannelOrderIndex(spaceRoom);
    const channels: Array<{ room: Room; index: number; order?: string; customOrderIndex?: number }> = [];

    for (const [roomId, metadata] of childOrder.entries()) {
        const room = roomById.get(roomId);
        if (!room || room.isSpaceRoom() || !isVisibleMembership(room)) {
            continue;
        }

        channels.push({
            room,
            index: metadata.index,
            order: metadata.order,
            customOrderIndex: customOrderByRoomId.get(roomId),
        });
    }

    channels.sort((left, right) => {
        const leftCustom = left.customOrderIndex;
        const rightCustom = right.customOrderIndex;
        if (leftCustom !== undefined && rightCustom !== undefined && leftCustom !== rightCustom) {
            return leftCustom - rightCustom;
        }
        if (leftCustom !== undefined) {
            return -1;
        }
        if (rightCustom !== undefined) {
            return 1;
        }

        if (left.order && right.order) {
            const byOrder = left.order.localeCompare(right.order);
            if (byOrder !== 0) {
                return byOrder;
            }
        } else if (left.order) {
            return -1;
        } else if (right.order) {
            return 1;
        }

        if (left.index !== right.index) {
            return left.index - right.index;
        }

        const byName = compareRoomsByName(left.room, right.room);
        if (byName !== 0) {
            return byName;
        }

        return left.room.roomId.localeCompare(right.room.roomId);
    });

    return channels.map((entry) => entry.room);
}

function getSpaceGlyph(spaceName: string): string {
    const normalized = spaceName.trim().replace(/^[@#+!]+/, "");
    if (!normalized) {
        return "#";
    }

    return normalized[0].toUpperCase();
}

async function getSpaceHierarchyRooms(client: MatrixClient, spaceRoomId: string): Promise<HierarchyRoom[]> {
    const roomById = new Map<string, HierarchyRoom>();
    const visitedTokens = new Set<string>();
    let fromToken: string | undefined;

    while (true) {
        const response = await client.getRoomHierarchy(spaceRoomId, 100, 1, false, fromToken);
        response.rooms.forEach((room) => {
            if (!roomById.has(room.room_id)) {
                roomById.set(room.room_id, room);
            }
        });

        const nextToken = response.next_batch;
        if (!nextToken || visitedTokens.has(nextToken)) {
            break;
        }
        visitedTokens.add(nextToken);
        fromToken = nextToken;
    }

    return Array.from(roomById.values());
}

function getHierarchyRoomName(room: HierarchyRoom): string {
    return room.name || room.canonical_alias || room.aliases?.[0] || room.room_id;
}

interface OrderedHierarchyChannelEntry {
    roomId: string;
    name: string;
    index: number;
    order?: string;
    customOrderIndex?: number;
}

function compareOrderedHierarchyChannelEntries(
    left: OrderedHierarchyChannelEntry,
    right: OrderedHierarchyChannelEntry,
): number {
    const leftCustom = left.customOrderIndex;
    const rightCustom = right.customOrderIndex;
    if (leftCustom !== undefined && rightCustom !== undefined && leftCustom !== rightCustom) {
        return leftCustom - rightCustom;
    }
    if (leftCustom !== undefined) {
        return -1;
    }
    if (rightCustom !== undefined) {
        return 1;
    }

    if (left.order && right.order) {
        const byOrder = left.order.localeCompare(right.order);
        if (byOrder !== 0) {
            return byOrder;
        }
    } else if (left.order) {
        return -1;
    } else if (right.order) {
        return 1;
    }

    if (left.index !== right.index) {
        return left.index - right.index;
    }

    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    if (byName !== 0) {
        return byName;
    }

    return left.roomId.localeCompare(right.roomId);
}

function sortRoomsBySpaceOrder(spaceRoom: Room, rooms: Room[]): Room[] {
    const childOrder = readSpaceChildOrder(spaceRoom);
    const customOrderByRoomId = buildCustomChannelOrderIndex(spaceRoom);
    const entries: Array<OrderedHierarchyChannelEntry & { room: Room }> = rooms.map((room, listIndex) => {
        const metadata = childOrder.get(room.roomId);
        return {
            room,
            roomId: room.roomId,
            name: getRoomName(room),
            index: metadata?.index ?? listIndex,
            order: metadata?.order,
            customOrderIndex: customOrderByRoomId.get(room.roomId),
        };
    });

    entries.sort(compareOrderedHierarchyChannelEntries);
    return entries.map((entry) => entry.room);
}

function buildJoinedHierarchyChannelIds(
    spaceRoom: Room,
    hierarchyRooms: HierarchyRoom[],
    visibleRoomIds: Set<string>,
    childOrderOverride?: Map<string, SpaceChildOrder>,
    customOrderOverride?: string[],
): string[] {
    const childOrder = childOrderOverride ?? readSpaceChildOrder(spaceRoom);
    const customOrderByRoomId = buildCustomChannelOrderIndex(spaceRoom, customOrderOverride);
    const entries: OrderedHierarchyChannelEntry[] = [];
    let hierarchyIndex = 0;

    for (const room of hierarchyRooms) {
        if (room.room_id === spaceRoom.roomId) {
            continue;
        }
        if (room.room_type === "m.space") {
            continue;
        }
        if (!visibleRoomIds.has(room.room_id)) {
            continue;
        }

        const metadata = childOrder.get(room.room_id);
        entries.push({
            roomId: room.room_id,
            name: getHierarchyRoomName(room),
            index: metadata?.index ?? hierarchyIndex,
            order: metadata?.order,
            customOrderIndex: customOrderByRoomId.get(room.room_id),
        });
        hierarchyIndex += 1;
    }

    entries.sort(compareOrderedHierarchyChannelEntries);
    return entries.map((entry) => entry.roomId);
}

function buildDiscoverableSpaceChannels(
    spaceRoom: Room,
    hierarchyRooms: HierarchyRoom[],
    visibleRoomIds: Set<string>,
    childOrderOverride?: Map<string, SpaceChildOrder>,
    customOrderOverride?: string[],
    voiceChannelHintRoomIds?: Set<string>,
): DiscoverableSpaceChannel[] {
    const childOrder = childOrderOverride ?? readSpaceChildOrder(spaceRoom);
    const customOrderByRoomId = buildCustomChannelOrderIndex(spaceRoom, customOrderOverride);
    const channels: Array<DiscoverableSpaceChannel & { index: number; order?: string; customOrderIndex?: number }> = [];
    let hierarchyIndex = 0;

    for (const room of hierarchyRooms) {
        if (room.room_id === spaceRoom.roomId) {
            continue;
        }
        if (room.room_type === "m.space") {
            continue;
        }
        if (room.join_rule !== JoinRule.Public) {
            continue;
        }
        if (visibleRoomIds.has(room.room_id)) {
            continue;
        }

        const metadata = childOrder.get(room.room_id);
        channels.push({
            roomId: room.room_id,
            name: getHierarchyRoomName(room),
            topic: room.topic,
            avatarMxc: room.avatar_url ?? null,
            memberCount: room.num_joined_members,
            isVoiceChannel: metadata?.isVoiceChannel === true || voiceChannelHintRoomIds?.has(room.room_id) === true,
            viaServers: metadata?.viaServers ?? [],
            index: metadata?.index ?? hierarchyIndex,
            order: metadata?.order,
            customOrderIndex: customOrderByRoomId.get(room.room_id),
        });
        hierarchyIndex += 1;
    }

    channels.sort(compareOrderedHierarchyChannelEntries);

    return channels.map(({ index: _index, order: _order, customOrderIndex: _customOrderIndex, ...channel }) => channel);
}

async function resolveSpaceHierarchyVoiceHints(
    client: MatrixClient,
    spaceRoom: Room,
    hierarchyRooms: HierarchyRoom[],
): Promise<{
    childOrderOverride?: Map<string, SpaceChildOrder>;
    customOrderOverride?: string[];
    voiceHintRoomIds: Set<string>;
}> {
    let childOrderOverride: Map<string, SpaceChildOrder> | undefined;
    let customOrderOverride: string[] | undefined;
    const voiceHintRoomIds = new Set<string>();
    const hierarchyChannelRoomIds = hierarchyRooms
        .filter((room) => room.room_id !== spaceRoom.roomId)
        .filter((room) => room.room_type !== "m.space")
        .map((room) => room.room_id);

    try {
        const remoteStateEvents = await client.roomState(spaceRoom.roomId);
        childOrderOverride = readSpaceChildOrderFromStateSnapshot(remoteStateEvents as SpaceChildStateSnapshotEvent[]);
        const remoteChannelOrder = readChannelOrderFromStateSnapshot(remoteStateEvents as SpaceChildStateSnapshotEvent[]);
        if (remoteChannelOrder.length > 0) {
            customOrderOverride = remoteChannelOrder;
        }
        for (const [roomId, metadata] of childOrderOverride.entries()) {
            if (metadata.isVoiceChannel) {
                voiceHintRoomIds.add(roomId);
            }
        }
    } catch {
        childOrderOverride = undefined;
        customOrderOverride = undefined;
    }

    for (const roomId of hierarchyChannelRoomIds) {
        const room = client.getRoom(roomId);
        if (isVoiceChannelRoom(room)) {
            voiceHintRoomIds.add(roomId);
        }
    }

    const unresolvedVoiceCandidates = hierarchyChannelRoomIds.filter((roomId) => !voiceHintRoomIds.has(roomId));
    await Promise.all(
        unresolvedVoiceCandidates.map(async (roomId) => {
            try {
                const roomState = await client.roomState(roomId);
                if (isVoiceChannelFromStateSnapshot(roomState as SpaceChildStateSnapshotEvent[])) {
                    voiceHintRoomIds.add(roomId);
                }
            } catch {
                // Room state can be inaccessible for non-members/invites; keep best-effort hints.
            }
        }),
    );

    return { childOrderOverride, customOrderOverride, voiceHintRoomIds };
}

function findParentSpaceIdForRoom(roomId: string, spaces: Room[]): string | null {
    for (const space of spaces) {
        const children = readSpaceChildOrder(space);
        if (children.has(roomId)) {
            return space.roomId;
        }
    }

    return null;
}

async function copyText(value: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const node = document.createElement("textarea");
    node.value = value;
    node.setAttribute("readonly", "true");
    node.style.position = "fixed";
    node.style.opacity = "0";
    document.body.appendChild(node);
    node.select();
    document.execCommand("copy");
    document.body.removeChild(node);
}

export function AppShell({ client, onLogout }: AppShellProps): React.ReactElement {
    const [voiceDiscoveryReady, setVoiceDiscoveryReady] = useState(false);
    const [rooms, setRooms] = useState<Room[]>(() => [...client.getRooms()]);
    const [selectedSpaceId, setSelectedSpaceId] = useState<string>(PEOPLE_SPACE_ID);
    const [activeRoomId, setActiveRoomId] = useState<string | null>(() => {
        const directRoomIds = getDirectRoomIds(client);
        const firstRoom = sortRoomsByActivity(
            client
                .getRooms()
                .filter((room) => !room.isSpaceRoom())
                .filter((room) => directRoomIds.has(room.roomId))
                .filter(isVisibleMembership),
        )[0];
        return firstRoom?.roomId ?? null;
    });
    const [replyToEvent, setReplyToEvent] = useState<MatrixEvent | null>(null);
    const [editingEvent, setEditingEvent] = useState<MatrixEvent | null>(null);
    const [renderReactionImages, setRenderReactionImages] = useState<boolean>(() => getFeatureRenderReactionImages());
    const [emojiUploadOpen, setEmojiUploadOpen] = useState(false);
    const [emojiUploadTarget, setEmojiUploadTarget] = useState<EmojiPackTarget | null>(null);
    const [createDirectChatOpen, setCreateDirectChatOpen] = useState(false);
    const [createRoomOpen, setCreateRoomOpen] = useState(false);
    const [createRoomParentSpaceId, setCreateRoomParentSpaceId] = useState<string | null>(null);
    const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
    const [importJsonOpen, setImportJsonOpen] = useState(false);
    const [spaceOnboardingSpaceId, setSpaceOnboardingSpaceId] = useState<string | null>(null);
    const [joinRoomOpen, setJoinRoomOpen] = useState(false);
    const [inviteOpen, setInviteOpen] = useState(false);
    const [inviteTargetRoomId, setInviteTargetRoomId] = useState<string | null>(null);
    const [roomSettingsRoomId, setRoomSettingsRoomId] = useState<string | null>(null);
    const [roomModerationOpen, setRoomModerationOpen] = useState(false);
    const [rightSidebarMode, setRightSidebarMode] = useState<RightSidebarMode>(() => readStoredRightSidebarMode());
    const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
    const [selectedSpaceHierarchyJoinedRoomIds, setSelectedSpaceHierarchyJoinedRoomIds] = useState<string[]>([]);
    const [discoverableSpaceChannels, setDiscoverableSpaceChannels] = useState<DiscoverableSpaceChannel[]>([]);
    const [refreshedVoiceChannelHintsBySpaceId, setRefreshedVoiceChannelHintsBySpaceId] = useState<
        Map<string, Set<string>>
    >(new Map());
    const [joiningDiscoverableRoomId, setJoiningDiscoverableRoomId] = useState<string | null>(null);
    const [settingsState, setSettingsState] = useState<SettingsState | null>(null);
    const [pendingFocusRoomId, setPendingFocusRoomId] = useState<string | null>(null);
    const [userSettings, setUserSettings] = useState<UserLocalSettings>(() => loadUserLocalSettings());
    const [toast, setToast] = useState<ToastState | null>(null);
    const [voiceSessionRoomId, setVoiceSessionRoomId] = useState<string | null>(null);
    const [voiceSessionStatus, setVoiceSessionStatus] = useState<VoiceSessionStatus>("disconnected");
    const [voiceAutoJoinNonce, setVoiceAutoJoinNonce] = useState(0);
    const [voiceControlState, setVoiceControlState] = useState<VoiceControlState>(DEFAULT_VOICE_CONTROL_STATE);
    const [voiceSpeakingByRoomId, setVoiceSpeakingByRoomId] = useState<Map<string, Set<string>>>(new Map());
    const [voiceScreenShareByRoomId, setVoiceScreenShareByRoomId] = useState<Map<string, Set<string>>>(new Map());
    const [voiceParticipantsByRoomId, setVoiceParticipantsByRoomId] = useState<Map<string, Set<string>>>(new Map());
    const [timelineFocusBottomNonce, setTimelineFocusBottomNonce] = useState(0);
    const voiceRoomRef = useRef<VoiceRoomHandle | null>(null);
    const openRoomAtBottom = useCallback((roomId: string): void => {
        setActiveRoomId(roomId);
        setTimelineFocusBottomNonce((value) => value + 1);
    }, []);

    const handleLiveParticipantsChange = useCallback(
        ({
            roomId,
            participants,
        }: {
            roomId: string;
            participants: Array<{ identity: string; userId?: string; isSpeaking: boolean; isScreenSharing: boolean }>;
        }): void => {
            const normalizeParticipantId = (participant: { identity: string; userId?: string }): string =>
                participant.userId ?? participant.identity;

            const participantUserIds = new Set(participants.map((participant) => normalizeParticipantId(participant)));
            const speakingUserIds = new Set(
                participants
                    .filter((participant) => participant.isSpeaking)
                    .map((participant) => normalizeParticipantId(participant)),
            );
            const sharingUserIds = new Set(
                participants
                    .filter((participant) => participant.isScreenSharing)
                    .map((participant) => normalizeParticipantId(participant)),
            );

            setVoiceParticipantsByRoomId((current) => {
                const next = new Map(current);
                next.set(roomId, participantUserIds);
                return next;
            });
            setVoiceSpeakingByRoomId((current) => updateRoomIdentitySetMap(current, roomId, speakingUserIds));
            setVoiceScreenShareByRoomId((current) => updateRoomIdentitySetMap(current, roomId, sharingUserIds));
        },
        [],
    );

    useEffect(() => {
        setVoiceDiscoveryReady(false);
        const homeserverUrl =
            (client as MatrixClient & {
                getHomeserverUrl?: () => string;
            }).getHomeserverUrl?.() ?? client.baseUrl;
        void initVoiceDiscovery(homeserverUrl).then(() => setVoiceDiscoveryReady(true));
        return () => {
            clearVoiceDiscovery();
        };
    }, [client]);

    useEffect(() => {
        const watchedRooms = new Set<Room>();

        const onRoomsChanged = (): void => {
            syncRoomListeners();
            setRooms([...client.getRooms()]);
        };

        const attachRoomListeners = (room: Room): void => {
            if (watchedRooms.has(room)) {
                return;
            }

            watchedRooms.add(room);
            room.on(RoomEvent.UnreadNotifications, onRoomsChanged);
            room.on(RoomEvent.Receipt, onRoomsChanged);
            room.currentState.on(RoomStateEvent.Events, onRoomsChanged);
        };

        const detachRoomListeners = (room: Room): void => {
            if (!watchedRooms.has(room)) {
                return;
            }

            room.removeListener(RoomEvent.UnreadNotifications, onRoomsChanged);
            room.removeListener(RoomEvent.Receipt, onRoomsChanged);
            room.currentState.removeListener(RoomStateEvent.Events, onRoomsChanged);
            watchedRooms.delete(room);
        };

        const syncRoomListeners = (): void => {
            const nextRooms = new Set(client.getRooms());

            for (const room of nextRooms) {
                attachRoomListeners(room);
            }

            for (const room of [...watchedRooms]) {
                if (!nextRooms.has(room)) {
                    detachRoomListeners(room);
                }
            }
        };

        client.on(ClientEvent.Room, onRoomsChanged);
        client.on(ClientEvent.Sync, onRoomsChanged);
        client.on(ClientEvent.AccountData, onRoomsChanged);
        client.on(RoomEvent.Timeline, onRoomsChanged);
        client.on(MatrixEventEvent.Decrypted, onRoomsChanged);

        onRoomsChanged();

        return () => {
            client.removeListener(ClientEvent.Room, onRoomsChanged);
            client.removeListener(ClientEvent.Sync, onRoomsChanged);
            client.removeListener(ClientEvent.AccountData, onRoomsChanged);
            client.removeListener(RoomEvent.Timeline, onRoomsChanged);
            client.removeListener(MatrixEventEvent.Decrypted, onRoomsChanged);

            for (const room of [...watchedRooms]) {
                detachRoomListeners(room);
            }
        };
    }, [client]);

    const visibleRooms = useMemo(
        () => rooms.filter(isVisibleMembership),
        [rooms],
    );
    const visibleRoomIdsKey = useMemo(
        () => visibleRooms.map((room) => room.roomId).sort().join("\u0000"),
        [visibleRooms],
    );
    const directRoomIds = useMemo(
        () => getDirectRoomIds(client),
        [client, rooms],
    );
    const roomById = useMemo(
        () => new Map(visibleRooms.map((room) => [room.roomId, room])),
        [visibleRooms],
    );
    const spaces = useMemo(
        () => sortRoomsByName(visibleRooms.filter((room) => room.isSpaceRoom())),
        [visibleRooms],
    );
    const voiceChannelHintRoomIds = useMemo(() => {
        const hints = new Set<string>();
        for (const space of spaces) {
            const childOrder = readSpaceChildOrder(space);
            for (const [roomId, metadata] of childOrder.entries()) {
                if (metadata.isVoiceChannel) {
                    hints.add(roomId);
                }
            }
        }
        for (const voiceHints of refreshedVoiceChannelHintsBySpaceId.values()) {
            for (const roomId of voiceHints) {
                hints.add(roomId);
            }
        }
        return hints;
    }, [refreshedVoiceChannelHintsBySpaceId, spaces]);
    const peopleChannels = useMemo(
        () =>
            sortRoomsByActivity(
                visibleRooms.filter((room) => !room.isSpaceRoom() && directRoomIds.has(room.roomId)),
            ),
        [directRoomIds, visibleRooms],
    );
    const isRoomVoiceChannel = useCallback(
        (room: Room | null): boolean => Boolean(room && (isVoiceChannelRoom(room) || voiceChannelHintRoomIds.has(room.roomId))),
        [voiceChannelHintRoomIds],
    );
    const selectedSpaceRoom = useMemo(
        () =>
            selectedSpaceId === PEOPLE_SPACE_ID
                ? null
                : roomById.get(selectedSpaceId) ?? null,
        [roomById, selectedSpaceId],
    );

    const channels = useMemo(() => {
        if (selectedSpaceId === PEOPLE_SPACE_ID) {
            return peopleChannels;
        }

        if (!selectedSpaceRoom || !selectedSpaceRoom.isSpaceRoom()) {
            return [];
        }

        if (selectedSpaceHierarchyJoinedRoomIds.length > 0) {
            const hierarchyRooms = selectedSpaceHierarchyJoinedRoomIds
                .map((roomId) => roomById.get(roomId))
                .filter((room): room is Room => Boolean(room && !room.isSpaceRoom() && isVisibleMembership(room)));
            if (hierarchyRooms.length > 0) {
                return sortRoomsBySpaceOrder(selectedSpaceRoom, hierarchyRooms);
            }
        }

        return getSpaceChannels(selectedSpaceRoom, roomById);
    }, [peopleChannels, roomById, selectedSpaceHierarchyJoinedRoomIds, selectedSpaceId, selectedSpaceRoom]);

    useEffect(() => {
        if (selectedSpaceId === PEOPLE_SPACE_ID || !selectedSpaceRoom?.isSpaceRoom()) {
            setSelectedSpaceHierarchyJoinedRoomIds([]);
            setDiscoverableSpaceChannels([]);
            setJoiningDiscoverableRoomId(null);
            return;
        }

        let cancelled = false;
        const currentSpaceRoom = selectedSpaceRoom;
        const visibleRoomIds = new Set(
            visibleRoomIdsKey.length > 0 ? visibleRoomIdsKey.split("\u0000") : [],
        );
        const loadPublicChannels = async (): Promise<void> => {
            try {
                const hierarchyRooms = await getSpaceHierarchyRooms(client, currentSpaceRoom.roomId);
                if (cancelled) {
                    return;
                }
                const { childOrderOverride, customOrderOverride, voiceHintRoomIds } = await resolveSpaceHierarchyVoiceHints(
                    client,
                    currentSpaceRoom,
                    hierarchyRooms,
                );
                if (cancelled) {
                    return;
                }
                setRefreshedVoiceChannelHintsBySpaceId((current) => {
                    const currentHints = current.get(currentSpaceRoom.roomId);
                    if (voiceHintRoomIds.size === 0) {
                        if (!currentHints) {
                            return current;
                        }
                        const next = new Map(current);
                        next.delete(currentSpaceRoom.roomId);
                        return next;
                    }
                    if (areStringSetsEqual(currentHints, voiceHintRoomIds)) {
                        return current;
                    }
                    const next = new Map(current);
                    next.set(currentSpaceRoom.roomId, voiceHintRoomIds);
                    return next;
                });
                setSelectedSpaceHierarchyJoinedRoomIds(
                    buildJoinedHierarchyChannelIds(currentSpaceRoom, hierarchyRooms, visibleRoomIds, childOrderOverride, customOrderOverride),
                );
                const channelsToJoin = buildDiscoverableSpaceChannels(
                    currentSpaceRoom,
                    hierarchyRooms,
                    visibleRoomIds,
                    childOrderOverride,
                    customOrderOverride,
                    voiceHintRoomIds,
                );
                setDiscoverableSpaceChannels(channelsToJoin);

                const successfullyJoinedIds: string[] = [];
                for (const channel of channelsToJoin) {
                    if (cancelled) {
                        return;
                    }

                    const viaServers = channel.viaServers?.filter((v) => v.length > 0) ?? [];
                    try {
                        const joinedChannel = await joinRoomWithRetry(client, channel.roomId, { viaServers });
                        const latestJoinedChannel = client.getRoom(channel.roomId) ?? joinedChannel;
                        if (latestJoinedChannel.getMyMembership() === "join") {
                            successfullyJoinedIds.push(channel.roomId);
                        }
                    } catch {
                        // Keep channel in discoverable list when join fails.
                    }
                }
                if (cancelled) return;

                // Immediately update channel list using already-fetched hierarchy data.
                // Don't wait for visibleRoomIdsKey change + another HTTP hierarchy call.
                if (successfullyJoinedIds.length > 0) {
                    const successfulRoomIds = new Set(successfullyJoinedIds);
                    const updatedVisibleRoomIds = new Set([...visibleRoomIds, ...successfullyJoinedIds]);
                    setSelectedSpaceHierarchyJoinedRoomIds(
                        buildJoinedHierarchyChannelIds(currentSpaceRoom, hierarchyRooms, updatedVisibleRoomIds, childOrderOverride, customOrderOverride),
                    );
                    setDiscoverableSpaceChannels((current) =>
                        current.filter((channel) => !successfulRoomIds.has(channel.roomId)),
                    );
                }
            } catch {
                if (!cancelled) {
                    setSelectedSpaceHierarchyJoinedRoomIds([]);
                    setDiscoverableSpaceChannels([]);
                    setRefreshedVoiceChannelHintsBySpaceId((current) => {
                        if (!current.has(currentSpaceRoom.roomId)) {
                            return current;
                        }
                        const next = new Map(current);
                        next.delete(currentSpaceRoom.roomId);
                        return next;
                    });
                }
            }
        };

        void loadPublicChannels();

        return () => {
            cancelled = true;
        };
    }, [client, selectedSpaceId, selectedSpaceRoom, visibleRoomIdsKey]);

    const showSpaceOnboarding =
        Boolean(spaceOnboardingSpaceId) &&
        selectedSpaceId === spaceOnboardingSpaceId &&
        Boolean(selectedSpaceRoom) &&
        channels.length === 0 &&
        discoverableSpaceChannels.length === 0;

    useEffect(() => {
        if (selectedSpaceId === PEOPLE_SPACE_ID) {
            return;
        }

        if (!spaces.some((space) => space.roomId === selectedSpaceId)) {
            setSelectedSpaceId(PEOPLE_SPACE_ID);
        }
    }, [selectedSpaceId, spaces]);

    useEffect(() => {
        const visibleSpaceIds = new Set(spaces.map((space) => space.roomId));
        setRefreshedVoiceChannelHintsBySpaceId((current) => {
            let changed = false;
            const next = new Map<string, Set<string>>();

            for (const [spaceId, roomIds] of current.entries()) {
                if (!visibleSpaceIds.has(spaceId)) {
                    changed = true;
                    continue;
                }
                next.set(spaceId, roomIds);
            }

            return changed ? next : current;
        });
    }, [spaces]);

    useEffect(() => {
        if (pendingFocusRoomId) {
            if (channels.some((room) => room.roomId === pendingFocusRoomId)) {
                openRoomAtBottom(pendingFocusRoomId);
                setPendingFocusRoomId(null);
            }
            return;
        }

        if (channels.length === 0) {
            setActiveRoomId(null);
            return;
        }

        if (!activeRoomId || !channels.some((room) => room.roomId === activeRoomId)) {
            openRoomAtBottom(channels[0].roomId);
        }
    }, [activeRoomId, channels, openRoomAtBottom, pendingFocusRoomId]);

    useEffect(() => {
        setReplyToEvent(null);
        setEditingEvent(null);
    }, [activeRoomId]);

    useEffect(() => {
        setSidebarSearchQuery("");
    }, [activeRoomId]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        window.localStorage.setItem(RIGHT_SIDEBAR_MODE_STORAGE_KEY, rightSidebarMode);
    }, [rightSidebarMode]);

    const activeRoom = useMemo(
        () => (activeRoomId ? roomById.get(activeRoomId) ?? null : null),
        [activeRoomId, roomById],
    );
    const roomSettingsRoom = useMemo(
        () => (roomSettingsRoomId ? client.getRoom(roomSettingsRoomId) ?? null : null),
        [client, roomSettingsRoomId],
    );
    const inviteTargetRoom = useMemo(
        () => (inviteTargetRoomId ? roomById.get(inviteTargetRoomId) ?? client.getRoom(inviteTargetRoomId) ?? null : activeRoom),
        [activeRoom, client, inviteTargetRoomId, roomById],
    );
    const { panelMode, selectUser, clearSelectedUser } = useSelectedUser(activeRoom?.roomId ?? null);
    const ownUserId = client.getUserId() ?? "";
    const canInviteInActiveRoom = Boolean(activeRoom && ownUserId && activeRoom.canInvite(ownUserId));
    const ownUser = ownUserId ? client.getUser(ownUserId) : null;
    const ownDisplayName = ownUser?.displayName || ownUserId || "User";
    const ownAvatarMxc = ownUser?.avatarUrl || "";
    const ownAvatarSources = useMemo(
        () =>
            Array.from(
                new Set(
                    [
                        thumbnailFromMxc(client, ownAvatarMxc, 64, 64, "crop"),
                        mediaFromMxc(client, ownAvatarMxc),
                    ].filter((url): url is string => Boolean(url)),
                ),
            ),
        [client, ownAvatarMxc],
    );
    const selectedSpaceName =
        selectedSpaceId === PEOPLE_SPACE_ID
              ? "People"
              : selectedSpaceRoom
                ? getRoomName(selectedSpaceRoom)
                : "People";
    const isActiveRoomDirect = Boolean(activeRoom && directRoomIds.has(activeRoom.roomId));
    const shouldShowReadReceipts =
        userSettings.privacy.showReadReceipts && selectedSpaceId === PEOPLE_SPACE_ID && isActiveRoomDirect;
    const isActiveRoomVoiceChannel = isRoomVoiceChannel(activeRoom);
    const shouldShowVoicePanel = Boolean(activeRoom && isActiveRoomVoiceChannel && voiceSessionRoomId === activeRoom.roomId);
    const shouldPrefixRoomWithHash = selectedSpaceId !== PEOPLE_SPACE_ID;
    const activeVoiceSessionRoom = useMemo(
        () => (voiceSessionRoomId ? roomById.get(voiceSessionRoomId) ?? client.getRoom(voiceSessionRoomId) ?? null : null),
        [client, roomById, voiceSessionRoomId],
    );
    const hasActiveVoiceSession = Boolean(
        voiceSessionRoomId && (voiceSessionStatus === "connected" || voiceSessionStatus === "joining"),
    );
    const liveVoiceParticipantsOverrideRoomId =
        voiceSessionRoomId && (voiceSessionStatus === "connected" || voiceSessionStatus === "joining")
            ? voiceSessionRoomId
            : null;
    useEffect(() => {
        setFeatureRenderReactionImages(renderReactionImages);
    }, [renderReactionImages]);

    useEffect(() => {
        saveUserLocalSettings(userSettings);
        applyAppearanceTheme(userSettings.appearance);
    }, [userSettings]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const bridge = window.heorotDesktop;
        if (!bridge?.setCloseOnWindowCloseMinimize) {
            return;
        }

        void bridge.setCloseOnWindowCloseMinimize(userSettings.appearance.closeOnWindowCloseMinimize);
    }, [userSettings.appearance.closeOnWindowCloseMinimize]);

    useEffect(() => {
        if (isRoomVoiceChannel(activeRoom) && !voiceSessionRoomId && activeRoom) {
            setVoiceSessionRoomId(activeRoom.roomId);
        }
    }, [activeRoom, isRoomVoiceChannel, voiceSessionRoomId]);

    useEffect(() => {
        if (!voiceSessionRoomId) {
            return;
        }
        if (roomById.has(voiceSessionRoomId)) {
            return;
        }
        setVoiceSessionRoomId(null);
        setVoiceSessionStatus("disconnected");
    }, [roomById, voiceSessionRoomId]);

    useEffect(() => {
        if (voiceSessionRoomId) {
            return;
        }
        setVoiceControlState(DEFAULT_VOICE_CONTROL_STATE);
    }, [voiceSessionRoomId]);

    useEffect(() => {
        if (!settingsState || settingsState.mode !== "server") {
            return;
        }

        if (selectedSpaceId === PEOPLE_SPACE_ID || !selectedSpaceRoom) {
            setSettingsState(null);
        }
    }, [selectedSpaceId, selectedSpaceRoom, settingsState]);

    const pushToast = useCallback((nextToast: Omit<ToastState, "id">): void => {
        setToast({
            id: Date.now(),
            ...nextToast,
        });
    }, []);

    const copyActiveRoomLink = useCallback(async (): Promise<void> => {
        if (!activeRoom) {
            return;
        }

        try {
            await copyText(buildMatrixToRoomPermalink(activeRoom.roomId));
            pushToast({ type: "success", message: "Room link copied." });
        } catch (copyError) {
            const message = copyError instanceof Error ? copyError.message : "Failed to copy room link.";
            pushToast({ type: "error", message });
        }
    }, [activeRoom, pushToast]);

    const reloadSpaceChannelsFromServer = useCallback(
        async (spaceId: string): Promise<void> => {
            const targetSpace = client.getRoom(spaceId);
            if (!targetSpace || !targetSpace.isSpaceRoom()) {
                pushToast({ type: "error", message: "Unable to reload channels: selected server is unavailable." });
                return;
            }

            try {
                let hierarchySpaceRoom = targetSpace;
                if (hierarchySpaceRoom.getMyMembership() !== "join") {
                    const fallbackViaServers = getViaServersForParentSpace(client, hierarchySpaceRoom.roomId);
                    try {
                        await joinRoomWithRetry(client, hierarchySpaceRoom.roomId, {
                            viaServers: fallbackViaServers,
                            maxAttempts: 1,
                        });
                    } catch {
                        // Best-effort join for users invited only to a child channel.
                    }

                    const refreshedSpaceRoom = client.getRoom(hierarchySpaceRoom.roomId);
                    if (refreshedSpaceRoom?.isSpaceRoom()) {
                        hierarchySpaceRoom = refreshedSpaceRoom;
                    }
                }

                if (hierarchySpaceRoom.getMyMembership() !== "join") {
                    setSelectedSpaceHierarchyJoinedRoomIds([]);
                    setDiscoverableSpaceChannels([]);
                    setJoiningDiscoverableRoomId(null);
                    setRooms([...client.getRooms()]);
                    pushToast({
                        type: "error",
                        message: "Can't load server hierarchy because you're not joined to the server room.",
                    });
                    return;
                }

                const hierarchyRooms = await getSpaceHierarchyRooms(client, hierarchySpaceRoom.roomId);
                const { childOrderOverride, voiceHintRoomIds: refreshedVoiceHints } = await resolveSpaceHierarchyVoiceHints(
                    client,
                    hierarchySpaceRoom,
                    hierarchyRooms,
                );

                setRefreshedVoiceChannelHintsBySpaceId((current) => {
                    const currentHints = current.get(spaceId);
                    if (refreshedVoiceHints.size === 0) {
                        if (!currentHints) {
                            return current;
                        }
                        const next = new Map(current);
                        next.delete(spaceId);
                        return next;
                    }
                    if (areStringSetsEqual(currentHints, refreshedVoiceHints)) {
                        return current;
                    }
                    const next = new Map(current);
                    next.set(spaceId, refreshedVoiceHints);
                    return next;
                });

                const hierarchyChannelRoomIds = hierarchyRooms
                    .filter((room) => room.room_id !== hierarchySpaceRoom.roomId)
                    .filter((room) => room.room_type !== "m.space")
                    .map((room) => room.room_id);
                const allHierarchyChannelIds = new Set(hierarchyChannelRoomIds);
                const latestVisibleRoomIds = new Set(
                    client
                        .getRooms()
                        .filter(isVisibleMembership)
                        .map((room) => room.roomId),
                );
                const hierarchyOrderForSpace = buildJoinedHierarchyChannelIds(
                    hierarchySpaceRoom,
                    hierarchyRooms,
                    allHierarchyChannelIds,
                    childOrderOverride,
                    [],
                );
                const joinedHierarchyOrder = hierarchyOrderForSpace.filter((roomId) => latestVisibleRoomIds.has(roomId));

                const ownUserId = client.getUserId() ?? "";
                const canPersistHierarchyOrder =
                    ownUserId.length > 0 && hierarchySpaceRoom.currentState.maySendStateEvent(CHANNEL_ORDER_STATE_EVENT, ownUserId);
                if (canPersistHierarchyOrder) {
                    const currentOrder = readChannelOrder(hierarchySpaceRoom);
                    const seenHierarchyIds = new Set(hierarchyOrderForSpace);
                    const mergedOrder = [
                        ...hierarchyOrderForSpace,
                        ...currentOrder.filter((roomId) => !seenHierarchyIds.has(roomId)),
                    ];
                    if (!areStringArraysEqual(currentOrder, mergedOrder)) {
                        await writeChannelOrder(client, hierarchySpaceRoom.roomId, mergedOrder);
                    }
                }

                setSelectedSpaceHierarchyJoinedRoomIds(joinedHierarchyOrder);
                setDiscoverableSpaceChannels(
                    buildDiscoverableSpaceChannels(
                        hierarchySpaceRoom,
                        hierarchyRooms,
                        latestVisibleRoomIds,
                        childOrderOverride,
                        hierarchyOrderForSpace,
                        refreshedVoiceHints,
                    ),
                );
                setJoiningDiscoverableRoomId(null);
                setRooms([...client.getRooms()]);
                pushToast({ type: "success", message: "Channels reloaded from server hierarchy." });
            } catch (reloadError) {
                const message = reloadError instanceof Error ? reloadError.message : "Failed to reload channels.";
                pushToast({ type: "error", message });
            }
        },
        [client, pushToast],
    );

    const runVoiceRoomAction = useCallback(
        (action: (voiceRoom: VoiceRoomHandle) => Promise<void>, fallbackMessage: string): void => {
            const voiceRoom = voiceRoomRef.current;
            if (!voiceRoom) {
                return;
            }

            void action(voiceRoom).catch((voiceActionError) => {
                const message = voiceActionError instanceof Error ? voiceActionError.message : fallbackMessage;
                pushToast({ type: "error", message });
            });
        },
        [pushToast],
    );

    const joinVoiceFromDock = useCallback((): void => {
        if (!voiceSessionRoomId || voiceSessionStatus !== "disconnected") {
            return;
        }

        runVoiceRoomAction((voiceRoom) => voiceRoom.join(), "Unable to join voice channel.");
    }, [runVoiceRoomAction, voiceSessionRoomId, voiceSessionStatus]);

    const leaveVoiceFromDock = useCallback((): void => {
        if (!voiceSessionRoomId || voiceSessionStatus === "disconnected") {
            return;
        }

        runVoiceRoomAction((voiceRoom) => voiceRoom.leave(), "Unable to leave voice channel.");
    }, [runVoiceRoomAction, voiceSessionRoomId, voiceSessionStatus]);

    const toggleVoiceMicFromDock = useCallback((): void => {
        if (!voiceSessionRoomId || voiceSessionStatus !== "connected") {
            return;
        }

        runVoiceRoomAction((voiceRoom) => voiceRoom.toggleMute(), "Unable to update microphone state.");
    }, [runVoiceRoomAction, voiceSessionRoomId, voiceSessionStatus]);

    const toggleVoiceAudioFromDock = useCallback((): void => {
        if (!voiceSessionRoomId || voiceSessionStatus !== "connected") {
            return;
        }

        runVoiceRoomAction((voiceRoom) => voiceRoom.toggleAudioMute(), "Unable to update audio output state.");
    }, [runVoiceRoomAction, voiceSessionRoomId, voiceSessionStatus]);

    const selectSidebarMode = useCallback(
        (mode: RightSidebarMode): void => {
            clearSelectedUser();
            setRightSidebarMode(mode);
        },
        [clearSelectedUser],
    );

    const selectChannel = useCallback(
        (roomId: string): void => {
            openRoomAtBottom(roomId);
            const room = roomById.get(roomId) ?? client.getRoom(roomId);
            if (!room || !isRoomVoiceChannel(room)) {
                return;
            }

            const sameVoiceSessionRoom = voiceSessionRoomId === roomId;
            if (sameVoiceSessionRoom && (voiceSessionStatus === "connected" || voiceSessionStatus === "joining")) {
                return;
            }

            setVoiceSessionRoomId(roomId);
            setVoiceSessionStatus("joining");
            setVoiceAutoJoinNonce((value) => value + 1);
        },
        [client, isRoomVoiceChannel, openRoomAtBottom, roomById, voiceSessionRoomId, voiceSessionStatus],
    );

    const focusRoom = useCallback(
        (roomId: string): void => {
            const room = client.getRoom(roomId);
            if (!room) {
                setPendingFocusRoomId(roomId);
                setSelectedSpaceId(PEOPLE_SPACE_ID);
                return;
            }

            if (room.isSpaceRoom()) {
                setSelectedSpaceId(room.roomId);
                setActiveRoomId(null);
                setPendingFocusRoomId(null);
                return;
            }

            if (directRoomIds.has(roomId)) {
                setSelectedSpaceId(PEOPLE_SPACE_ID);
            } else {
                const parentSpaceId = findParentSpaceIdForRoom(roomId, spaces);
                if (parentSpaceId) {
                    setSelectedSpaceId(parentSpaceId);
                } else {
                    setSelectedSpaceId(PEOPLE_SPACE_ID);
                }
            }

            openRoomAtBottom(roomId);
            setPendingFocusRoomId(null);
        },
        [client, directRoomIds, openRoomAtBottom, spaces],
    );

    const requestJoinRoom = useCallback(
        async (target: string, options?: { viaServers?: string[]; preferredSpaceId?: string | null }): Promise<string> => {
            const joinedRoom = await joinRoomWithRetry(client, target, { viaServers: options?.viaServers });

            if (joinedRoom.isSpaceRoom()) {
                setSelectedSpaceId(joinedRoom.roomId);
                setActiveRoomId(null);
                setPendingFocusRoomId(null);
                setRooms([...client.getRooms()]);
                return joinedRoom.roomId;
            }

            let joinedParentSpaceId: string | null = null;
            if (!directRoomIds.has(joinedRoom.roomId)) {
                joinedParentSpaceId = await ensureRoomParentSpacesJoined(client, joinedRoom, options?.preferredSpaceId ?? null);
            }
            setRooms([...client.getRooms()]);

            if (directRoomIds.has(joinedRoom.roomId)) {
                setSelectedSpaceId(PEOPLE_SPACE_ID);
            } else {
                const parentSpaceId =
                    joinedParentSpaceId ??
                    findParentSpaceIdForRoom(joinedRoom.roomId, spaces) ??
                    options?.preferredSpaceId ??
                    null;
                if (parentSpaceId) {
                    setSelectedSpaceId(parentSpaceId);
                } else {
                    setSelectedSpaceId(PEOPLE_SPACE_ID);
                }
            }

            openRoomAtBottom(joinedRoom.roomId);
            setPendingFocusRoomId(null);

            if (options?.preferredSpaceId && options.preferredSpaceId === selectedSpaceId) {
                setSelectedSpaceHierarchyJoinedRoomIds((current) =>
                    current.includes(joinedRoom.roomId) ? current : [...current, joinedRoom.roomId],
                );
                setDiscoverableSpaceChannels((current) =>
                    current.filter((channel) => channel.roomId !== joinedRoom.roomId),
                );
            }

            return joinedRoom.roomId;
        },
        [client, directRoomIds, openRoomAtBottom, selectedSpaceId, spaces],
    );

    const joinDiscoverableSpaceChannel = useCallback(
        async (roomId: string): Promise<void> => {
            if (joiningDiscoverableRoomId) {
                return;
            }

            const targetChannel = discoverableSpaceChannels.find((channel) => channel.roomId === roomId);
            if (!targetChannel) {
                return;
            }

            setJoiningDiscoverableRoomId(roomId);
            try {
                const viaServers = targetChannel.viaServers?.filter((via) => via.length > 0) ?? [];
                await requestJoinRoom(roomId, {
                    viaServers,
                    preferredSpaceId: selectedSpaceId === PEOPLE_SPACE_ID ? null : selectedSpaceId,
                });
                pushToast({ type: "success", message: "Joined channel." });
            } catch (joinError) {
                pushToast({ type: "error", message: describeJoinError(joinError, roomId) });
            } finally {
                setJoiningDiscoverableRoomId(null);
            }
        },
        [discoverableSpaceChannels, joiningDiscoverableRoomId, pushToast, requestJoinRoom, selectedSpaceId],
    );

    useEffect(() => {
        if (!pendingFocusRoomId) {
            return;
        }

        const room = client.getRoom(pendingFocusRoomId);
        if (!room || room.isSpaceRoom()) {
            return;
        }

        if (directRoomIds.has(pendingFocusRoomId)) {
            setSelectedSpaceId(PEOPLE_SPACE_ID);
        } else {
            const parentSpaceId = findParentSpaceIdForRoom(pendingFocusRoomId, spaces);
            if (parentSpaceId) {
                setSelectedSpaceId(parentSpaceId);
            } else {
                setSelectedSpaceId(PEOPLE_SPACE_ID);
            }
        }

        openRoomAtBottom(pendingFocusRoomId);
        setPendingFocusRoomId(null);
    }, [client, directRoomIds, openRoomAtBottom, pendingFocusRoomId, spaces]);

    const leaveActiveRoom = useCallback(async (): Promise<void> => {
        if (!activeRoom) {
            return;
        }

        const roomLabel = getRoomName(activeRoom);
        if (!window.confirm(`Leave "${roomLabel}"?`)) {
            return;
        }

        try {
            await client.leave(activeRoom.roomId);
            setReplyToEvent(null);
            setEditingEvent(null);
            setInviteOpen(false);
            setRoomSettingsRoomId(null);
            setRoomModerationOpen(false);
            pushToast({ type: "success", message: `Left ${roomLabel}.` });
        } catch (leaveError) {
            const message = leaveError instanceof Error ? leaveError.message : "Failed to leave room.";
            pushToast({ type: "error", message });
        }
    }, [activeRoom, client, pushToast]);

    const openRoomSettingsFor = useCallback(
        (roomId: string | null): void => {
            if (!roomId) {
                return;
            }

            setRoomSettingsRoomId(roomId);
        },
        [],
    );

    const openUserSettings = useCallback((tab = "my-account"): void => {
        setSettingsState({
            mode: "user",
            tab,
        });
    }, []);

    const openServerSettings = useCallback((tab = "overview"): void => {
        if (!selectedSpaceRoom) {
            return;
        }

        setSettingsState({
            mode: "server",
            tab,
        });
    }, [selectedSpaceRoom]);

    const openCreateRoomDialog = useCallback((parentSpaceId: string | null): void => {
        setCreateRoomParentSpaceId(parentSpaceId);
        setCreateRoomOpen(true);
    }, []);

    const openInviteDialogFor = useCallback((roomId: string | null): void => {
        if (!roomId) {
            return;
        }
        setInviteTargetRoomId(roomId);
        setInviteOpen(true);
    }, []);

    const shouldRenderRightPanel = panelMode.mode === "user" || rightSidebarMode !== "closed";

    const [channelsPaneWidth, setChannelsPaneWidth] = useState<number>(readChannelsPaneWidth);
    const [isResizingPane, setIsResizingPane] = useState(false);

    const handleResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = channelsPaneWidth;
        setIsResizingPane(true);

        const onMove = (ev: PointerEvent): void => {
            const next = Math.min(CHANNELS_PANE_MAX, Math.max(CHANNELS_PANE_MIN, startWidth + ev.clientX - startX));
            setChannelsPaneWidth(next);
        };
        const onUp = (ev: PointerEvent): void => {
            const final = Math.min(CHANNELS_PANE_MAX, Math.max(CHANNELS_PANE_MIN, startWidth + ev.clientX - startX));
            setChannelsPaneWidth(final);
            try { window.localStorage.setItem(CHANNELS_PANE_WIDTH_KEY, String(Math.round(final))); } catch { /* ignore */ }
            setIsResizingPane(false);
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
        };
        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
    }, [channelsPaneWidth]);

    const appShellStyle = useMemo(() => ({
        gridTemplateColumns: shouldRenderRightPanel
            ? `72px ${channelsPaneWidth}px minmax(0, 1fr) 280px`
            : `72px ${channelsPaneWidth}px minmax(0, 1fr)`,
    }), [channelsPaneWidth, shouldRenderRightPanel]);

    const appShellClassName = useMemo(() => {
        const classes = ["app-shell"];
        if (userSettings.appearance.compactMode) {
            classes.push("is-compact");
        }
        if (!userSettings.appearance.showTimestamps) {
            classes.push("hide-timestamps");
        }
        if (!shouldRenderRightPanel) {
            classes.push("right-panel-collapsed");
        }
        if (isResizingPane) {
            classes.push("is-resizing");
        }
        if (typeof window !== "undefined" && window.heorotDesktop) {
            classes.push("is-desktop-runtime");
            if (window.heorotDesktop.platform === "win32") {
                classes.push("is-desktop-win32");
            }
        }
        return classes.join(" ");
    }, [shouldRenderRightPanel, isResizingPane, userSettings.appearance.compactMode, userSettings.appearance.showTimestamps]);

    const hasOpenDialog = Boolean(
        emojiUploadOpen ||
            createDirectChatOpen ||
            createRoomOpen ||
            createSpaceOpen ||
            importJsonOpen ||
            joinRoomOpen ||
            inviteOpen ||
            roomSettingsRoomId ||
            roomModerationOpen ||
            settingsState,
    );

    useElementLikeNotifications({
        client,
        activeRoomId,
        hasOpenDialog,
        settings: userSettings.notifications,
    });

    return (
        <div className={appShellClassName} style={appShellStyle}>
            <aside className="left-rail">
                <div className="rail-logo">H</div>
                <button
                    type="button"
                    className={`rail-icon${selectedSpaceId === PEOPLE_SPACE_ID ? " is-active" : ""}`}
                    onClick={() => setSelectedSpaceId(PEOPLE_SPACE_ID)}
                    title="People"
                >
                    @
                </button>
                {spaces.map((space) => {
                    const avatarUrl = thumbnailFromMxc(client, space.getMxcAvatarUrl(), 48, 48);
                    return (
                        <button
                            type="button"
                            key={space.roomId}
                            className={`rail-icon${selectedSpaceId === space.roomId ? " is-active" : ""}`}
                            onClick={() => setSelectedSpaceId(space.roomId)}
                            title={getRoomName(space)}
                        >
                            {avatarUrl ? (
                                <img src={avatarUrl} alt="" className="rail-icon-avatar" />
                            ) : (
                                getSpaceGlyph(getRoomName(space))
                            )}
                        </button>
                    );
                })}
                <button
                    type="button"
                    className="rail-icon rail-create-space"
                    onClick={() => setCreateSpaceOpen(true)}
                    title="Create Space"
                    disabled={client.isGuest()}
                >
                    +
                </button>
            </aside>

            <section className="channels-pane">
                <div className="channels-pane-resize-handle" onPointerDown={handleResizePointerDown} />
                <div className="pane-top pane-top-row">
                    <span>{selectedSpaceName}</span>
                    <div className="pane-top-actions">
                        {selectedSpaceId === PEOPLE_SPACE_ID ? (
                            <button
                                type="button"
                                className="pane-top-action"
                                onClick={() => setCreateDirectChatOpen(true)}
                                title="Start direct chat"
                            >
                                New DM
                            </button>
                        ) : null}
                        {selectedSpaceRoom ? (
                            <button
                                type="button"
                                className="pane-top-action"
                                onClick={() => openServerSettings("overview")}
                                title="Open server settings"
                            >
                                Server
                            </button>
                        ) : null}
                    </div>
                </div>
                {showSpaceOnboarding ? (
                    <div className="space-onboarding-card">
                        <div className="space-onboarding-header">
                            <h3 className="space-onboarding-title">Space is ready</h3>
                            <button
                                type="button"
                                className="space-onboarding-dismiss"
                                aria-label="Dismiss onboarding"
                                onClick={() => setSpaceOnboardingSpaceId(null)}
                            >
                                x
                            </button>
                        </div>
                        <p className="space-onboarding-text">Create your first channel or configure the server.</p>
                        <div className="space-onboarding-actions">
                            <button
                                type="button"
                                className="room-dialog-button room-dialog-button-primary"
                                onClick={() => openCreateRoomDialog(selectedSpaceRoom?.roomId ?? null)}
                            >
                                Create channel
                            </button>
                            <button
                                type="button"
                                className="room-dialog-button room-dialog-button-secondary"
                                onClick={() => openServerSettings("overview")}
                            >
                                Open server settings
                            </button>
                            <button
                                type="button"
                                className="room-dialog-button room-dialog-button-secondary"
                                onClick={() => openInviteDialogFor(selectedSpaceRoom?.roomId ?? null)}
                            >
                                Invite members
                            </button>
                        </div>
                    </div>
                ) : null}
                <RoomList
                    client={client}
                    spaceId={selectedSpaceId}
                    rooms={channels}
                    voiceChannelHintRoomIds={voiceChannelHintRoomIds}
                    voiceDiscoveryReady={voiceDiscoveryReady}
                    showRoomAvatars={selectedSpaceId === PEOPLE_SPACE_ID || userSettings.appearance.showSpaceChannelAvatars}
                    discoverableRooms={selectedSpaceId === PEOPLE_SPACE_ID ? [] : discoverableSpaceChannels}
                    discoverableJoiningRoomId={joiningDiscoverableRoomId}
                    activeRoomId={activeRoomId}
                    orderingMode={selectedSpaceId === PEOPLE_SPACE_ID ? "dynamic" : "manual"}
                    showOrderingControls={selectedSpaceId !== PEOPLE_SPACE_ID}
                    showHashPrefix={selectedSpaceId !== PEOPLE_SPACE_ID}
                    onSelectRoom={selectChannel}
                    onJoinDiscoverableRoom={(roomId) => {
                        void joinDiscoverableSpaceChannel(roomId);
                    }}
                    localVoiceSession={
                        voiceSessionRoomId
                            ? {
                                  roomId: voiceSessionRoomId,
                                  status: voiceSessionStatus,
                                  userId: ownUserId || null,
                                  displayName: ownDisplayName,
                                  avatarMxc: ownAvatarMxc || null,
                                  micMuted: voiceSessionStatus === "connected" ? voiceControlState.micMuted : false,
                                  audioMuted: voiceSessionStatus === "connected" ? voiceControlState.audioMuted : false,
                              }
                            : null
                    }
                    liveSpeakingByRoomId={voiceSpeakingByRoomId}
                    liveScreenShareByRoomId={voiceScreenShareByRoomId}
                    liveParticipantsByRoomId={voiceParticipantsByRoomId}
                    liveParticipantsOverrideRoomId={liveVoiceParticipantsOverrideRoomId}
                    onOpenRoomSettings={openRoomSettingsFor}
                />
                <div className="pane-bottom">
                    {hasActiveVoiceSession && voiceSessionRoomId ? (
                        <div
                            className={`pane-voice-dock${
                                voiceSessionStatus === "connected"
                                    ? " is-connected"
                                    : voiceSessionStatus === "joining"
                                      ? " is-connecting"
                                      : ""
                            }`}
                        >
                            <button
                                type="button"
                                className="pane-voice-pill"
                                onClick={() => openRoomAtBottom(voiceSessionRoomId)}
                                title="Open voice channel"
                            >
                                <span className="pane-voice-pill-title">
                                    Voice: {activeVoiceSessionRoom ? getRoomName(activeVoiceSessionRoom) : "Voice channel"}
                                </span>
                                <span className="pane-voice-pill-subtitle">
                                    {voiceSessionStatus === "joining"
                                        ? "Connecting..."
                                        : voiceSessionStatus === "connected"
                                          ? "Connected"
                                          : "Not connected"}
                                </span>
                            </button>
                            <div className="pane-voice-controls">
                                {voiceSessionStatus === "disconnected" ? (
                                    <button
                                        type="button"
                                        className="pane-voice-control pane-voice-control-join"
                                        onClick={joinVoiceFromDock}
                                    >
                                        Join
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="pane-voice-control pane-voice-control-leave"
                                        onClick={leaveVoiceFromDock}
                                    >
                                        {voiceSessionStatus === "joining" ? "Cancel" : "Leave"}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className={`pane-voice-control${voiceControlState.micMuted ? " is-muted" : ""}`}
                                    onClick={toggleVoiceMicFromDock}
                                    aria-pressed={!voiceControlState.micMuted}
                                    disabled={voiceSessionStatus !== "connected"}
                                >
                                    {voiceControlState.micMuted ? "Unmute mic" : "Mute mic"}
                                </button>
                                <button
                                    type="button"
                                    className={`pane-voice-control${voiceControlState.audioMuted ? " is-muted" : ""}`}
                                    onClick={toggleVoiceAudioFromDock}
                                    aria-pressed={!voiceControlState.audioMuted}
                                    disabled={voiceSessionStatus !== "connected"}
                                >
                                    {voiceControlState.audioMuted ? "Unmute audio" : "Mute audio"}
                                </button>
                            </div>
                            <div className="pane-voice-indicators">
                                <span className={`pane-voice-indicator${voiceControlState.micMuted ? " is-muted" : " is-live"}`}>
                                    Mic {voiceControlState.micMuted ? "muted" : "live"}
                                </span>
                                <span className={`pane-voice-indicator${voiceControlState.audioMuted ? " is-muted" : " is-live"}`}>
                                    Audio {voiceControlState.audioMuted ? "muted" : "live"}
                                </span>
                            </div>
                        </div>
                    ) : null}
                    <button
                        type="button"
                        className="pane-user-card"
                        onClick={() => openUserSettings("my-account")}
                        title="Open user settings"
                    >
                        <Avatar
                            className="pane-user-avatar"
                            name={ownDisplayName}
                            src={ownAvatarSources[0] ?? null}
                            sources={ownAvatarSources}
                            seed={ownUserId || undefined}
                            userId={ownUserId || undefined}
                        />
                        <span className="pane-user-meta">
                            <span className="pane-user-name">{ownDisplayName}</span>
                            <span className="pane-user-id">{ownUserId || "Unknown user"}</span>
                        </span>
                    </button>
                </div>
            </section>

            <section className="main-pane">
                <ChannelHeader
                    room={activeRoom}
                    isDirectMessage={isActiveRoomDirect}
                    showHashPrefix={shouldPrefixRoomWithHash}
                    sidebarMode={rightSidebarMode}
                    searchQuery={sidebarSearchQuery}
                    canInviteInRoom={canInviteInActiveRoom}
                    onSearchQueryChange={setSidebarSearchQuery}
                    onSelectSidebarMode={selectSidebarMode}
                    onOpenDirectChat={() => setCreateDirectChatOpen(true)}
                    onOpenCreateRoom={() =>
                        openCreateRoomDialog(selectedSpaceId === PEOPLE_SPACE_ID ? null : selectedSpaceRoom?.roomId ?? null)
                    }
                    onOpenJoinRoom={() => setJoinRoomOpen(true)}
                    onOpenInviteUsers={() => openInviteDialogFor(activeRoom?.roomId ?? null)}
                    onOpenRoomSettings={() => openRoomSettingsFor(activeRoom?.roomId ?? null)}
                    onOpenModeration={() => setRoomModerationOpen(true)}
                    onCopyRoomLink={copyActiveRoomLink}
                    onLeaveRoom={leaveActiveRoom}
                />
                {hasActiveVoiceSession && voiceSessionRoomId ? (
                    <div
                        className={`main-voice-slot${shouldShowVoicePanel ? "" : " voice-room-hidden"}`}
                        aria-hidden={!shouldShowVoicePanel}
                    >
                        <VoiceRoom
                            ref={voiceRoomRef}
                            client={client}
                            matrixRoomId={voiceSessionRoomId}
                            matrixRoom={
                                activeRoom?.roomId === voiceSessionRoomId ? activeRoom : client.getRoom(voiceSessionRoomId) ?? undefined
                            }
                            audioSettings={userSettings.audio}
                            autoJoinNonce={voiceAutoJoinNonce}
                            onAudioSettingsChange={(audio) =>
                                setUserSettings({
                                    ...userSettings,
                                    audio,
                                })
                            }
                            onSessionStateChange={(state) => {
                                setVoiceSessionRoomId(state.roomId);
                                setVoiceSessionStatus(state.status);
                                if (state.status === "joining") {
                                    setVoiceParticipantsByRoomId((current) => {
                                        const next = new Map(current);
                                        next.set(state.roomId, new Set<string>());
                                        return next;
                                    });
                                }
                            }}
                            onControlsStateChange={setVoiceControlState}
                            onLiveParticipantsChange={handleLiveParticipantsChange}
                        />
                    </div>
                ) : null}
                {!shouldShowVoicePanel ? (
                    <div className="main-chat-stack">
                        <Timeline
                            client={client}
                            room={activeRoom}
                            focusBottomNonce={timelineFocusBottomNonce}
                            replyToEventId={replyToEvent?.getId() ?? null}
                            onReply={(event) => {
                                setEditingEvent(null);
                                setReplyToEvent(event);
                            }}
                            onEdit={(event) => {
                                setReplyToEvent(null);
                                setEditingEvent(event);
                            }}
                            onSelectUser={selectUser}
                            activeSpaceId={selectedSpaceId === PEOPLE_SPACE_ID ? null : selectedSpaceId}
                            customReactionImagesEnabled={renderReactionImages}
                            showReadReceipts={shouldShowReadReceipts}
                        />
                        <div className="main-chat-composer">
                            <Composer
                                client={client}
                                room={activeRoom}
                                activeSpaceId={selectedSpaceId === PEOPLE_SPACE_ID ? null : selectedSpaceId}
                                editingEvent={editingEvent}
                                onCancelEdit={() => setEditingEvent(null)}
                                replyToEvent={replyToEvent}
                                onCancelReply={() => setReplyToEvent(null)}
                            />
                        </div>
                    </div>
                ) : null}
            </section>

            {shouldRenderRightPanel ? (
                <RightPanel
                    client={client}
                    room={activeRoom}
                    activeSpaceRoom={selectedSpaceId === PEOPLE_SPACE_ID ? null : selectedSpaceRoom}
                    mode={panelMode}
                    roomMode={rightSidebarMode}
                    searchQuery={sidebarSearchQuery}
                    onSearchQueryChange={setSidebarSearchQuery}
                    onSelectUser={selectUser}
                    onBackToRoom={clearSelectedUser}
                    onOpenRoomSettings={() => openRoomSettingsFor(activeRoom?.roomId ?? null)}
                    onCopyRoomLink={copyActiveRoomLink}
                    onLeaveRoom={leaveActiveRoom}
                    onOpenRoom={focusRoom}
                    onToast={pushToast}
                />
            ) : null}
            {emojiUploadOpen && emojiUploadTarget ? (
                <EmojiUploadDialog
                    client={client}
                    target={emojiUploadTarget}
                    open={emojiUploadOpen}
                    onClose={() => {
                        setEmojiUploadOpen(false);
                        setEmojiUploadTarget(null);
                    }}
                />
            ) : null}
            <CreateDirectChatDialog
                client={client}
                open={createDirectChatOpen}
                onClose={() => setCreateDirectChatOpen(false)}
                onResolved={({ roomId, created, isGroup, targetCount }) => {
                    setCreateDirectChatOpen(false);
                    focusRoom(roomId);
                    pushToast({
                        type: "success",
                        message: isGroup
                            ? created
                                ? `Group chat created (${targetCount} people).`
                                : "Group chat opened."
                            : created
                                ? "Direct message created."
                                : "Direct message opened.",
                    });
                }}
            />
            <CreateRoomDialog
                client={client}
                open={createRoomOpen}
                spaceParentId={createRoomParentSpaceId}
                onClose={() => {
                    setCreateRoomOpen(false);
                    setCreateRoomParentSpaceId(null);
                }}
                onCreated={(roomId) => {
                    setCreateRoomOpen(false);
                    const createdInSpaceId = createRoomParentSpaceId;
                    setCreateRoomParentSpaceId(null);
                    focusRoom(roomId);
                    if (createdInSpaceId && createdInSpaceId === spaceOnboardingSpaceId) {
                        setSpaceOnboardingSpaceId(null);
                    }
                    pushToast({
                        type: "success",
                        message: createdInSpaceId ? "Channel created in Space." : "Room created.",
                    });
                }}
            />
            <CreateSpaceDialog
                client={client}
                open={createSpaceOpen}
                onClose={() => setCreateSpaceOpen(false)}
                onCreated={(roomId) => {
                    setCreateSpaceOpen(false);
                    focusRoom(roomId);
                    setSpaceOnboardingSpaceId(roomId);
                    pushToast({ type: "success", message: "Space created." });
                }}
                onJoinPublicSpaceRequest={(target) => requestJoinRoom(target)}
                onJoined={() => {
                    setCreateSpaceOpen(false);
                    pushToast({ type: "success", message: "Joined public Space." });
                }}
                onImport={() => setImportJsonOpen(true)}
            />
            <JoinRoomDialog
                client={client}
                open={joinRoomOpen}
                onClose={() => setJoinRoomOpen(false)}
                onJoinRequest={(target) => requestJoinRoom(target)}
                onJoined={() => {
                    setJoinRoomOpen(false);
                    pushToast({ type: "success", message: "Joined room." });
                }}
            />
            <InviteDialog
                client={client}
                room={inviteTargetRoom}
                open={inviteOpen}
                onCompleted={({ invited, failed }) => {
                    if (invited.length > 0 && failed.length === 0) {
                        pushToast({
                            type: "success",
                            message: invited.length === 1 ? "User invited." : `${invited.length} users invited.`,
                        });
                        return;
                    }

                    if (invited.length > 0 && failed.length > 0) {
                        const firstFailure = failed[0];
                        pushToast({
                            type: "info",
                            message: `Invited ${invited.length}, failed ${failed.length} (${firstFailure.userId}: ${firstFailure.message}).`,
                        });
                    }
                }}
                onClose={() => {
                    setInviteOpen(false);
                    setInviteTargetRoomId(null);
                }}
            />
            <RoomSettingsDialog
                client={client}
                room={roomSettingsRoom}
                open={Boolean(roomSettingsRoomId)}
                onClose={() => setRoomSettingsRoomId(null)}
            />
            <RoomModerationDialog
                client={client}
                room={activeRoom}
                open={roomModerationOpen}
                onClose={() => setRoomModerationOpen(false)}
            />
            <SettingsOverlay
                open={Boolean(settingsState)}
                mode={settingsState?.mode ?? "user"}
                initialTab={settingsState?.tab ?? "my-account"}
                client={client}
                spaceRoom={settingsState?.mode === "server" ? selectedSpaceRoom : null}
                spaceChannels={channels}
                activeRoomId={activeRoomId}
                onSelectRoom={setActiveRoomId}
                onOpenEmojiUpload={(target) => {
                    setEmojiUploadTarget(target);
                    setEmojiUploadOpen(true);
                }}
                onOpenCreateRoomInSpace={(spaceId) => {
                    setSettingsState(null);
                    openCreateRoomDialog(spaceId);
                }}
                onRefreshSpaceChannels={reloadSpaceChannelsFromServer}
                onClose={() => setSettingsState(null)}
                onLeftSpace={(spaceId) => {
                    if (selectedSpaceId === spaceId) {
                        setSelectedSpaceId(PEOPLE_SPACE_ID);
                    }
                    setSettingsState(null);
                }}
                onLogout={onLogout}
                userSettings={userSettings}
                onUserSettingsChange={setUserSettings}
                renderReactionImages={renderReactionImages}
                onToggleRenderReactionImages={setRenderReactionImages}
                onToast={pushToast}
            />
            <ImportJsonWizard
                client={client}
                open={importJsonOpen}
                onClose={() => setImportJsonOpen(false)}
                onImported={(spaceId) => {
                    setImportJsonOpen(false);
                    focusRoom(spaceId);
                    pushToast({ type: "success", message: "Import completed." });
                }}
            />
            <Toast toast={toast} onClose={() => setToast(null)} />
        </div>
    );
}
