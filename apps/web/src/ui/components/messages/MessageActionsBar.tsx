import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk/src/matrix";

import type { ToastState } from "../Toast";
import { ReactionPicker } from "../ReactionPicker";
import { MessageContextMenu } from "./MessageContextMenu";
import { useMessageActions } from "../../hooks/useMessageActions";

interface Position {
    x: number;
    y: number;
}

interface MessageActionsBarProps {
    client: MatrixClient;
    room: Room;
    event: MatrixEvent;
    activeSpaceId: string | null;
    visible: boolean;
    contextMenuPosition: Position | null;
    onRequestContextMenu: (position: Position) => void;
    onCloseContextMenu: () => void;
    onReply: (event: MatrixEvent) => void;
    onEdit: (event: MatrixEvent) => void;
    onToast: (toast: Omit<ToastState, "id">) => void;
}

export function MessageActionsBar({
    client,
    room,
    event,
    activeSpaceId,
    visible,
    contextMenuPosition,
    onRequestContextMenu,
    onCloseContextMenu,
    onReply,
    onEdit,
    onToast,
}: MessageActionsBarProps): React.ReactElement {
    const {
        canEdit,
        canDelete,
        plainTextBody,
        copyLink,
        copyText,
        copyEventId,
        deleteMessage,
        react,
    } = useMessageActions({ client, room, event });

    const [barReactionPickerOpen, setBarReactionPickerOpen] = useState(false);
    const [menuReactionPickerPosition, setMenuReactionPickerPosition] = useState<Position | null>(null);
    const moreButtonRef = useRef<HTMLButtonElement | null>(null);
    const barReactButtonRef = useRef<HTMLButtonElement | null>(null);
    const barReactionPickerRef = useRef<HTMLDivElement | null>(null);

    const isContextMenuOpen = Boolean(contextMenuPosition);

    useEffect(() => {
        if (!barReactionPickerOpen) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setBarReactionPickerOpen(false);
            }
        };

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if (barReactionPickerRef.current?.contains(target)) {
                return;
            }

            if (barReactButtonRef.current?.contains(target)) {
                return;
            }

            setBarReactionPickerOpen(false);
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("mousedown", onMouseDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [barReactionPickerOpen]);

    useEffect(() => {
        if (!menuReactionPickerPosition) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setMenuReactionPickerPosition(null);
            }
        };

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if ((target as HTMLElement).closest(".message-actions-reaction-picker-floating")) {
                return;
            }

            setMenuReactionPickerPosition(null);
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("mousedown", onMouseDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [menuReactionPickerPosition]);

    const isVisible = visible || isContextMenuOpen || barReactionPickerOpen || Boolean(menuReactionPickerPosition);

    const withToast = async (
        action: () => Promise<void>,
        successMessage: string,
        errorMessage: string,
        closeContextMenu = false,
    ): Promise<void> => {
        try {
            await action();
            onToast({ type: "success", message: successMessage });
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            onToast({ type: "error", message: `${errorMessage} (${details})` });
        } finally {
            if (closeContextMenu) {
                onCloseContextMenu();
            }
        }
    };

    const handleReactSelection = async (selection: { key: string; shortcode?: string }): Promise<void> => {
        try {
            await react(selection);
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            onToast({ type: "error", message: `Unable to react. (${details})` });
        }
    };

    const handleDelete = async (): Promise<void> => {
        const confirmed = window.confirm("Delete message?");
        if (!confirmed) {
            return;
        }

        await withToast(
            () => deleteMessage(),
            "Message deleted.",
            "Failed to delete message.",
            true,
        );
    };

    const openContextMenuFromMore = (): void => {
        const rect = moreButtonRef.current?.getBoundingClientRect();
        if (!rect) {
            return;
        }

        onRequestContextMenu({
            x: rect.left,
            y: rect.bottom + 4,
        });
    };

    const openReactFromContextMenu = (): void => {
        if (!contextMenuPosition) {
            return;
        }

        setMenuReactionPickerPosition({
            x: contextMenuPosition.x,
            y: contextMenuPosition.y,
        });
        onCloseContextMenu();
    };

    const floatingPickerStyle = useMemo(() => {
        if (!menuReactionPickerPosition) {
            return undefined;
        }

        return {
            left: `${Math.min(menuReactionPickerPosition.x, window.innerWidth - 340)}px`,
            top: `${Math.min(menuReactionPickerPosition.y, window.innerHeight - 360)}px`,
        };
    }, [menuReactionPickerPosition]);

    return (
        <>
            <div className={`message-actions-bar${isVisible ? " is-visible" : ""}`}>
                <button
                    ref={barReactButtonRef}
                    type="button"
                    className="message-actions-button"
                    title="React"
                    aria-label="React"
                    onClick={() => setBarReactionPickerOpen((open) => !open)}
                >
                    😀
                </button>
                <button
                    type="button"
                    className="message-actions-button"
                    title="Reply"
                    aria-label="Reply"
                    onClick={() => onReply(event)}
                >
                    ↩
                </button>
                {canEdit ? (
                    <button
                        type="button"
                        className="message-actions-button"
                        title="Edit"
                        aria-label="Edit"
                        onClick={() => onEdit(event)}
                    >
                        ✏
                    </button>
                ) : null}
                {canDelete ? (
                    <button
                        type="button"
                        className="message-actions-button"
                        title="Delete"
                        aria-label="Delete"
                        onClick={() => {
                            void handleDelete();
                        }}
                    >
                        🗑
                    </button>
                ) : null}
                <button
                    type="button"
                    className="message-actions-button"
                    title="Copy link"
                    aria-label="Copy link"
                    onClick={() => {
                        void withToast(() => copyLink(), "Copied link.", "Failed to copy link.");
                    }}
                >
                    🔗
                </button>
                <button
                    ref={moreButtonRef}
                    type="button"
                    className="message-actions-button"
                    title="More"
                    aria-label="More actions"
                    onClick={openContextMenuFromMore}
                >
                    ⋯
                </button>

                {barReactionPickerOpen ? (
                    <div ref={barReactionPickerRef} className="message-actions-reaction-picker">
                        <ReactionPicker
                            client={client}
                            room={room}
                            activeSpaceId={activeSpaceId}
                            onSelect={handleReactSelection}
                            onFinished={() => setBarReactionPickerOpen(false)}
                        />
                    </div>
                ) : null}
            </div>

            <MessageContextMenu
                open={isContextMenuOpen}
                position={contextMenuPosition}
                canEdit={canEdit}
                canDelete={canDelete}
                canCopyText={Boolean(plainTextBody && plainTextBody.trim().length > 0)}
                onClose={onCloseContextMenu}
                onReact={openReactFromContextMenu}
                onReply={() => onReply(event)}
                onEdit={() => onEdit(event)}
                onDelete={() => {
                    void handleDelete();
                }}
                onCopyLink={() => {
                    void withToast(() => copyLink(), "Copied link.", "Failed to copy link.", true);
                }}
                onCopyText={() => {
                    void withToast(() => copyText(), "Copied text.", "Failed to copy text.", true);
                }}
                onCopyEventId={() => {
                    void withToast(() => copyEventId(), "Copied event ID.", "Failed to copy event ID.", true);
                }}
            />

            {menuReactionPickerPosition
                ? createPortal(
                      <div className="message-actions-reaction-picker-floating" style={floatingPickerStyle}>
                          <ReactionPicker
                              client={client}
                              room={room}
                              activeSpaceId={activeSpaceId}
                              onSelect={handleReactSelection}
                              onFinished={() => setMenuReactionPickerPosition(null)}
                          />
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
