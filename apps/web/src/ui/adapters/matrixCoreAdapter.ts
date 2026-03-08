import { ClientEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";

import type { CoreConfig } from "../../core/config/configTypes";

const READY_SYNC_STATES = new Set(["PREPARED", "SYNCING", "CATCHUP"]);
const CLIENT_READY_TIMEOUT_MS = 20_000;

function normalizeSyncState(state: unknown): string {
    return String(state ?? "").toUpperCase();
}

export function isClientReady(client: MatrixClient): boolean {
    const currentState = normalizeSyncState(client.getSyncState?.());
    return READY_SYNC_STATES.has(currentState);
}

export async function waitForClientReady(client: MatrixClient): Promise<void> {
    if (isClientReady(client)) {
        return;
    }

    await new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            client.removeListener(ClientEvent.Sync, onSync);
            reject(new Error("Matrix sync did not reach a ready state in time."));
        }, CLIENT_READY_TIMEOUT_MS);

        const onSync = (state: unknown, _prevState?: unknown, data?: { error?: unknown }): void => {
            const normalized = normalizeSyncState(state);
            if (READY_SYNC_STATES.has(normalized)) {
                client.removeListener(ClientEvent.Sync, onSync);
                window.clearTimeout(timeoutId);
                resolve();
                return;
            }

            if (normalized === "ERROR") {
                client.removeListener(ClientEvent.Sync, onSync);
                window.clearTimeout(timeoutId);
                const syncError = data?.error;
                reject(
                    syncError instanceof Error
                        ? syncError
                        : new Error("Matrix sync entered error state before becoming ready."),
                );
            }
        };

        client.on(ClientEvent.Sync, onSync);
    });
}

export function getDefaultHomeserver(config: CoreConfig | null): string {
    const serverConfig = config?.default_server_config;
    const homeserver =
        serverConfig && typeof serverConfig === "object"
            ? (serverConfig["m.homeserver"] as { base_url?: string } | undefined)
            : undefined;

    return homeserver?.base_url ?? config?.default_hs_url?.toString() ?? "https://matrix.org";
}

export function getDefaultIdentityServer(config: CoreConfig | null): string | undefined {
    const serverConfig = config?.default_server_config;
    const identityServer =
        serverConfig && typeof serverConfig === "object"
            ? (serverConfig["m.identity_server"] as { base_url?: string } | undefined)
            : undefined;

    const value = identityServer?.base_url ?? config?.default_is_url?.toString();
    return value && value.trim().length > 0 ? value : undefined;
}

export function getFallbackHomeserver(config: CoreConfig | null): string | null {
    const value =
        config && typeof config.fallback_hs_url === "string" && config.fallback_hs_url.trim().length > 0
            ? config.fallback_hs_url.trim()
            : null;

    return value;
}

export function isCustomHomeserverDisabled(config: CoreConfig | null): boolean {
    return config?.disable_custom_urls === true;
}
