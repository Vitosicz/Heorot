import React, { useEffect } from "react";

interface RoomDialogProps {
    open: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    footer?: React.ReactNode;
}

export function RoomDialog({ open, title, onClose, children, footer }: RoomDialogProps): React.ReactElement | null {
    useEffect(() => {
        if (!open) {
            return undefined;
        }

        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose, open]);

    if (!open) {
        return null;
    }

    return (
        <div
            className="room-dialog-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="room-dialog">
                <div className="room-dialog-header">
                    <h2 className="room-dialog-title">{title}</h2>
                    <button type="button" className="room-dialog-close" onClick={onClose} aria-label="Close dialog">
                        x
                    </button>
                </div>
                <div className="room-dialog-body">{children}</div>
                {footer ? <div className="room-dialog-footer">{footer}</div> : null}
            </div>
        </div>
    );
}
