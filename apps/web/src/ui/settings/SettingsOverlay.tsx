import React, { useEffect, useMemo, useState } from "react";
import { RoomStateEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../components/Toast";
import { useMatrix } from "../providers/MatrixProvider";
import { SettingsNav, type SettingsNavSection } from "./SettingsNav";
import { ChannelsTab } from "./server/tabs/ChannelsTab";
import { DangerTab } from "./server/tabs/DangerTab";
import { EmojiTab } from "./server/tabs/EmojiTab";
import { MembersTab } from "./server/tabs/MembersTab";
import { OverviewTab } from "./server/tabs/OverviewTab";
import { PermissionsTab } from "./server/tabs/PermissionsTab";
import { VisibilityTab } from "./server/tabs/VisibilityTab";
import { AdvancedTab } from "./server/tabs/AdvancedTab";
import { AppearanceTab } from "./user/tabs/AppearanceTab";
import { AudioTab } from "./user/tabs/AudioTab";
import { DevicesTab } from "./user/tabs/DevicesTab";
import { EncryptionTab } from "./user/tabs/EncryptionTab";
import { MyAccountTab } from "./user/tabs/MyAccountTab";
import { NotificationsTab } from "./user/tabs/NotificationsTab";
import { PersonalEmojiTab } from "./user/tabs/PersonalEmojiTab";
import { PrivacyTab } from "./user/tabs/PrivacyTab";
import { ProfileTab } from "./user/tabs/ProfileTab";
import { SignOutTab } from "./user/tabs/SignOutTab";
import type { UserLocalSettings } from "./user/settingsStore";
import { VerificationDialog, type VerificationTarget } from "../components/verification/VerificationDialog";
import type { EmojiPackTarget } from "../emoji/EmojiPackTypes";

export type SettingsMode = "server" | "user";

const SERVER_NAV: SettingsNavSection[] = [
    {
        title: "Server",
        items: [
            { id: "overview", label: "Overview" },
            { id: "emoji", label: "Emoji" },
        ],
    },
    {
        title: "Channels",
        items: [{ id: "channels", label: "Channels" }],
    },
    {
        title: "Access",
        items: [{ id: "visibility", label: "Visibility" }],
    },
    {
        title: "Members & Permissions",
        items: [
            { id: "members", label: "Members" },
            { id: "permissions", label: "Permissions" },
        ],
    },
    {
        title: "Danger",
        items: [
            { id: "advanced", label: "Advanced" },
            { id: "danger", label: "Danger zone" },
        ],
    },
];

const USER_NAV: SettingsNavSection[] = [
    {
        title: "User Settings",
        items: [
            { id: "my-account", label: "My Account" },
            { id: "profile", label: "Profile" },
            { id: "emoji", label: "Emoji" },
            { id: "privacy", label: "Privacy & Safety" },
        ],
    },
    {
        title: "App Settings",
        items: [
            { id: "appearance", label: "Appearance" },
            { id: "notifications", label: "Notifications" },
            { id: "audio", label: "Audio" },
        ],
    },
    {
        title: "Security",
        items: [
            { id: "devices", label: "Devices" },
            { id: "encryption", label: "Encryption & Recovery" },
        ],
    },
    {
        title: "Danger",
        items: [{ id: "sign-out", label: "Sign out" }],
    },
];

interface SettingsOverlayProps {
    open: boolean;
    mode: SettingsMode;
    initialTab: string;
    client: MatrixClient;
    spaceRoom: Room | null;
    spaceChannels: Room[];
    activeRoomId: string | null;
    onSelectRoom: (roomId: string) => void;
    onOpenEmojiUpload: (target: EmojiPackTarget) => void;
    onOpenCreateRoomInSpace: (spaceId: string) => void;
    onRefreshSpaceChannels: (spaceId: string) => Promise<void>;
    onClose: () => void;
    onLeftSpace: (spaceId: string) => void;
    onLogout: () => Promise<void>;
    userSettings: UserLocalSettings;
    onUserSettingsChange: (settings: UserLocalSettings) => void;
    renderReactionImages: boolean;
    onToggleRenderReactionImages: (enabled: boolean) => void;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

function getDefaultTab(mode: SettingsMode): string {
    return mode === "server" ? "overview" : "my-account";
}

export function SettingsOverlay({
    open,
    mode,
    initialTab,
    client,
    spaceRoom,
    spaceChannels,
    activeRoomId,
    onSelectRoom,
    onOpenEmojiUpload,
    onOpenCreateRoomInSpace,
    onRefreshSpaceChannels,
    onClose,
    onLeftSpace,
    onLogout,
    userSettings,
    onUserSettingsChange,
    renderReactionImages,
    onToggleRenderReactionImages,
    onToast,
}: SettingsOverlayProps): React.ReactElement | null {
    const matrix = useMatrix();
    const [, setSpaceStateTick] = useState(0);
    const [activeTab, setActiveTab] = useState<string>(initialTab || getDefaultTab(mode));
    const [verificationOpen, setVerificationOpen] = useState(false);
    const [verificationTarget, setVerificationTarget] = useState<VerificationTarget | null>(null);
    const [verificationNonce, setVerificationNonce] = useState(0);

    useEffect(() => {
        if (!open) {
            setVerificationOpen(false);
            setVerificationTarget(null);
            return;
        }

        setActiveTab(initialTab || getDefaultTab(mode));
    }, [initialTab, mode, open]);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose, open]);

    useEffect(() => {
        if (!open || mode !== "server" || !spaceRoom) {
            return undefined;
        }

        const onStateEvent = (event: unknown): void => {
            const matrixEvent = event as { getRoomId?: () => string };
            if (matrixEvent.getRoomId?.() !== spaceRoom.roomId) {
                return;
            }

            setSpaceStateTick((tick) => tick + 1);
        };

        spaceRoom.currentState.on(RoomStateEvent.Events, onStateEvent as any);
        return () => {
            spaceRoom.currentState.removeListener(RoomStateEvent.Events, onStateEvent as any);
        };
    }, [mode, open, spaceRoom]);

    const navSections = mode === "server" ? SERVER_NAV : USER_NAV;
    const title = useMemo(() => {
        if (mode === "server") {
            const roomName = spaceRoom?.name || spaceRoom?.getCanonicalAlias() || spaceRoom?.roomId || "Server";
            return `Server Settings - ${roomName}`;
        }
        return "User Settings";
    }, [mode, spaceRoom]);

    if (!open) {
        return null;
    }

    const renderServerTab = (): React.ReactNode => {
        if (!spaceRoom) {
            return <div className="settings-empty">No space selected.</div>;
        }

        switch (activeTab) {
            case "overview":
                return <OverviewTab client={client} spaceRoom={spaceRoom} onToast={onToast} />;
            case "emoji":
                return (
                    <EmojiTab
                        client={client}
                        spaceRoom={spaceRoom}
                        onOpenUploadDialog={() =>
                            onOpenEmojiUpload({
                                kind: "space",
                                spaceId: spaceRoom.roomId,
                            })
                        }
                        onToast={onToast}
                    />
                );
            case "channels":
                return (
                    <ChannelsTab
                        client={client}
                        spaceId={spaceRoom.roomId}
                        rooms={spaceChannels}
                        activeRoomId={activeRoomId}
                        onSelectRoom={onSelectRoom}
                        onCreateChannel={() => onOpenCreateRoomInSpace(spaceRoom.roomId)}
                        onRefreshChannels={() => onRefreshSpaceChannels(spaceRoom.roomId)}
                    />
                );
            case "visibility":
                return <VisibilityTab client={client} spaceRoom={spaceRoom} onToast={onToast} />;
            case "members":
                return <MembersTab client={client} spaceRoom={spaceRoom} />;
            case "permissions":
                return <PermissionsTab client={client} spaceRoom={spaceRoom} onToast={onToast} />;
            case "advanced":
                return <AdvancedTab spaceRoom={spaceRoom} onToast={onToast} />;
            case "danger":
                return (
                    <DangerTab
                        client={client}
                        spaceRoom={spaceRoom}
                        onLeftSpace={onLeftSpace}
                        onToast={onToast}
                    />
                );
            default:
                return <OverviewTab client={client} spaceRoom={spaceRoom} onToast={onToast} />;
        }
    };

    const renderUserTab = (): React.ReactNode => {
        const ownUserId = client.getUserId() ?? "";

        const openOwnVerification = (): void => {
            if (!ownUserId) {
                onToast({
                    type: "error",
                    message: "Missing user id for verification flow.",
                });
                return;
            }

            setVerificationTarget({ userId: ownUserId });
            setVerificationOpen(true);
        };

        const openDeviceVerification = (target: VerificationTarget): void => {
            setVerificationTarget(target);
            setVerificationOpen(true);
        };

        switch (activeTab) {
            case "my-account":
                return <MyAccountTab client={client} onToast={onToast} onSignOut={onLogout} />;
            case "profile":
                return <ProfileTab client={client} onToast={onToast} />;
            case "emoji":
                return (
                    <PersonalEmojiTab
                        client={client}
                        onOpenUploadDialog={() =>
                            onOpenEmojiUpload({
                                kind: "personal",
                            })
                        }
                        onToast={onToast}
                    />
                );
            case "appearance":
                return (
                    <AppearanceTab
                        settings={userSettings.appearance}
                        renderReactionImages={renderReactionImages}
                        onToggleRenderReactionImages={onToggleRenderReactionImages}
                        onChange={(appearance) =>
                            onUserSettingsChange({
                                ...userSettings,
                                appearance,
                            })
                        }
                    />
                );
            case "notifications":
                return (
                    <NotificationsTab
                        settings={userSettings.notifications}
                        onChange={(notifications) =>
                            onUserSettingsChange({
                                ...userSettings,
                                notifications,
                            })
                        }
                    />
                );
            case "audio":
                return (
                    <AudioTab
                        settings={userSettings.audio}
                        onChange={(audio) =>
                            onUserSettingsChange({
                                ...userSettings,
                                audio,
                            })
                        }
                    />
                );
            case "privacy":
                return (
                    <PrivacyTab
                        settings={userSettings.privacy}
                        onChange={(privacy) =>
                            onUserSettingsChange({
                                ...userSettings,
                                privacy,
                            })
                        }
                    />
                );
            case "devices":
                return (
                    <DevicesTab
                        client={client}
                        verificationNonce={verificationNonce}
                        onOpenOwnVerification={openOwnVerification}
                        onOpenDeviceVerification={openDeviceVerification}
                    />
                );
            case "encryption":
                return (
                    <EncryptionTab
                        client={client}
                        verificationNonce={verificationNonce}
                        onOpenVerification={openOwnVerification}
                    />
                );
            case "sign-out":
                return <SignOutTab onSignOut={onLogout} />;
            default:
                return <MyAccountTab client={client} onToast={onToast} onSignOut={onLogout} />;
        }
    };

    return (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={title}>
            <div className="settings-shell">
                <aside className="settings-sidebar">
                    <SettingsNav sections={navSections} activeTab={activeTab} onChangeTab={setActiveTab} />
                </aside>
                <section className="settings-main">
                    <header className="settings-header">
                        <h1>{title}</h1>
                        <button type="button" className="settings-close" onClick={onClose} aria-label="Close settings">
                            x
                        </button>
                    </header>
                    <div className="settings-content">{mode === "server" ? renderServerTab() : renderUserTab()}</div>
                </section>
            </div>
            <VerificationDialog
                client={client}
                open={verificationOpen}
                target={verificationTarget}
                onClose={() => setVerificationOpen(false)}
                onCompleted={() => {
                    setVerificationNonce((value) => value + 1);
                    onToast({
                        type: "success",
                        message: "Verification completed.",
                    });
                    void matrix.refreshDeviceVerification();
                }}
            />
        </div>
    );
}
