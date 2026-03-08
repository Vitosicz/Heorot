import React, { useCallback, useEffect, useMemo, useState } from "react";
import { EventType, Preset, RoomCreateTypeField, RoomType, Visibility, type MatrixClient } from "matrix-js-sdk/src/matrix";

import { describeJoinError, joinRoomWithRetry } from "../../adapters/joinAdapter";
import { RoomDialog } from "./RoomDialog";

interface CreateSpaceDialogProps {
    client: MatrixClient;
    open: boolean;
    onClose: () => void;
    onCreated?: (roomId: string) => void;
    onJoined?: (roomId: string) => void;
    onJoinPublicSpaceRequest?: (target: string) => Promise<string>;
    onImport?: () => void;
}

type SpaceVisibilityChoice = "private" | "public";
type CreateSpaceTab = "create" | "discover" | "import";
type PublicRoomsResponse = Awaited<ReturnType<MatrixClient["publicRooms"]>>;
type PublicSpaceResult = PublicRoomsResponse["chunk"][number];

function normalizeAliasLocalPart(input: string): string {
    let normalized = input.trim();
    if (normalized.startsWith("#")) {
        normalized = normalized.slice(1);
    }

    const serverSeparator = normalized.indexOf(":");
    if (serverSeparator > 0) {
        normalized = normalized.slice(0, serverSeparator);
    }

    return normalized;
}

function supportsPublicSpaceCreation(client: MatrixClient): Promise<boolean> {
    return client
        .isVersionSupported("v1.4")
        .then((supported) => supported || client.doesServerSupportUnstableFeature("org.matrix.msc3827.stable"))
        .catch(() => false);
}

function formatJoinedMembers(count: number): string {
    if (count === 1) {
        return "1 member";
    }
    return `${count} members`;
}

function getPublicSpaceJoinTarget(space: PublicSpaceResult): string {
    if (space.canonical_alias) {
        return space.canonical_alias;
    }
    if (Array.isArray(space.aliases) && space.aliases.length > 0) {
        return space.aliases[0];
    }
    return space.room_id;
}

function getPublicSpaceLabel(space: PublicSpaceResult): string {
    return space.name || space.canonical_alias || space.room_id;
}

