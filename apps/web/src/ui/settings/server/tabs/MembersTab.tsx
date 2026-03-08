import React, { useMemo } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { memberAvatarSources } from "../../../adapters/avatar";
import { Avatar } from "../../../components/Avatar";
import { getUserPowerLevel } from "../../../components/rooms/roomAdminUtils";
import { getPowerRoleLabel } from "../../useSpacePermissions";

interface MembersTabProps {
    client: MatrixClient;
    spaceRoom: Room;
}

interface MemberRow {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    avatarSources: string[];
    powerLevel: number;
}

export function MembersTab({ client, spaceRoom }: MembersTabProps): React.ReactElement {
    const members = useMemo(() => {
        return spaceRoom
            .getMembers()
            .filter((member) => member.membership === "join" || member.membership === "invite")
            .map((member): MemberRow => {
                const displayName = member.rawDisplayName || member.name || member.userId;
                const avatarSources = memberAvatarSources(client, member, 72, "crop");
                return {
                    userId: member.userId,
                    displayName,
                    avatarUrl: avatarSources[0] ?? null,
                    avatarSources,
                    powerLevel: getUserPowerLevel(spaceRoom, member.userId),
                };
            })
            .sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }));
    }, [client, spaceRoom]);

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Members</h2>
            <p className="settings-tab-description">Read-only member list for this Space.</p>

            <div className="settings-members-list">
                {members.map((member) => {
                    const role = getPowerRoleLabel(member.powerLevel);
                    return (
                        <div className="settings-members-row" key={member.userId}>
                            <Avatar
                                className="settings-members-avatar"
                                name={member.displayName}
                                src={member.avatarUrl}
                                sources={member.avatarSources}
                                seed={member.userId}
                                userId={member.userId}
                            />
                            <div className="settings-members-main">
                                <span className="settings-members-name">{member.displayName}</span>
                                <span className="settings-members-id">{member.userId}</span>
                            </div>
                            <span className={`settings-role-badge settings-role-${role.toLowerCase()}`}>
                                {role} ({member.powerLevel})
                            </span>
                        </div>
                    );
                })}
                {members.length === 0 ? <div className="settings-empty">No members found.</div> : null}
            </div>
        </div>
    );
}
