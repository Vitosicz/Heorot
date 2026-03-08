import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Position {
    x: number;
    y: number;
}

interface MessageContextMenuProps {
    open: boolean;
    position: Position | null;
    canEdit: boolean;
    canDelete: boolean;
    canCopyText: boolean;
    onClose: () => void;
    onReact: () => void;
    onReply: () => void;
    onEdit: () => void;
    onDelete: () => void;
    onCopyLink: () => void;
    onCopyText: () => void;
    onCopyEventId: () => void;
}

export function MessageContextMenu({
    open,
    position,
    canEdit,
    canDelete,
    canCopyText,
    onClose,
    onReact,
    onReply,
    onEdit,
    onDelete,
    onCopyLink,
    onCopyText,
    onCopyEventId,
}: MessageContextMenuProps): React.ReactElement | null {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const [clampedPosition, setClampedPosition] = useState<Position | null>(position);

    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node | null;
            if (!target) {
                return;
            }

            if (menuRef.current?.contains(target)) {
                return;
            }

            onClose();
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("mousedown", onMouseDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("mousedown", onMouseDown);
        };
    }, [onClose, open]);

    useLayoutEffect(() => {
        if (!open || !position || !menuRef.current) {
            setClampedPosition(position);
            return;
        }

        const viewportPadding = 8;
        const rect = menuRef.current.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - viewportPadding;
        const maxY = window.innerHeight - rect.height - viewportPadding;

        setClampedPosition({
            x: Math.min(Math.max(position.x, viewportPadding), Math.max(maxX, viewportPadding)),
            y: Math.min(Math.max(position.y, viewportPadding), Math.max(maxY, viewportPadding)),
        });
    }, [open, position]);

    if (!open || !position) {
        return null;
    }

    const clickAction = (action: () => void): void => {
        action();
        onClose();
    };

    return createPortal(
        <div
            ref={menuRef}
            className="message-context-menu"
            style={{
                left: `${clampedPosition?.x ?? position.x}px`,
                top: `${clampedPosition?.y ?? position.y}px`,
            }}
            role="menu"
        >
            <button type="button" className="message-context-menu-item" onClick={() => clickAction(onReact)}>
                React
            </button>
            <button type="button" className="message-context-menu-item" onClick={() => clickAction(onReply)}>
                Reply
            </button>
            {canEdit ? (
                <button type="button" className="message-context-menu-item" onClick={() => clickAction(onEdit)}>
                    Edit
                </button>
            ) : null}
            {canDelete ? (
                <button
                    type="button"
                    className="message-context-menu-item message-context-menu-item-danger"
                    onClick={() => clickAction(onDelete)}
                >
                    Delete
                </button>
            ) : null}
            <button type="button" className="message-context-menu-item" onClick={() => clickAction(onCopyLink)}>
                Copy link
            </button>
            <hr className="message-context-menu-divider" />
            <button
                type="button"
                className="message-context-menu-item"
                onClick={() => clickAction(onCopyText)}
                disabled={!canCopyText}
            >
                Copy text
            </button>
            <button type="button" className="message-context-menu-item" onClick={() => clickAction(onCopyEventId)}>
                Copy event ID
            </button>
        </div>,
        document.body,
    );
}
