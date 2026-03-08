import React, { useEffect, useMemo, useRef, useState } from "react";
import { EventType, RoomStateEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { mediaFromMxc, thumbnailFromMxc } from "../../../adapters/media";
import type { ToastState } from "../../../components/Toast";
import { useSpacePermissions } from "../../useSpacePermissions";

interface OverviewTabProps {
    client: MatrixClient;
    spaceRoom: Room;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

function getTopic(room: Room): string {
    const event = room.currentState.getStateEvents(EventType.RoomTopic, "");
    const content = event?.getContent() as { topic?: unknown } | undefined;
    return typeof content?.topic === "string" ? content.topic : "";
}

function getAvatarMxc(room: Room): string {
    const event = room.currentState.getStateEvents(EventType.RoomAvatar, "");
    const content = event?.getContent() as { url?: unknown } | undefined;
    if (typeof content?.url === "string" && content.url.startsWith("mxc://")) {
        return content.url;
    }

    return room.getMxcAvatarUrl() ?? "";
}

async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    document.execCommand("copy");
    document.body.removeChild(textArea);
}

export function OverviewTab({ client, spaceRoom, onToast }: OverviewTabProps): React.ReactElement {
    const permissions = useSpacePermissions(client, spaceRoom);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [, setRoomStateTick] = useState(0);
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [avatarMxc, setAvatarMxc] = useState("");
    const [uploadingAvatar, setUploadingAvatar] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const roomName = spaceRoom.name || spaceRoom.getCanonicalAlias() || spaceRoom.roomId;
    const roomTopic = getTopic(spaceRoom);
    const roomAvatarMxc = getAvatarMxc(spaceRoom);

    useEffect(() => {
        setName(roomName);
        setTopic(roomTopic);
        setAvatarMxc(roomAvatarMxc);
    }, [roomAvatarMxc, roomName, roomTopic, spaceRoom.roomId]);

    useEffect(() => {
        const onStateEvent = (event: unknown): void => {
            const matrixEvent = event as { getRoomId?: () => string };
            if (matrixEvent.getRoomId?.() !== spaceRoom.roomId) {
                return;
            }

            setRoomStateTick((tick) => tick + 1);
        };

        spaceRoom.currentState.on(RoomStateEvent.Events, onStateEvent as any);
        return () => {
            spaceRoom.currentState.removeListener(RoomStateEvent.Events, onStateEvent as any);
        };
    }, [spaceRoom]);

    const avatarPreview = useMemo(
        () =>
            thumbnailFromMxc(client, avatarMxc || roomAvatarMxc, 120, 120, "crop") ??
            mediaFromMxc(client, avatarMxc || roomAvatarMxc),
        [avatarMxc, client, roomAvatarMxc],
    );

    const hasChanges =
        (permissions.canEditName && name.trim() !== roomName.trim()) ||
        (permissions.canEditTopic && topic.trim() !== roomTopic.trim()) ||
        (permissions.canEditAvatar && avatarMxc !== roomAvatarMxc);

    const uploadAvatar = async (file: File): Promise<void> => {
        if (!permissions.canEditAvatar) {
            return;
        }

        setUploadingAvatar(true);
        setError(null);
        try {
            const upload = await client.uploadContent(file, {
                includeFilename: true,
                type: file.type || "application/octet-stream",
                name: file.name,
            });
            const mxc = upload.content_uri;
            if (!mxc || !mxc.startsWith("mxc://")) {
                throw new Error("Homeserver did not return a valid MXC URL.");
            }

            setAvatarMxc(mxc);
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : "Failed to upload avatar.");
        } finally {
            setUploadingAvatar(false);
        }
    };

    const save = async (): Promise<void> => {
        setSaving(true);
        setError(null);
        try {
            if (permissions.canEditName && name.trim() !== roomName.trim()) {
                await client.setRoomName(spaceRoom.roomId, name.trim());
            }

            if (permissions.canEditTopic && topic.trim() !== roomTopic.trim()) {
                await client.setRoomTopic(spaceRoom.roomId, topic.trim());
            }

            if (permissions.canEditAvatar && avatarMxc !== roomAvatarMxc) {
                const content = avatarMxc ? { url: avatarMxc } : {};
                await client.sendStateEvent(spaceRoom.roomId, EventType.RoomAvatar, content as any, "");
            }

            onToast({ type: "success", message: "Server overview updated." });
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to save server settings.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Overview</h2>
            <p className="settings-tab-description">
                Update Space profile details. These settings apply to all channels in this server.
            </p>

            <div className="settings-overview-avatar-row">
                <div className="settings-overview-avatar-preview">
                    {avatarPreview ? <img src={avatarPreview} alt="" /> : <span>{roomName.slice(0, 1).toUpperCase()}</span>}
                </div>
                <div className="settings-overview-avatar-actions">
                    <button
                        type="button"
                        className="settings-button"
                        disabled={!permissions.canEditAvatar || uploadingAvatar}
                        title={!permissions.canEditAvatar ? "You cannot edit server avatar." : "Upload avatar"}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        {uploadingAvatar ? "Uploading..." : "Upload avatar"}
                    </button>
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        disabled={!permissions.canEditAvatar || (!avatarMxc && !roomAvatarMxc)}
                        onClick={() => setAvatarMxc("")}
                    >
                        Remove avatar
                    </button>
                    <input
                        ref={fileInputRef}
                        className="settings-hidden-input"
                        type="file"
                        accept="image/*"
                        onChange={(event) => {
                            const selectedFile = event.target.files?.[0];
                            if (selectedFile) {
                                void uploadAvatar(selectedFile);
                            }
                            event.currentTarget.value = "";
                        }}
                    />
                </div>
            </div>

            <label className="settings-field">
                <span>Server name</span>
                <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={!permissions.canEditName || saving}
                    title={!permissions.canEditName ? "You cannot edit server name." : ""}
                />
            </label>

            <label className="settings-field">
                <span>Description</span>
                <textarea
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    disabled={!permissions.canEditTopic || saving}
                    title={!permissions.canEditTopic ? "You cannot edit server topic." : ""}
                />
            </label>

            {!permissions.canEditName || !permissions.canEditTopic || !permissions.canEditAvatar ? (
                <p className="settings-inline-note">
                    Some fields are read-only because your power level does not allow editing these state events.
                </p>
            ) : null}

            {error ? <p className="settings-inline-error">{error}</p> : null}

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button settings-button-secondary"
                    onClick={() =>
                        void copyText(spaceRoom.roomId)
                            .then(() => onToast({ type: "success", message: "Copied Space ID." }))
                            .catch((copyError: unknown) =>
                                onToast({
                                    type: "error",
                                    message:
                                        copyError instanceof Error
                                            ? copyError.message
                                            : "Failed to copy Space ID.",
                                }),
                            )
                    }
                >
                    Copy Space ID
                </button>
                <button
                    type="button"
                    className="settings-button"
                    disabled={!hasChanges || saving || uploadingAvatar}
                    onClick={() => void save()}
                >
                    {saving ? "Saving..." : "Save changes"}
                </button>
            </div>
        </div>
    );
}
