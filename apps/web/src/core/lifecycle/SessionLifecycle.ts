import { createClient, decodeBase64, type MatrixClient, type TokenRefreshFunction } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";

import { MatrixClientManager } from "../client/MatrixClientManager";
import { createMatrixClient } from "../client/createMatrixClient";
import { WebPlatform } from "../platform/WebPlatform";
import { getStoredSessionVars, persistCredentials } from "../storage/sessionStore";
import { idbClear } from "../storage/storageAccess";
import {
    ACCESS_TOKEN_IV,
    REFRESH_TOKEN_IV,
    persistAccessTokenInStorage,
    persistRefreshTokenInStorage,
    tryDecryptToken,
} from "../storage/tokens";
import type { MatrixClientAssignOpts, MatrixCredentials } from "../types/credentials";

const LOGOUT_REQUEST_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);

        promise.then(
            (result) => {
                window.clearTimeout(timeoutId);
                resolve(result);
            },
            (error) => {
                window.clearTimeout(timeoutId);
                reject(error);
            },
        );
    });
}

export interface SetLoggedInOptions {
    clearStorage?: boolean;
    startSyncing?: boolean;
    persistSession?: boolean;
}

export interface SessionLifecycleOptions {
    platform?: WebPlatform;
    clientManager?: MatrixClientManager;
}

export class SessionLifecycle {
    public readonly platform: WebPlatform;
    public readonly clientManager: MatrixClientManager;

    public constructor(options: SessionLifecycleOptions = {}) {
        this.platform = options.platform ?? new WebPlatform();
        this.clientManager = options.clientManager ?? new MatrixClientManager();
    }

    public async restoreSession(ignoreGuest = false): Promise<boolean> {
        const session = await getStoredSessionVars();

        if (!session.hasAccessToken || !session.accessToken || !session.userId || !session.hsUrl) {
            return false;
        }

        if (ignoreGuest && session.isGuest) {
            return false;
        }

        const pickleKey = await this.platform.getPickleKey(session.userId, session.deviceId ?? "");
        const decryptedAccessToken = await tryDecryptToken(pickleKey ?? undefined, session.accessToken, ACCESS_TOKEN_IV);
        const decryptedRefreshToken = session.refreshToken
            ? await tryDecryptToken(pickleKey ?? undefined, session.refreshToken, REFRESH_TOKEN_IV)
            : undefined;

        await this.setLoggedIn(
            {
                homeserverUrl: session.hsUrl,
                identityServerUrl: session.isUrl,
                userId: session.userId,
                deviceId: session.deviceId,
                accessToken: decryptedAccessToken,
                refreshToken: decryptedRefreshToken,
                guest: session.isGuest,
                pickleKey: pickleKey ?? undefined,
            },
            {
                clearStorage: false,
                startSyncing: true,
                persistSession: true,
            },
        );

        return true;
    }

    public async setLoggedIn(credentials: MatrixCredentials, options: SetLoggedInOptions = {}): Promise<MatrixClient> {
        const clearStorage = options.clearStorage === true;
        const startSyncing = options.startSyncing !== false;
        const persistSession = options.persistSession !== false;

        if (clearStorage) {
            await this.clearStorage();
        }

        const resolvedCredentials = { ...credentials };

        if (!resolvedCredentials.pickleKey && resolvedCredentials.deviceId) {
            resolvedCredentials.pickleKey =
                (await this.platform.getPickleKey(resolvedCredentials.userId, resolvedCredentials.deviceId)) ??
                (await this.platform.createPickleKey(resolvedCredentials.userId, resolvedCredentials.deviceId)) ??
                undefined;
        }

        const tokenRefreshFunction = this.createTokenRefreshFunction(resolvedCredentials, persistSession);
        this.clientManager.replaceUsingCreds(resolvedCredentials, tokenRefreshFunction);

        if (persistSession) {
            await persistCredentials(resolvedCredentials);
        }

        const assignOpts: MatrixClientAssignOpts = {};
        if (resolvedCredentials.pickleKey) {
            if (resolvedCredentials.pickleKey.length === 43) {
                assignOpts.rustCryptoStoreKey = decodeBase64(resolvedCredentials.pickleKey);
            } else {
                assignOpts.rustCryptoStorePassword = resolvedCredentials.pickleKey;
            }
        }

        try {
            if (startSyncing) {
                await this.clientManager.start(assignOpts);
            } else {
                await this.clientManager.assign(assignOpts);
            }
        } finally {
            assignOpts.rustCryptoStoreKey?.fill(0);
        }

        return this.clientManager.safeGet();
    }

