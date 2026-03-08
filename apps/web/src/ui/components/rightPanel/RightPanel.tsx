import React from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import type { RightPanelMode } from "../../hooks/useSelectedUser";
import { MembersPanel } from "../rightSidebar/panels/MembersPanel";
import { SearchPanel } from "../rightSidebar/panels/SearchPanel";
import { PinsPanel } from "../rightSidebar/panels/PinsPanel";
import { InfoPanel } from "../rightSidebar/panels/InfoPanel";
import type { RightSidebarMode } from "./types";
import { UserProfilePanel } from "./UserProfilePanel";

interface RightPanelProps {
    client: MatrixClient;
    room: Room | null;
    activeSpaceRoom: Room | null;
    mode: RightPanelMode;
    roomMode: RightSidebarMode;
    searchQuery: string;
    onSearchQueryChange: (value: string) => void;
    onSelectUser: (userId: string) => void;
    onBackToRoom: () => void;
    onOpenRoomSettings: () => void;
    onCopyRoomLink: () => Promise<void>;
    onLeaveRoom: () => Promise<void>;
    onOpenRoom: (roomId: string) => void;
    onToast?: (toast: { type: "success" | "error" | "info"; message: string }) => void;
}

export function RightPanel({
    client,
    room,
    activeSpaceRoom,
    mode,
    roomMode,
    searchQuery,
    onSearchQueryChange,
    onSelectUser,
    onBackToRoom,
    onOpenRoomSettings,
    onCopyRoomLink,
    onLeaveRoom,
    onOpenRoom,
    onToast,
}: RightPanelProps): React.ReactElement {
    if (!room) {
        return (
            <aside className="right-panel">
                <div className="right-panel-empty">Select a room to view room info.</div>
            </aside>
        );
    }

    return (
        <aside className="right-panel">
            {mode.mode === "user" ? (
                <UserProfilePanel
                    client={client}
                    room={room}
                    activeSpaceRoom={activeSpaceRoom}
                    userId={mode.userId}
                    onBack={onBackToRoom}
                    onOpenRoom={onOpenRoom}
                    onToast={onToast}
                />
            ) : (
                <>
                    {roomMode === "members" ? (
                        <MembersPanel
                            client={client}
                            room={room}
                            activeSpaceRoom={activeSpaceRoom}
                            onSelectUser={onSelectUser}
                        />
                    ) : null}
                    {roomMode === "search" ? (
                        <SearchPanel
                            room={room}
                            query={searchQuery}
                            onQueryChange={onSearchQueryChange}
                        />
                    ) : null}
                    {roomMode === "pins" ? <PinsPanel room={room} /> : null}
                    {roomMode === "info" ? (
                        <InfoPanel
                            client={client}
                            room={room}
                            onOpenRoomSettings={onOpenRoomSettings}
                            onCopyRoomLink={onCopyRoomLink}
                            onLeaveRoom={onLeaveRoom}
                        />
                    ) : null}
                </>
            )}
        </aside>
    );
}
