import React, { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import { describeJoinError, joinRoomWithRetry } from "../../adapters/joinAdapter";
import { RoomDialog } from "./RoomDialog";

interface JoinRoomDialogProps {
    client: MatrixClient;
    open: boolean;
    onClose: () => void;
    onJoined?: (roomId: string) => void;
    onJoinRequest?: (target: string) => Promise<string>;
}

export function JoinRoomDialog({
    client,
    open,
    onClose,
    onJoined,
    onJoinRequest,
}: JoinRoomDialogProps): React.ReactElement | null {
    const [roomIdOrAlias, setRoomIdOrAlias] = useState("");
    const [joining, setJoining] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }

        setRoomIdOrAlias("");
        setJoining(false);
        setError(null);
    }, [open]);

    const submit = async (): Promise<void> => {
        const target = roomIdOrAlias.trim();
        if (!target) {
            setError("Enter a room ID or alias.");
            return;
        }

        setJoining(true);
        setError(null);
        try {
            const joinedRoomId = onJoinRequest
                ? await onJoinRequest(target)
                : (await joinRoomWithRetry(client, target)).roomId;
            onJoined?.(joinedRoomId);
            onClose();
        } catch (joinError) {
            setError(describeJoinError(joinError, target));
        } finally {
            setJoining(false);
        }
    };

    return (
        <RoomDialog
            open={open}
            title="Join room"
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="room-dialog-button room-dialog-button-secondary" onClick={onClose} disabled={joining}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="room-dialog-button room-dialog-button-primary"
                        onClick={() => void submit()}
                        disabled={joining}
                    >
                        {joining ? "Joining..." : "Join"}
                    </button>
                </>
            }
        >
            <label className="room-dialog-field">
                <span>Room ID or alias</span>
                <input
                    className="room-dialog-input"
                    type="text"
                    value={roomIdOrAlias}
                    onChange={(event) => setRoomIdOrAlias(event.target.value)}
                    placeholder="!room:server.tld or #alias:server.tld"
                    disabled={joining}
                />
            </label>
            {error ? <p className="room-dialog-error">{error}</p> : null}
        </RoomDialog>
    );
}
