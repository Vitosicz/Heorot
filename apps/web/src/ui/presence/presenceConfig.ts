import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import type { CoreConfig } from "../../core/config/configTypes";

type PresenceByHomeserver = Record<string, boolean>;

const LOCAL_DEV_ORIGINS = ["http://localhost:8008", "http://127.0.0.1:8008", "http://localhost:5173", "http://127.0.0.1:5173"];

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

function readPresenceByHomeserver(config: CoreConfig | null): Map<string, boolean> {
    const raw = config?.enable_presence_by_hs_url as PresenceByHomeserver | undefined;
    if (!raw || typeof raw !== "object") {
        return new Map<string, boolean>();
    }

    const out = new Map<string, boolean>();
    for (const [homeserverUrl, enabled] of Object.entries(raw)) {
        const normalized = normalizeOrigin(homeserverUrl);
        if (!normalized || typeof enabled !== "boolean") {
            continue;
        }
        out.set(normalized, enabled);
    }
    return out;
}

function getConfiguredHomeserverOrigin(config: CoreConfig | null): string | null {
    const explicit = normalizeOrigin(config?.default_hs_url as string | undefined);
    if (explicit) {
        return explicit;
    }

    const defaultServerConfig = config?.default_server_config as
        | {
              "m.homeserver"?: {
                  base_url?: unknown;
              };
          }
        | undefined;
    const baseUrl = defaultServerConfig?.["m.homeserver"]?.base_url;
    return typeof baseUrl === "string" ? normalizeOrigin(baseUrl) : null;
}

function isDesktopRuntime(): boolean {
    if (typeof window === "undefined") {
        return false;
    }
    return Boolean(window.heorotDesktop);
}

function buildDefaultEnabledOrigins(config: CoreConfig | null, currentHomeserverOrigin: string | null): Set<string> {
    const defaults = new Set<string>();
    for (const origin of LOCAL_DEV_ORIGINS) {
        const normalized = normalizeOrigin(origin);
        if (normalized) {
            defaults.add(normalized);
        }
    }

    const configuredOrigin = getConfiguredHomeserverOrigin(config);
    if (configuredOrigin) {
        defaults.add(configuredOrigin);
    } else if (currentHomeserverOrigin) {
        defaults.add(currentHomeserverOrigin);
    }

    return defaults;
}

function getClientHomeserverOrigin(client: MatrixClient | null): string | null {
    if (!client) {
        return null;
    }

    const viaGetter =
        (client as MatrixClient & {
            getHomeserverUrl?: () => string;
        }).getHomeserverUrl?.() ?? null;
    return normalizeOrigin(viaGetter ?? client.baseUrl ?? null);
}

export function isPresenceEnabledForClient(config: CoreConfig | null, client: MatrixClient | null): boolean {
    if (!isDesktopRuntime()) {
        return false;
    }

    const currentHomeserverOrigin = getClientHomeserverOrigin(client);
    if (!currentHomeserverOrigin) {
        return false;
    }

    const configuredMap = readPresenceByHomeserver(config);
    if (configuredMap.size > 0) {
        return configuredMap.get(currentHomeserverOrigin) === true;
    }

    const defaultEnabledOrigins = buildDefaultEnabledOrigins(config, currentHomeserverOrigin);
    return defaultEnabledOrigins.has(currentHomeserverOrigin);
}

