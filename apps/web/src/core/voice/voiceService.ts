import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import type { CoreConfig } from "../config/configTypes";
import { getVoiceDiscovery } from "../voice/voiceDiscovery";

export interface LiveKitTokenResponse {
    token: string;
    wsUrl: string;
    livekitRoom: string;
    expiresAt: string;
    jti?: string;
}

export interface VoiceParticipantsResponse {
    matrixRoomId: string;
    participants: Array<{
        identity: string;
        name?: string;
        matrixUserId?: string;
        micPublished?: boolean;
        micMuted?: boolean;
        audioMuted?: boolean;
        screenSharing?: boolean;
    }>;
    count: number;
}

export interface VoiceParticipantStateUpdateBody {
    matrixRoomId: string;
    audioMuted: boolean;
}

interface VoiceServiceErrorInfo {
    reason: string;
    retryAfterMs?: number;
}

function trimTrailingSlashes(value: string): string {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
}

function normalizeOrigin(url: string | null | undefined): string | null {
    if (!url || typeof url !== "string") {
        return null;
    }

    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function getClientHomeserverOrigin(client: MatrixClient): string | null {
    const viaGetter =
        (client as MatrixClient & {
            getHomeserverUrl?: () => string;
        }).getHomeserverUrl?.() ?? null;

    return normalizeOrigin(viaGetter ?? client.baseUrl ?? null);
}

// Returns the voice API base URL (already includes /voice prefix).
// Prefers autodiscovery result; then logged-in homeserver domain; then legacy config.
function getVoiceApiBaseUrl(client: MatrixClient, config: CoreConfig | null): string {
    const discovery = getVoiceDiscovery();
    if (discovery) return discovery.apiBaseUrl;

    const homeserverOrigin = getClientHomeserverOrigin(client);
    if (homeserverOrigin) {
        return `${trimTrailingSlashes(homeserverOrigin)}/voice`;
    }

    const value = typeof config?.voice_service_url === "string" ? config.voice_service_url.trim() : "";
    if (!value) {
        throw new Error("Voice service unavailable: discovery failed and homeserver URL is unavailable.");
    }
    if (!value.startsWith("https://")) {
        throw new Error("Voice service unavailable: `voice_service_url` must use https://.");
    }
    return trimTrailingSlashes(value) + "/voice";
}

function getMatrixAccessToken(client: MatrixClient): string {
    const token = client.getAccessToken();
    if (!token) {
        throw new Error("Missing Matrix access token in current session.");
    }
    return token;
}

export function isVoiceFeatureEnabled(config: CoreConfig | null): boolean {
    if (config?.voice_enabled === false) {
        return false;
    }

    return true;
}

function parseVoiceServiceErrorInfo(body: unknown, status: number): VoiceServiceErrorInfo {
    if (!body || typeof body !== "object") {
        return { reason: `HTTP ${status}` };
    }

    const payload = body as {
        error?: unknown;
        error_code?: unknown;
        retry_after_ms?: unknown;
    };

    let reason = `HTTP ${status}`;
    if (typeof payload.error === "string" && payload.error.trim().length > 0) {
        reason = payload.error.trim();
    } else if (payload.error && typeof payload.error === "object") {
        const nestedError = payload.error as { message?: unknown };
        if (typeof nestedError.message === "string" && nestedError.message.trim().length > 0) {
            reason = nestedError.message.trim();
        }
    }

    const retryAfterMs =
        typeof payload.retry_after_ms === "number" && Number.isFinite(payload.retry_after_ms)
            ? Math.max(0, Math.round(payload.retry_after_ms))
            : undefined;

    return {
        reason,
        retryAfterMs,
    };
}

export async function fetchLiveKitToken(
    client: MatrixClient,
    config: CoreConfig | null,
    matrixRoomId: string,
    options?: { signal?: AbortSignal },
): Promise<LiveKitTokenResponse> {
    const apiBaseUrl = getVoiceApiBaseUrl(client, config);
    const response = await fetch(`${apiBaseUrl}/livekit/token`, {
        method: "POST",
        signal: options?.signal,
        headers: {
            Authorization: `Bearer ${getMatrixAccessToken(client)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ matrixRoomId }),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const { reason, retryAfterMs } = parseVoiceServiceErrorInfo(body, response.status);
        const error = new Error(`Unable to fetch LiveKit token: ${reason}`) as Error & {
            status?: number;
            retryAfterMs?: number;
        };
        error.status = response.status;
        if (typeof retryAfterMs === "number") {
            error.retryAfterMs = retryAfterMs;
        }
        throw error;
    }

    return (await response.json()) as LiveKitTokenResponse;
}

export async function fetchVoiceParticipants(
    client: MatrixClient,
    config: CoreConfig | null,
    matrixRoomId: string,
): Promise<VoiceParticipantsResponse> {
    const apiBaseUrl = getVoiceApiBaseUrl(client, config);
    const response = await fetch(
        `${apiBaseUrl}/livekit/participants?matrixRoomId=${encodeURIComponent(matrixRoomId)}`,
        {
            method: "GET",
            headers: {
                Authorization: `Bearer ${getMatrixAccessToken(client)}`,
            },
        },
    );

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const { reason } = parseVoiceServiceErrorInfo(body, response.status);
        throw new Error(`Unable to fetch voice participants: ${reason}`);
    }

    return (await response.json()) as VoiceParticipantsResponse;
}

export async function updateVoiceParticipantState(
    client: MatrixClient,
    config: CoreConfig | null,
    payload: VoiceParticipantStateUpdateBody,
): Promise<void> {
    const apiBaseUrl = getVoiceApiBaseUrl(client, config);
    const response = await fetch(`${apiBaseUrl}/livekit/state`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${getMatrixAccessToken(client)}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const { reason } = parseVoiceServiceErrorInfo(body, response.status);
        throw new Error(`Unable to update voice state: ${reason}`);
    }
}
