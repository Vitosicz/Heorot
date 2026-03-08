import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type MatrixClient, type RoomMember } from "matrix-js-sdk/src/matrix";

import { createOrReuseDirectChat, createOrReuseDirectGroupChat, isValidMatrixUserId } from "../../adapters/dmAdapter";
import { mediaFromMxc, thumbnailFromMxc } from "../../adapters/media";
import { Avatar } from "../Avatar";
import { RoomDialog } from "./RoomDialog";

interface CreateDirectChatDialogProps {
    client: MatrixClient;
    open: boolean;
    onClose: () => void;
    onResolved?: (result: { roomId: string; created: boolean; isGroup: boolean; targetCount: number }) => void;
}

const SUGGESTIONS_LIMIT = 12;
const SEARCH_DEBOUNCE_MS = 150;

interface UserSuggestion {
    userId: string;
    displayName: string;
    avatarMxc: string | null;
    source: "local" | "directory" | "profile";
}

interface UserDirectoryResult {
    user_id?: unknown;
    display_name?: unknown;
    avatar_url?: unknown;
}

interface UserDirectoryResponse {
    results?: UserDirectoryResult[];
}

function toDisplayName(displayName: string | null | undefined, userId: string): string {
    if (displayName && displayName.trim().length > 0) {
        return displayName.trim();
    }
    return userId;
}

function normalize(text: string): string {
    return text.trim().toLocaleLowerCase();
}

function matchScore(term: string, suggestion: UserSuggestion): number {
    const userId = suggestion.userId.toLocaleLowerCase();
    const displayName = suggestion.displayName.toLocaleLowerCase();

    if (userId === term) {
        return 0;
    }
    if (displayName === term) {
        return 1;
    }
    if (userId.startsWith(term)) {
        return 2;
    }
    if (displayName.startsWith(term)) {
        return 3;
    }
    if (userId.includes(term)) {
        return 4;
    }
    if (displayName.includes(term)) {
        return 5;
    }
    return 6;
}

function collectLocalSuggestions(client: MatrixClient, ownUserId: string, term: string): UserSuggestion[] {
    const byUserId = new Map<string, UserSuggestion>();
    const normalizedTerm = normalize(term);

    for (const room of client.getRooms()) {
        for (const member of room.currentState.getMembers()) {
            const roomMember = member as RoomMember;
            const userId = roomMember.userId;
            if (!userId || userId === ownUserId || byUserId.has(userId)) {
                continue;
            }

            const membership = roomMember.membership;
            if (membership !== "join" && membership !== "invite" && membership !== "knock") {
                continue;
            }

            const displayName = toDisplayName(roomMember.name, userId);
            const searchable = `${userId} ${displayName}`.toLocaleLowerCase();
            if (normalizedTerm.length > 0 && !searchable.includes(normalizedTerm)) {
                continue;
            }

            byUserId.set(userId, {
                userId,
                displayName,
                avatarMxc: roomMember.getMxcAvatarUrl() || null,
                source: "local",
            });
        }
    }

    return Array.from(byUserId.values());
}

function findLocalSuggestionByUserId(client: MatrixClient, ownUserId: string, userId: string): UserSuggestion | null {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
        return null;
    }

    for (const room of client.getRooms()) {
        const member = room.getMember(normalizedUserId);
        if (!member || member.userId === ownUserId) {
            continue;
        }

        if (member.membership !== "join" && member.membership !== "invite" && member.membership !== "knock") {
            continue;
        }

        return {
            userId: normalizedUserId,
            displayName: toDisplayName(member.name, normalizedUserId),
            avatarMxc: member.getMxcAvatarUrl() || null,
            source: "local",
        };
    }

    return null;
}

function dedupeSuggestions(suggestions: UserSuggestion[]): UserSuggestion[] {
    const byUserId = new Map<string, UserSuggestion>();
    for (const suggestion of suggestions) {
        if (!byUserId.has(suggestion.userId)) {
            byUserId.set(suggestion.userId, suggestion);
        }
    }
    return Array.from(byUserId.values());
}

function mergeTargets(existing: UserSuggestion[], addition: UserSuggestion): UserSuggestion[] {
    if (existing.some((target) => target.userId === addition.userId)) {
        return existing;
    }
    return [...existing, addition];
}

