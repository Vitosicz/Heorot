import type { MatrixClient } from "matrix-js-sdk/src/matrix";

function toDevicePixels(size: number): number {
    const ratio = typeof window === "undefined" ? 1 : Math.max(window.devicePixelRatio || 1, 1);
    return Math.max(1, Math.floor(size * ratio));
}

export function mxcToHttp(client: MatrixClient, mxc: string | null | undefined): string | null {
    if (!mxc) {
        return null;
    }

    return client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true);
}

export function mxcThumbnailToHttp(
    client: MatrixClient,
    mxc: string | null | undefined,
    width: number,
    height: number,
): string | null {
    if (!mxc) {
        return null;
    }

    return client.mxcUrlToHttp(
        mxc,
        toDevicePixels(width),
        toDevicePixels(height),
        "crop",
        false,
        true,
    );
}
