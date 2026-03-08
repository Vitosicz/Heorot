import type { MatrixClient, ResizeMethod } from "matrix-js-sdk/src/matrix";

function toDevicePixels(size: number): number {
    const pixelRatio = typeof window === "undefined" ? 1 : Math.max(window.devicePixelRatio || 1, 1);
    return Math.max(1, Math.floor(size * pixelRatio));
}

export function thumbnailFromMxc(
    client: MatrixClient,
    mxc: string | null | undefined,
    width: number,
    height: number,
    resizeMethod: ResizeMethod = "crop",
): string | null {
    if (!mxc) {
        return null;
    }

    // Match Matrix spec/client behavior: fetch media through Matrix media APIs, not direct links.
    return client.mxcUrlToHttp(
        mxc,
        toDevicePixels(width),
        toDevicePixels(height),
        resizeMethod,
        false,
        true,
    );
}

export function mediaFromMxc(client: MatrixClient, mxc: string | null | undefined): string | null {
    if (!mxc) {
        return null;
    }

    // Use the regular media endpoint so <img> can load it directly in the browser.
    return client.mxcUrlToHttp(mxc, undefined, undefined, undefined, false, true);
}
