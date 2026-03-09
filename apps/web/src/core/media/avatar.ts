import type {
    MatrixClient,
    ResizeMethod,
    Room,
    RoomMember,
} from "matrix-js-sdk/src/matrix";

import { mediaFromMxc, thumbnailFromMxc } from "./media";

function uniqueUrls(urls: Array<string | null | undefined>): string[] {
    return Array.from(
        new Set(
            urls.filter((url): url is string => typeof url === "string" && url.length > 0),
        ),
    );
}

export function memberAvatarSources(
    client: MatrixClient,
    member: RoomMember | null | undefined,
    size: number,
    resizeMethod: ResizeMethod = "crop",
): string[] {
    const mxc = member?.getMxcAvatarUrl();
    if (!mxc) {
        return [];
    }

    return uniqueUrls([
        thumbnailFromMxc(client, mxc, size, size, resizeMethod),
        mediaFromMxc(client, mxc),
    ]);
}

export function roomAvatarSources(
    client: MatrixClient,
    room: Room,
    size: number,
    includeFallbackMember = true,
): string[] {
    const roomAvatarMxc = room.getMxcAvatarUrl();
    const fallbackMxc = includeFallbackMember
        ? (room as Room & {
              getAvatarFallbackMember?: () => RoomMember | undefined;
          }).getAvatarFallbackMember?.()?.getMxcAvatarUrl()
        : undefined;

    return uniqueUrls([
        thumbnailFromMxc(client, roomAvatarMxc, size, size, "crop"),
        mediaFromMxc(client, roomAvatarMxc),
        thumbnailFromMxc(client, fallbackMxc, size, size, "crop"),
        mediaFromMxc(client, fallbackMxc),
    ]);
}
