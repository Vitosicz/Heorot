import React from "react";

export interface SettingsNavItem {
    id: string;
    label: string;
}

export interface SettingsNavSection {
    title: string;
    items: SettingsNavItem[];
}

interface SettingsNavProps {
    sections: SettingsNavSection[];
    activeTab: string;
    onChangeTab: (tabId: string) => void;
}

export function SettingsNav({ sections, activeTab, onChangeTab }: SettingsNavProps): React.ReactElement {
    return (
        <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((section) => (
                <section className="settings-nav-section" key={section.title}>
                    <h3 className="settings-nav-title">{section.title}</h3>
                    <div className="settings-nav-items">
                        {section.items.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className={`settings-nav-item${activeTab === item.id ? " is-active" : ""}`}
                                onClick={() => onChangeTab(item.id)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                </section>
            ))}
        </nav>
    );
}

