import { useEffect, useMemo, useState } from "react";
import { UserEvent, type MatrixClient, type User } from "matrix-js-sdk/src/matrix";

import { buildPresenceVm, type PresenceVm } from "./buildPresenceVm";

function sanitizeUserIds(userIds: string[]): string[] {
    const unique = new Set<string>();
    const out: string[] = [];
    for (const userId of userIds) {
        if (typeof userId !== "string" || userId.length === 0 || unique.has(userId)) {
            continue;
        }
        unique.add(userId);
        out.push(userId);
    }
    return out;
}

export function usePresenceMap(
    client: MatrixClient | null,
    userIds: string[],
    enabled: boolean,
): Map<string, PresenceVm> {
    const idsKey = useMemo(() => userIds.join("\u0000"), [userIds]);
    const normalizedUserIds = useMemo(() => sanitizeUserIds(userIds), [idsKey]);
    const normalizedIdsKey = useMemo(() => normalizedUserIds.join("\u0000"), [normalizedUserIds]);
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        if (!client || !enabled || normalizedUserIds.length === 0) {
            return undefined;
        }

        const trackedUsers = new Set(normalizedUserIds);
        const onPresenceUpdate = (_event: unknown, user: User): void => {
            if (!user?.userId || !trackedUsers.has(user.userId)) {
                return;
            }

            setRevision((value) => value + 1);
        };

        client.on(UserEvent.Presence, onPresenceUpdate as any);
        client.on(UserEvent.CurrentlyActive, onPresenceUpdate as any);
        return () => {
            client.removeListener(UserEvent.Presence, onPresenceUpdate as any);
            client.removeListener(UserEvent.CurrentlyActive, onPresenceUpdate as any);
        };
    }, [client, enabled, normalizedIdsKey, normalizedUserIds]);

    return useMemo(() => {
        const output = new Map<string, PresenceVm>();
        if (!client || !enabled || normalizedUserIds.length === 0) {
            return output;
        }

        for (const userId of normalizedUserIds) {
            const user = client.getUser(userId);
            output.set(
                userId,
                buildPresenceVm({
                    presence: user?.presence,
                    currentlyActive: user?.currentlyActive,
                    lastActiveAgo: user?.lastActiveAgo,
                }),
            );
        }

        return output;
    }, [client, enabled, normalizedIdsKey, normalizedUserIds, revision]);
}

export function usePresenceVm(
    client: MatrixClient | null,
    userId: string | null | undefined,
    enabled: boolean,
): PresenceVm | null {
    const normalizedUserId = typeof userId === "string" && userId.length > 0 ? userId : null;
    const map = usePresenceMap(client, normalizedUserId ? [normalizedUserId] : [], enabled);
    if (!normalizedUserId) {
        return null;
    }

    return map.get(normalizedUserId) ?? null;
}

