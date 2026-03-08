import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventType, JoinRule, RoomEvent, type MatrixClient, type MatrixEvent, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { memberAvatarSources } from "../../adapters/avatar";
import { getDirectRoomIds } from "../../adapters/dmAdapter";
import { useMatrix } from "../../providers/MatrixProvider";
import { isPresenceEnabledForClient } from "../../presence/presenceConfig";
import { toAvatarPresenceState } from "../../presence/buildPresenceVm";
import { usePresenceMap } from "../../presence/usePresence";
import { Avatar } from "../Avatar";
import { buildMatrixToRoomPermalink } from "../../utils/permalink";
import { AboutCard } from "./cards/AboutCard";
import { MediaCard } from "./cards/MediaCard";

interface RoomInfoPanelProps {
    client: MatrixClient;
    room: Room;
    onSelectUser: (userId: string) => void;
    onOpenInvite: () => void;
    onOpenRoomSettings: () => void;
    onLeaveRoom: () => Promise<void>;
    onToast?: (toast: { type: "success" | "error" | "info"; message: string }) => void;
}

function getRoomName(room: Room): string {
    return room.name || room.getCanonicalAlias() || room.roomId;
}

function getRoomTopic(room: Room): string {
    const topicEvent = room.currentState.getStateEvents(EventType.RoomTopic, "");
    const content = (topicEvent?.getContent() ?? {}) as { topic?: unknown };
    return typeof content.topic === "string" ? content.topic : "";
}

function getMembers(room: Room): RoomMember[] {
    return room
        .getMembers()
        .filter((member) => member.membership === "join" || member.membership === "invite")
        .sort((left, right) => {
            const leftName = left.rawDisplayName || left.name || left.userId;
            const rightName = right.rawDisplayName || right.name || right.userId;
            return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
        });
}

function getPinnedCount(room: Room): number {
    const pinnedEvents = room.currentState.getStateEvents(EventType.RoomPinnedEvents, "");
    const content = (pinnedEvents?.getContent() ?? {}) as { pinned?: unknown };
    if (!Array.isArray(content.pinned)) {
        return 0;
    }
    return content.pinned.length;
}

function isEncrypted(room: Room): boolean {
    return Boolean(room.currentState.getStateEvents(EventType.RoomEncryption, ""));
}

