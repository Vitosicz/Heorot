import React, { useState } from "react";

interface SignOutTabProps {
    onSignOut: () => Promise<void>;
}

export function SignOutTab({ onSignOut }: SignOutTabProps): React.ReactElement {
    const [pending, setPending] = useState(false);
    const isDesktopRuntime = typeof window !== "undefined" && Boolean(window.heorotDesktop?.quitApp);

    const runSignOut = async (): Promise<void> => {
        const confirmed = window.confirm("Sign out of this session?");
        if (!confirmed) {
            return;
        }

        setPending(true);
        try {
            await onSignOut();
        } finally {
            setPending(false);
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Sign out</h2>
            <p className="settings-tab-description">End this current session.</p>

            <div className="settings-danger-card">
                <div>
                    <h3>Sign out of this device</h3>
                    <p>You will need to sign in again to access encrypted history on this session.</p>
                </div>
                <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={pending}
                    onClick={() => void runSignOut()}
                >
                    {pending ? "Signing out..." : "Sign out"}
                </button>
            </div>
            {isDesktopRuntime ? (
                <div className="settings-danger-card">
                    <div>
                        <h3>Quit desktop app</h3>
                        <p>Close the desktop process completely.</p>
                    </div>
                    <button
                        type="button"
                        className="settings-button settings-button-secondary"
                        onClick={() => {
                            void window.heorotDesktop?.quitApp?.();
                        }}
                    >
                        Quit app
                    </button>
                </div>
            ) : null}
        </div>
    );
}
