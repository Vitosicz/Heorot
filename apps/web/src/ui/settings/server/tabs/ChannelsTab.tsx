import React, { useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { RoomList } from "../../../components/RoomList";

interface ChannelsTabProps {
    client: MatrixClient;
    spaceId: string;
    rooms: Room[];
    activeRoomId: string | null;
    onSelectRoom: (roomId: string) => void;
    onCreateChannel: () => void;
    onRefreshChannels: () => Promise<void>;
}

export function ChannelsTab({
    client,
    spaceId,
    rooms,
    activeRoomId,
    onSelectRoom,
    onCreateChannel,
    onRefreshChannels,
}: ChannelsTabProps): React.ReactElement {
    const [refreshing, setRefreshing] = useState(false);

    const handleRefresh = async (): Promise<void> => {
        if (refreshing) {
            return;
        }

        setRefreshing(true);
        try {
            await onRefreshChannels();
        } finally {
            setRefreshing(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Channels</h2>
            <p className="settings-tab-description">
                Reorder channels for this Space. Ordering is fixed and persisted per-space.
            </p>

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() => void handleRefresh()}
                    disabled={refreshing}
                >
                    {refreshing ? "Reloading..." : "Reload channels"}
                </button>
                <button type="button" className="settings-button settings-button-secondary" onClick={onCreateChannel}>
                    Create channel
                </button>
            </div>

            <div className="settings-channels-panel">
                <RoomList
                    client={client}
                    spaceId={spaceId}
                    rooms={rooms}
                    activeRoomId={activeRoomId}
                    orderingMode="manual"
                    showOrderingControls
                    showHashPrefix
                    onSelectRoom={onSelectRoom}
                />
            </div>
        </div>
    );
}
