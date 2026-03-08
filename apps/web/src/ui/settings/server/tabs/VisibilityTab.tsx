import React, { useEffect, useMemo, useState } from "react";
import {
    EventType,
    GuestAccess,
    HistoryVisibility,
    JoinRule,
    type MatrixClient,
    type Room,
} from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../../../components/Toast";

interface VisibilityTabProps {
    client: MatrixClient;
    spaceRoom: Room;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

function readJoinRule(room: Room): JoinRule {
    const event = room.currentState.getStateEvents(EventType.RoomJoinRules, "");
    const content = event?.getContent() as { join_rule?: unknown } | undefined;
    const value = typeof content?.join_rule === "string" ? content.join_rule : "";
    if (value === JoinRule.Public || value === JoinRule.Restricted || value === JoinRule.Knock) {
        return value;
    }
    return JoinRule.Invite;
}

function readHistoryVisibility(room: Room): HistoryVisibility {
    const event = room.currentState.getStateEvents(EventType.RoomHistoryVisibility, "");
    const content = event?.getContent() as { history_visibility?: unknown } | undefined;
    const value = typeof content?.history_visibility === "string" ? content.history_visibility : "";
    if (
        value === HistoryVisibility.Joined ||
        value === HistoryVisibility.Invited ||
        value === HistoryVisibility.WorldReadable
    ) {
        return value;
    }
    return HistoryVisibility.Shared;
}

function readGuestAccessEnabled(room: Room): boolean {
    const event = room.currentState.getStateEvents(EventType.RoomGuestAccess, "");
    const content = event?.getContent() as { guest_access?: unknown } | undefined;
    return content?.guest_access === GuestAccess.CanJoin;
}

export function VisibilityTab({ client, spaceRoom, onToast }: VisibilityTabProps): React.ReactElement {
    const [joinRule, setJoinRule] = useState<JoinRule>(() => readJoinRule(spaceRoom));
    const [historyVisibility, setHistoryVisibility] = useState<HistoryVisibility>(() => readHistoryVisibility(spaceRoom));
    const [guestAccessEnabled, setGuestAccessEnabled] = useState<boolean>(() => readGuestAccessEnabled(spaceRoom));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const myUserId = client.getUserId() ?? "";
    const canEditJoinRule = Boolean(myUserId && spaceRoom.currentState.maySendStateEvent(EventType.RoomJoinRules, myUserId));
    const canEditHistoryVisibility = Boolean(
        myUserId && spaceRoom.currentState.maySendStateEvent(EventType.RoomHistoryVisibility, myUserId),
    );
    const canEditGuestAccess = Boolean(
        myUserId && spaceRoom.currentState.maySendStateEvent(EventType.RoomGuestAccess, myUserId),
    );

    useEffect(() => {
        setJoinRule(readJoinRule(spaceRoom));
        setHistoryVisibility(readHistoryVisibility(spaceRoom));
        setGuestAccessEnabled(readGuestAccessEnabled(spaceRoom));
        setSaving(false);
        setError(null);
    }, [spaceRoom.roomId]);

    const hasChanges = useMemo(() => {
        return (
            (canEditJoinRule && joinRule !== readJoinRule(spaceRoom)) ||
            (canEditHistoryVisibility && historyVisibility !== readHistoryVisibility(spaceRoom)) ||
            (canEditGuestAccess && guestAccessEnabled !== readGuestAccessEnabled(spaceRoom))
        );
    }, [
        canEditGuestAccess,
        canEditHistoryVisibility,
        canEditJoinRule,
        guestAccessEnabled,
        historyVisibility,
        joinRule,
        spaceRoom,
    ]);

    const save = async (): Promise<void> => {
        setSaving(true);
        setError(null);
        try {
            const updates: Promise<unknown>[] = [];
            if (canEditJoinRule && joinRule !== readJoinRule(spaceRoom)) {
                updates.push(
                    client.sendStateEvent(
                        spaceRoom.roomId,
                        EventType.RoomJoinRules,
                        { join_rule: joinRule } as any,
                        "",
                    ),
                );
            }
            if (canEditHistoryVisibility && historyVisibility !== readHistoryVisibility(spaceRoom)) {
                updates.push(
                    client.sendStateEvent(
                        spaceRoom.roomId,
                        EventType.RoomHistoryVisibility,
                        { history_visibility: historyVisibility } as any,
                        "",
                    ),
                );
            }
            if (canEditGuestAccess && guestAccessEnabled !== readGuestAccessEnabled(spaceRoom)) {
                updates.push(
                    client.sendStateEvent(
                        spaceRoom.roomId,
                        EventType.RoomGuestAccess,
                        {
                            guest_access: guestAccessEnabled ? GuestAccess.CanJoin : GuestAccess.Forbidden,
                        } as any,
                        "",
                    ),
                );
            }

            await Promise.all(updates);
            onToast({ type: "success", message: "Visibility settings updated." });
        } catch (saveError) {
            const message = saveError instanceof Error ? saveError.message : "Failed to update visibility settings.";
            setError(message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Visibility</h2>
            <p className="settings-tab-description">
                Configure who can join this Space and how much history is visible.
            </p>

            <div className="settings-section-card">
                <label className="settings-field">
                    <span>Join rule</span>
                    <select
                        value={joinRule}
                        onChange={(event) => setJoinRule(event.target.value as JoinRule)}
                        disabled={saving || !canEditJoinRule}
                    >
                        <option value={JoinRule.Invite}>Invite only</option>
                        <option value={JoinRule.Public}>Public</option>
                        <option value={JoinRule.Restricted}>Restricted</option>
                        <option value={JoinRule.Knock}>Knock</option>
                    </select>
                </label>

                <label className="settings-field">
                    <span>History visibility</span>
                    <select
                        value={historyVisibility}
                        onChange={(event) => setHistoryVisibility(event.target.value as HistoryVisibility)}
                        disabled={saving || !canEditHistoryVisibility}
                    >
                        <option value={HistoryVisibility.Shared}>Shared</option>
                        <option value={HistoryVisibility.Joined}>Joined</option>
                        <option value={HistoryVisibility.Invited}>Invited</option>
                        <option value={HistoryVisibility.WorldReadable}>World readable</option>
                    </select>
                </label>

                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={guestAccessEnabled}
                        onChange={(event) => setGuestAccessEnabled(event.target.checked)}
                        disabled={saving || !canEditGuestAccess}
                    />
                    Allow guest users to join
                </label>

                {!canEditJoinRule || !canEditHistoryVisibility || !canEditGuestAccess ? (
                    <p className="settings-inline-note">
                        Some controls are read-only because your power level does not allow editing these state events.
                    </p>
                ) : null}
            </div>

            {error ? <p className="settings-inline-error">{error}</p> : null}

            <div className="settings-actions-row">
                <button
                    type="button"
                    className="settings-button"
                    disabled={!hasChanges || saving}
                    onClick={() => void save()}
                >
                    {saving ? "Saving..." : "Save changes"}
                </button>
            </div>
        </div>
    );
}
