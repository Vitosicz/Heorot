import React from "react";

import type { PresenceVm } from "../../presence/buildPresenceVm";

interface PresenceTextProps {
    presence: PresenceVm;
    className?: string;
}

export function PresenceText({ presence, className }: PresenceTextProps): React.ReactElement {
    const classes = ["presence-text"];
    if (className) {
        classes.push(className);
    }

    return (
        <div className={classes.join(" ")}>
            <span className={`presence-text-primary is-${presence.state}`}>{presence.primaryLabel}</span>
            {presence.secondaryLabel ? <span className="presence-text-secondary">{presence.secondaryLabel}</span> : null}
        </div>
    );
}

