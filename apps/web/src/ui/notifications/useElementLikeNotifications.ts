import { useEffect, useRef } from "react";
import {
    ClientEvent,
    EventType,
    LOCAL_NOTIFICATION_SETTINGS_PREFIX,
    MatrixEventEvent,
    MsgType,
    RoomEvent,
    SyncState,
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    type SyncStateData,
} from "matrix-js-sdk/src/matrix";

import { mediaFromMxc, thumbnailFromMxc } from "../adapters/media";
import type { NotificationsSettings } from "../settings/user/settingsStore";
import { playNotificationSound } from "./sound";

interface UseElementLikeNotificationsOptions {
    client: MatrixClient;
    activeRoomId: string | null;
    hasOpenDialog: boolean;
    settings: NotificationsSettings;
}

const MAX_PENDING_ENCRYPTED = 20;
const RECENTLY_ACTIVE_THRESHOLD_MS = 2 * 60 * 1000;

function stripPlainReplyFallback(body: string): string {
    const lines = body.split("\n");
    while (lines.length > 0 && lines[0].startsWith("> ")) {
        lines.shift();
    }
    if (lines[0] === "") {
        lines.shift();
    }
    return lines.join("\n");
}

function roomDisplayName(room: Room): string {
    return room.name || room.getCanonicalAlias() || room.roomId;
}

function senderDisplayName(event: MatrixEvent): string {
    return event.sender?.name || event.getSender() || "Unknown user";
}

function localNotificationsAreSilenced(client: MatrixClient): boolean {
    const deviceId = client.getDeviceId();
    if (!deviceId) {
        return false;
    }

    const eventType = `${LOCAL_NOTIFICATION_SETTINGS_PREFIX.name}.${deviceId}` as const;
    const content = client.getAccountData(eventType)?.getContent() as { is_silenced?: unknown } | undefined;
    return content?.is_silenced === true;
}

async function createLocalNotificationSettingsIfNeeded(
    client: MatrixClient,
    settings: NotificationsSettings,
): Promise<void> {
    if (client.isGuest()) {
        return;
    }

    const deviceId = client.getDeviceId();
    if (!deviceId) {
        return;
    }

    const eventType = `${LOCAL_NOTIFICATION_SETTINGS_PREFIX.name}.${deviceId}` as const;
    if (client.getAccountData(eventType)) {
        return;
    }

    const isSilenced =
        !settings.notificationsEnabled && !settings.notificationBodyEnabled && !settings.audioNotificationsEnabled;
    await client.setLocalNotificationSettings(deviceId, {
        is_silenced: isSilenced,
    });
}

function notificationMessageForEvent(event: MatrixEvent): string | null {
    const content = event.getContent() as {
        body?: unknown;
        msgtype?: unknown;
        membership?: unknown;
        displayname?: unknown;
    };
    const body = typeof content.body === "string" ? stripPlainReplyFallback(content.body).trim() : "";
    const msgType = typeof content.msgtype === "string" ? content.msgtype : null;

    if (msgType === MsgType.Image) {
        return body ? `[Image] ${body}` : "[Image]";
    }
    if (msgType === MsgType.Video) {
        return body ? `[Video] ${body}` : "[Video]";
    }
    if (msgType === MsgType.File) {
        return body ? `[File] ${body}` : "[File]";
    }
    if (msgType === MsgType.Audio) {
        return body ? `[Audio] ${body}` : "[Audio]";
    }
    if (msgType === MsgType.Location) {
        return body ? `[Location] ${body}` : "[Location]";
    }
    if (body) {
        return body;
    }

    if (event.getType() === EventType.RoomMember) {
        const membership = typeof content.membership === "string" ? content.membership : "updated";
        const displayName = typeof content.displayname === "string" && content.displayname.length > 0
            ? content.displayname
            : senderDisplayName(event);
        if (membership === "join") {
            return `${displayName} joined the room`;
        }
        if (membership === "leave") {
            return `${displayName} left the room`;
        }
        return `${displayName} membership updated`;
    }

    return event.getType();
}

function buildAvatarUrl(client: MatrixClient, event: MatrixEvent): string | null {
    const avatarMxc = event.sender?.getMxcAvatarUrl?.() || "";
    return (
        thumbnailFromMxc(client, avatarMxc, 64, 64, "crop") ||
        mediaFromMxc(client, avatarMxc) ||
        null
    );
}

