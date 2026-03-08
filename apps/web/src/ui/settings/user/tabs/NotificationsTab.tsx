import React, { useRef, useState } from "react";

import type { NotificationsSettings } from "../settingsStore";
import { playNotificationSound } from "../../../notifications/sound";

interface NotificationsTabProps {
    settings: NotificationsSettings;
    onChange: (settings: NotificationsSettings) => void;
}

export function NotificationsTab({ settings, onChange }: NotificationsTabProps): React.ReactElement {
    const [error, setError] = useState<string | null>(null);
    const [testPending, setTestPending] = useState(false);
    const soundUploadRef = useRef<HTMLInputElement | null>(null);

    const desktopPermission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
    const desktopEnabled = settings.notificationsEnabled;

    const setDesktopEnabled = async (enabled: boolean): Promise<void> => {
        setError(null);

        if (!enabled) {
            onChange({ ...settings, notificationsEnabled: false });
            return;
        }

        if (typeof Notification === "undefined") {
            setError("Desktop notifications are not supported in this runtime.");
            return;
        }

        if (Notification.permission === "granted") {
            onChange({ ...settings, notificationsEnabled: true });
            return;
        }

        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            setError("Desktop notifications permission was denied.");
            onChange({ ...settings, notificationsEnabled: false });
            return;
        }

        onChange({ ...settings, notificationsEnabled: true });
    };

    const onSoundUploadChanged = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        if (!file.type.startsWith("audio/")) {
            setError("Selected file is not an audio file.");
            return;
        }

        setError(null);

        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = typeof reader.result === "string" ? reader.result : null;
            if (!dataUrl || !dataUrl.startsWith("data:")) {
                setError("Failed to read selected sound.");
                return;
            }

            onChange({
                ...settings,
                customMessageSoundDataUrl: dataUrl,
                customMessageSoundName: file.name,
            });
        };
        reader.onerror = () => {
            setError("Failed to load selected sound.");
        };
        reader.readAsDataURL(file);
    };

    const testSound = async (): Promise<void> => {
        setError(null);
        setTestPending(true);
        try {
            await playNotificationSound(settings.customMessageSoundDataUrl);
        } catch (soundError) {
            setError(soundError instanceof Error ? soundError.message : "Unable to play sound.");
        } finally {
            setTestPending(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Notifications</h2>
            <p className="settings-tab-description">
                Matrix-native local notification handling using Matrix push-actions.
            </p>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={desktopEnabled}
                    onChange={(event) => {
                        void setDesktopEnabled(event.target.checked);
                    }}
                />
                Enable desktop notifications for this session
            </label>
            <p className="settings-inline-note">
                Permission:{" "}
                {desktopPermission === "unsupported"
                    ? "unsupported"
                    : desktopPermission === "granted"
                      ? "granted"
                      : desktopPermission === "denied"
                        ? "denied"
                        : "default"}
            </p>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.notificationBodyEnabled}
                    onChange={(event) => onChange({ ...settings, notificationBodyEnabled: event.target.checked })}
                />
                Show message body in desktop notifications
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.audioNotificationsEnabled}
                    onChange={(event) => onChange({ ...settings, audioNotificationsEnabled: event.target.checked })}
                />
                Enable notification sound
            </label>

            <div className="settings-section-card">
                <h3>Message sound</h3>
                <p className="settings-inline-note">
                    Current:{" "}
                    {settings.customMessageSoundName && settings.customMessageSoundDataUrl
                        ? settings.customMessageSoundName
                        : "Default"}
                </p>
                <input
                    ref={soundUploadRef}
                    type="file"
                    accept="audio/*"
                    className="settings-hidden-input"
                    onChange={onSoundUploadChanged}
                    aria-label="Upload custom message sound"
                />
                <div className="settings-actions-row">
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        onClick={() => soundUploadRef.current?.click()}
                    >
                        Browse audio file
                    </button>
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        onClick={() =>
                            onChange({
                                ...settings,
                                customMessageSoundDataUrl: null,
                                customMessageSoundName: null,
                            })
                        }
                        disabled={!settings.customMessageSoundDataUrl}
                    >
                        Use default
                    </button>
                    <button
                        type="button"
                        className="settings-button"
                        onClick={() => {
                            void testSound();
                        }}
                        disabled={testPending}
                    >
                        {testPending ? "Testing..." : "Test sound"}
                    </button>
                </div>
            </div>

            {error ? <p className="settings-inline-error">{error}</p> : null}
        </div>
    );
}

