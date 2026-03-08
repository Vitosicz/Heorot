import React from "react";

import type { PrivacySettings } from "../settingsStore";

interface PrivacyTabProps {
    settings: PrivacySettings;
    onChange: (settings: PrivacySettings) => void;
}

export function PrivacyTab({ settings, onChange }: PrivacyTabProps): React.ReactElement {
    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Privacy & Safety</h2>
            <p className="settings-tab-description">
                Local placeholder settings. Backend privacy rules are TODO.
            </p>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.showReadReceipts}
                    onChange={(event) => onChange({ ...settings, showReadReceipts: event.target.checked })}
                />
                Show read receipts (stub)
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.allowDmsFromServerMembers}
                    onChange={(event) => onChange({ ...settings, allowDmsFromServerMembers: event.target.checked })}
                />
                Allow DMs from server members (stub)
            </label>
        </div>
    );
}