export function CreateDirectChatDialog({
    client,
    open,
    onClose,
    onResolved,
}: CreateDirectChatDialogProps): React.ReactElement | null {
    const [queryInput, setQueryInput] = useState("");
    const [targets, setTargets] = useState<UserSuggestion[]>([]);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
    const [suggestionsOpen, setSuggestionsOpen] = useState(false);
    const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const autocompleteRef = useRef<HTMLDivElement | null>(null);
    const debounceTimerRef = useRef<number | null>(null);
    const searchNonceRef = useRef(0);
    const ownUserId = client.getUserId() ?? "";

    useEffect(() => {
        if (!open) {
            return;
        }

        setQueryInput("");
        setTargets([]);
        setCreating(false);
        setError(null);
        setSuggestions([]);
        setSuggestionsOpen(false);
        setActiveSuggestionIndex(0);
    }, [open]);

    useEffect(
        () => () => {
            if (debounceTimerRef.current !== null) {
                window.clearTimeout(debounceTimerRef.current);
            }
        },
        [],
    );

    useEffect(() => {
        if (!suggestionsOpen) {
            return;
        }

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            const autocompleteNode = autocompleteRef.current;
            if (autocompleteNode?.contains(target) || inputRef.current?.contains(target)) {
                return;
            }

            setSuggestionsOpen(false);
        };

        window.addEventListener("mousedown", onMouseDown);
        return () => {
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [suggestionsOpen]);

    const buildTargetFromUserId = useCallback(
        async (candidateUserId: string): Promise<UserSuggestion> => {
            const targetUserId = candidateUserId.trim();
            if (!isValidMatrixUserId(targetUserId)) {
                throw new Error("Enter a valid Matrix user ID (example: @alice:example.org).");
            }

            if (targetUserId === ownUserId) {
                throw new Error("You cannot create a direct chat with yourself.");
            }

            const known =
                targets.find((target) => target.userId === targetUserId) ||
                suggestions.find((suggestion) => suggestion.userId === targetUserId) ||
                findLocalSuggestionByUserId(client, ownUserId, targetUserId);
            if (known) {
                return known;
            }

            const user = client.getUser(targetUserId);
            let displayName = user?.displayName ?? targetUserId;
            let avatarMxc = user?.avatarUrl ?? null;

            try {
                const profile = await client.getProfileInfo(targetUserId);
                displayName = toDisplayName(profile.displayname, targetUserId);
                avatarMxc = typeof profile.avatar_url === "string" ? profile.avatar_url : avatarMxc;
            } catch {
                displayName = toDisplayName(displayName, targetUserId);
            }

            return {
                userId: targetUserId,
                displayName,
                avatarMxc,
                source: "profile",
            };
        },
        [client, ownUserId, suggestions, targets],
    );

    const updateSuggestions = async (term: string): Promise<void> => {
        const trimmed = term.trim();
        if (!trimmed) {
            setSuggestions([]);
            setSuggestionsOpen(false);
            return;
        }

        const normalizedTerm = normalize(trimmed);
        const nonce = searchNonceRef.current + 1;
        searchNonceRef.current = nonce;

        const localSuggestions = collectLocalSuggestions(client, ownUserId, trimmed);
        let directorySuggestions: UserSuggestion[] = [];

        try {
            const response = (await client.searchUserDirectory({
                term: trimmed,
                limit: 20,
            })) as UserDirectoryResponse;
            if (searchNonceRef.current !== nonce) {
                return;
            }

            const results = Array.isArray(response.results) ? response.results : [];
            directorySuggestions = results.flatMap((entry): UserSuggestion[] => {
                if (typeof entry.user_id !== "string" || entry.user_id.length === 0 || entry.user_id === ownUserId) {
                    return [];
                }

                return [
                    {
                        userId: entry.user_id,
                        displayName: toDisplayName(
                            typeof entry.display_name === "string" ? entry.display_name : null,
                            entry.user_id,
                        ),
                        avatarMxc: typeof entry.avatar_url === "string" ? entry.avatar_url : null,
                        source: "directory",
                    },
                ];
            });
        } catch {
            directorySuggestions = [];
        }

        let profileSuggestion: UserSuggestion[] = [];
        if (trimmed.startsWith("@") && trimmed.includes(":")) {
            const hasKnownCandidate = localSuggestions.some((entry) => entry.userId === trimmed) ||
                directorySuggestions.some((entry) => entry.userId === trimmed);

            if (!hasKnownCandidate) {
                try {
                    const profile = await client.getProfileInfo(trimmed);
                    if (searchNonceRef.current !== nonce) {
                        return;
                    }

                    profileSuggestion = [
                        {
                            userId: trimmed,
                            displayName: toDisplayName(profile.displayname, trimmed),
                            avatarMxc: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
                            source: "profile",
                        },
                    ];
                } catch {
                    profileSuggestion = [];
                }
            }
        }

        const merged = dedupeSuggestions([
            ...profileSuggestion,
            ...localSuggestions,
            ...directorySuggestions,
        ])
            .filter((entry) => {
                const searchable = `${entry.userId} ${entry.displayName}`.toLocaleLowerCase();
                return searchable.includes(normalizedTerm);
            })
            .sort((left, right) => {
                const leftScore = matchScore(normalizedTerm, left);
                const rightScore = matchScore(normalizedTerm, right);
                if (leftScore !== rightScore) {
                    return leftScore - rightScore;
                }

                if (left.source !== right.source) {
                    if (left.source === "profile") {
                        return -1;
                    }
                    if (right.source === "profile") {
                        return 1;
                    }
                    if (left.source === "local") {
                        return -1;
                    }
                    if (right.source === "local") {
                        return 1;
                    }
                }

                return left.displayName.localeCompare(right.displayName, undefined, {
                    sensitivity: "base",
                });
            })
            .slice(0, SUGGESTIONS_LIMIT);

        setSuggestions(merged);
        setActiveSuggestionIndex(0);
        setSuggestionsOpen(merged.length > 0);
    };

    const setSearchInput = (value: string): void => {
        setQueryInput(value);
        setError(null);
        setActiveSuggestionIndex(0);

        if (debounceTimerRef.current !== null) {
            window.clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }

        const trimmed = value.trim();
        if (!trimmed) {
            searchNonceRef.current += 1;
            setSuggestions([]);
            setSuggestionsOpen(false);
            return;
        }

        debounceTimerRef.current = window.setTimeout(() => {
            void updateSuggestions(trimmed);
        }, SEARCH_DEBOUNCE_MS);
    };

    const removeTarget = useCallback((userId: string): void => {
        setTargets((current) => current.filter((target) => target.userId !== userId));
    }, []);

    const addTarget = useCallback((target: UserSuggestion): void => {
        setTargets((current) => mergeTargets(current, target));
        setQueryInput("");
        setError(null);
        setSuggestionsOpen(false);
        setSuggestions([]);
        setActiveSuggestionIndex(0);
        inputRef.current?.focus();
    }, []);

    const toggleTarget = useCallback((target: UserSuggestion): void => {
        setTargets((current) => {
            if (current.some((entry) => entry.userId === target.userId)) {
                return current.filter((entry) => entry.userId !== target.userId);
            }
            return [...current, target];
        });
        setQueryInput("");
        setError(null);
        setSuggestionsOpen(false);
        setSuggestions([]);
        setActiveSuggestionIndex(0);
        inputRef.current?.focus();
    }, []);

    const addTypedTarget = useCallback(async (): Promise<boolean> => {
        const typed = queryInput.trim();
        if (!typed) {
            return false;
        }

        try {
            const target = await buildTargetFromUserId(typed);
            addTarget(target);
            return true;
        } catch (addError) {
            const message = addError instanceof Error ? addError.message : "Unable to add this user.";
            setError(message);
            return false;
        }
    }, [addTarget, buildTargetFromUserId, queryInput]);

    const submit = async (): Promise<void> => {
        if (creating) {
            return;
        }

        setError(null);

        let nextTargets = [...targets];
        const typed = queryInput.trim();

        if (typed.length > 0 && isValidMatrixUserId(typed)) {
            try {
                const typedTarget = await buildTargetFromUserId(typed);
                nextTargets = mergeTargets(nextTargets, typedTarget);
            } catch (submitError) {
                const message = submitError instanceof Error ? submitError.message : "Unable to add this user.";
                setError(message);
                return;
            }
        } else if (typed.length > 0 && nextTargets.length === 0) {
            setError("Enter a valid Matrix user ID (example: @alice:example.org).");
            return;
        }

        if (nextTargets.length === 0) {
            setError("Select at least one user to start a chat.");
            return;
        }

        const targetUserIds = Array.from(new Set(nextTargets.map((target) => target.userId)));
        if (targetUserIds.length === 0) {
            setError("Select at least one user to start a chat.");
            return;
        }

        setTargets(nextTargets);
        setQueryInput("");
        setCreating(true);
        try {
            if (targetUserIds.length === 1) {
                const result = await createOrReuseDirectChat(client, targetUserIds[0]);
                onResolved?.({
                    ...result,
                    isGroup: false,
                    targetCount: 1,
                });
            } else {
                const result = await createOrReuseDirectGroupChat(client, targetUserIds);
                onResolved?.({
                    ...result,
                    isGroup: true,
                    targetCount: targetUserIds.length,
                });
            }
            onClose();
        } catch (createError) {
            const message = createError instanceof Error ? createError.message : "Failed to open chat.";
            setError(message);
        } finally {
            setCreating(false);
        }
    };

    const activeSuggestion = useMemo(
        () => (suggestions.length > 0 ? suggestions[activeSuggestionIndex] ?? suggestions[0] : null),
        [activeSuggestionIndex, suggestions],
    );
    const selectedUserIds = useMemo(
        () => new Set(targets.map((target) => target.userId)),
        [targets],
    );
    const canSubmit = targets.length > 0 || queryInput.trim().length > 0;

    return (
        <RoomDialog
            open={open}
            title="Start chat"
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="room-dialog-button room-dialog-button-secondary" onClick={onClose} disabled={creating}>
                        Cancel
                    </button>
                    <button type="button" className="room-dialog-button room-dialog-button-primary" onClick={() => void submit()} disabled={!canSubmit || creating}>
                        {creating ? "Opening..." : "Start chat"}
                    </button>
                </>
            }
        >
            {targets.length > 0 ? (
                <label className="room-dialog-field">
                    <span>Selected people</span>
                    <div className="room-dialog-recipients">
                        {targets.map((target) => {
                            const avatarSources = [
                                thumbnailFromMxc(client, target.avatarMxc, 40, 40, "crop"),
                                mediaFromMxc(client, target.avatarMxc),
                            ];
                            return (
                                <div key={target.userId} className="room-dialog-recipient">
                                    <Avatar
                                        className="room-dialog-recipient-avatar"
                                        name={target.displayName}
                                        src={avatarSources[0] ?? null}
                                        sources={avatarSources}
                                        seed={target.userId}
                                        userId={target.userId}
                                    />
                                    <span className="room-dialog-recipient-label">{target.displayName}</span>
                                    <button
                                        type="button"
                                        className="room-dialog-recipient-remove"
                                        onClick={() => removeTarget(target.userId)}
                                        aria-label={`Remove ${target.displayName}`}
                                        disabled={creating}
                                    >
                                        x
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </label>
            ) : null}

            <label className="room-dialog-field">
                <span>Add people</span>
                <input
                    ref={inputRef}
                    className="room-dialog-input"
                    type="text"
                    value={queryInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    onFocus={() => {
                        if (suggestions.length > 0) {
                            setSuggestionsOpen(true);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "ArrowDown" && suggestions.length > 0) {
                            event.preventDefault();
                            setSuggestionsOpen(true);
                            setActiveSuggestionIndex((index) => (index + 1) % suggestions.length);
                            return;
                        }

                        if (event.key === "ArrowUp" && suggestions.length > 0) {
                            event.preventDefault();
                            setSuggestionsOpen(true);
                            setActiveSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
                            return;
                        }

                        if (event.key === "Tab" && suggestionsOpen && activeSuggestion) {
                            event.preventDefault();
                            addTarget(activeSuggestion);
                            return;
                        }

                        if (event.key === "Enter") {
                            event.preventDefault();
                            if (suggestionsOpen && activeSuggestion) {
                                addTarget(activeSuggestion);
                                return;
                            }

                            if (queryInput.trim().length > 0 && isValidMatrixUserId(queryInput.trim())) {
                                void addTypedTarget();
                                return;
                            }

                            void submit();
                            return;
                        }

                        if (event.key === "Backspace" && queryInput.length === 0 && targets.length > 0) {
                            event.preventDefault();
                            removeTarget(targets[targets.length - 1].userId);
                            return;
                        }

                        if (event.key === "Escape" && suggestionsOpen) {
                            event.preventDefault();
                            event.stopPropagation();
                            setSuggestionsOpen(false);
                        }
                    }}
                    placeholder="Search or enter @alice:example.org"
                    disabled={creating}
                />
            </label>

            <p className="room-dialog-helper">
                Pick one person for a DM, or multiple people for a private group chat.
            </p>

            {suggestionsOpen && suggestions.length > 0 ? (
                <div className="room-dialog-autocomplete" ref={autocompleteRef} role="listbox" aria-label="User suggestions">
                    {suggestions.map((suggestion, index) => {
                        const avatarSources = [
                            thumbnailFromMxc(client, suggestion.avatarMxc, 40, 40, "crop"),
                            mediaFromMxc(client, suggestion.avatarMxc),
                        ];
                        const isActive = index === activeSuggestionIndex;
                        const isSelected = selectedUserIds.has(suggestion.userId);
                        return (
                            <button
                                type="button"
                                key={suggestion.userId}
                                className={`room-dialog-autocomplete-item${isActive ? " is-active" : ""}${isSelected ? " is-selected" : ""}`}
                                role="option"
                                aria-selected={isActive}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => toggleTarget(suggestion)}
                            >
                                <Avatar
                                    className="room-dialog-autocomplete-avatar"
                                    name={suggestion.displayName}
                                    src={avatarSources[0] ?? null}
                                    sources={avatarSources}
                                    seed={suggestion.userId}
                                    userId={suggestion.userId}
                                />
                                <span className="room-dialog-autocomplete-main">
                                    <span className="room-dialog-autocomplete-name">{suggestion.displayName}</span>
                                    <span className="room-dialog-autocomplete-id">{suggestion.userId}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {error ? <p className="room-dialog-error">{error}</p> : null}
        </RoomDialog>
    );
}
