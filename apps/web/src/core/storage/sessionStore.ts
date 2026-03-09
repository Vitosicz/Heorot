import type { MatrixCredentials, StoredSession } from "../types/credentials";
import type { AESEncryptedSecretStoragePayload } from "matrix-js-sdk/src/types";

import { idbLoad } from "./storageAccess";
import {
    ACCESS_TOKEN_STORAGE_KEY,
    HAS_ACCESS_TOKEN_STORAGE_KEY,
    HAS_REFRESH_TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    persistAccessTokenInStorage,
    persistRefreshTokenInStorage,
} from "./tokens";

export const HOMESERVER_URL_KEY = "mx_hs_url";
export const ID_SERVER_URL_KEY = "mx_is_url";
export const USER_ID_KEY = "mx_user_id";
export const DEVICE_ID_KEY = "mx_device_id";
export const IS_GUEST_KEY = "mx_is_guest";
export const HAS_PICKLE_KEY = "mx_has_pickle_key";

export const CORE_SESSION_STORAGE_KEYS = [
    HOMESERVER_URL_KEY,
    ID_SERVER_URL_KEY,
    USER_ID_KEY,
    DEVICE_ID_KEY,
    IS_GUEST_KEY,
    HAS_PICKLE_KEY,
    ACCESS_TOKEN_STORAGE_KEY,
    REFRESH_TOKEN_STORAGE_KEY,
    HAS_ACCESS_TOKEN_STORAGE_KEY,
    HAS_REFRESH_TOKEN_STORAGE_KEY,
] as const;

function getLocalStorage(): Storage | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }

    return window.localStorage;
}

export async function persistCredentials(credentials: MatrixCredentials): Promise<void> {
    const localStorage = getLocalStorage();

    if (localStorage) {
        localStorage.setItem(HOMESERVER_URL_KEY, credentials.homeserverUrl);

        if (credentials.identityServerUrl) {
            localStorage.setItem(ID_SERVER_URL_KEY, credentials.identityServerUrl);
        }

        localStorage.setItem(USER_ID_KEY, credentials.userId);
        localStorage.setItem(IS_GUEST_KEY, JSON.stringify(Boolean(credentials.guest)));

        if (credentials.deviceId) {
            localStorage.setItem(DEVICE_ID_KEY, credentials.deviceId);
        }

        if (credentials.pickleKey) {
            localStorage.setItem(HAS_PICKLE_KEY, "true");
        }
    }

    await persistAccessTokenInStorage(credentials.accessToken, credentials.pickleKey);
    await persistRefreshTokenInStorage(credentials.refreshToken, credentials.pickleKey);
}

export async function getStoredToken(storageKey: string): Promise<StoredSession["accessToken"]> {
    const token = await idbLoad<AESEncryptedSecretStoragePayload | string>("account", storageKey);
    const localStorage = getLocalStorage();
    if (localStorage) {
        // Security hardening: scrub legacy plaintext tokens.
        localStorage.removeItem(storageKey);
    }

    return token;
}

export async function getStoredSessionVars(): Promise<StoredSession> {
    const localStorage = getLocalStorage();

    const hsUrl = localStorage?.getItem(HOMESERVER_URL_KEY) ?? undefined;
    const isUrl = localStorage?.getItem(ID_SERVER_URL_KEY) ?? undefined;
    const accessToken = await getStoredToken(ACCESS_TOKEN_STORAGE_KEY);
    const refreshToken = await getStoredToken(REFRESH_TOKEN_STORAGE_KEY);

    const hasAccessToken = (localStorage?.getItem(HAS_ACCESS_TOKEN_STORAGE_KEY) === "true") || Boolean(accessToken);
    const hasRefreshToken = (localStorage?.getItem(HAS_REFRESH_TOKEN_STORAGE_KEY) === "true") || Boolean(refreshToken);

    const userId = localStorage?.getItem(USER_ID_KEY) ?? undefined;
    const deviceId = localStorage?.getItem(DEVICE_ID_KEY) ?? undefined;
    const isGuest = localStorage?.getItem(IS_GUEST_KEY) === "true";

    return {
        hsUrl,
        isUrl,
        hasAccessToken,
        accessToken,
        hasRefreshToken,
        refreshToken,
        userId,
        deviceId,
        isGuest,
    };
}
