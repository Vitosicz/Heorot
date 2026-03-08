import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    EventType,
    NotificationCountType,
    M_BEACON,
    RoomStateEvent,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { memberAvatarSources, roomAvatarSources } from "../adapters/avatar";
import { mediaFromMxc, thumbnailFromMxc } from "../adapters/media";
import { fetchVoiceParticipants, isVoiceFeatureEnabled } from "../adapters/voiceAdapter";
import { useMatrix } from "../providers/MatrixProvider";
import { isPresenceEnabledForClient } from "../presence/presenceConfig";
import { toAvatarPresenceState } from "../presence/buildPresenceVm";
import { usePresenceMap } from "../presence/usePresence";
import {
    CATEGORY_STATE_EVENT,
    CHANNEL_ORDER_STATE_EVENT,
    canManageCategories,
    createCategory,
    getCategoryCollapsed,
    readCategories,
    readCategoriesFromStateSnapshot,
    readChannelOrder,
    readChannelOrderFromStateSnapshot,
    setCategoryCollapsed,
    writeCategories,
    writeChannelOrder,
    type HeorotCategory,
} from "../stores/CategoryStore";
import { isVoiceChannelRoom } from "../voice/voiceChannel";
import { Avatar } from "./Avatar";
import micMuteIcon from "./icons/mic-02.svg";
import volumeMuteIcon from "./icons/volume-mute-02.svg";

interface RoomListProps {
    client: MatrixClient;
    spaceId: string;
    rooms: Room[];
    showRoomAvatars?: boolean;
    voiceChannelHintRoomIds?: Set<string>;
    discoverableRooms?: DiscoverableSpaceChannel[];
    discoverableJoiningRoomId?: string | null;
    activeRoomId: string | null;
    orderingMode?: "manual" | "dynamic";
    showOrderingControls?: boolean;
    showHashPrefix?: boolean;
    onSelectRoom: (roomId: string) => void;
    onJoinDiscoverableRoom?: (roomId: string) => void;
    localVoiceSession?: {
        roomId: string;
        status: "disconnected" | "joining" | "connected";
        userId: string | null;
        displayName: string;
        avatarMxc?: string | null;
        micMuted?: boolean;
        audioMuted?: boolean;
    } | null;
    liveSpeakingByRoomId?: Map<string, Set<string>>;
    liveScreenShareByRoomId?: Map<string, Set<string>>;
    liveParticipantsByRoomId?: Map<string, Set<string>>;
    liveParticipantsOverrideRoomId?: string | null;
    onOpenRoomSettings?: (roomId: string) => void;
    voiceDiscoveryReady?: boolean;
}

interface VoiceParticipantInfo {
    identity: string;
    matrixUserId?: string;
    displayName: string;
    avatarMxc: string | null;
    micMuted?: boolean;
    audioMuted?: boolean;
    screenSharing?: boolean;
}

interface VoicePresenceInfo {
    count: number;
    participants: VoiceParticipantInfo[];
    error?: string;
}

export interface DiscoverableSpaceChannel {
    roomId: string;
    name: string;
    topic?: string;
    avatarMxc?: string | null;
    memberCount?: number;
    isVoiceChannel?: boolean;
    viaServers?: string[];
}

const EMPTY_VOICE_CHANNEL_HINT_IDS = new Set<string>();
const VOICE_PRESENCE_POLL_ACTIVE_MS = 4_000;
const VOICE_PRESENCE_POLL_IDLE_MS = 8_000;
const VOICE_PRESENCE_POLL_HIDDEN_MS = 20_000;
const VOICE_PRESENCE_POLL_MAX_BACKOFF_MS = 60_000;

function getServerUnreadCount(room: Room): number {
    const getUnreadNotificationCount = (room as Room & {
        getUnreadNotificationCount?: (type?: NotificationCountType) => number;
    }).getUnreadNotificationCount;

    if (!getUnreadNotificationCount) {
        return 0;
    }

    try {
        return getUnreadNotificationCount.call(room, NotificationCountType.Total) ?? 0;
    } catch {
        return 0;
    }
}

function eventTriggersUnread(event: MatrixEvent, ownUserId: string): boolean {
    if (event.getSender() === ownUserId) {
        return false;
    }

    switch (event.getType()) {
        case EventType.RoomMember:
        case EventType.RoomThirdPartyInvite:
        case EventType.CallAnswer:
        case EventType.CallHangup:
        case EventType.RoomCanonicalAlias:
        case EventType.RoomServerAcl:
        case M_BEACON.name:
        case M_BEACON.altName:
            return false;
    }

    return !event.isRedacted();
}

function hasUnreadActivity(room: Room, ownUserId: string): boolean {
    const events = room.getLiveTimeline()?.getEvents() ?? room.timeline;
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        const eventId = event.getId();
        if (!eventId) {
            continue;
        }

        if (!eventTriggersUnread(event, ownUserId)) {
            continue;
        }

        return !room.hasUserReadEvent(ownUserId, eventId);
    }

    return false;
}

function getRoomName(room: Room): string {
    return room.name || room.getCanonicalAlias() || room.roomId;
}

function getRoomAvatarSeed(room: Room): string | undefined {
    const fallbackMember = (room as Room & {
        getAvatarFallbackMember?: () => { userId?: string } | undefined;
    }).getAvatarFallbackMember?.();

    if (fallbackMember?.userId) {
        return fallbackMember.userId;
    }

    return undefined;
}

function getDirectTargetUserId(room: Room, ownUserId: string): string | null {
    const members = room
        .getMembers()
        .filter((member) => member.userId !== ownUserId)
        .filter((member) => member.membership === "join" || member.membership === "invite" || member.membership === "knock")
        .sort((left, right) => {
            const leftName = left.rawDisplayName || left.name || left.userId;
            const rightName = right.rawDisplayName || right.name || right.userId;
            return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
        });

    if (members.length === 0) {
        return null;
    }

    return members[0]?.userId ?? null;
}

