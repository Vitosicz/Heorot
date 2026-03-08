import React from "react";

interface MediaCardProps {
    title?: string;
    description?: string;
}

export function MediaCard({
    title = "Media & Files",
    description = "Recent media preview will be added here.",
}: MediaCardProps): React.ReactElement {
    return (
        <section className="rp-card">
            <header className="rp-card-header">
                <h3 className="rp-card-title">{title}</h3>
            </header>
            <p className="rp-card-text is-empty">{description}</p>
        </section>
    );
}
