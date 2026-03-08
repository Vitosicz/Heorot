import React, { useEffect, useMemo, useState } from "react";
import { EventType, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../../../components/Toast";
import { getUserPowerLevel } from "../../../components/rooms/roomAdminUtils";

interface PermissionsTabProps {
    client: MatrixClient;
    spaceRoom: Room;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

interface PowerLevelsContent {
    events?: Record<string, number>;
    users?: Record<string, number>;
    events_default?: number;
    state_default?: number;
    users_default?: number;
    redact?: number;
    invite?: number;
    kick?: number;
    ban?: number;
    notifications?: Record<string, number>;
}

interface PowerLevelDraft {
    usersDefault: string;
    eventsDefault: string;
    stateDefault: string;
    invite: string;
    kick: string;
    ban: string;
    redact: string;
}

type UserPowerDraftMap = Record<string, string>;

function readPowerLevels(room: Room): PowerLevelsContent {
    const powerLevelsEvent = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    const content = powerLevelsEvent?.getContent() as PowerLevelsContent | undefined;
    return content ?? {};
}

function buildDraft(content: PowerLevelsContent): PowerLevelDraft {
    return {
        usersDefault: String(content.users_default ?? 0),
        eventsDefault: String(content.events_default ?? 0),
        stateDefault: String(content.state_default ?? 50),
        invite: String(content.invite ?? 0),
        kick: String(content.kick ?? 50),
        ban: String(content.ban ?? 50),
        redact: String(content.redact ?? 50),
    };
}

function parseDraftInteger(value: string): number | null {
    if (!/^-?\d+$/.test(value.trim())) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function isSameBaseValues(content: PowerLevelsContent, draft: PowerLevelDraft): boolean {
    return (
        (content.users_default ?? 0) === parseDraftInteger(draft.usersDefault) &&
        (content.events_default ?? 0) === parseDraftInteger(draft.eventsDefault) &&
        (content.state_default ?? 50) === parseDraftInteger(draft.stateDefault) &&
        (content.invite ?? 0) === parseDraftInteger(draft.invite) &&
        (content.kick ?? 50) === parseDraftInteger(draft.kick) &&
        (content.ban ?? 50) === parseDraftInteger(draft.ban) &&
        (content.redact ?? 50) === parseDraftInteger(draft.redact)
    );
}

export function PermissionsTab({ client, spaceRoom, onToast }: PermissionsTabProps): React.ReactElement {
    const [powerLevels, setPowerLevels] = useState<PowerLevelsContent>(() => readPowerLevels(spaceRoom));
    const [draft, setDraft] = useState<PowerLevelDraft>(() => buildDraft(powerLevels));
    const [userDraftById, setUserDraftById] = useState<UserPowerDraftMap>({});
    const [userActionPendingId, setUserActionPendingId] = useState<string | null>(null);
    const [addUserId, setAddUserId] = useState("");
    const [addUserLevel, setAddUserLevel] = useState("50");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const powerLevelsEvent = spaceRoom.currentState.getStateEvents(EventType.RoomPowerLevels, "");
    const powerLevelsSnapshot = JSON.stringify(powerLevelsEvent?.getContent() ?? {});

    useEffect(() => {
        const content = readPowerLevels(spaceRoom);
        setPowerLevels(content);
        setDraft(buildDraft(content));
        setUserDraftById(
            Object.fromEntries(
                Object.entries(content.users ?? {}).map(([userId, level]) => [userId, String(level)]),
            ),
        );
        setUserActionPendingId(null);
        setAddUserId("");
        setAddUserLevel("50");
        setSaving(false);
        setError(null);
    }, [powerLevelsSnapshot, spaceRoom.roomId]);

    const myUserId = client.getUserId() ?? "";
    const ownPowerLevel = myUserId ? getUserPowerLevel(spaceRoom, myUserId) : 0;
    const canEditPowerLevels = Boolean(
        myUserId && spaceRoom.currentState.maySendStateEvent(EventType.RoomPowerLevels, myUserId),
    );

    const eventPowerLevels = useMemo(
        () =>
            Object.entries(powerLevels.events ?? {}).sort(([leftType], [rightType]) =>
                leftType.localeCompare(rightType, undefined, { sensitivity: "base" }),
            ),
        [powerLevels.events],
    );
    const userPowerLevels = useMemo(
        () =>
            Object.entries(powerLevels.users ?? {}).sort((left, right) => {
                const levelDelta = right[1] - left[1];
                if (levelDelta !== 0) {
                    return levelDelta;
                }
                return left[0].localeCompare(right[0], undefined, { sensitivity: "base" });
            }),
        [powerLevels.users],
    );

    const hasChanges = useMemo(() => {
        if (!canEditPowerLevels) {
            return false;
        }
        return !isSameBaseValues(powerLevels, draft);
    }, [canEditPowerLevels, draft, powerLevels]);

    const save = async (): Promise<void> => {
        if (!canEditPowerLevels) {
            return;
        }

        const usersDefault = parseDraftInteger(draft.usersDefault);
        const eventsDefault = parseDraftInteger(draft.eventsDefault);
        const stateDefault = parseDraftInteger(draft.stateDefault);
        const invite = parseDraftInteger(draft.invite);
        const kick = parseDraftInteger(draft.kick);
        const ban = parseDraftInteger(draft.ban);
        const redact = parseDraftInteger(draft.redact);

        if (
            usersDefault === null ||
            eventsDefault === null ||
            stateDefault === null ||
            invite === null ||
            kick === null ||
            ban === null ||
            redact === null
        ) {
            setError("Power levels must be whole numbers.");
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const nextContent: PowerLevelsContent = {
                ...powerLevels,
                users_default: usersDefault,
                events_default: eventsDefault,
                state_default: stateDefault,
                invite,
                kick,
                ban,
                redact,
            };

            await client.sendStateEvent(spaceRoom.roomId, EventType.RoomPowerLevels, nextContent as Record<string, unknown>, "");
            setPowerLevels(nextContent);
            setDraft(buildDraft(nextContent));
            onToast({ type: "success", message: "Permissions updated." });
        } catch (saveError) {
            const message = saveError instanceof Error ? saveError.message : "Failed to update permissions.";
            setError(message);
        } finally {
            setSaving(false);
        }
    };

    const canManageTargetUser = (targetUserId: string): boolean => {
        if (!canEditPowerLevels || !myUserId) {
            return false;
        }
        if (targetUserId === myUserId) {
            return false;
        }
        return ownPowerLevel > getUserPowerLevel(spaceRoom, targetUserId);
    };

    const canSetTargetLevel = (targetUserId: string, nextLevel: number): boolean => {
        if (!canManageTargetUser(targetUserId)) {
            return false;
        }
        return nextLevel < ownPowerLevel;
    };

    const updateUserOverride = async (targetUserId: string, nextLevel: number | null): Promise<boolean> => {
        const normalizedTarget = targetUserId.trim();
        if (!normalizedTarget) {
            setError("User ID is required.");
            return false;
        }
        if (!canEditPowerLevels) {
            setError("You do not have permission to edit user power levels.");
            return false;
        }
        if (!canManageTargetUser(normalizedTarget)) {
            setError("You can only edit users with lower power level than your own.");
            return false;
        }
        if (nextLevel !== null && !canSetTargetLevel(normalizedTarget, nextLevel)) {
            setError("Target power level must be lower than your own power level.");
            return false;
        }

        setUserActionPendingId(normalizedTarget);
        setError(null);
        try {
            const latest = readPowerLevels(spaceRoom);
            const nextUsers = { ...(latest.users ?? {}) };
            if (nextLevel === null) {
                delete nextUsers[normalizedTarget];
            } else {
                nextUsers[normalizedTarget] = nextLevel;
            }

            const nextContent: PowerLevelsContent = {
                ...latest,
                users: nextUsers,
            };

            await client.sendStateEvent(spaceRoom.roomId, EventType.RoomPowerLevels, nextContent as Record<string, unknown>, "");

            setPowerLevels(nextContent);
            setDraft(buildDraft(nextContent));
            setUserDraftById((current) => {
                const nextDrafts = { ...current };
                if (nextLevel === null) {
                    delete nextDrafts[normalizedTarget];
                } else {
                    nextDrafts[normalizedTarget] = String(nextLevel);
                }
                return nextDrafts;
            });
            onToast({
                type: "success",
                message: nextLevel === null ? `Removed override for ${normalizedTarget}.` : `Updated ${normalizedTarget}.`,
            });
            return true;
        } catch (userSaveError) {
            const message = userSaveError instanceof Error ? userSaveError.message : "Failed to update user power level.";
            setError(message);
            return false;
        } finally {
            setUserActionPendingId(null);
        }
    };

    const addUserOverride = async (): Promise<void> => {
        const normalizedTarget = addUserId.trim();
        const level = parseDraftInteger(addUserLevel);
        if (!normalizedTarget) {
            setError("User ID is required.");
            return;
        }
        if (level === null) {
            setError("Power level must be a whole number.");
            return;
        }

        const success = await updateUserOverride(normalizedTarget, level);
        if (success) {
            setAddUserId("");
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Permissions</h2>
            <p className="settings-tab-description">
                Manage Space power levels from <code>m.room.power_levels</code>.
            </p>

            <div className="settings-permissions-summary">
                <div>
                    <strong>Role mapping:</strong> Admin {">="} 100, Mod {">="} 50, Member uses defaults.
                </div>
                <div>Your power level: {ownPowerLevel}</div>
                <div>users_default: {powerLevels.users_default ?? 0}</div>
                <div>events_default: {powerLevels.events_default ?? 0}</div>
                <div>state_default: {powerLevels.state_default ?? 50}</div>
                <div>invite/kick/ban/redact: {powerLevels.invite ?? 0}/{powerLevels.kick ?? 50}/{powerLevels.ban ?? 50}/{powerLevels.redact ?? 50}</div>
            </div>

            <div className="settings-section-card">
                <h3>Base power levels</h3>
                <div className="settings-power-grid">
                    <label className="settings-field">
                        <span>users_default</span>
                        <input
                            type="number"
                            value={draft.usersDefault}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    usersDefault: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>events_default</span>
                        <input
                            type="number"
                            value={draft.eventsDefault}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    eventsDefault: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>state_default</span>
                        <input
                            type="number"
                            value={draft.stateDefault}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    stateDefault: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>invite</span>
                        <input
                            type="number"
                            value={draft.invite}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    invite: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>kick</span>
                        <input
                            type="number"
                            value={draft.kick}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    kick: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>ban</span>
                        <input
                            type="number"
                            value={draft.ban}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    ban: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                    <label className="settings-field">
                        <span>redact</span>
                        <input
                            type="number"
                            value={draft.redact}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    redact: event.target.value,
                                }))
                            }
                            disabled={!canEditPowerLevels || saving}
                        />
                    </label>
                </div>
                {!canEditPowerLevels ? (
                    <p className="settings-inline-note">Read-only: your power level does not allow editing permissions.</p>
                ) : null}
                {error ? <p className="settings-inline-error">{error}</p> : null}
                <div className="settings-actions-row">
                    <button
                        type="button"
                        className="settings-button"
                        disabled={!hasChanges || saving || !canEditPowerLevels}
                        onClick={() => void save()}
                    >
                        {saving ? "Saving..." : "Save base levels"}
                    </button>
                </div>
            </div>

            <h3 className="settings-subtitle">Event type requirements</h3>
            <div className="settings-table-wrap">
                <table className="settings-table">
                    <thead>
                        <tr>
                            <th>Event type</th>
                            <th>Required PL</th>
                        </tr>
                    </thead>
                    <tbody>
                        {eventPowerLevels.map(([eventType, level]) => (
                            <tr key={eventType}>
                                <td>{eventType}</td>
                                <td>{level}</td>
                            </tr>
                        ))}
                        {eventPowerLevels.length === 0 ? (
                            <tr>
                                <td colSpan={2}>No explicit event overrides.</td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>

            <h3 className="settings-subtitle">User power levels</h3>
            <div className="settings-section-card">
                <h3>Add or update user override</h3>
                <div className="settings-user-override-add">
                    <label className="settings-field">
                        <span>User ID</span>
                        <input
                            type="text"
                            value={addUserId}
                            onChange={(event) => setAddUserId(event.target.value)}
                            placeholder="@alice:example.org"
                            disabled={!canEditPowerLevels || saving || userActionPendingId !== null}
                        />
                    </label>
                    <label className="settings-field">
                        <span>Power level</span>
                        <input
                            type="number"
                            value={addUserLevel}
                            onChange={(event) => setAddUserLevel(event.target.value)}
                            disabled={!canEditPowerLevels || saving || userActionPendingId !== null}
                        />
                    </label>
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        disabled={!canEditPowerLevels || saving || userActionPendingId !== null}
                        onClick={() => void addUserOverride()}
                    >
                        Set override
                    </button>
                </div>
            </div>
            <div className="settings-table-wrap">
                <table className="settings-table">
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>PL</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {userPowerLevels.map(([userId, level]) => {
                            const userDraftValue = userDraftById[userId] ?? String(level);
                            const parsedUserDraftLevel = parseDraftInteger(userDraftValue);
                            const canManageTarget = canManageTargetUser(userId);
                            const rowPending = userActionPendingId === userId;
                            const canSetFromDraft =
                                parsedUserDraftLevel !== null && canSetTargetLevel(userId, parsedUserDraftLevel);
                            const memberDefaultLevel = powerLevels.users_default ?? 0;

                            return (
                                <tr key={userId}>
                                    <td>{userId}</td>
                                    <td>{level}</td>
                                    <td>
                                        <div className="settings-user-override-actions">
                                            <input
                                                className="settings-user-override-level-input"
                                                type="number"
                                                value={userDraftValue}
                                                onChange={(event) =>
                                                    setUserDraftById((current) => ({
                                                        ...current,
                                                        [userId]: event.target.value,
                                                    }))
                                                }
                                                disabled={!canEditPowerLevels || saving || rowPending || !canManageTarget}
                                            />
                                            <button
                                                type="button"
                                                className="settings-button settings-button-secondary"
                                                disabled={!canEditPowerLevels || saving || rowPending || !canSetFromDraft}
                                                onClick={() => {
                                                    if (parsedUserDraftLevel === null) {
                                                        setError("Power level must be a whole number.");
                                                        return;
                                                    }
                                                    void updateUserOverride(userId, parsedUserDraftLevel);
                                                }}
                                            >
                                                Set
                                            </button>
                                            <button
                                                type="button"
                                                className="settings-button settings-button-secondary"
                                                disabled={!canEditPowerLevels || saving || rowPending || !canSetTargetLevel(userId, 100)}
                                                onClick={() => void updateUserOverride(userId, 100)}
                                            >
                                                Admin
                                            </button>
                                            <button
                                                type="button"
                                                className="settings-button settings-button-secondary"
                                                disabled={!canEditPowerLevels || saving || rowPending || !canSetTargetLevel(userId, 50)}
                                                onClick={() => void updateUserOverride(userId, 50)}
                                            >
                                                Mod
                                            </button>
                                            <button
                                                type="button"
                                                className="settings-button settings-button-secondary"
                                                disabled={
                                                    !canEditPowerLevels ||
                                                    saving ||
                                                    rowPending ||
                                                    !canSetTargetLevel(userId, memberDefaultLevel)
                                                }
                                                onClick={() => void updateUserOverride(userId, memberDefaultLevel)}
                                            >
                                                Member
                                            </button>
                                            <button
                                                type="button"
                                                className="settings-button settings-button-secondary"
                                                disabled={!canEditPowerLevels || saving || rowPending || !canManageTarget}
                                                onClick={() => void updateUserOverride(userId, null)}
                                            >
                                                Remove override
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                        {userPowerLevels.length === 0 ? (
                            <tr>
                                <td colSpan={3}>No explicit user power levels.</td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>

            <p className="settings-inline-note">
                You can edit only users with lower power level than your own, and target level must stay below your level.
            </p>
        </div>
    );
}
