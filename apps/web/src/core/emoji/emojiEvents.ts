export interface EmojiPackUpdatedEventDetail {
    kind: "space" | "personal";
    spaceId?: string;
}

const EMOJI_PACK_UPDATED_EVENT = "heorot:emoji-pack-updated";

export function emitEmojiPackUpdated(detail: EmojiPackUpdatedEventDetail): void {
    if (typeof window === "undefined") {
        return;
    }

    window.dispatchEvent(new CustomEvent<EmojiPackUpdatedEventDetail>(EMOJI_PACK_UPDATED_EVENT, { detail }));
}

export function subscribeEmojiPackUpdated(
    listener: (detail: EmojiPackUpdatedEventDetail) => void,
): () => void {
    if (typeof window === "undefined") {
        return () => {};
    }

    const handler = (event: Event): void => {
        const customEvent = event as CustomEvent<EmojiPackUpdatedEventDetail>;
        if (!customEvent.detail) {
            return;
        }

        listener(customEvent.detail);
    };

    window.addEventListener(EMOJI_PACK_UPDATED_EVENT, handler as EventListener);
    return () => {
        window.removeEventListener(EMOJI_PACK_UPDATED_EVENT, handler as EventListener);
    };
}