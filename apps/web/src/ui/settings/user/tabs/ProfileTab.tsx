import React, { useEffect, useMemo, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import { mediaFromMxc, thumbnailFromMxc } from "../../../adapters/media";
import { Avatar } from "../../../components/Avatar";
import type { ToastState } from "../../../components/Toast";

interface ProfileTabProps {
    client: MatrixClient;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

export function ProfileTab({ client, onToast }: ProfileTabProps): React.ReactElement {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const userId = client.getUserId() ?? "";

    const [displayName, setDisplayName] = useState("");
    const [avatarMxc, setAvatarMxc] = useState("");
    const [baselineDisplayName, setBaselineDisplayName] = useState("");
    const [baselineAvatarMxc, setBaselineAvatarMxc] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let canceled = false;
        const loadProfile = async (): Promise<void> => {
            if (!userId) {
                return;
            }

            setLoading(true);
            setError(null);
            try {
                const info = await client.getProfileInfo(userId);
                if (canceled) {
                    return;
                }

                const nextDisplayName = info.displayname ?? "";
                const nextAvatarMxc = info.avatar_url ?? "";
                setDisplayName(nextDisplayName);
                setAvatarMxc(nextAvatarMxc);
                setBaselineDisplayName(nextDisplayName);
                setBaselineAvatarMxc(nextAvatarMxc);
            } catch (loadError) {
                if (!canceled) {
                    setError(loadError instanceof Error ? loadError.message : "Failed to load profile.");
                }
            } finally {
                if (!canceled) {
                    setLoading(false);
                }
            }
        };

        void loadProfile();
        return () => {
            canceled = true;
        };
    }, [client, userId]);

    const avatarPreview = useMemo(
        () =>
            thumbnailFromMxc(client, avatarMxc, 112, 112, "crop") ??
            mediaFromMxc(client, avatarMxc),
        [avatarMxc, client],
    );

    const hasChanges =
        displayName.trim() !== baselineDisplayName.trim() ||
        avatarMxc !== baselineAvatarMxc;

    const uploadAvatar = async (file: File): Promise<void> => {
        setUploading(true);
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
            setUploading(false);
        }
    };

    const saveProfile = async (): Promise<void> => {
        if (!userId || !hasChanges) {
            return;
        }

        setSaving(true);
        setError(null);
        try {
            if (displayName.trim() !== baselineDisplayName.trim()) {
                await client.setDisplayName(displayName.trim());
            }

            if (avatarMxc !== baselineAvatarMxc) {
                await client.setAvatarUrl(avatarMxc || "");
            }

            setBaselineDisplayName(displayName);
            setBaselineAvatarMxc(avatarMxc);
            onToast({ type: "success", message: "Profile updated." });
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to update profile.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Profile</h2>
            <p className="settings-tab-description">
                Global Matrix profile settings (same model as reference Matrix clients).
            </p>

            {loading ? <p className="settings-inline-note">Loading profile...</p> : null}

            <div className="settings-profile-row">
                <Avatar
                    className="settings-profile-avatar"
                    name={displayName || userId || "User"}
                    src={avatarPreview}
                    sources={[avatarPreview]}
                    seed={userId || undefined}
                    userId={userId || undefined}
                />
                <div className="settings-profile-actions">
                    <button
                        type="button"
                        className="settings-button"
                        disabled={uploading}
                        onClick={() => fileInputRef.current?.click()}
                    >
                        {uploading ? "Uploading..." : "Upload avatar"}
                    </button>
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        disabled={uploading || saving || !avatarMxc}
                        onClick={() => setAvatarMxc("")}
                    >
                        Clear avatar
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
                <span>Display name</span>
                <input
                    type="text"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    disabled={saving}
                />
            </label>

            {error ? <p className="settings-inline-error">{error}</p> : null}

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button"
                    disabled={!hasChanges || saving || uploading}
                    onClick={() => void saveProfile()}
                >
                    {saving ? "Saving..." : "Save profile"}
                </button>
            </div>
        </div>
    );
}
