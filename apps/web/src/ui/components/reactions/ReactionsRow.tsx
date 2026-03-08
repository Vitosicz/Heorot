import React, { useEffect, useMemo, useReducer, useState } from "react";
import {
    EventType,
    RelationType,
    RelationsEvent,
    type MatrixClient,
    type MatrixEvent,
    type Relations,
    type Room,
} from "matrix-js-sdk/src/matrix";

import { ReactionsRowButton } from "./ReactionsRowButton";

const MAX_ITEMS_WHEN_LIMITED = 8;

interface ReactionAggregate {
    key: string;
    count: number;
    reactionEvents: MatrixEvent[];
    myReactionEvent: MatrixEvent | null;
}

function getReactionRelations(room: Room, eventId: string): Relations | null {
    return room.relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction) ?? null;
}

function deduplicateReactionEventsBySender(events: Iterable<MatrixEvent>): MatrixEvent[] {
    const uniqueBySender = new Map<string, MatrixEvent>();

    for (const event of events) {
        if (event.isRedacted()) {
            continue;
        }

        const sender = event.getSender();
        if (!sender || uniqueBySender.has(sender)) {
            continue;
        }

        uniqueBySender.set(sender, event);
    }

    return [...uniqueBySender.values()];
}

interface ReactionsRowProps {
    client: MatrixClient;
    room: Room;
    mxEvent: MatrixEvent;
    customReactionImagesEnabled: boolean;
}

export function ReactionsRow({
    client,
    room,
    mxEvent,
    customReactionImagesEnabled,
}: ReactionsRowProps): React.ReactElement | null {
    const [showAll, setShowAll] = useState(false);
    const [relationsVersion, rerenderRelations] = useReducer((value: number) => value + 1, 0);

    const eventId = mxEvent.getId();
    const userId = client.getUserId() ?? "";

    const relations = eventId ? getReactionRelations(room, eventId) : null;

    useEffect(() => {
        if (!relations) {
            return undefined;
        }

        const onChange = (): void => {
            rerenderRelations();
        };

        relations.on(RelationsEvent.Add, onChange);
        relations.on(RelationsEvent.Remove, onChange);
        relations.on(RelationsEvent.Redaction, onChange);

        return () => {
            relations.off(RelationsEvent.Add, onChange);
            relations.off(RelationsEvent.Remove, onChange);
            relations.off(RelationsEvent.Redaction, onChange);
        };
    }, [relations]);

    useEffect(() => {
        setShowAll(false);
    }, [eventId]);

    const myReactionsByKey = useMemo(() => {
        if (!relations || !userId) {
            return new Map<string, MatrixEvent>();
        }

        const bySender = relations.getAnnotationsBySender();
        if (!bySender) {
            return new Map<string, MatrixEvent>();
        }

        const mine = bySender[userId] ?? new Set<MatrixEvent>();
        const map = new Map<string, MatrixEvent>();

        for (const reactionEvent of mine) {
            if (reactionEvent.isRedacted()) {
                continue;
            }

            const key = reactionEvent.getRelation()?.key;
            if (!key || map.has(key)) {
                continue;
            }

            map.set(key, reactionEvent);
        }

        return map;
    }, [relations, relationsVersion, userId]);

    const canReact = useMemo(() => {
        if (!userId) {
            return false;
        }

        return room.currentState.maySendEvent(EventType.Reaction, userId);
    }, [room, userId]);

    const aggregates = useMemo(() => {
        if (!relations) {
            return [];
        }

        const sortedAnnotations = relations.getSortedAnnotationsByKey() ?? [];
        const buckets: ReactionAggregate[] = [];

        for (const [key, events] of sortedAnnotations) {
            if (!key) {
                continue;
            }

            const deduplicated = deduplicateReactionEventsBySender(events);
            if (deduplicated.length === 0) {
                continue;
            }

            buckets.push({
                key,
                count: deduplicated.length,
                reactionEvents: deduplicated,
                myReactionEvent: myReactionsByKey.get(key) ?? null,
            });
        }

        return buckets;
    }, [myReactionsByKey, relations, relationsVersion]);

    const visibleAggregates =
        !showAll && aggregates.length > MAX_ITEMS_WHEN_LIMITED + 1
            ? aggregates.slice(0, MAX_ITEMS_WHEN_LIMITED)
            : aggregates;

    const shouldShowAllButton = !showAll && aggregates.length > MAX_ITEMS_WHEN_LIMITED + 1;

    if (aggregates.length === 0) {
        return null;
    }

    return (
        <div className="reactions-row-wrap">
            <div className="reactions-row" role="toolbar" aria-label="Reactions">
                {visibleAggregates.map((aggregate) => {
                    const canRedactMyReaction = aggregate.myReactionEvent
                        ? room.currentState.maySendRedactionForEvent(aggregate.myReactionEvent, userId)
                        : true;

                    return (
                        <ReactionsRowButton
                            key={aggregate.key}
                            client={client}
                            room={room}
                            mxEvent={mxEvent}
                            content={aggregate.key}
                            count={aggregate.count}
                            reactionEvents={aggregate.reactionEvents}
                            myReactionEvent={aggregate.myReactionEvent}
                            customReactionImagesEnabled={customReactionImagesEnabled}
                            disabled={!canReact || (aggregate.myReactionEvent !== null && !canRedactMyReaction)}
                        />
                    );
                })}
                {shouldShowAllButton ? (
                    <button
                        type="button"
                        className="reactions-row-show-all"
                        onClick={() => setShowAll(true)}
                    >
                        Show all
                    </button>
                ) : null}
            </div>
        </div>
    );
}