export function CreateSpaceDialog({
    client,
    open,
    onClose,
    onCreated,
    onJoined,
    onJoinPublicSpaceRequest,
    onImport,
}: CreateSpaceDialogProps): React.ReactElement | null {
    const [activeTab, setActiveTab] = useState<CreateSpaceTab>("create");
    const [step, setStep] = useState<"visibility" | "details">("visibility");
    const [visibilityChoice, setVisibilityChoice] = useState<SpaceVisibilityChoice>("private");
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [aliasLocalPart, setAliasLocalPart] = useState("");
    const [saving, setSaving] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [supportsPublic, setSupportsPublic] = useState(true);
    const [publicSearchInput, setPublicSearchInput] = useState("");
    const [publicSearchTerm, setPublicSearchTerm] = useState("");
    const [publicSpaces, setPublicSpaces] = useState<PublicSpaceResult[]>([]);
    const [publicNextBatch, setPublicNextBatch] = useState<string | null>(null);
    const [publicLoading, setPublicLoading] = useState(false);
    const [publicLoadingMore, setPublicLoadingMore] = useState(false);
    const [publicLoaded, setPublicLoaded] = useState(false);
    const [publicError, setPublicError] = useState<string | null>(null);
    const [joiningPublicRoomId, setJoiningPublicRoomId] = useState<string | null>(null);

    const isGuest = client.isGuest();
    const canSubmit = useMemo(() => name.trim().length > 0 && !saving && !isGuest, [isGuest, name, saving]);
    const showCreateFooterActions = activeTab === "create" || activeTab === "import";

    useEffect(() => {
        if (!open) {
            return;
        }

        setActiveTab("create");
        setStep("visibility");
        setVisibilityChoice("private");
        setName("");
        setTopic("");
        setAliasLocalPart("");
        setSaving(false);
        setCreateError(null);
        setSupportsPublic(true);
        setPublicSearchInput("");
        setPublicSearchTerm("");
        setPublicSpaces([]);
        setPublicNextBatch(null);
        setPublicLoading(false);
        setPublicLoadingMore(false);
        setPublicLoaded(false);
        setPublicError(null);
        setJoiningPublicRoomId(null);

        void supportsPublicSpaceCreation(client).then((supported) => {
            setSupportsPublic(supported);
            if (!supported) {
                setVisibilityChoice("private");
            }
        });
    }, [client, open]);

    const submit = async (): Promise<void> => {
        if (!canSubmit) {
            return;
        }

        setSaving(true);
        setCreateError(null);

        try {
            const normalizedAlias = normalizeAliasLocalPart(aliasLocalPart);
            const wantsPublic = visibilityChoice === "public" && supportsPublic;
            const createVisibility = wantsPublic ? Visibility.Public : Visibility.Private;
            const preset = wantsPublic ? Preset.PublicChat : Preset.PrivateChat;

            const initialState: Array<{ type: string; state_key: string; content: Record<string, unknown> }> = [
                {
                    type: EventType.RoomHistoryVisibility,
                    state_key: "",
                    content: {
                        history_visibility: wantsPublic ? "world_readable" : "invited",
                    },
                },
            ];

            const options: Parameters<MatrixClient["createRoom"]>[0] = {
                name: name.trim(),
                topic: topic.trim() || undefined,
                visibility: createVisibility,
                preset,
                room_alias_name: wantsPublic && normalizedAlias ? normalizedAlias : undefined,
                creation_content: {
                    [RoomCreateTypeField]: "m.space",
                } as Record<string, unknown>,
                power_level_content_override: {
                    events_default: 100,
                    invite: wantsPublic ? 0 : 50,
                },
                initial_state: initialState,
            };

            const response = await client.createRoom(options);
            onCreated?.(response.room_id);
            onClose();
        } catch (createError) {
            const message = createError instanceof Error ? createError.message : "Failed to create Space.";
            setCreateError(message);
        } finally {
            setSaving(false);
        }
    };

    const loadPublicSpaces = useCallback(
        async (append: boolean): Promise<void> => {
            const sinceToken = append ? publicNextBatch ?? undefined : undefined;
            if (append && !sinceToken) {
                return;
            }

            if (append) {
                setPublicLoadingMore(true);
            } else {
                setPublicLoading(true);
                setPublicError(null);
            }

            try {
                const response = await client.publicRooms({
                    limit: 24,
                    since: sinceToken,
                    filter: {
                        generic_search_term: publicSearchTerm || undefined,
                        ...(supportsPublic ? { room_types: [RoomType.Space] } : {}),
                    },
                });

                const onlySpaces = supportsPublic
                    ? response.chunk.filter(
                          (room) => room.room_type === RoomType.Space || room.room_type === "m.space",
                      )
                    : response.chunk;

                setPublicSpaces((previous) => {
                    if (!append) {
                        return onlySpaces;
                    }
                    const merged = [...previous];
                    for (const room of onlySpaces) {
                        if (!merged.some((entry) => entry.room_id === room.room_id)) {
                            merged.push(room);
                        }
                    }
                    return merged;
                });
                setPublicNextBatch(response.next_batch ?? null);
                setPublicLoaded(true);
            } catch (loadError) {
                const message = loadError instanceof Error ? loadError.message : "Failed to load public spaces.";
                setPublicError(message);
            } finally {
                setPublicLoading(false);
                setPublicLoadingMore(false);
            }
        },
        [client, publicNextBatch, publicSearchTerm, supportsPublic],
    );

    useEffect(() => {
        if (!open || activeTab !== "discover" || publicLoaded || publicLoading || publicError) {
            return;
        }
        void loadPublicSpaces(false);
    }, [activeTab, loadPublicSpaces, open, publicError, publicLoaded, publicLoading]);

    const submitPublicSearch = (): void => {
        const searchTerm = publicSearchInput.trim();
        setPublicSearchTerm(searchTerm);
        setPublicSpaces([]);
        setPublicNextBatch(null);
        setPublicLoaded(false);
        setPublicError(null);
    };

    const joinPublicSpace = async (space: PublicSpaceResult): Promise<void> => {
        const target = getPublicSpaceJoinTarget(space);
        setJoiningPublicRoomId(space.room_id);
        setPublicError(null);
        try {
            const joinedRoomId = onJoinPublicSpaceRequest
                ? await onJoinPublicSpaceRequest(target)
                : (await joinRoomWithRetry(client, target)).roomId;
            onJoined?.(joinedRoomId);
            onClose();
        } catch (joinError) {
            setPublicError(describeJoinError(joinError, target));
        } finally {
            setJoiningPublicRoomId(null);
        }
    };

    return (
        <RoomDialog
            open={open}
            title="Create Space"
            onClose={onClose}
            footer={
                <>
                    <button type="button" className="room-dialog-button room-dialog-button-secondary" onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    {activeTab === "create" && step === "visibility" ? (
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-primary"
                            onClick={() => setStep("details")}
                            disabled={saving || isGuest}
                        >
                            Continue
                        </button>
                    ) : null}
                    {activeTab === "create" && step === "details" ? (
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-primary"
                            onClick={() => void submit()}
                            disabled={!canSubmit}
                        >
                            {saving ? "Creating..." : "Create Space"}
                        </button>
                    ) : null}
                    {activeTab === "import" && onImport ? (
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-primary"
                            onClick={() => { onClose(); onImport(); }}
                            disabled={isGuest}
                        >
                            Continue
                        </button>
                    ) : null}
                </>
            }
        >
            <div className="room-dialog-tabs">
                <button
                    type="button"
                    className={`room-dialog-tab${activeTab === "create" ? " is-active" : ""}`}
                    onClick={() => setActiveTab("create")}
                >
                    Create new space
                </button>
                <button
                    type="button"
                    className={`room-dialog-tab${activeTab === "discover" ? " is-active" : ""}`}
                    onClick={() => setActiveTab("discover")}
                >
                    Discover public spaces
                </button>
                {onImport ? (
                    <button
                        type="button"
                        className={`room-dialog-tab${activeTab === "import" ? " is-active" : ""}`}
                        onClick={() => setActiveTab("import")}
                    >
                        Import from JSON
                    </button>
                ) : null}
            </div>

            {activeTab === "import" ? (
                <div className="create-space-panel">
                    <p className="room-dialog-muted">
                        Import a server from a JSON export file. The wizard will create a Space with all channels and emoji.
                    </p>
                    {isGuest ? (
                        <p className="room-dialog-warning">Register or sign in to import a Space.</p>
                    ) : null}
                </div>
            ) : activeTab === "create" ? (
                <div className={`create-space-panel create-space-panel-${step}`}>
                    {isGuest ? <p className="room-dialog-warning">Register or sign in to create a Space.</p> : null}

                    {step === "visibility" ? (
                        <>
                            <p className="room-dialog-muted">Choose who can discover and join this Space.</p>
                            <label className="room-dialog-checkbox">
                                <input
                                    type="radio"
                                    name="space-visibility"
                                    checked={visibilityChoice === "private"}
                                    onChange={() => setVisibilityChoice("private")}
                                    disabled={saving}
                                />
                                Private Space
                            </label>
                            <label className="room-dialog-checkbox">
                                <input
                                    type="radio"
                                    name="space-visibility"
                                    checked={visibilityChoice === "public"}
                                    onChange={() => setVisibilityChoice("public")}
                                    disabled={saving || !supportsPublic}
                                />
                                Public Space
                            </label>
                            {!supportsPublic ? (
                                <p className="room-dialog-muted">
                                    This homeserver does not support public Space filtering. The Space will be private.
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <label className="room-dialog-field">
                                <span>Space name</span>
                                <input
                                    className="room-dialog-input"
                                    type="text"
                                    value={name}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder="My Community"
                                    disabled={saving}
                                />
                            </label>
                            <label className="room-dialog-field">
                                <span>Description</span>
                                <input
                                    className="room-dialog-input"
                                    type="text"
                                    value={topic}
                                    onChange={(event) => setTopic(event.target.value)}
                                    placeholder="Optional description"
                                    disabled={saving}
                                />
                            </label>
                            {visibilityChoice === "public" && supportsPublic ? (
                                <label className="room-dialog-field">
                                    <span>Alias local part</span>
                                    <input
                                        className="room-dialog-input"
                                        type="text"
                                        value={aliasLocalPart}
                                        onChange={(event) => setAliasLocalPart(event.target.value)}
                                        placeholder="my-space"
                                        disabled={saving}
                                    />
                                </label>
                            ) : null}
                        </>
                    )}
                    {createError ? <p className="room-dialog-error">{createError}</p> : null}
                </div>
            ) : (
                <div className="create-space-panel create-space-panel-discover">
                    <div className="join-public-toolbar">
                        <input
                            className="room-dialog-input"
                            type="text"
                            value={publicSearchInput}
                            onChange={(event) => setPublicSearchInput(event.target.value)}
                            placeholder="Search public spaces"
                            disabled={publicLoading || publicLoadingMore}
                        />
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-secondary"
                            onClick={() => submitPublicSearch()}
                            disabled={publicLoading || publicLoadingMore}
                        >
                            Search
                        </button>
                    </div>
                    <div className="join-public-results">
                        {publicLoading ? <p className="room-dialog-muted">Loading public spaces...</p> : null}
                        {!publicLoading && publicSpaces.length === 0 && !publicError ? (
                            <p className="room-dialog-muted">No public spaces found for this query.</p>
                        ) : null}
                        {publicSpaces.map((space) => (
                            <div key={space.room_id} className="join-public-space-item">
                                <div className="join-public-space-main">
                                    <p className="join-public-space-name">{getPublicSpaceLabel(space)}</p>
                                    {space.topic ? <p className="join-public-space-topic">{space.topic}</p> : null}
                                    <p className="join-public-space-meta">
                                        {formatJoinedMembers(space.num_joined_members)}
                                        {space.canonical_alias ? ` • ${space.canonical_alias}` : ""}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className="room-dialog-button room-dialog-button-primary"
                                    onClick={() => void joinPublicSpace(space)}
                                    disabled={Boolean(joiningPublicRoomId)}
                                >
                                    {joiningPublicRoomId === space.room_id ? "Joining..." : "Join"}
                                </button>
                            </div>
                        ))}
                    </div>
                    {publicNextBatch ? (
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-secondary"
                            onClick={() => void loadPublicSpaces(true)}
                            disabled={publicLoading || publicLoadingMore || Boolean(joiningPublicRoomId)}
                        >
                            {publicLoadingMore ? "Loading..." : "Load more"}
                        </button>
                    ) : null}
                    {publicError ? <p className="room-dialog-error">{publicError}</p> : null}
                </div>
            )}
        </RoomDialog>
    );
}
