import React from "react";

import type { AppearanceSettings } from "../settingsStore";

const CHAT_LINE_LENGTH_MIN_CH = 45;
const CHAT_LINE_LENGTH_MAX_CH = 120;
const CHAT_LINE_LENGTH_PREVIEW_BODY =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Vivamus porttitor, nibh at gravida tristique, est arcu lacinia velit, sed efficitur justo sem vel mauris.";

interface AppearanceTabProps {
    settings: AppearanceSettings;
    renderReactionImages: boolean;
    onToggleRenderReactionImages: (enabled: boolean) => void;
    onChange: (settings: AppearanceSettings) => void;
}

export function AppearanceTab({
    settings,
    renderReactionImages,
    onToggleRenderReactionImages,
    onChange,
}: AppearanceTabProps): React.ReactElement {
    const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.heorotDesktop);
    const useMaximumLineWidth = settings.chatLineLengthCh === 0;
    const effectiveLineLengthCh = useMaximumLineWidth
        ? CHAT_LINE_LENGTH_MAX_CH
        : Math.max(CHAT_LINE_LENGTH_MIN_CH, Math.min(CHAT_LINE_LENGTH_MAX_CH, settings.chatLineLengthCh));
    const previewStyle: React.CSSProperties | undefined = useMaximumLineWidth
        ? undefined
        : ({
              ["--settings-chat-preview-max-width" as "--settings-chat-preview-max-width"]: `${effectiveLineLengthCh}ch`,
          } as React.CSSProperties);

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Appearance</h2>
            <p className="settings-tab-description">Local-only UI preferences for this browser session profile.</p>

            <div className="settings-section-card">
                <h3>Theme</h3>
                <div className="settings-theme-row">
                    <button
                        type="button"
                        className={`settings-theme-button${settings.theme === "dark" ? " is-active" : ""}`}
                        onClick={() => onChange({ ...settings, theme: "dark" })}
                    >
                        Dark
                    </button>
                    <button
                        type="button"
                        className={`settings-theme-button${settings.theme === "light" ? " is-active" : ""}`}
                        onClick={() => onChange({ ...settings, theme: "light" })}
                    >
                        Light
                    </button>
                </div>
            </div>

            <div className="settings-section-card settings-chat-width-card">
                <h3>Chat line width</h3>
                <div className="settings-chat-width-preview">
                    <div className="settings-chat-preview-event" style={previewStyle}>
                        <span className="settings-chat-preview-avatar" aria-hidden="true">
                            V
                        </span>
                        <div className="settings-chat-preview-main">
                            <div className="settings-chat-preview-header">
                                <span className="settings-chat-preview-name">Vitosi</span>
                                <span className="settings-chat-preview-time">08:34</span>
                            </div>
                            <p className="settings-chat-preview-body">{CHAT_LINE_LENGTH_PREVIEW_BODY}</p>
                        </div>
                    </div>
                </div>
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={useMaximumLineWidth}
                        onChange={(event) =>
                            onChange({
                                ...settings,
                                chatLineLengthCh: event.target.checked ? 0 : CHAT_LINE_LENGTH_MAX_CH,
                            })
                        }
                    />
                    Use maximum width (current behavior)
                </label>
                <div className="settings-chat-width-slider-row">
                    <span className="settings-chat-width-slider-label">
                        {useMaximumLineWidth ? "Maximum" : `${effectiveLineLengthCh} ch`}
                    </span>
                    <input
                        type="range"
                        className="settings-chat-width-slider"
                        min={CHAT_LINE_LENGTH_MIN_CH}
                        max={CHAT_LINE_LENGTH_MAX_CH}
                        step={1}
                        value={effectiveLineLengthCh}
                        disabled={useMaximumLineWidth}
                        onChange={(event) => {
                            const parsedValue = Number.parseInt(event.target.value, 10);
                            if (!Number.isFinite(parsedValue)) {
                                return;
                            }
                            onChange({
                                ...settings,
                                chatLineLengthCh: Math.max(
                                    CHAT_LINE_LENGTH_MIN_CH,
                                    Math.min(CHAT_LINE_LENGTH_MAX_CH, parsedValue),
                                ),
                            });
                        }}
                    />
                    <div className="settings-chat-width-scale">
                        <span>{CHAT_LINE_LENGTH_MIN_CH} ch</span>
                        <span>{CHAT_LINE_LENGTH_MAX_CH} ch</span>
                    </div>
                </div>
            </div>
            <p className="settings-inline-note">Limits only message text width. The timeline keeps wrapping on word boundaries.</p>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.compactMode}
                    onChange={(event) => onChange({ ...settings, compactMode: event.target.checked })}
                />
                Compact mode (higher message density)
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.showTimestamps}
                    onChange={(event) => onChange({ ...settings, showTimestamps: event.target.checked })}
                />
                Show timestamps in timeline
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.showSpaceChannelAvatars}
                    onChange={(event) =>
                        onChange({
                            ...settings,
                            showSpaceChannelAvatars: event.target.checked,
                        })
                    }
                />
                Show avatars in Space channels list
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={renderReactionImages}
                    onChange={(event) => onToggleRenderReactionImages(event.target.checked)}
                />
                Render reaction images
            </label>
            {isDesktopRuntime ? (
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={settings.closeOnWindowCloseMinimize}
                        onChange={(event) =>
                            onChange({
                                ...settings,
                                closeOnWindowCloseMinimize: event.target.checked,
                            })
                        }
                    />
                    Close button minimizes app (desktop)
                </label>
            ) : null}
        </div>
    );
}
