import React, { useMemo } from "react";
import { EventType, type MatrixClient, type Room, type RoomMember } from "matrix-js-sdk/src/matrix";

import { memberAvatarSources } from "../../../adapters/avatar";
import { useMatrix } from "../../../providers/MatrixProvider";
import { getPresenceSortRank, toAvatarPresenceState } from "../../../presence/buildPresenceVm";
import { isPresenceEnabledForClient } from "../../../presence/presenceConfig";
import { usePresenceMap } from "../../../presence/usePresence";
import { Avatar } from "../../Avatar";

interface MembersPanelProps {
    client: MatrixClient;
    room: Room;
    activeSpaceRoom: Room | null;
    onSelectUser: (userId: string) => void;
}

function getVisibleMembers(room: Room): RoomMember[] {
    return room
        .getMembers()
        .filter((member) => member.membership === "join" || member.membership === "invite");
}

function getUserPowerLevel(room: Room | null, userId: string): number {
    if (!room) {
        return 0;
    }

    const powerLevelsEvent = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    const content = (powerLevelsEvent?.getContent() ?? {}) as {
        users?: Record<string, number>;
        users_default?: number;
    };

    const directLevel = content.users?.[userId];
    if (typeof directLevel === "number" && Number.isFinite(directLevel)) {
        return directLevel;
    }

    return typeof content.users_default === "number" && Number.isFinite(content.users_default) ? content.users_default : 0;
}

function getRoleLabel(level: number): string {
    if (level >= 100) {
        return "Admin";
    }
    if (level >= 50) {
        return "Mod";
    }
    return "Member";
}

function getLastActiveTs(member: RoomMember): number {
    const user = member.user as
        | {
              getLastActiveTs?: () => number;
          }
        | null
        | undefined;

    if (!user?.getLastActiveTs) {
        return 0;
    }

    try {
        return user.getLastActiveTs() ?? 0;
    } catch {
        return 0;
    }
}

export function MembersPanel({
    client,
    room,
    activeSpaceRoom,
    onSelectUser,
}: MembersPanelProps): React.ReactElement {
    const { config } = useMatrix();
    const members = useMemo(() => getVisibleMembers(room), [room]);
    const roleSourceRoom = activeSpaceRoom ?? room;
    const presenceEnabled = useMemo(() => isPresenceEnabledForClient(config, client), [client, config]);
    const presenceByUserId = usePresenceMap(
        client,
        members.map((member) => member.userId),
        presenceEnabled,
    );
    const orderedMembers = useMemo(() => {
        const copy = [...members];
        copy.sort((left, right) => {
            if (presenceEnabled) {
                const byPresence =
                    getPresenceSortRank(presenceByUserId.get(left.userId)) -
                    getPresenceSortRank(presenceByUserId.get(right.userId));
                if (byPresence !== 0) {
                    return byPresence;
                }
            }

            const byPower = getUserPowerLevel(roleSourceRoom, right.userId) - getUserPowerLevel(roleSourceRoom, left.userId);
            if (byPower !== 0) {
                return byPower;
            }

            if (presenceEnabled) {
                const byLastActive = getLastActiveTs(right) - getLastActiveTs(left);
                if (byLastActive !== 0) {
                    return byLastActive;
                }
            }

            const leftName = left.rawDisplayName || left.name || left.userId;
            const rightName = right.rawDisplayName || right.name || right.userId;
            return leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
        });
        return copy;
    }, [members, presenceByUserId, presenceEnabled, roleSourceRoom]);

    return (
        <div className="rs-panel">
            <div className="rs-panel-header">
                <h2 className="rs-panel-title">Members - {orderedMembers.length}</h2>
            </div>
            <div className="rs-members-list">
                {orderedMembers.map((member) => {
                    const displayName = member.rawDisplayName || member.name || member.userId;
                    const sources = memberAvatarSources(client, member, 72, "crop");
                    const roleLabel = getRoleLabel(getUserPowerLevel(roleSourceRoom, member.userId));
                    const presence = presenceByUserId.get(member.userId);

                    return (
                        <button
                            type="button"
                            className="rs-member-row"
                            key={member.userId}
                            onClick={() => onSelectUser(member.userId)}
                            title={member.userId}
                        >
                            <Avatar
                                className="rs-member-avatar"
                                name={displayName}
                                src={sources[0] ?? null}
                                sources={sources}
                                seed={member.userId}
                                userId={member.userId}
                                presenceState={presenceEnabled ? toAvatarPresenceState(presence) : null}
                            />
                            <span className="rs-member-meta">
                                <span className="rs-member-name">{displayName}</span>
                                <span className="rs-member-id">{member.userId}</span>
                            </span>
                            <span className="rs-member-badge">{roleLabel}</span>
                        </button>
                    );
                })}
                {orderedMembers.length === 0 ? <div className="rs-empty-state">No members found.</div> : null}
            </div>
        </div>
    );
}

