import React, { useMemo } from "react";
import { EventType, type MatrixEvent, type Room } from "matrix-js-sdk/src/matrix";

interface SearchPanelProps {
    room: Room;
    query: string;
    onQueryChange: (value: string) => void;
}

interface SearchResult {
    eventId: string;
    senderLabel: string;
    body: string;
    ts: number;
}

function getMessageBody(event: MatrixEvent): string {
    const content = event.getContent() as { body?: unknown };
    return typeof content.body === "string" ? content.body : "";
}

function getSearchResults(room: Room, query: string): SearchResult[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return [];
    }

    const events = room.getLiveTimeline()?.getEvents() ?? room.timeline;
    const matches: SearchResult[] = [];

    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        if (event.getType() !== EventType.RoomMessage || event.isRedacted()) {
            continue;
        }

        const eventId = event.getId();
        if (!eventId) {
            continue;
        }

        const body = getMessageBody(event);
        if (!body || !body.toLowerCase().includes(normalized)) {
            continue;
        }

        const senderId = event.getSender() ?? "unknown";
        const member = room.getMember(senderId);
        const senderLabel = member?.rawDisplayName || member?.name || senderId;

        matches.push({
            eventId,
            senderLabel,
            body,
            ts: event.getTs(),
        });

        if (matches.length >= 60) {
            break;
        }
    }

    return matches;
}

export function SearchPanel({ room, query, onQueryChange }: SearchPanelProps): React.ReactElement {
    const results = useMemo(() => getSearchResults(room, query), [query, room]);

    return (
        <div className="rs-panel">
            <div className="rs-panel-header">
                <h2 className="rs-panel-title">Search</h2>
            </div>
            <div className="rs-search-wrap">
                <input
                    className="rs-search-input"
                    placeholder="Search messages..."
                    aria-label="Search messages in room"
                    value={query}
                    onChange={(event) => onQueryChange(event.target.value)}
                />
            </div>
            <div className="rs-search-results">
                {!query.trim() ? <div className="rs-empty-state">Type to search recent messages.</div> : null}
                {query.trim() && results.length === 0 ? <div className="rs-empty-state">No results.</div> : null}
                {results.map((result) => (
                    <div className="rs-search-result" key={result.eventId}>
                        <div className="rs-search-result-head">
                            <span className="rs-search-sender">{result.senderLabel}</span>
                            <span className="rs-search-time">
                                {new Date(result.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                        </div>
                        <p className="rs-search-body">{result.body}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}

