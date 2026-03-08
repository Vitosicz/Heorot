import React, { useEffect, useMemo, useState } from "react";
import { EventType, KnownMembership, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { RoomDialog } from "./RoomDialog";
import {
    getActionPowerLevel,
    getBannedMembers,
    getJoinedOrInvitedMembers,
    getRoomDisplayName,
    getUserPowerLevel,
} from "./roomAdminUtils";

interface RoomModerationDialogProps {
    client: MatrixClient;
    room: Room | null;
    open: boolean;
    onClose: () => void;
}

function getMemberDisplayName(userId: string, displayName: string | null | undefined): string {
    return displayName || userId;
}

export function RoomModerationDialog({
    client,
    room,
    open,
    onClose,
}: RoomModerationDialogProps): React.ReactElement | null {
    const [reason, setReason] = useState("");
    const [powerInputByUserId, setPowerInputByUserId] = useState<Record<string, string>>({});
    const [pendingAction, setPendingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const myUserId = client.getUserId() ?? "";
    const roomLabel = room ? getRoomDisplayName(room) : "room";

    const members = useMemo(() => (room ? getJoinedOrInvitedMembers(room) : []), [room]);
    const bannedMembers = useMemo(() => (room ? getBannedMembers(room) : []), [room]);
    const ownPowerLevel = room && myUserId ? getUserPowerLevel(room, myUserId) : 0;
    const canManagePowerLevels = Boolean(
        room && myUserId && room.currentState.maySendStateEvent(EventType.RoomPowerLevels, myUserId),
    );
    const requiredKickLevel = room ? getActionPowerLevel(room, "kick") : 50;
    const requiredBanLevel = room ? getActionPowerLevel(room, "ban") : 50;

    useEffect(() => {
        if (!open || !room) {
            return;
        }

        const nextInput: Record<string, string> = {};
        for (const member of members) {
            nextInput[member.userId] = String(getUserPowerLevel(room, member.userId));
        }

        setPowerInputByUserId(nextInput);
        setReason("");
        setPendingAction(null);
        setError(null);
    }, [members, open, room]);

    const canModerateTarget = (targetUserId: string, requiredLevel: number): boolean => {
        if (!room || !myUserId) {
            return false;
        }

        if (targetUserId === myUserId) {
            return false;
        }

        if (ownPowerLevel < requiredLevel) {
            return false;
        }

        const targetPowerLevel = getUserPowerLevel(room, targetUserId);
        return ownPowerLevel > targetPowerLevel;
    };

    const applyPowerLevel = async (targetUserId: string, value: number): Promise<void> => {
        if (!room) {
            return;
        }

        setPendingAction(`pl:${targetUserId}`);
        setError(null);
        try {
            await client.setPowerLevel(room.roomId, targetUserId, value);
            setPowerInputByUserId((current) => ({
                ...current,
                [targetUserId]: String(value),
            }));
        } catch (powerError) {
            const message = powerError instanceof Error ? powerError.message : "Failed to set power level.";
            setError(message);
        } finally {
            setPendingAction(null);
        }
    };

    const runModerationAction = async (
        actionKey: string,
        action: () => Promise<unknown>,
        confirmMessage: string,
    ): Promise<void> => {
        if (!window.confirm(confirmMessage)) {
            return;
        }

        setPendingAction(actionKey);
        setError(null);
        try {
            await action();
        } catch (moderationError) {
            const message = moderationError instanceof Error ? moderationError.message : "Moderation action failed.";
            setError(message);
        } finally {
            setPendingAction(null);
        }
    };

    return (
        <RoomDialog
            open={open}
            title={`Moderation: ${roomLabel}`}
            onClose={onClose}
            footer={
                <button type="button" className="room-dialog-button room-dialog-button-primary" onClick={onClose}>
                    Close
                </button>
            }
        >
            <label className="room-dialog-field">
                <span>Moderation reason (optional)</span>
                <input
                    className="room-dialog-input"
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason for kick / ban actions"
                />
            </label>

            <h3 className="room-dialog-section-title">Members and roles</h3>
            <div className="room-moderation-list">
                {members.map((member) => {
                    const targetPowerLevel = room ? getUserPowerLevel(room, member.userId) : 0;
                    const displayName = getMemberDisplayName(member.userId, member.rawDisplayName || member.name);
                    const isInvited = member.membership === KnownMembership.Invite;
                    const canKickTarget = canModerateTarget(member.userId, requiredKickLevel);
                    const canBanTarget = canModerateTarget(member.userId, requiredBanLevel);
                    const actionReason = reason.trim() || undefined;

                    return (
                        <div className="room-moderation-item" key={member.userId}>
                            <div className="room-moderation-item-main">
                                <span className="room-moderation-item-name">{displayName}</span>
                                <span className="room-moderation-item-meta">
                                    {member.userId} . {isInvited ? "Invited" : "Joined"} . PL {targetPowerLevel}
                                </span>
                            </div>
                            <div className="room-moderation-item-actions">
                                {canManagePowerLevels ? (
                                    <>
                                        <input
                                            className="room-moderation-pl-input"
                                            type="number"
                                            value={powerInputByUserId[member.userId] ?? String(targetPowerLevel)}
                                            onChange={(event) =>
                                                setPowerInputByUserId((current) => ({
                                                    ...current,
                                                    [member.userId]: event.target.value,
                                                }))
                                            }
                                            disabled={pendingAction !== null}
                                        />
                                        <button
                                            type="button"
                                            className="room-dialog-button room-dialog-button-secondary"
                                            onClick={() => {
                                                const parsed = Number(powerInputByUserId[member.userId]);
                                                if (!Number.isInteger(parsed)) {
                                                    setError("Power level must be an integer.");
                                                    return;
                                                }

                                                void applyPowerLevel(member.userId, parsed);
                                            }}
                                            disabled={pendingAction !== null}
                                        >
                                            Set
                                        </button>
                                        <button
                                            type="button"
                                            className="room-dialog-button room-dialog-button-secondary"
                                            onClick={() => void applyPowerLevel(member.userId, 50)}
                                            disabled={pendingAction !== null}
                                        >
                                            Mod
                                        </button>
                                        <button
                                            type="button"
                                            className="room-dialog-button room-dialog-button-secondary"
                                            onClick={() => void applyPowerLevel(member.userId, 0)}
                                            disabled={pendingAction !== null}
                                        >
                                            User
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    type="button"
                                    className="room-dialog-button room-dialog-button-secondary"
                                    onClick={() => {
                                        if (!room) {
                                            return;
                                        }

                                        void runModerationAction(
                                            `kick:${member.userId}`,
                                            () => client.kick(room.roomId, member.userId, actionReason),
                                            `${isInvited ? "Remove invite for" : "Kick"} ${displayName}?`,
                                        );
                                    }}
                                    disabled={!room || !canKickTarget || pendingAction !== null}
                                >
                                    {isInvited ? "Remove invite" : "Kick"}
                                </button>
                                <button
                                    type="button"
                                    className="room-dialog-button room-dialog-button-danger"
                                    onClick={() => {
                                        if (!room) {
                                            return;
                                        }

                                        void runModerationAction(
                                            `ban:${member.userId}`,
                                            () => client.ban(room.roomId, member.userId, actionReason),
                                            `Ban ${displayName}?`,
                                        );
                                    }}
                                    disabled={!room || !canBanTarget || pendingAction !== null}
                                >
                                    Ban
                                </button>
                            </div>
                        </div>
                    );
                })}
                {members.length === 0 ? <p className="room-dialog-muted">No members to moderate.</p> : null}
            </div>

            <h3 className="room-dialog-section-title">Banned users</h3>
            <div className="room-moderation-list">
                {bannedMembers.map((member) => {
                    const displayName = getMemberDisplayName(member.userId, member.rawDisplayName || member.name);
                    const canUnbanTarget = canModerateTarget(member.userId, requiredBanLevel);
                    return (
                        <div className="room-moderation-item" key={member.userId}>
                            <div className="room-moderation-item-main">
                                <span className="room-moderation-item-name">{displayName}</span>
                                <span className="room-moderation-item-meta">{member.userId}</span>
                            </div>
                            <div className="room-moderation-item-actions">
                                <button
                                    type="button"
                                    className="room-dialog-button room-dialog-button-secondary"
                                    onClick={() => {
                                        if (!room) {
                                            return;
                                        }

                                        void runModerationAction(
                                            `unban:${member.userId}`,
                                            () => client.unban(room.roomId, member.userId),
                                            `Unban ${displayName}?`,
                                        );
                                    }}
                                    disabled={!room || !canUnbanTarget || pendingAction !== null}
                                >
                                    Unban
                                </button>
                            </div>
                        </div>
                    );
                })}
                {bannedMembers.length === 0 ? <p className="room-dialog-muted">No banned users.</p> : null}
            </div>

            {!canManagePowerLevels ? (
                <p className="room-dialog-warning">You do not have permission to manage room power levels.</p>
            ) : null}
            {error ? <p className="room-dialog-error">{error}</p> : null}
        </RoomDialog>
    );
}
