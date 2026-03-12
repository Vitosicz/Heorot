import React, { useEffect, useMemo, useState } from "react";
import { ClientEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

import { loadAvailableEmojis, resolveEmojiShortcode } from "../emoji/EmojiResolver";
import { resetPersonalEmojiPackCache, resetSpaceEmojiPackCache } from "../emoji/EmojiPackStore";
import { PERSONAL_EMOJI_PACK_EVENT_TYPE, SPACE_EMOJI_PACK_EVENT_TYPE } from "../emoji/EmojiPackTypes";
import { subscribeEmojiPackUpdated } from "../emoji/emojiEvents";
import { mxcThumbnailToHttp } from "../utils/mxc";

export interface ReactionSelection {
    key: string;
    shortcode?: string;
}

interface ReactionPickerProps {
    client: MatrixClient;
    room: Room;
    activeSpaceId: string | null;
    onSelect: (selection: ReactionSelection) => Promise<void> | void;
    onFinished: () => void;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👀", "✅"];

export function ReactionPicker({
    client,
    room,
    activeSpaceId,
    onSelect,
    onFinished,
}: ReactionPickerProps): React.ReactElement {
    const [customEmojis, setCustomEmojis] = useState<Array<{ shortcode: string; name: string; url: string }>>([]);
    const [shortcodeInput, setShortcodeInput] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const load = async (): Promise<void> => {
            try {
                const emojis = await loadAvailableEmojis(client, room, activeSpaceId);
                if (!cancelled) {
                    setCustomEmojis(emojis);
                }
            } catch {
                if (!cancelled) {
                    setCustomEmojis([]);
                }
            }
        };

        const reload = (): void => {
            void load();
        };

        reload();

        const onTimeline = (event: MatrixEvent): void => {
            if (event.getType() !== SPACE_EMOJI_PACK_EVENT_TYPE) {
                return;
            }

            const updatedSpaceId = typeof event.getRoomId === "function" ? event.getRoomId() : undefined;
            resetSpaceEmojiPackCache(typeof updatedSpaceId === "string" ? updatedSpaceId : undefined);
            reload();
        };

        const onAccountData = (event: MatrixEvent): void => {
            if (event.getType() !== PERSONAL_EMOJI_PACK_EVENT_TYPE) {
                return;
            }

            resetPersonalEmojiPackCache();
            reload();
        };

        const unsubscribeEmojiPackUpdated = subscribeEmojiPackUpdated((detail) => {
            if (detail.kind === "space") {
                resetSpaceEmojiPackCache(detail.spaceId);
            } else {
                resetPersonalEmojiPackCache();
            }
            reload();
        });

        client.on(RoomEvent.Timeline, onTimeline);
        client.on(ClientEvent.AccountData, onAccountData);

        return () => {
            cancelled = true;
            unsubscribeEmojiPackUpdated();
            client.removeListener(RoomEvent.Timeline, onTimeline);
            client.removeListener(ClientEvent.AccountData, onAccountData);
        };
    }, [activeSpaceId, client, room]);

    const customEmojiWithHttp = useMemo(
        () =>
            customEmojis.map((emoji) => ({
                ...emoji,
                http: mxcThumbnailToHttp(client, emoji.url, 32, 32),
            })),
        [client, customEmojis],
    );

    const chooseReaction = async (selection: ReactionSelection): Promise<void> => {
        if (!selection.key.trim()) {
            return;
        }

        try {
            setError(null);
            await onSelect(selection);
            onFinished();
        } catch (selectionError) {
            setError(selectionError instanceof Error ? selectionError.message : "Unable to add reaction.");
        }
    };

    const submitShortcode = async (): Promise<void> => {
        const input = shortcodeInput.trim();
        if (!input) {
            return;
        }

        if (input.startsWith("mxc://")) {
            await chooseReaction({ key: input });
            return;
        }

        const resolved = await resolveEmojiShortcode(client, room, input, activeSpaceId);
        if (resolved) {
            await chooseReaction({
                key: resolved.url,
                shortcode: resolved.shortcode,
            });
            return;
        }

        const looksLikeUnicode = /\p{Emoji}/u.test(input);
        if (looksLikeUnicode) {
            await chooseReaction({ key: input });
            return;
        }

        setError("Shortcode not found in emoji packs.");
    };

    return (
        <div className="reaction-picker">
            <div className="reaction-picker-section">
                <div className="reaction-picker-title">Quick reactions</div>
                <div className="reaction-picker-grid">
                    {QUICK_REACTIONS.map((reaction) => (
                        <button
                            key={reaction}
                            type="button"
                            className="reaction-picker-item"
                            onClick={() => {
                                void chooseReaction({ key: reaction });
                            }}
                            aria-label={`React with ${reaction}`}
                        >
                            {reaction}
                        </button>
                    ))}
                </div>
            </div>

            {customEmojiWithHttp.length > 0 ? (
                <div className="reaction-picker-section">
                    <div className="reaction-picker-title">Custom emojis</div>
                    <div className="reaction-picker-grid reaction-picker-grid-custom">
                        {customEmojiWithHttp.map((emoji) => (
                            <button
                                key={emoji.shortcode}
                                type="button"
                                className="reaction-picker-item reaction-picker-item-custom"
                                onClick={() => {
                                    void chooseReaction({
                                        key: emoji.url,
                                        shortcode: emoji.shortcode,
                                    });
                                }}
                                title={emoji.shortcode}
                            >
                                {emoji.http ? (
                                    <img src={emoji.http} alt={emoji.shortcode} loading="lazy" decoding="async" />
                                ) : (
                                    emoji.shortcode
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className="reaction-picker-section">
                <div className="reaction-picker-title">Shortcode / key</div>
                <div className="reaction-picker-input-row">
                    <input
                        className="reaction-picker-input"
                        value={shortcodeInput}
                        onChange={(event) => setShortcodeInput(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void submitShortcode();
                            }
                        }}
                        placeholder=":kekw: or mxc://..."
                    />
                    <button
                        type="button"
                        className="reaction-picker-send"
                        onClick={() => {
                            void submitShortcode();
                        }}
                    >
                        Add
                    </button>
                </div>
                {error ? <p className="reaction-picker-error">{error}</p> : null}
            </div>
        </div>
    );
}