    public async loginWithPassword(
        homeserverUrl: string,
        identifier: { type: "m.id.user"; user: string },
        password: string,
        identityServerUrl?: string,
        initialDeviceDisplayName?: string,
    ): Promise<MatrixCredentials> {
        const tempClient = createClient({
            baseUrl: homeserverUrl,
            idBaseUrl: identityServerUrl,
        });

        const response = await tempClient.loginRequest({
            type: "m.login.password",
            identifier,
            password,
            initial_device_display_name: initialDeviceDisplayName,
            refresh_token: true,
        });

        return {
            homeserverUrl,
            identityServerUrl,
            userId: response.user_id,
            deviceId: response.device_id,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            guest: false,
        };
    }

    public async loginWithToken(
        homeserverUrl: string,
        token: string,
        identityServerUrl?: string,
        initialDeviceDisplayName?: string,
    ): Promise<MatrixCredentials> {
        const tempClient = createClient({
            baseUrl: homeserverUrl,
            idBaseUrl: identityServerUrl,
        });

        const response = await tempClient.loginRequest({
            type: "m.login.token",
            token,
            initial_device_display_name: initialDeviceDisplayName,
            refresh_token: true,
        });

        return {
            homeserverUrl,
            identityServerUrl,
            userId: response.user_id,
            deviceId: response.device_id,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            guest: false,
        };
    }

    public async logout(clearStorage = true): Promise<void> {
        const client = this.clientManager.get();

        if (client && !client.isGuest()) {
            try {
                await withTimeout(
                    client.logout(true),
                    LOGOUT_REQUEST_TIMEOUT_MS,
                    "Homeserver logout request timed out.",
                );
            } catch (error) {
                logger.warn("Logout API call failed", error);
            }
        }

        if (client?.getUserId() && client?.getDeviceId()) {
            await this.platform.destroyPickleKey(client.getUserId()!, client.getDeviceId()!);
        }

        this.clientManager.stop(true);

        if (clearStorage) {
            await this.clearStorage();
        }
    }

    private createTokenRefreshFunction(
        credentials: MatrixCredentials,
        persistSession: boolean,
    ): TokenRefreshFunction | undefined {
        if (!credentials.refreshToken) {
            return undefined;
        }

        const refreshClient = createClient({
            baseUrl: credentials.homeserverUrl,
            idBaseUrl: credentials.identityServerUrl,
        });

        return async (refreshToken: string) => {
            const response = await refreshClient.refreshToken(refreshToken);
            const nextAccessToken = response.access_token;
            const nextRefreshToken = response.refresh_token || refreshToken;

            credentials.accessToken = nextAccessToken;
            credentials.refreshToken = nextRefreshToken;

            if (persistSession) {
                await persistAccessTokenInStorage(nextAccessToken, credentials.pickleKey);
                await persistRefreshTokenInStorage(nextRefreshToken, credentials.pickleKey);
            }

            return {
                accessToken: nextAccessToken,
                refreshToken: nextRefreshToken,
                expiry:
                    typeof response.expires_in_ms === "number"
                        ? new Date(Date.now() + response.expires_in_ms)
                        : undefined,
            };
        };
    }
    public async clearStorage(): Promise<void> {
        if (typeof window !== "undefined") {
            window.localStorage.clear();
            window.sessionStorage.clear();
        }

        await Promise.allSettled([idbClear("account"), idbClear("pickleKey")]);

        const cleanupClient = createMatrixClient({
            baseUrl: "",
        });

        await cleanupClient.clearStores();
    }
}
