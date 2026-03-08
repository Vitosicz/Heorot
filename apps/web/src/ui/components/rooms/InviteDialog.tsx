import React, { useEffect, useMemo, useState } from "react";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { inviteUsersToRoom, type InviteUsersResult } from "../../adapters/inviteAdapter";
import { RoomDialog } from "./RoomDialog";
import { getRoomDisplayName } from "./roomAdminUtils";

interface InviteDialogProps {
    client: MatrixClient;
    room: Room | null;
    open: boolean;
    onClose: () => void;
    onCompleted?: (result: InviteUsersResult) => void;
}

export function InviteDialog({
    client,
    room,
    open,
    onClose,
    onCompleted,
}: InviteDialogProps): React.ReactElement | null {
    const [userIdInput, setUserIdInput] = useState("");
    const [reason, setReason] = useState("");
    const [inviting, setInviting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const myUserId = client.getUserId() ?? "";
    const canInvite = useMemo(() => Boolean(room && myUserId && room.canInvite(myUserId)), [myUserId, room]);
    const roomLabel = room ? getRoomDisplayName(room) : "room";

    useEffect(() => {
        if (!open) {
            return;
        }

        setUserIdInput("");
        setReason("");
        setInviting(false);
        setError(null);
    }, [open, room?.roomId]);

    const submit = async (): Promise<void> => {
        if (!room) {
            setError("Select a room first.");
            return;
        }

        if (!canInvite) {
            setError("You do not have permission to invite users in this room.");
            return;
        }

        setInviting(true);
        setError(null);
        try {
            const result = await inviteUsersToRoom(client, room.roomId, userIdInput, reason);
            if (result.invited.length === 0) {
                const firstFailure = result.failed[0];
                if (firstFailure) {
                    setError(`${firstFailure.userId}: ${firstFailure.message}`);
                } else {
                    setError("Failed to invite users.");
                }
                return;
            }

            onCompleted?.(result);
            onClose();
        } catch (inviteError) {
            const message = inviteError instanceof Error ? inviteError.message : "Failed to invite user.";
            setError(message);
        } finally {
            setInviting(false);
        }
    };

    return (
        <RoomDialog
            open={open}
            title={`Invite to ${roomLabel}`}
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="room-dialog-button room-dialog-button-secondary" onClick={onClose} disabled={inviting}>
                        Cancel
                    </button>
                    <button type="button" className="room-dialog-button room-dialog-button-primary" onClick={() => void submit()} disabled={inviting || !room}>
                        {inviting ? "Inviting..." : "Invite"}
                    </button>
                </>
            }
        >
            <label className="room-dialog-field">
                <span>User ID(s)</span>
                <textarea
                    className="room-dialog-textarea"
                    value={userIdInput}
                    onChange={(event) => setUserIdInput(event.target.value)}
                    placeholder="@alice:example.org, @bob:example.org"
                    disabled={inviting}
                />
                <small className="room-dialog-muted">Use spaces, commas, or new lines to invite multiple users.</small>
            </label>
            <label className="room-dialog-field">
                <span>Reason (optional)</span>
                <input
                    className="room-dialog-input"
                    type="text"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Reason for invite"
                    disabled={inviting}
                />
            </label>
            {!canInvite && room ? (
                <p className="room-dialog-warning">You do not have invite permissions in this room.</p>
            ) : null}
            {error ? <p className="room-dialog-error">{error}</p> : null}
        </RoomDialog>
    );
}