function mergeOrder(serverOrder: string[], currentRoomIds: string[]): string[] {
    const currentSet = new Set(currentRoomIds);
    const ordered: string[] = [];
    const orderedSet = new Set<string>();
    for (const id of serverOrder) {
        if (currentSet.has(id) && !orderedSet.has(id)) {
            ordered.push(id);
            orderedSet.add(id);
        }
    }
    for (const id of currentRoomIds) {
        if (!orderedSet.has(id)) {
            ordered.push(id);
            orderedSet.add(id);
        }
    }
    return ordered;
}

function reorderRoomIds(roomIds: string[], fromIndex: number, toIndex: number): string[] {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= roomIds.length || toIndex >= roomIds.length || fromIndex === toIndex) {
        return roomIds;
    }

    const next = [...roomIds];
    const [removed] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, removed);
    return next;
}

export function RoomList({
    client,
    spaceId,
    rooms,
    showRoomAvatars = true,
    voiceChannelHintRoomIds = EMPTY_VOICE_CHANNEL_HINT_IDS,
    discoverableRooms = [],
    discoverableJoiningRoomId = null,
    activeRoomId,
    orderingMode = "manual",
    showOrderingControls = false,
    showHashPrefix = true,
    onSelectRoom,
    onJoinDiscoverableRoom,
    localVoiceSession = null,
    liveSpeakingByRoomId = new Map(),
    liveScreenShareByRoomId = new Map(),
    liveParticipantsByRoomId = new Map(),
    liveParticipantsOverrideRoomId = null,
    onOpenRoomSettings,
    voiceDiscoveryReady = false,
}: RoomListProps): React.ReactElement {
    const { config } = useMatrix();
    const manualOrderingEnabled = orderingMode === "manual";
    const orderingControlsEnabled = manualOrderingEnabled && showOrderingControls;
    const ownUserId = client.getUserId() ?? "";
    const presenceEnabled = useMemo(() => isPresenceEnabledForClient(config, client), [client, config]);
    const showChannelSettingsButton = Boolean(onOpenRoomSettings);
    const [draggedRoomId, setDraggedRoomId] = useState<string | null>(null);
    const [dragOverCatId, setDragOverCatId] = useState<string | null>(null);
    const [menuRoomId, setMenuRoomId] = useState<string | null>(null);
    const [catMenuId, setCatMenuId] = useState<string | null>(null);
    const [voicePresenceByRoomId, setVoicePresenceByRoomId] = useState<Map<string, VoicePresenceInfo>>(new Map());
    const [categories, setCategories] = useState<HeorotCategory[]>([]);
    const [editingCatId, setEditingCatId] = useState<string | null>(null);
    const [editingCatName, setEditingCatName] = useState("");
    const canManageCats = useMemo(() => {
        const spaceRoom = client.getRoom(spaceId);
        return spaceRoom ? canManageCategories(spaceRoom, ownUserId) : false;
    }, [client, spaceId, ownUserId]);
    const directUserIdByRoomId = useMemo(() => {
        const out = new Map<string, string>();
        if (!presenceEnabled || showHashPrefix) {
            return out;
        }

        for (const room of rooms) {
            const userId = getDirectTargetUserId(room, ownUserId);
            if (!userId) {
                continue;
            }
            out.set(room.roomId, userId);
        }
        return out;
    }, [ownUserId, presenceEnabled, rooms, showHashPrefix]);
    const presenceByUserId = usePresenceMap(
        client,
        Array.from(new Set(directUserIdByRoomId.values())),
        presenceEnabled && !showHashPrefix,
    );

    const currentRoomIds = useMemo(() => rooms.map((room) => room.roomId), [rooms]);
    const currentRoomIdsKey = useMemo(() => currentRoomIds.join("\u0000"), [currentRoomIds]);
    const [serverRoomOrder, setServerRoomOrder] = useState<string[]>(() => {
        if (!manualOrderingEnabled) return [];
        const room = client.getRoom(spaceId);
        return room ? readChannelOrder(room) : [];
    });
    const [orderedRoomIds, setOrderedRoomIds] = useState<string[]>(() => {
        if (!manualOrderingEnabled) return currentRoomIds;
        const room = client.getRoom(spaceId);
        return mergeOrder(room ? readChannelOrder(room) : [], currentRoomIds);
    });

    useEffect(() => {
        if (!manualOrderingEnabled) {
            setMenuRoomId(null);
            setDraggedRoomId(null);
            setCategories([]);
            setServerRoomOrder([]);
            setOrderedRoomIds(currentRoomIds);
            return;
        }

        const merged = mergeOrder(serverRoomOrder, currentRoomIds);
        setOrderedRoomIds(merged);

        if (!orderingControlsEnabled) {
            setMenuRoomId(null);
            setDraggedRoomId(null);
            return;
        }

        setMenuRoomId((current) => (current && merged.includes(current) ? current : null));
        setDraggedRoomId((current) => (current && merged.includes(current) ? current : null));
    }, [spaceId, currentRoomIds, currentRoomIdsKey, manualOrderingEnabled, orderingControlsEnabled, serverRoomOrder]);

    useEffect(() => {
        const spaceRoom = client.getRoom(spaceId);
        if (!spaceRoom) {
            setCategories([]);
            setServerRoomOrder([]);
            return;
        }

        let cancelled = false;

        const loadFromCurrentState = (): void => {
            setCategories(readCategories(spaceRoom));
            setServerRoomOrder(readChannelOrder(spaceRoom));
        };

        const loadFromServerState = async (): Promise<void> => {
            try {
                const remoteStateEvents = await client.roomState(spaceId);
                if (cancelled) {
                    return;
                }
                const snapshotEvents = remoteStateEvents as Array<{ type?: unknown; state_key?: unknown; content?: unknown }>;
                setCategories(readCategoriesFromStateSnapshot(snapshotEvents));
                setServerRoomOrder(readChannelOrderFromStateSnapshot(snapshotEvents));
            } catch {
                // Keep best-effort data from synced current state.
            }
        };

        loadFromCurrentState();
        void loadFromServerState();

        const handler = (event: MatrixEvent): void => {
            if (event.getRoomId() !== spaceId) return;
            if (event.getType() === CATEGORY_STATE_EVENT || event.getType() === CHANNEL_ORDER_STATE_EVENT) {
                loadFromCurrentState();
            }
        };

        client.on(RoomStateEvent.Events, handler);
        return () => {
            cancelled = true;
            client.off(RoomStateEvent.Events, handler);
        };
    }, [client, spaceId]);

    useEffect(() => {
        if (!menuRoomId || !orderingControlsEnabled) {
            return undefined;
        }

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement | null;
            if (!target) {
                return;
            }

            if (target.closest(".room-item-menu") || target.closest(".room-item-menu-button")) {
                return;
            }

            setMenuRoomId(null);
        };

        window.addEventListener("mousedown", onMouseDown);
        return () => {
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [orderingControlsEnabled, menuRoomId]);

    const orderedRooms = useMemo(() => {
        if (!manualOrderingEnabled) {
            return rooms;
        }

        const roomById = new Map(rooms.map((room) => [room.roomId, room] as const));
        return orderedRoomIds
            .map((roomId) => roomById.get(roomId))
            .filter((room): room is Room => Boolean(room));
    }, [manualOrderingEnabled, orderedRoomIds, rooms]);
    const { uncategorized, categorizedGroups, hiddenRoomIds } = useMemo(() => {
        const effectiveCategories = manualOrderingEnabled ? categories : [];
        const assignedIds = new Set(effectiveCategories.flatMap((c) => c.roomIds));
        const roomById = new Map(rooms.map((r) => [r.roomId, r]));
        const hidden = new Set<string>();
        const catGroups = effectiveCategories.map((cat) => {
            const collapsed = getCategoryCollapsed(spaceId, cat.id);
            const catRooms = cat.roomIds
                .map((id) => roomById.get(id))
                .filter((r): r is Room => Boolean(r));
            if (collapsed) {
                for (const r of catRooms) {
                    if (r.roomId !== activeRoomId) hidden.add(r.roomId);
                }
            }
            return { cat, rooms: catRooms, collapsed };
        });
        return {
            uncategorized: orderedRooms.filter((r) => !assignedIds.has(r.roomId)),
            categorizedGroups: catGroups,
            hiddenRoomIds: hidden,
        };
    }, [activeRoomId, categories, manualOrderingEnabled, orderedRooms, rooms, spaceId]);
    const polledVoiceRooms = useMemo(() => {
        if (!isVoiceFeatureEnabled(config)) {
            return [];
        }

        const visibleVoiceRoomsById = new Map<string, Room>();
        for (const room of orderedRooms) {
            const isVoice = isVoiceChannelRoom(room) || voiceChannelHintRoomIds.has(room.roomId);
            if (!isVoice) {
                continue;
            }

            const isHiddenInCollapsedGroup =
                hiddenRoomIds.has(room.roomId) && room.roomId !== activeRoomId;
            if (isHiddenInCollapsedGroup) {
                continue;
            }

            visibleVoiceRoomsById.set(room.roomId, room);
        }

        const hasActiveLocalVoiceSession =
            localVoiceSession?.status === "connected" || localVoiceSession?.status === "joining";
        if (hasActiveLocalVoiceSession && localVoiceSession?.roomId) {
            const localVoiceRoom = rooms.find((room) => room.roomId === localVoiceSession.roomId);
            if (localVoiceRoom && (isVoiceChannelRoom(localVoiceRoom) || voiceChannelHintRoomIds.has(localVoiceRoom.roomId))) {
                visibleVoiceRoomsById.set(localVoiceRoom.roomId, localVoiceRoom);
            }
        }

        return Array.from(visibleVoiceRoomsById.values());
    }, [
        activeRoomId,
        config,
        hiddenRoomIds,
        localVoiceSession?.roomId,
        localVoiceSession?.status,
        orderedRooms,
        rooms,
        voiceChannelHintRoomIds,
    ]);

    useEffect(() => {
        if (!isVoiceFeatureEnabled(config)) {
            setVoicePresenceByRoomId(new Map());
            return;
        }

        const voiceRooms = polledVoiceRooms;
        if (voiceRooms.length === 0) {
            setVoicePresenceByRoomId(new Map());
            return;
        }

        let cancelled = false;
        let timeoutId: number | null = null;
        let loading = false;
        let refreshQueued = false;
        let consecutiveFailures = 0;

        const hasDocument = typeof document !== "undefined";
        const computeBasePollIntervalMs = (): number => {
            if (hasDocument && document.visibilityState === "hidden") {
                return VOICE_PRESENCE_POLL_HIDDEN_MS;
            }
            const hasActiveLocalVoiceSession =
                localVoiceSession?.status === "connected" || localVoiceSession?.status === "joining";
            return hasActiveLocalVoiceSession ? VOICE_PRESENCE_POLL_ACTIVE_MS : VOICE_PRESENCE_POLL_IDLE_MS;
        };

        const scheduleNextPoll = (): void => {
            if (cancelled) {
                return;
            }

            const baseIntervalMs = computeBasePollIntervalMs();
            const failureMultiplier = consecutiveFailures > 0 ? 2 ** Math.min(3, consecutiveFailures) : 1;
            const nextIntervalMs = Math.min(baseIntervalMs * failureMultiplier, VOICE_PRESENCE_POLL_MAX_BACKOFF_MS);
            timeoutId = window.setTimeout(() => {
                void load();
            }, nextIntervalMs);
        };

        const load = async (): Promise<void> => {
            if (loading) {
                refreshQueued = true;
                return;
            }

            loading = true;
            const next = new Map<string, VoicePresenceInfo>();
            let hadError = false;
            await Promise.all(
                voiceRooms.map(async (room) => {
                    try {
                        const payload = await fetchVoiceParticipants(client, config, room.roomId);
                        const participantsByMatrixUserId = new Map<string, VoiceParticipantInfo>();

                        for (const participant of payload.participants) {
                            const memberLookupId = participant.matrixUserId ?? participant.identity;
                            const member = room.getMember(memberLookupId);
                            const user = client.getUser(memberLookupId);
                            const displayName =
                                participant.name ||
                                member?.rawDisplayName ||
                                member?.name ||
                                user?.displayName ||
                                participant.identity;
                            const avatarMxc =
                                member?.getMxcAvatarUrl() ||
                                user?.avatarUrl ||
                                null;
                            const key = memberLookupId;
                            const existing = participantsByMatrixUserId.get(key);

                            participantsByMatrixUserId.set(key, {
                                identity: key,
                                matrixUserId: participant.matrixUserId,
                                displayName: existing?.displayName || displayName,
                                avatarMxc: existing?.avatarMxc || avatarMxc,
                                micMuted:
                                    participant.micMuted === true || existing?.micMuted === true
                                        ? true
                                        : participant.micMuted ?? existing?.micMuted,
                                audioMuted:
                                    participant.audioMuted === true || existing?.audioMuted === true
                                        ? true
                                        : participant.audioMuted ?? existing?.audioMuted,
                                screenSharing:
                                    participant.screenSharing === true || existing?.screenSharing === true
                                        ? true
                                        : participant.screenSharing ?? existing?.screenSharing,
                            });
                        }

                        const participants = Array.from(participantsByMatrixUserId.values());

                        next.set(room.roomId, {
                            count: participants.length,
                            participants,
                        });
                    } catch (voiceError) {
                        hadError = true;
                        next.set(room.roomId, {
                            count: 0,
                            participants: [],
                            error: voiceError instanceof Error ? voiceError.message : "Unable to load voice presence.",
                        });
                    }
                }),
            );
            if (!cancelled) {
                setVoicePresenceByRoomId(next);
            }

            loading = false;
            consecutiveFailures = hadError ? Math.min(consecutiveFailures + 1, 5) : 0;

            if (refreshQueued) {
                refreshQueued = false;
                void load();
                return;
            }

            scheduleNextPoll();
        };

        void load();

        const handleVisibilityChange = (): void => {
            if (cancelled) {
                return;
            }

            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            void load();
        };
        if (hasDocument) {
            document.addEventListener("visibilitychange", handleVisibilityChange);
        }

        return () => {
            cancelled = true;
            if (hasDocument) {
                document.removeEventListener("visibilitychange", handleVisibilityChange);
            }
            if (timeoutId !== null) {
                window.clearTimeout(timeoutId);
            }
        };
    }, [client, config, localVoiceSession?.status, polledVoiceRooms, voiceDiscoveryReady]);

    const persistOrder = useCallback(
        (nextOrder: string[]): void => {
            if (!orderingControlsEnabled) {
                return;
            }

            setOrderedRoomIds(nextOrder);
            void writeChannelOrder(client, spaceId, nextOrder);
        },
        [client, orderingControlsEnabled, spaceId],
    );

    const moveByOffset = useCallback(
        (roomId: string, offset: number): void => {
            if (!orderingControlsEnabled) {
                return;
            }

            const currentIndex = orderedRoomIds.indexOf(roomId);
            const targetIndex = currentIndex + offset;
            if (currentIndex < 0 || targetIndex < 0 || targetIndex >= orderedRoomIds.length) {
                return;
            }

            persistOrder(reorderRoomIds(orderedRoomIds, currentIndex, targetIndex));
        },
        [orderingControlsEnabled, orderedRoomIds, persistOrder],
    );

    const resetToDefaultOrder = useCallback((): void => {
        if (!orderingControlsEnabled) {
            return;
        }

        void writeChannelOrder(client, spaceId, []);
        setOrderedRoomIds(currentRoomIds);
        setMenuRoomId(null);
    }, [client, currentRoomIds, orderingControlsEnabled, spaceId]);

    const handleDropOnRoom = useCallback(
        (targetRoomId: string): void => {
            if (!orderingControlsEnabled || !draggedRoomId || draggedRoomId === targetRoomId) {
                return;
            }

            const fromIndex = orderedRoomIds.indexOf(draggedRoomId);
            const toIndex = orderedRoomIds.indexOf(targetRoomId);
            if (fromIndex < 0 || toIndex < 0) {
                return;
            }

            persistOrder(reorderRoomIds(orderedRoomIds, fromIndex, toIndex));
            setDraggedRoomId(null);
        },
        [draggedRoomId, orderingControlsEnabled, orderedRoomIds, persistOrder],
    );

    const handleDropOnCategory = useCallback(
        (cat: HeorotCategory): void => {
            if (!orderingControlsEnabled || !draggedRoomId) return;
            const next = categories.map((c) => ({
                ...c,
                roomIds:
                    c.id === cat.id
                        ? [draggedRoomId, ...c.roomIds.filter((id) => id !== draggedRoomId)]
                        : c.roomIds.filter((id) => id !== draggedRoomId),
            }));
            setCategories(next);
            void writeCategories(client, spaceId, next);
            setDraggedRoomId(null);
            setDragOverCatId(null);
        },
        [categories, client, draggedRoomId, orderingControlsEnabled, spaceId],
    );

    const handleAddCategory = useCallback((): void => {
        const newCat = createCategory("New Category");
        const next = [...categories, newCat];
        setCategories(next);
        void writeCategories(client, spaceId, next);
        setEditingCatId(newCat.id);
        setEditingCatName(newCat.name);
    }, [categories, client, spaceId]);

    const startCatRename = useCallback((cat: HeorotCategory): void => {
        setEditingCatId(cat.id);
        setEditingCatName(cat.name);
    }, []);

    const commitCatRename = useCallback(
        (catId: string): void => {
            const trimmed = editingCatName.trim().slice(0, 32) || "New Category";
            const next = categories.map((c) => (c.id === catId ? { ...c, name: trimmed } : c));
            setCategories(next);
            void writeCategories(client, spaceId, next);
            setEditingCatId(null);
            setEditingCatName("");
        },
        [categories, client, editingCatName, spaceId],
    );

    const toggleCategory = useCallback(
        (cat: HeorotCategory): void => {
            const newCollapsed = !getCategoryCollapsed(spaceId, cat.id);
            setCategoryCollapsed(spaceId, cat.id, newCollapsed);
            setCategories((prev) => [...prev]);
        },
        [spaceId],
    );

    const deleteCategory = useCallback(
        (catId: string): void => {
            const next = categories.filter((c) => c.id !== catId);
            setCategories(next);
            void writeCategories(client, spaceId, next);
            if (editingCatId === catId) {
                setEditingCatId(null);
                setEditingCatName("");
            }
        },
        [categories, client, editingCatId, spaceId],
    );

    const removeRoomFromCategory = useCallback(
        (catId: string, roomId: string): void => {
            const next = categories.map((c) =>
                c.id === catId ? { ...c, roomIds: c.roomIds.filter((id) => id !== roomId) } : c,
            );
            setCategories(next);
            void writeCategories(client, spaceId, next);
        },
        [categories, client, spaceId],
    );

    const moveCategoryRoom = useCallback(
        (catId: string, roomId: string, offset: number): void => {
            const cat = categories.find((c) => c.id === catId);
            if (!cat) return;
            const idx = cat.roomIds.indexOf(roomId);
            const newIdx = idx + offset;
            if (idx < 0 || newIdx < 0 || newIdx >= cat.roomIds.length) return;
            const newRoomIds = [...cat.roomIds];
            [newRoomIds[idx], newRoomIds[newIdx]] = [newRoomIds[newIdx], newRoomIds[idx]];
            const next = categories.map((c) => (c.id === catId ? { ...c, roomIds: newRoomIds } : c));
            setCategories(next);
            void writeCategories(client, spaceId, next);
        },
        [categories, client, spaceId],
    );

    // Render a single joined room item (shared by uncategorized + categorized sections)
    const renderRoomItem = (
        room: Room,
        opts: { indexInGroup: number; groupSize: number; catId: string | null },
    ): React.ReactElement => {
        const { indexInGroup, groupSize, catId } = opts;
        const unreadCount = getServerUnreadCount(room);
        const showActivityDot = unreadCount === 0 && ownUserId ? hasUnreadActivity(room, ownUserId) : false;
        const isActive = room.roomId === activeRoomId;
        const roomName = getRoomName(room);
        const allowMemberAvatarFallback = !showHashPrefix;
        const roomAvatarList = roomAvatarSources(client, room, 64, allowMemberAvatarFallback);
        const roomAvatarUrl = roomAvatarList[0] ?? null;
        const roomAvatarSeed = allowMemberAvatarFallback ? getRoomAvatarSeed(room) ?? room.roomId : room.roomId;
        const presenceUserId = directUserIdByRoomId.get(room.roomId) ?? null;
        const presence = presenceUserId ? presenceByUserId.get(presenceUserId) : null;
        const isMenuOpen = orderingControlsEnabled && menuRoomId === room.roomId;
        const dragClass = draggedRoomId === room.roomId ? " is-dragging" : "";
        const isVoiceChannel = isVoiceChannelRoom(room) || voiceChannelHintRoomIds.has(room.roomId);
        const voicePresence = voicePresenceByRoomId.get(room.roomId);
        const voiceParticipants = voicePresence?.participants ?? [];
        const liveSpeakingUserIds = liveSpeakingByRoomId.get(room.roomId) ?? null;
        const liveScreenShareUserIds = liveScreenShareByRoomId.get(room.roomId) ?? null;
        const liveParticipantIdsForRoom =
            liveParticipantsOverrideRoomId === room.roomId
                ? liveParticipantsByRoomId.get(room.roomId) ?? null
                : null;
        const hasLiveParticipantOverride = Boolean(liveParticipantIdsForRoom);
        const localVoiceSessionForRoom =
            isVoiceChannel && localVoiceSession?.roomId === room.roomId ? localVoiceSession : null;
        const localVoiceIdentity =
            localVoiceSessionForRoom &&
            localVoiceSessionForRoom.status !== "disconnected" &&
            localVoiceSessionForRoom.userId
                ? localVoiceSessionForRoom.userId
                : null;
        const voiceParticipantsWithLocalState = localVoiceIdentity
            ? voiceParticipants.map((participant) =>
                  participant.identity === localVoiceIdentity || participant.matrixUserId === localVoiceIdentity
                      ? {
                            ...participant,
                            micMuted: localVoiceSessionForRoom?.micMuted === true,
                            audioMuted: localVoiceSessionForRoom?.audioMuted === true,
                        }
                      : participant,
              )
            : voiceParticipants;
        const localParticipantCandidate =
            localVoiceIdentity && localVoiceSessionForRoom
                  ? {
                        identity: localVoiceIdentity,
                        matrixUserId: localVoiceIdentity,
                        displayName: localVoiceSessionForRoom.displayName,
                        avatarMxc: localVoiceSessionForRoom.avatarMxc ?? null,
                        micMuted: localVoiceSessionForRoom.micMuted === true,
                        audioMuted: localVoiceSessionForRoom.audioMuted === true,
                        screenSharing: false,
                    }
                : null;
        const hasLocalParticipantAlready = localParticipantCandidate
            ? voiceParticipantsWithLocalState.some(
                  (participant) => participant.identity === localParticipantCandidate.identity,
              )
            : false;
        const voiceParticipantsWithLocal =
            localParticipantCandidate && !hasLocalParticipantAlready
                ? [...voiceParticipantsWithLocalState, localParticipantCandidate]
                : voiceParticipantsWithLocalState;
        const voiceParticipantsByIdentity = new Map<string, VoiceParticipantInfo>();
        for (const participant of voiceParticipantsWithLocal) {
            voiceParticipantsByIdentity.set(participant.identity, participant);
            if (participant.matrixUserId) {
                voiceParticipantsByIdentity.set(participant.matrixUserId, participant);
            }
        }
        const voiceParticipantsEffective =
            hasLiveParticipantOverride && liveParticipantIdsForRoom
                ? Array.from(liveParticipantIdsForRoom).map((identity) => {
                      const participant = voiceParticipantsByIdentity.get(identity);
                      if (participant) {
                          return participant;
                      }

                      const member = room.getMember(identity);
                      const user = client.getUser(identity);
                      const isLocalParticipant = localVoiceIdentity === identity;

                      return {
                          identity,
                          matrixUserId: identity,
                          displayName: member?.rawDisplayName || member?.name || user?.displayName || identity,
                          avatarMxc: member?.getMxcAvatarUrl() || user?.avatarUrl || null,
                          micMuted: isLocalParticipant ? localVoiceSessionForRoom?.micMuted === true : undefined,
                          audioMuted: isLocalParticipant ? localVoiceSessionForRoom?.audioMuted === true : undefined,
                      };
                  })
                : voiceParticipantsWithLocal;
        const voiceParticipantsTotalBase = hasLiveParticipantOverride
            ? voiceParticipantsEffective.length
            : voicePresence?.count ?? voiceParticipantsWithLocalState.length;
        const voiceParticipantsTotal = hasLiveParticipantOverride
            ? voiceParticipantsEffective.length
            : Math.max(voiceParticipantsTotalBase, voiceParticipantsWithLocal.length);
        const sortedVoiceParticipants = [...voiceParticipantsEffective].sort((left, right) => {
            const leftUserId = left.matrixUserId ?? left.identity;
            const rightUserId = right.matrixUserId ?? right.identity;
            if (leftUserId === ownUserId && rightUserId !== ownUserId) {
                return -1;
            }
            if (rightUserId === ownUserId && leftUserId !== ownUserId) {
                return 1;
            }

            return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
        });
        const voiceSubtitle = hasLiveParticipantOverride
            ? localVoiceSessionForRoom?.status === "joining"
                ? "Connecting..."
                : voiceParticipantsTotal > 0
                  ? `${voiceParticipantsTotal} connected`
                  : "No one connected"
            : voicePresence
              ? voicePresence.error
                  ? "Voice presence unavailable"
                  : localVoiceSessionForRoom?.status === "joining"
                    ? "Connecting..."
                    : voiceParticipantsTotal > 0
                      ? `${voiceParticipantsTotal} connected`
                      : "No one connected"
              : localVoiceSessionForRoom?.status === "joining"
                ? "Connecting..."
                : "Voice channel";

        return (
            <div
                key={room.roomId}
                role="listitem"
                className={`room-item${isActive ? " is-active" : ""}${dragClass}`}
                draggable={orderingControlsEnabled}
                onDragStart={(event) => {
                    if (!orderingControlsEnabled) {
                        event.preventDefault();
                        return;
                    }
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", room.roomId);
                    setDraggedRoomId(room.roomId);
                }}
                onDragOver={(event) => {
                    if (!orderingControlsEnabled || catId !== null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                    if (!orderingControlsEnabled || catId !== null) return;
                    event.preventDefault();
                    handleDropOnRoom(room.roomId);
                }}
                onDragEnd={() => { setDraggedRoomId(null); setDragOverCatId(null); }}
            >
                <div className="room-item-row">
                    {orderingControlsEnabled ? <span className="room-item-handle">::</span> : null}
                    <button
                        type="button"
                        className="room-item-select"
                        onClick={() => onSelectRoom(room.roomId)}
                        title={roomName}
                    >
                        <span className={`room-item-main${showRoomAvatars ? "" : " room-item-main-no-avatar"}`}>
                            {showRoomAvatars ? (
                                <Avatar
                                    className="room-item-avatar"
                                    name={roomName}
                                    src={roomAvatarUrl}
                                    sources={roomAvatarList}
                                    seed={roomAvatarSeed}
                                    userId={roomAvatarSeed}
                                    presenceState={presenceEnabled ? toAvatarPresenceState(presence) : null}
                                />
                            ) : null}
                            <span className="room-item-title-block">
                                <span className="room-item-name">
                                    {isVoiceChannel ? "\uD83D\uDD0A " : ""}
                                    {showHashPrefix ? "#" : ""}
                                    {roomName}
                                </span>
                                {isVoiceChannel ? (
                                    <span className="room-item-subtitle">{voiceSubtitle}</span>
                                ) : null}
                            </span>
                        </span>
                    </button>
                    {unreadCount > 0 ? <span className="room-item-unread">{unreadCount}</span> : null}
                    {unreadCount === 0 && showActivityDot ? <span className="room-item-activity" /> : null}
                    {showChannelSettingsButton ? (
                        <button
                            type="button"
                            className="room-item-settings-button"
                            aria-label={`Channel settings for ${roomName}`}
                            title="Channel settings"
                            onClick={(event) => {
                                event.stopPropagation();
                                onOpenRoomSettings?.(room.roomId);
                            }}
                        >
                            {"\u2699"}
                        </button>
                    ) : null}
                    {orderingControlsEnabled ? (
                        <>
                            <button
                                type="button"
                                className="room-item-menu-button"
                                aria-label={`Channel options for ${roomName}`}
                                onClick={() => setMenuRoomId((openFor) => (openFor === room.roomId ? null : room.roomId))}
                            >
                                ...
                            </button>
                            {isMenuOpen ? (
                                <div className="room-item-menu">
                                    {catId === null ? (
                                        <>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => moveByOffset(room.roomId, -1)}
                                                disabled={indexInGroup === 0}
                                            >
                                                Move up
                                            </button>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => moveByOffset(room.roomId, 1)}
                                                disabled={indexInGroup === groupSize - 1}
                                            >
                                                Move down
                                            </button>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={resetToDefaultOrder}
                                            >
                                                Reset to default order
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => { moveCategoryRoom(catId, room.roomId, -1); setMenuRoomId(null); }}
                                                disabled={indexInGroup === 0}
                                            >
                                                Move up
                                            </button>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => { moveCategoryRoom(catId, room.roomId, 1); setMenuRoomId(null); }}
                                                disabled={indexInGroup === groupSize - 1}
                                            >
                                                Move down
                                            </button>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => { removeRoomFromCategory(catId, room.roomId); setMenuRoomId(null); }}
                                            >
                                                Remove from category
                                            </button>
                                        </>
                                    )}
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </div>
                {isVoiceChannel && sortedVoiceParticipants.length > 0 ? (
                    <div className="room-item-voice-users">
                        {sortedVoiceParticipants.map((participant) => {
                            const participantUserId = participant.matrixUserId ?? participant.identity;
                            const member = room.getMember(participantUserId);
                            const memberSources = memberAvatarSources(client, member, 40, "crop");
                            const fallbackSources = participant.avatarMxc
                                ? [
                                      thumbnailFromMxc(client, participant.avatarMxc, 40, 40, "crop"),
                                      mediaFromMxc(client, participant.avatarMxc),
                                  ].filter((source): source is string => Boolean(source))
                                : [];
                            const participantAvatarSources =
                                memberSources.length > 0 ? memberSources : fallbackSources;
                            const isOwnIdentity = ownUserId.length > 0 && participantUserId === ownUserId;
                            const isLocalVoiceParticipant = Boolean(
                                localVoiceSessionForRoom &&
                                    localVoiceSessionForRoom.status !== "disconnected" &&
                                    (participantUserId === localVoiceIdentity || isOwnIdentity),
                            );
                            const participantName = isOwnIdentity ? "You" : participant.displayName;
                            const isSpeaking = Boolean(
                                liveSpeakingUserIds?.has(participantUserId) || liveSpeakingUserIds?.has(participant.identity),
                            );
                            const isScreenSharing = Boolean(
                                participant.screenSharing === true ||
                                    liveScreenShareUserIds?.has(participantUserId) ||
                                    liveScreenShareUserIds?.has(participant.identity),
                            );
                            const isMicMuted =
                                participant.micMuted === true ||
                                (isLocalVoiceParticipant && localVoiceSessionForRoom?.micMuted === true);
                            const isAudioMuted =
                                participant.audioMuted === true ||
                                (isLocalVoiceParticipant && localVoiceSessionForRoom?.audioMuted === true);

                            return (
                                <button
                                    key={participant.identity}
                                    type="button"
                                    className={`room-item-voice-user${isSpeaking ? " is-speaking" : ""}${
                                        isScreenSharing ? " is-screen-sharing" : ""
                                    }`}
                                    onClick={() => onSelectRoom(room.roomId)}
                                    title={`${participantName} in ${roomName}`}
                                >
                                    <span className="room-item-voice-user-branch" aria-hidden="true" />
                                    <span className="room-item-voice-avatar-wrap">
                                        <Avatar
                                            className="room-item-voice-avatar"
                                            name={participantName}
                                            src={participantAvatarSources[0] ?? null}
                                            sources={participantAvatarSources}
                                            seed={participantUserId}
                                            userId={participantUserId}
                                        />
                                        <span
                                            className={`room-item-voice-speaking-ring${isSpeaking ? " is-speaking" : ""}`}
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <span className="room-item-voice-name">{participantName}</span>
                                    {isMicMuted || isAudioMuted || isScreenSharing ? (
                                        <span className="room-item-voice-status-icons">
                                            {isMicMuted ? (
                                                <span
                                                    className="room-item-voice-status-icon is-mic"
                                                    role="img"
                                                    aria-label="Microphone muted"
                                                    title="Microphone muted"
                                                >
                                                    <img src={micMuteIcon} alt="" aria-hidden="true" />
                                                </span>
                                            ) : null}
                                            {isAudioMuted ? (
                                                <span
                                                    className="room-item-voice-status-icon is-audio"
                                                    role="img"
                                                    aria-label="Audio muted"
                                                    title="Audio muted"
                                                >
                                                    <img src={volumeMuteIcon} alt="" aria-hidden="true" />
                                                </span>
                                            ) : null}
                                            {isScreenSharing ? (
                                                <span
                                                    className="room-item-voice-status-icon is-screen-share"
                                                    role="img"
                                                    aria-label="Screen sharing"
                                                    title="Screen sharing"
                                                >
                                                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                                        <path
                                                            fill="currentColor"
                                                            d="M4 5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h6v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-2v-2h6a2 2 0 0 0 2-2v-3.5a1 1 0 1 0-2 0V16H4V7h16v1.5a1 1 0 1 0 2 0V7a2 2 0 0 0-2-2H4Zm8.7 4.3a1 1 0 0 0-1.4 1.4l.6.6H8a1 1 0 1 0 0 2h3.9l-.6.6a1 1 0 1 0 1.4 1.4l2.3-2.3a1 1 0 0 0 0-1.4l-2.3-2.3ZM12 18h0v2h0v-2Z"
                                                        />
                                                    </svg>
                                                </span>
                                            ) : null}
                                        </span>
                                    ) : null}
                                    <span
                                        className={`room-item-voice-speaking-bars${isSpeaking ? " is-speaking" : ""}`}
                                        aria-hidden="true"
                                    >
                                        <span />
                                        <span />
                                        <span />
                                    </span>
                                    {isScreenSharing ? <span className="room-item-voice-live-badge">LIVE</span> : null}
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </div>
        );
    };

    return (
        <div className="room-list">
            <div className="room-list-header">
                <div className="room-list-header-row">
                    <h2>Channels</h2>
                    <div className="room-list-header-actions">
                        {canManageCats ? (
                            <button
                                type="button"
                                className="room-list-edit-button"
                                onClick={handleAddCategory}
                                title="Add category"
                            >
                                + Category
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="room-list-items">
                {uncategorized.map((room, index) =>
                    renderRoomItem(room, { indexInGroup: index, groupSize: uncategorized.length, catId: null }),
                )}
                {categorizedGroups.map(({ cat, rooms: catRooms, collapsed }) => (
                    <div key={cat.id} className="room-category">
                        <div
                            role="group"
                            className={`room-category-header${dragOverCatId === cat.id ? " is-drag-over" : ""}`}
                            onDragOver={(event) => {
                                if (!orderingControlsEnabled || !draggedRoomId) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                setDragOverCatId(cat.id);
                            }}
                            onDragLeave={() => setDragOverCatId(null)}
                            onDrop={(event) => {
                                event.preventDefault();
                                handleDropOnCategory(cat);
                            }}
                        >
                            <button
                                type="button"
                                className="room-category-toggle"
                                aria-label={collapsed ? "Expand category" : "Collapse category"}
                                onClick={() => toggleCategory(cat)}
                            >
                                <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 10 10"
                                    fill="currentColor"
                                    className={`room-category-toggle-icon${collapsed ? " is-collapsed" : ""}`}
                                >
                                    <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                            </button>
                            {editingCatId === cat.id ? (
                                <input
                                    className="room-category-name-input"
                                    value={editingCatName}
                                    onChange={(event) => setEditingCatName(event.target.value)}
                                    onBlur={() => commitCatRename(cat.id)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            commitCatRename(cat.id);
                                        } else if (event.key === "Escape") {
                                            setEditingCatId(null);
                                            setEditingCatName("");
                                        }
                                    }}
                                    maxLength={32}
                                    autoFocus
                                />
                            ) : (
                                <button
                                    type="button"
                                    className="room-category-name"
                                    onClick={() => toggleCategory(cat)}
                                >
                                    {cat.name}
                                </button>
                            )}
                            {collapsed ? (
                                <span className="room-category-hidden-count">{catRooms.length}</span>
                            ) : null}
                            {canManageCats && editingCatId !== cat.id ? (
                                <div className="room-category-menu-wrapper">
                                    <button
                                        type="button"
                                        className="room-category-menu-button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setCatMenuId((id) => (id === cat.id ? null : cat.id));
                                        }}
                                    >
                                        ···
                                    </button>
                                    {catMenuId === cat.id ? (
                                        <div className="room-category-menu">
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => {
                                                    startCatRename(cat);
                                                    setCatMenuId(null);
                                                }}
                                            >
                                                Rename
                                            </button>
                                            <button
                                                type="button"
                                                className="room-item-menu-action"
                                                onClick={() => {
                                                    deleteCategory(cat.id);
                                                    setCatMenuId(null);
                                                }}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                        <div className={`room-category-channels${collapsed ? " is-collapsed" : ""}`}>
                            <div className="room-category-channels-inner">
                                {catRooms.map((room, index) =>
                                    renderRoomItem(room, { indexInGroup: index, groupSize: catRooms.length, catId: cat.id }),
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                {discoverableRooms.length > 0 ? (
                    <div className="room-list-discoverable">
                        <div className="room-list-discoverable-title">Public channels</div>
                        {discoverableRooms.map((room) => {
                            const isVoiceChannel = room.isVoiceChannel === true || voiceChannelHintRoomIds.has(room.roomId);
                            const previewAvatarSources =
                                room.avatarMxc && room.avatarMxc.length > 0
                                    ? [
                                          thumbnailFromMxc(client, room.avatarMxc, 64, 64, "crop"),
                                          mediaFromMxc(client, room.avatarMxc),
                                      ].filter((source): source is string => Boolean(source))
                                    : [];
                            const isJoining = discoverableJoiningRoomId === room.roomId;
                            const subtitle =
                                room.topic && room.topic.trim().length > 0
                                    ? room.topic.trim()
                                    : isVoiceChannel
                                      ? "Voice channel"
                                      : `${room.memberCount ?? 0} members`;

                            return (
                                <div key={room.roomId} className="room-item room-item-discoverable">
                                    <div className="room-item-row">
                                        <span className={`room-item-main${showRoomAvatars ? "" : " room-item-main-no-avatar"}`}>
                                            {showRoomAvatars ? (
                                                <Avatar
                                                    className="room-item-avatar"
                                                    name={room.name}
                                                    src={previewAvatarSources[0] ?? null}
                                                    sources={previewAvatarSources}
                                                    seed={room.roomId}
                                                    userId={room.roomId}
                                                />
                                            ) : null}
                                            <span className="room-item-title-block">
                                                <span className="room-item-name">
                                                    {isVoiceChannel ? "\uD83D\uDD0A " : ""}
                                                    {showHashPrefix ? "#" : ""}
                                                    {room.name}
                                                </span>
                                                <span className="room-item-subtitle">{subtitle}</span>
                                            </span>
                                        </span>
                                        <button
                                            type="button"
                                            className="room-item-join-button"
                                            onClick={() => onJoinDiscoverableRoom?.(room.roomId)}
                                            disabled={isJoining || !onJoinDiscoverableRoom}
                                        >
                                            {isJoining ? "Joining..." : "Join"}
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : null}
                {uncategorized.length === 0 && categorizedGroups.length === 0 && discoverableRooms.length === 0 ? (
                    <div className="room-list-empty">No channels in this space.</div>
                ) : null}
            </div>
        </div>
    );
}
