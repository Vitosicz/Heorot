import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";
import {
    getMatrixErrorCode,
    getMatrixErrorMessage,
    getMatrixErrorStatus,
    getMatrixRetryAfterMs,
} from "./matrixError";

interface JoinRoomWithRetryOptions {
    viaServers?: string[];
    maxAttempts?: number;
    retryDelayMs?: number;
}

const DEFAULT_JOIN_MAX_ATTEMPTS = 3;
const DEFAULT_JOIN_RETRY_DELAY_MS = 350;
const RETRYABLE_JOIN_HTTP_STATUS = new Set([504, 524]);

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
    const status = getMatrixErrorStatus(error);
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
    const status = getMatrixErrorStatus(error);
    const errcode = getMatrixErrorCode(error);
    const message = getMatrixErrorMessage(error);

    if (status === 403 || errcode === "M_FORBIDDEN") {
        return "You do not have permission to join this room.";
    }

    if (status === 404 || errcode === "M_NOT_FOUND") {
        return "Room was not found. Check the room ID or alias.";
    }

    if (status === 429 || errcode === "M_LIMIT_EXCEEDED") {
        const retryAfterMs = getMatrixRetryAfterMs(error);
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