export function useElementLikeNotifications({
    client,
    activeRoomId,
    hasOpenDialog,
    settings,
}: UseElementLikeNotificationsOptions): void {
    const settingsRef = useRef(settings);
    const activeRoomIdRef = useRef(activeRoomId);
    const hasOpenDialogRef = useRef(hasOpenDialog);
    const pendingEncryptedEventIdsRef = useRef<string[]>([]);
    const notifsByRoomRef = useRef<Record<string, Notification[]>>({});
    const isSyncingRef = useRef(client.getSyncState() === SyncState.Syncing);
    const lastActivityTsRef = useRef<number>(Date.now());
    const lastMousePositionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    useEffect(() => {
        activeRoomIdRef.current = activeRoomId;
    }, [activeRoomId]);

    useEffect(() => {
        hasOpenDialogRef.current = hasOpenDialog;
    }, [hasOpenDialog]);

    useEffect(() => {
        const onUserActivity = (event: Event): void => {
            if (!document.hasFocus()) {
                return;
            }

            if (event.type === "mousemove") {
                const mouse = event as MouseEvent;
                if (
                    mouse.screenX === lastMousePositionRef.current.x &&
                    mouse.screenY === lastMousePositionRef.current.y
                ) {
                    return;
                }
                lastMousePositionRef.current = {
                    x: mouse.screenX,
                    y: mouse.screenY,
                };
            }

            lastActivityTsRef.current = Date.now();
        };

        const onWindowBlurred = (): void => {
            lastActivityTsRef.current = 0;
        };

        const onVisibilityChanged = (event: Event): void => {
            if (document.visibilityState === "hidden") {
                lastActivityTsRef.current = 0;
                return;
            }
            onUserActivity(event);
        };

        document.addEventListener("mousedown", onUserActivity);
        document.addEventListener("mousemove", onUserActivity);
        document.addEventListener("keydown", onUserActivity);
        document.addEventListener("visibilitychange", onVisibilityChanged);
        window.addEventListener("focus", onUserActivity);
        window.addEventListener("blur", onWindowBlurred);
        window.addEventListener("wheel", onUserActivity, { passive: true, capture: true });

        return () => {
            document.removeEventListener("mousedown", onUserActivity);
            document.removeEventListener("mousemove", onUserActivity);
            document.removeEventListener("keydown", onUserActivity);
            document.removeEventListener("visibilitychange", onVisibilityChanged);
            window.removeEventListener("focus", onUserActivity);
            window.removeEventListener("blur", onWindowBlurred);
            window.removeEventListener("wheel", onUserActivity, { capture: true });
        };
    }, []);

    useEffect(() => {
        const userActiveRecently = (): boolean => {
            if (!document.hasFocus()) {
                return false;
            }
            if (document.visibilityState === "hidden") {
                return false;
            }
            if (lastActivityTsRef.current <= 0) {
                return false;
            }
            return Date.now() - lastActivityTsRef.current <= RECENTLY_ACTIVE_THRESHOLD_MS;
        };

        const clearRoomNotifications = (roomId: string): void => {
            const list = notifsByRoomRef.current[roomId];
            if (!list || list.length === 0) {
                return;
            }

            for (const notification of list) {
                notification.close();
            }
            delete notifsByRoomRef.current[roomId];
        };

        const displayPopupNotification = (event: MatrixEvent, room: Room): void => {
            if (!settingsRef.current.notificationsEnabled) {
                return;
            }
            if (typeof Notification === "undefined" || Notification.permission !== "granted") {
                return;
            }
            if (localNotificationsAreSilenced(client)) {
                return;
            }

            let message = notificationMessageForEvent(event);
            if (!message) {
                return;
            }

            const senderName = senderDisplayName(event);
            const roomName = roomDisplayName(room);
            let title = roomName;

            if (!event.sender || roomName === event.sender.name || event.getType() === EventType.RoomMember) {
                title = roomName;
            } else {
                title = `${senderName} (${roomName})`;
            }

            if (!settingsRef.current.notificationBodyEnabled) {
                message = "";
            }

            const avatarUrl = buildAvatarUrl(client, event);
            const notification = new Notification(title, {
                body: message,
                icon: avatarUrl ?? undefined,
                tag: `${room.roomId}:${event.getId() ?? Date.now()}`,
            });

            notification.onclick = () => {
                window.focus();
                notification.close();
            };

            if (!notifsByRoomRef.current[room.roomId]) {
                notifsByRoomRef.current[room.roomId] = [];
            }
            notifsByRoomRef.current[room.roomId].push(notification);
        };

        const playAudioNotification = async (): Promise<void> => {
            if (!settingsRef.current.audioNotificationsEnabled) {
                return;
            }
            if (localNotificationsAreSilenced(client)) {
                return;
            }
            await playNotificationSound(settingsRef.current.customMessageSoundDataUrl);
        };

        const evaluateEvent = (event: MatrixEvent): void => {
            const roomId = event.getRoomId();
            if (!roomId) {
                return;
            }

            const room = client.getRoom(roomId);
            if (!room) {
                return;
            }

            const actions = client.getPushActionsForEvent(event);
            if (!actions?.notify) {
                return;
            }

            const threadRootId = event.threadRootId;
            const eventId = event.getId();
            const threadId = eventId && eventId !== threadRootId ? threadRootId : undefined;
            const isViewingEventTimeline = activeRoomIdRef.current === room.roomId && !threadId;

            if (isViewingEventTimeline && userActiveRecently() && !hasOpenDialogRef.current) {
                return;
            }

            displayPopupNotification(event, room);

            if (actions.tweaks?.sound) {
                void playAudioNotification().catch(() => undefined);
            }
        };

        const onSyncStateChange = (state: SyncState, _prevState: SyncState | null, data?: SyncStateData): void => {
            if (state === SyncState.Syncing) {
                isSyncingRef.current = true;
            } else if (state === SyncState.Stopped || state === SyncState.Error) {
                isSyncingRef.current = false;
            }

            if (![SyncState.Stopped, SyncState.Error].includes(state) && !data?.fromCache) {
                void createLocalNotificationSettingsIfNeeded(client, settingsRef.current).catch(() => undefined);
            }
        };

        const onEvent = (
            event: MatrixEvent,
            _room: Room | undefined,
            toStartOfTimeline: boolean | undefined,
            removed: boolean,
            data?: IRoomTimelineData,
        ): void => {
            if (removed) {
                return;
            }
            if (!data?.liveEvent || toStartOfTimeline) {
                return;
            }
            if (!isSyncingRef.current) {
                return;
            }
            if (event.getSender() === client.getUserId()) {
                return;
            }

            const timelineSet = data.timeline.getTimelineSet() as { threadListType?: unknown };
            if (timelineSet.threadListType !== null && timelineSet.threadListType !== undefined) {
                return;
            }

            void client.decryptEventIfNeeded(event);
            if (event.isBeingDecrypted() || event.isDecryptionFailure()) {
                const eventId = event.getId();
                if (!eventId) {
                    return;
                }

                pendingEncryptedEventIdsRef.current.push(eventId);
                while (pendingEncryptedEventIdsRef.current.length > MAX_PENDING_ENCRYPTED) {
                    pendingEncryptedEventIdsRef.current.shift();
                }
                return;
            }

            evaluateEvent(event);
        };

        const onEventDecrypted = (event: MatrixEvent): void => {
            if (event.isDecryptionFailure()) {
                return;
            }

            const eventId = event.getId();
            if (!eventId) {
                return;
            }

            const index = pendingEncryptedEventIdsRef.current.indexOf(eventId);
            if (index < 0) {
                return;
            }

            pendingEncryptedEventIdsRef.current.splice(index, 1);
            evaluateEvent(event);
        };

        const onRoomReceipt = (_event: MatrixEvent, room: Room): void => {
            if (room.getUnreadNotificationCount() !== 0) {
                return;
            }
            clearRoomNotifications(room.roomId);
        };

        client.on(RoomEvent.Timeline, onEvent);
        client.on(RoomEvent.Receipt, onRoomReceipt);
        client.on(MatrixEventEvent.Decrypted, onEventDecrypted);
        client.on(ClientEvent.Sync, onSyncStateChange);

        return () => {
            client.removeListener(RoomEvent.Timeline, onEvent);
            client.removeListener(RoomEvent.Receipt, onRoomReceipt);
            client.removeListener(MatrixEventEvent.Decrypted, onEventDecrypted);
            client.removeListener(ClientEvent.Sync, onSyncStateChange);

            for (const roomId of Object.keys(notifsByRoomRef.current)) {
                clearRoomNotifications(roomId);
            }
            pendingEncryptedEventIdsRef.current = [];
        };
    }, [client]);
}
