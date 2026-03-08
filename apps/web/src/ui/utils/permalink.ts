export function buildMatrixToEventPermalink(roomId: string, eventId: string): string {
    return `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
}

export function buildMatrixToRoomPermalink(roomId: string): string {
    return `https://matrix.to/#/${encodeURIComponent(roomId)}`;
}