function isPublic(room: Room): boolean {
    const joinRulesEvent = room.currentState.getStateEvents(EventType.RoomJoinRules, "");
    const content = (joinRulesEvent?.getContent() ?? {}) as { join_rule?: unknown };
    return content.join_rule === JoinRule.Public;
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

export function RoomInfoPanel({
    client,
    room,
    onSelectUser,
    onOpenInvite,
    onOpenRoomSettings,
    onLeaveRoom,
    onToast,
}: RoomInfoPanelProps): React.ReactElement {
    const { config } = useMatrix();
    const [membersExpanded, setMembersExpanded] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [, setTagVersion] = useState(0);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const ownUserId = client.getUserId() ?? "";

    const directRoomIds = getDirectRoomIds(client);
    const isDirectMessage = directRoomIds.has(room.roomId);
    const topic = getRoomTopic(room);
    const roomName = getRoomName(room);
    const memberList = useMemo(() => getMembers(room), [room]);
    const presenceEnabled = useMemo(() => isPresenceEnabledForClient(config, client), [client, config]);
    const presenceByUserId = usePresenceMap(
        client,
        memberList.map((member) => member.userId),
        presenceEnabled,
    );
    const canEditTopic = Boolean(ownUserId && room.currentState.maySendStateEvent(EventType.RoomTopic, ownUserId));
    const favourite = Boolean(room.tags?.["m.favourite"]);
    const encrypted = isEncrypted(room);
    const publicRoom = isPublic(room);
    const pinnedCount = getPinnedCount(room);

    useEffect(() => {
        const onRoomTags = (_event: MatrixEvent): void => {
            setTagVersion((version) => version + 1);
        };

        room.on(RoomEvent.Tags, onRoomTags as any);
        return () => {
            room.removeListener(RoomEvent.Tags, onRoomTags as any);
        };
    }, [room]);

    useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target || menuRef.current?.contains(target)) {
                return;
            }
            setMenuOpen(false);
        };

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setMenuOpen(false);
            }
        };

        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [menuOpen]);

    const copyLink = useCallback(async (): Promise<void> => {
        try {
            await copyText(buildMatrixToRoomPermalink(room.roomId));
            onToast?.({ type: "success", message: "Room link copied." });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to copy room link.";
            onToast?.({ type: "error", message });
        }
    }, [onToast, room.roomId]);

    const toggleFavourite = useCallback(async (): Promise<void> => {
        try {
            if (favourite) {
                await client.deleteRoomTag(room.roomId, "m.favourite");
                onToast?.({ type: "success", message: "Removed from favourites." });
            } else {
                await client.setRoomTag(room.roomId, "m.favourite", {});
                onToast?.({ type: "success", message: "Added to favourites." });
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unable to update favourites.";
            onToast?.({ type: "error", message });
        }
    }, [client, favourite, onToast, room.roomId]);

    return (
        <div className="right-panel-body">
            <header className="rp-room-header">
                <div className="rp-room-title-wrap">
                    <h2 className="rp-room-title">
                        {isDirectMessage ? roomName : `#${roomName}`}
                    </h2>
                    {topic ? <p className="rp-room-topic">{topic}</p> : null}
                </div>
                <div className="rp-room-badges">
                    <span className={`rp-badge ${encrypted ? "rp-badge-safe" : "rp-badge-info"}`}>
                        {encrypted ? "Encrypted" : "Unencrypted"}
                    </span>
                    {!isDirectMessage && publicRoom ? <span className="rp-badge rp-badge-info">Public</span> : null}
                </div>
                <div className="rp-room-actions">
                    <button type="button" className="rp-icon-btn" onClick={() => onToast?.({ type: "info", message: "Search coming soon." })}>
                        Search
                    </button>
                    <button type="button" className="rp-icon-btn" onClick={() => onToast?.({ type: "info", message: `${pinnedCount} pinned messages.` })}>
                        Pins
                    </button>
                    <button type="button" className="rp-icon-btn" onClick={() => setMembersExpanded((expanded) => !expanded)}>
                        Members
                    </button>
                    <button type="button" className="rp-icon-btn" onClick={onOpenRoomSettings}>
                        Settings
                    </button>
                    <div className="rp-profile-menu" ref={menuRef}>
                        <button
                            type="button"
                            className="rp-icon-btn"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            onClick={() => setMenuOpen((open) => !open)}
                        >
                            ...
                        </button>
                        {menuOpen ? (
                            <div className="rp-profile-menu-panel" role="menu">
                                <button
                                    type="button"
                                    className="rp-profile-menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                        onOpenInvite();
                                        setMenuOpen(false);
                                    }}
                                >
                                    Invite
                                </button>
                                <button
                                    type="button"
                                    className="rp-profile-menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                        void toggleFavourite();
                                        setMenuOpen(false);
                                    }}
                                >
                                    {favourite ? "Unfavourite" : "Favourite"}
                                </button>
                                <button type="button" className="rp-profile-menu-item" role="menuitem" disabled>
                                    Export chat
                                </button>
                            </div>
                        ) : null}
                    </div>
                </div>
            </header>

            <AboutCard
                title="About"
                body={topic}
                emptyText="No topic set for this channel."
                action={
                    canEditTopic ? (
                        <button type="button" className="rp-inline-link" onClick={onOpenRoomSettings}>
                            Edit
                        </button>
                    ) : null
                }
            />

            <section className="rp-card">
                <header className="rp-card-header">
                    <h3 className="rp-card-title">Members</h3>
                    <span className="rp-row-value">{memberList.length}</span>
                </header>
                <div className="rp-members-avatars">
                    {memberList.slice(0, 8).map((member) => {
                        const displayName = member.rawDisplayName || member.name || member.userId;
                        const sources = memberAvatarSources(client, member, 72, "crop");
                        const presence = presenceByUserId.get(member.userId);
                        return (
                            <button
                                type="button"
                                className="rp-member-avatar-button"
                                key={member.userId}
                                onClick={() => onSelectUser(member.userId)}
                                title={displayName}
                            >
                                <Avatar
                                    className="rp-member-avatar"
                                    name={displayName}
                                    src={sources[0] ?? null}
                                    sources={sources}
                                    seed={member.userId}
                                    userId={member.userId}
                                    presenceState={presenceEnabled ? toAvatarPresenceState(presence) : null}
                                />
                            </button>
                        );
                    })}
                </div>
                {membersExpanded ? (
                    <div className="rp-members-list">
                        {memberList.map((member) => {
                            const displayName = member.rawDisplayName || member.name || member.userId;
                            const sources = memberAvatarSources(client, member, 72, "crop");
                            const presence = presenceByUserId.get(member.userId);
                            return (
                                <button
                                    type="button"
                                    className="rp-member-row"
                                    key={member.userId}
                                    onClick={() => onSelectUser(member.userId)}
                                >
                                    <Avatar
                                        className="rp-member-row-avatar"
                                        name={displayName}
                                        src={sources[0] ?? null}
                                        sources={sources}
                                        seed={member.userId}
                                        userId={member.userId}
                                        presenceState={presenceEnabled ? toAvatarPresenceState(presence) : null}
                                    />
                                    <span className="rp-member-row-meta">
                                        <span className="rp-member-row-name">{displayName}</span>
                                        <span className="rp-member-row-id">{member.userId}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ) : null}
            </section>

            <MediaCard title="Media & Files" description="Recent media and files will appear here." />

            <section className="rp-card rp-card-row-action">
                <button type="button" className="rp-row-button" onClick={() => void copyLink()}>
                    Copy link
                </button>
            </section>

            <section className="rp-card rp-danger-card">
                <header className="rp-card-header">
                    <h3 className="rp-card-title">Danger zone</h3>
                </header>
                <button type="button" className="rp-danger-button" onClick={() => void onLeaveRoom()}>
                    {isDirectMessage ? "Leave conversation" : "Leave room"}
                </button>
            </section>
        </div>
    );
}
