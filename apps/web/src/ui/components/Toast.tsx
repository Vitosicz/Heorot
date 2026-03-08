import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface ToastState {
    id: number;
    type: "success" | "error" | "info";
    message: string;
}

interface ToastProps {
    toast: ToastState | null;
    onClose: () => void;
    durationMs?: number;
}

export function Toast({ toast, onClose, durationMs = 2800 }: ToastProps): React.ReactElement | null {
    const [isExiting, setIsExiting] = useState(false);

    useEffect(() => {
        if (!toast) {
            setIsExiting(false);
            return undefined;
        }

        setIsExiting(false);
        const timer = window.setTimeout(() => {
            setIsExiting(true);
        }, durationMs);

        return () => {
            window.clearTimeout(timer);
        };
    }, [durationMs, toast]);

    useEffect(() => {
        if (!isExiting) return undefined;
        const timer = window.setTimeout(() => {
            onClose();
        }, 180);
        return () => {
            window.clearTimeout(timer);
        };
    }, [isExiting, onClose]);

    if (!toast) return null;

    return createPortal(
        <div className={`toast toast-${toast.type}${isExiting ? " is-exiting" : ""}`} role="status" aria-live="polite">
            {toast.message}
        </div>,
        document.body,
    );
}
