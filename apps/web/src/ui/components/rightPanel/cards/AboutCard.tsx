import React from "react";

interface AboutCardProps {
    title: string;
    body: string;
    emptyText?: string;
    action?: React.ReactNode;
}

export function AboutCard({ title, body, emptyText = "No details available.", action }: AboutCardProps): React.ReactElement {
    const text = body.trim().length > 0 ? body : emptyText;

    return (
        <section className="rp-card">
            <header className="rp-card-header">
                <h3 className="rp-card-title">{title}</h3>
                {action ? <div className="rp-card-action">{action}</div> : null}
            </header>
            <p className={`rp-card-text${body.trim().length === 0 ? " is-empty" : ""}`}>{text}</p>
        </section>
    );
}
