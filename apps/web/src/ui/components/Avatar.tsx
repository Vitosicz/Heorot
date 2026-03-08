import React, { useEffect, useMemo, useState } from "react";

import { getAvatarColor } from "../utils/avatarColor";
import type { PresenceState } from "../presence/buildPresenceVm";

interface AvatarProps {
    name: string;
    src?: string | null;
    sources?: Array<string | null | undefined>;
    className: string;
    seed?: string;
    userId?: string;
    presenceState?: Exclude<PresenceState, "unknown"> | null;
}

function getLocalpartFromUserId(userId?: string): string {
    if (!userId) {
        return "";
    }

    const withoutSigil = userId.startsWith("@") ? userId.slice(1) : userId;
    const localpart = withoutSigil.split(":")[0] ?? "";
    return localpart.trim();
}

function getInitials(name: string, userId?: string): string {
    const trimmedName = name.trim();
    if (trimmedName.length > 0) {
        return trimmedName[0]?.toUpperCase() ?? "?";
    }

    const localpart = getLocalpartFromUserId(userId);
    if (localpart.length > 0) {
        return localpart[0]?.toUpperCase() ?? "?";
    }

    return "?";
}

function buildSourceList(src?: string | null, sources?: Array<string | null | undefined>): string[] {
    const ordered = [
        src,
        ...(sources ?? []),
    ];

    return Array.from(
        new Set(
            ordered.filter((item): item is string => typeof item === "string" && item.length > 0),
        ),
    );
}

export function Avatar({ name, src, sources, className, seed, userId, presenceState }: AvatarProps): React.ReactElement {
    const [sourceIndex, setSourceIndex] = useState(0);
    const initials = useMemo(() => getInitials(name, userId), [name, userId]);
    const sourceList = useMemo(() => buildSourceList(src, sources), [src, sources]);
    const imageSrc = sourceList[sourceIndex] ?? null;
    const fallbackStyle = useMemo<React.CSSProperties | undefined>(() => {
        if (imageSrc || !seed) {
            return undefined;
        }

        return {
            backgroundColor: getAvatarColor(seed),
            color: "#ffffff",
            boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
        };
    }, [imageSrc, seed]);

    useEffect(() => {
        setSourceIndex(0);
    }, [sourceList]);

    return (
        <span className={`avatar ${className}`} aria-hidden="true">
            <span className="avatar-mask" style={fallbackStyle}>
                {imageSrc ? (
                    <img
                        className="avatar-image"
                        src={imageSrc}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={() => setSourceIndex((index) => index + 1)}
                    />
                ) : (
                    <span className="avatar-fallback">{initials}</span>
                )}
            </span>
            {presenceState ? <span className={`avatar-presence-dot is-${presenceState}`} /> : null}
        </span>
    );
}
