import { useCallback, useEffect, useMemo, useState } from "react";

export type RightPanelMode = { mode: "room" } | { mode: "user"; userId: string };

interface UseSelectedUserResult {
    panelMode: RightPanelMode;
    selectUser: (userId: string) => void;
    clearSelectedUser: () => void;
}

export function useSelectedUser(roomId: string | null): UseSelectedUserResult {
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

    useEffect(() => {
        setSelectedUserId(null);
    }, [roomId]);

    const selectUser = useCallback((userId: string): void => {
        if (!userId) {
            return;
        }
        setSelectedUserId(userId);
    }, []);

    const clearSelectedUser = useCallback((): void => {
        setSelectedUserId(null);
    }, []);

    const panelMode = useMemo<RightPanelMode>(() => {
        if (selectedUserId) {
            return {
                mode: "user",
                userId: selectedUserId,
            };
        }

        return { mode: "room" };
    }, [selectedUserId]);

    return {
        panelMode,
        selectUser,
        clearSelectedUser,
    };
}
