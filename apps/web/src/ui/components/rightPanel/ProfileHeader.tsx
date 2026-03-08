import React, { useEffect, useMemo, useRef, useState } from "react";

import { Avatar } from "../Avatar";
import type { PresenceVm } from "../../presence/buildPresenceVm";
import { toAvatarPresenceState } from "../../presence/buildPresenceVm";
import { PresenceText } from "../presence/PresenceText";

interface ProfileHeaderProps {
    displayName: string;
    userId: string;
    avatarSources: string[];
    presence: PresenceVm | null;
    onBack: () => void;
    onCopyMxid: () => Promise<void>;
    onCopyUserId: () => Promise<void>;
    onMessage?: () => Promise<void>;
}

function hashToHue(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index++) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % 360;
}

export function ProfileHeader({
    displayName,
    userId,
    avatarSources,
    presence,
    onBack,
    onCopyMxid,
    onCopyUserId,
    onMessage,
}: ProfileHeaderProps): React.ReactElement {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const hue = useMemo(() => hashToHue(userId), [userId]);
    const bannerStyle = useMemo(
        () => ({
            background: `linear-gradient(135deg, hsl(${hue} 62% 42%), hsl(${(hue + 48) % 360} 55% 28%))`,
        }),
        [hue],
    );

    useEffect(() => {
        if (!menuOpen) {
            return undefined;
        }

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target || menuRef.current?.contains(target)) {
                return;
            }
            setMenuOpen(false);
        };

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setMenuOpen(false);
            }
        };

        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [menuOpen]);

    return (
        <header className="rp-profile-hero">
            <div className="rp-profile-banner" style={bannerStyle} />
            <button type="button" className="rp-profile-close" onClick={onBack} aria-label="Close profile">
                x
            </button>
            <Avatar
                className="rp-profile-avatar"
                name={displayName}
                src={avatarSources[0] ?? null}
                sources={avatarSources}
                seed={userId}
                userId={userId}
                presenceState={toAvatarPresenceState(presence)}
            />
            <div className="rp-profile-main">
                <h2 className="rp-profile-name">{displayName}</h2>
                <div className="rp-profile-mxid">{userId}</div>
                {presence ? <PresenceText presence={presence} className="rp-profile-presence" /> : null}
            </div>
            <div className="rp-profile-actions">
                {onMessage ? (
                    <button type="button" className="rp-icon-btn rp-icon-btn-primary" onClick={() => void onMessage()}>
                        Message
                    </button>
                ) : null}
                <button type="button" className="rp-icon-btn" disabled>
                    Call
                </button>
                <button type="button" className="rp-icon-btn" disabled>
                    Add
                </button>
                <div className="rp-profile-menu" ref={menuRef}>
                    <button
                        type="button"
                        className="rp-icon-btn"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        onClick={() => setMenuOpen((open) => !open)}
                    >
                        ...
                    </button>
                    {menuOpen ? (
                        <div className="rp-profile-menu-panel" role="menu">
                            <button
                                type="button"
                                className="rp-profile-menu-item"
                                role="menuitem"
                                onClick={() => {
                                    void onCopyMxid();
                                    setMenuOpen(false);
                                }}
                            >
                                Copy MXID
                            </button>
                            <button
                                type="button"
                                className="rp-profile-menu-item"
                                role="menuitem"
                                onClick={() => {
                                    void onCopyUserId();
                                    setMenuOpen(false);
                                }}
                            >
                                Copy user ID
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        </header>
    );
}
