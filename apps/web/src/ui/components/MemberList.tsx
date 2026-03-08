import React, { useMemo } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { memberAvatarSources } from "../adapters/avatar";
import { Avatar } from "./Avatar";

interface MemberListProps {
    client: MatrixClient;
    room: Room | null;
}

interface RenderMember {
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    avatarSources: string[];
}

export function MemberList({ client, room }: MemberListProps): React.ReactElement {
    const members = useMemo(() => {
        if (!room) {
            return [];
        }

        return room
            .getMembers()
            .filter((member) => member.membership === "join" || member.membership === "invite")
            .map((member): RenderMember => {
                const displayName = member.rawDisplayName || member.name || member.userId;
                const avatarSources = memberAvatarSources(client, member, 68, "crop");
                const avatarUrl = avatarSources[0] ?? null;

                return {
                    userId: member.userId,
                    displayName,
                    avatarUrl,
                    avatarSources,
                };
            })
            .sort((left, right) => left.displayName.localeCompare(right.displayName));
    }, [client, room]);

    return (
        <aside className="members-sidebar">
            <div className="members-header">Members</div>
            <div className="members-list">
                {members.map((member) => (
                    <div className="member-item" key={member.userId}>
                        <Avatar
                            className="member-avatar"
                            name={member.displayName}
                            src={member.avatarUrl}
                            sources={member.avatarSources}
                            seed={member.userId}
                            userId={member.userId}
                        />
                        <span className="member-name">{member.displayName}</span>
                    </div>
                ))}
            </div>
        </aside>
    );
}
