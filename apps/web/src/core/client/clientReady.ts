import { ClientEvent, type MatrixClient } from "matrix-js-sdk/src/matrix";

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
