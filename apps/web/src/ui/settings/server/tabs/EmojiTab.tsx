import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RoomStateEvent, type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";

import { mediaFromMxc, thumbnailFromMxc } from "../../../adapters/media";
import { SPACE_EMOJI_PACK_EVENT_TYPE, type EmojiPackContent } from "../../../emoji/EmojiPackTypes";
import {
    getSpacePack,
    normalizeEmojiShortcode,
    resetEmojiPackCache,
    saveSpacePack,
} from "../../../emoji/EmojiPackStore";
import type { ToastState } from "../../../components/Toast";
import { useSpacePermissions } from "../../useSpacePermissions";

interface EmojiTabProps {
    client: MatrixClient;
    spaceRoom: Room;
    onOpenUploadDialog: () => void;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

function buildEmptyPack(): EmojiPackContent {
    return {
        version: 1,
        emojis: {},
    };
}

function clonePack(pack: EmojiPackContent | null): EmojiPackContent {
    if (!pack) {
        return buildEmptyPack();
    }

    return {
        version: 1,
        emojis: { ...pack.emojis },
    };
}

export function EmojiTab({ client, spaceRoom, onOpenUploadDialog, onToast }: EmojiTabProps): React.ReactElement {
    const permissions = useSpacePermissions(client, spaceRoom);
    const [pack, setPack] = useState<EmojiPackContent>(buildEmptyPack);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [search, setSearch] = useState("");
    const [renameSource, setRenameSource] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const [error, setError] = useState<string | null>(null);

    const loadPack = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(null);
        try {
            resetEmojiPackCache(spaceRoom.roomId);
            const loaded = await getSpacePack(client, spaceRoom.roomId);
            setPack(clonePack(loaded));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load emoji pack.");
        } finally {
            setLoading(false);
        }
    }, [client, spaceRoom.roomId]);

    useEffect(() => {
        void loadPack();
    }, [loadPack]);

    useEffect(() => {
        const onStateEvent = (event: unknown): void => {
            const matrixEvent = event as { getType?: () => string; getRoomId?: () => string };
            if (matrixEvent.getRoomId?.() !== spaceRoom.roomId) {
                return;
            }

            if (matrixEvent.getType?.() === SPACE_EMOJI_PACK_EVENT_TYPE) {
                void loadPack();
            }
        };

        spaceRoom.currentState.on(RoomStateEvent.Events, onStateEvent as any);
        return () => {
            spaceRoom.currentState.removeListener(RoomStateEvent.Events, onStateEvent as any);
        };
    }, [loadPack, spaceRoom]);

    const filteredEmojis = useMemo(() => {
        const trimmed = search.trim().toLowerCase();
        const entries = Object.entries(pack.emojis).sort(([left], [right]) => left.localeCompare(right));
        if (!trimmed) {
            return entries;
        }

        return entries.filter(([shortcode, emoji]) => {
            return shortcode.toLowerCase().includes(trimmed) || emoji.name.toLowerCase().includes(trimmed);
        });
    }, [pack.emojis, search]);

    const removeEmoji = async (shortcode: string): Promise<void> => {
        if (!permissions.canEditEmojiPack || saving) {
            return;
        }

        const confirmed = window.confirm(`Remove ${shortcode} from this space pack?`);
        if (!confirmed) {
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const nextPack = clonePack(pack);
            delete nextPack.emojis[shortcode];
            await saveSpacePack(client, spaceRoom.roomId, nextPack);
            setPack(nextPack);
            onToast({ type: "success", message: `Removed ${shortcode}.` });
        } catch (removeError) {
            setError(removeError instanceof Error ? removeError.message : "Failed to remove emoji.");
        } finally {
            setSaving(false);
        }
    };

    const renameEmoji = async (oldShortcode: string): Promise<void> => {
        if (!permissions.canEditEmojiPack || saving) {
            return;
        }

        const normalized = normalizeEmojiShortcode(renameValue);
        if (!/^:[a-z0-9_+\-]+:$/.test(normalized)) {
            setError("Shortcode must look like :kekw: (letters/numbers/_+-).");
            return;
        }

        if (normalized === oldShortcode) {
            setRenameSource(null);
            setRenameValue("");
            return;
        }

        if (pack.emojis[normalized]) {
            setError(`${normalized} already exists in this space pack.`);
            return;
        }

        const emoji = pack.emojis[oldShortcode];
        if (!emoji) {
            setError("Emoji does not exist anymore.");
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const nextPack = clonePack(pack);
            delete nextPack.emojis[oldShortcode];
            nextPack.emojis[normalized] = {
                ...emoji,
                name: normalized.slice(1, -1),
            };
            await saveSpacePack(client, spaceRoom.roomId, nextPack);
            setPack(nextPack);
            setRenameSource(null);
            setRenameValue("");
            onToast({ type: "success", message: `Renamed ${oldShortcode} to ${normalized}.` });
        } catch (renameError) {
            setError(renameError instanceof Error ? renameError.message : "Failed to rename emoji.");
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Emoji</h2>
            <p className="settings-tab-description">
                Manage custom server emoji stored as <code>{SPACE_EMOJI_PACK_EVENT_TYPE}</code> state.
            </p>

            <div className="settings-actions-row">
                <input
                    className="settings-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search by shortcode"
                />
                <button
                    type="button"
                    className="settings-button"
                    disabled={!permissions.canEditEmojiPack}
                    title={!permissions.canEditEmojiPack ? "You cannot edit the space emoji pack." : "Upload emoji"}
                    onClick={onOpenUploadDialog}
                >
                    Upload emoji
                </button>
            </div>

            {loading ? <p className="settings-inline-note">Loading emoji pack...</p> : null}
            {error ? <p className="settings-inline-error">{error}</p> : null}

            {!permissions.canEditEmojiPack ? (
                <p className="settings-inline-note">
                    Read-only: your power level does not allow editing the Space emoji pack.
                </p>
            ) : null}

            <div className="settings-emoji-grid">
                {filteredEmojis.map(([shortcode, emoji]) => {
                    const imageUrl =
                        thumbnailFromMxc(client, emoji.url, 48, 48, "crop") ??
                        mediaFromMxc(client, emoji.url);
                    const isRenaming = renameSource === shortcode;

                    return (
                        <div key={shortcode} className="settings-emoji-item">
                            <div className="settings-emoji-preview">
                                {imageUrl ? <img src={imageUrl} alt={shortcode} loading="lazy" decoding="async" /> : <span>?</span>}
                            </div>
                            <div className="settings-emoji-main">
                                {isRenaming ? (
                                    <input
                                        className="settings-emoji-rename-input"
                                        value={renameValue}
                                        onChange={(event) => setRenameValue(event.target.value)}
                                        placeholder="new shortcode"
                                    />
                                ) : (
                                    <span className="settings-emoji-shortcode">{shortcode}</span>
                                )}
                                <span className="settings-emoji-meta">{emoji.url}</span>
                            </div>
                            <div className="settings-emoji-actions">
                                {isRenaming ? (
                                    <>
                                        <button
                                            type="button"
                                            className="settings-button settings-button-secondary"
                                            disabled={saving}
                                            onClick={() => void renameEmoji(shortcode)}
                                        >
                                            Save
                                        </button>
                                        <button
                                            type="button"
                                            className="settings-button settings-button-secondary"
                                            disabled={saving}
                                            onClick={() => {
                                                setRenameSource(null);
                                                setRenameValue("");
                                            }}
                                        >
                                            Cancel
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            className="settings-button settings-button-secondary"
                                            disabled={!permissions.canEditEmojiPack || saving}
                                            onClick={() => {
                                                setRenameSource(shortcode);
                                                setRenameValue(shortcode);
                                            }}
                                        >
                                            Rename
                                        </button>
                                        <button
                                            type="button"
                                            className="settings-button settings-button-danger"
                                            disabled={!permissions.canEditEmojiPack || saving}
                                            onClick={() => void removeEmoji(shortcode)}
                                        >
                                            Remove
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })}
                {filteredEmojis.length === 0 && !loading ? (
                    <div className="settings-empty">No emoji in this pack.</div>
                ) : null}
            </div>
        </div>
    );
}
