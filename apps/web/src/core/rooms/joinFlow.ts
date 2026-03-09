import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

interface JoinRoomWithRetryOptions {
    viaServers?: string[];
    maxAttempts?: number;
    retryDelayMs?: number;
}

interface MatrixLikeErrorData {
    errcode?: unknown;
    error?: unknown;
    retry_after_ms?: unknown;
    status?: unknown;
    statusCode?: unknown;
}

interface MatrixLikeError {
    errcode?: unknown;
    httpStatus?: unknown;
    status?: unknown;
    statusCode?: unknown;
    data?: MatrixLikeErrorData;
    message?: unknown;
}

const DEFAULT_JOIN_MAX_ATTEMPTS = 3;
const DEFAULT_JOIN_RETRY_DELAY_MS = 350;
const RETRYABLE_JOIN_HTTP_STATUS = new Set([504, 524]);

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== "object") {
        return "";
    }

    const matrixError = error as MatrixLikeError;
    if (typeof matrixError.data?.error === "string" && matrixError.data.error.trim().length > 0) {
        return matrixError.data.error;
    }

    if (typeof matrixError.message === "string" && matrixError.message.trim().length > 0) {
        return matrixError.message;
    }

    return "";
}

function getErrorCode(error: unknown): string | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    if (typeof matrixError.errcode === "string") {
        return matrixError.errcode;
    }
    if (typeof matrixError.data?.errcode === "string") {
        return matrixError.data.errcode;
    }

    return null;
}

function getErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    const candidate =
        typeof matrixError.httpStatus === "number"
            ? matrixError.httpStatus
            : typeof matrixError.statusCode === "number"
              ? matrixError.statusCode
              : typeof matrixError.status === "number"
                ? matrixError.status
                : typeof matrixError.data?.statusCode === "number"
                  ? matrixError.data.statusCode
                  : typeof matrixError.data?.status === "number"
                    ? matrixError.data.status
                    : null;

    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return null;
    }

    return candidate;
}

function getRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }

    const matrixError = error as MatrixLikeError;
    const candidate = matrixError.data?.retry_after_ms;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
        return null;
    }

    return candidate;
}

function sanitizeViaServers(viaServers: string[] | undefined): string[] {
    if (!Array.isArray(viaServers)) {
        return [];
    }

    return [...new Set(viaServers.map((via) => via.trim()).filter((via) => via.length > 0))];
}

function normalizeMaxAttempts(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_JOIN_MAX_ATTEMPTS;
    }

    const normalized = Math.floor(value);
    if (normalized < 1) {
        return 1;
    }

    return normalized;
}

function normalizeRetryDelayMs(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_JOIN_RETRY_DELAY_MS;
    }

    if (value < 0) {
        return 0;
    }

    return value;
}

function isRetryableJoinError(error: unknown): boolean {
    const status = getErrorStatus(error);
    return status !== null && RETRYABLE_JOIN_HTTP_STATUS.has(status);
}

function sleep(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        globalThis.setTimeout(resolve, durationMs);
    });
}

export function describeJoinError(error: unknown, target?: string): string {
    const status = getErrorStatus(error);
    const errcode = getErrorCode(error);
    const message = getErrorMessage(error);

    if (status === 403 || errcode === "M_FORBIDDEN") {
        return "You do not have permission to join this room.";
    }

    if (status === 404 || errcode === "M_NOT_FOUND") {
        return "Room was not found. Check the room ID or alias.";
    }

    if (status === 429 || errcode === "M_LIMIT_EXCEEDED") {
        const retryAfterMs = getRetryAfterMs(error);
        if (retryAfterMs && retryAfterMs > 0) {
            const retryAfterSeconds = Math.max(1, Math.round(retryAfterMs / 1000));
            return `Join rate limit reached. Try again in ${retryAfterSeconds}s.`;
        }
        return "Join rate limit reached. Try again in a moment.";
    }

    if (status === 504 || status === 524) {
        return "Homeserver timed out while joining. Try again.";
    }

    if (status !== null && status >= 500) {
        return "Homeserver returned an error while joining. Try again.";
    }

    if (message.length > 0) {
        return message;
    }

    if (target && target.trim().length > 0) {
        return `Failed to join "${target.trim()}".`;
    }

    return "Failed to join room.";
}

export async function joinRoomWithRetry(
    client: MatrixClient,
    target: string,
    options: JoinRoomWithRetryOptions = {},
): Promise<Room> {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) {
        throw new Error("Enter a room ID or alias.");
    }

    const viaServers = sanitizeViaServers(options.viaServers);
    const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
    const retryDelayMs = normalizeRetryDelayMs(options.retryDelayMs);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            if (viaServers.length > 0) {
                return await client.joinRoom(normalizedTarget, { viaServers });
            }
            return await client.joinRoom(normalizedTarget);
        } catch (joinError) {
            lastError = joinError;
            if (!isRetryableJoinError(joinError) || attempt >= maxAttempts) {
                throw joinError;
            }

            const nextDelayMs = retryDelayMs * attempt;
            await sleep(nextDelayMs);
        }
    }

    throw lastError ?? new Error("Failed to join room.");
}
