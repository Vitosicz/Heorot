import decryptAESSecretStorageItem from "matrix-js-sdk/src/utils/decryptAESSecretStorageItem";
import encryptAESSecretStorageItem from "matrix-js-sdk/src/utils/encryptAESSecretStorageItem";
import type { AESEncryptedSecretStoragePayload } from "matrix-js-sdk/src/types";

import { idbDelete, idbSave } from "./storageAccess";

export const ACCESS_TOKEN_STORAGE_KEY = "mx_access_token";
export const REFRESH_TOKEN_STORAGE_KEY = "mx_refresh_token";
export const ACCESS_TOKEN_IV = "access_token";
export const REFRESH_TOKEN_IV = "refresh_token";
export const HAS_ACCESS_TOKEN_STORAGE_KEY = "mx_has_access_token";
export const HAS_REFRESH_TOKEN_STORAGE_KEY = "mx_has_refresh_token";

function getLocalStorage(): Storage | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }

    return window.localStorage;
}

async function pickleKeyToAesKey(pickleKey: string): Promise<Uint8Array> {
    const pickleKeyBuffer = new Uint8Array(pickleKey.length);

    for (let index = 0; index < pickleKey.length; index++) {
        pickleKeyBuffer[index] = pickleKey.charCodeAt(index);
    }

    const hkdfKey = await crypto.subtle.importKey("raw", pickleKeyBuffer, "HKDF", false, ["deriveBits"]);
    pickleKeyBuffer.fill(0);

    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: "HKDF",
                hash: "SHA-256",
                // @ts-expect-error Missing in older TS DOM types.
                salt: new Uint8Array(32),
                info: new Uint8Array(0),
            },
            hkdfKey,
            256,
        ),
    );
}

export async function tryDecryptToken(
    pickleKey: string | undefined,
    token: AESEncryptedSecretStoragePayload | string,
    tokenName: string,
): Promise<string> {
    if (typeof token === "string") {
        return token;
    }

    if (!pickleKey) {
        throw new Error(`Cannot decrypt ${tokenName}: missing pickleKey`);
    }

    const encryptionKey = await pickleKeyToAesKey(pickleKey);
    const decryptedToken = await decryptAESSecretStorageItem(token, encryptionKey, tokenName);
    encryptionKey.fill(0);

    return decryptedToken;
}

export async function persistTokenInStorage(
    storageKey: string,
    tokenName: string,
    token: string | undefined,
    pickleKey: string | undefined,
    hasTokenStorageKey: string,
): Promise<void> {
    const localStorage = getLocalStorage();

    if (localStorage) {
        if (token) {
            localStorage.setItem(hasTokenStorageKey, "true");
        } else {
            localStorage.removeItem(hasTokenStorageKey);
        }

        // Security hardening: remove any legacy plaintext token remnants.
        localStorage.removeItem(storageKey);
    }

    if (!token) {
        await idbDelete("account", storageKey);
        return;
    }

    let tokenToPersist: AESEncryptedSecretStoragePayload | string = token;

    if (pickleKey) {
        const encryptionKey = await pickleKeyToAesKey(pickleKey);
        try {
            tokenToPersist = await encryptAESSecretStorageItem(token, encryptionKey, tokenName);
        } finally {
            encryptionKey.fill(0);
        }
    }

    await idbSave("account", storageKey, tokenToPersist);
}

export async function persistAccessTokenInStorage(token: string | undefined, pickleKey?: string): Promise<void> {
    await persistTokenInStorage(ACCESS_TOKEN_STORAGE_KEY, ACCESS_TOKEN_IV, token, pickleKey, HAS_ACCESS_TOKEN_STORAGE_KEY);
}

export async function persistRefreshTokenInStorage(token: string | undefined, pickleKey?: string): Promise<void> {
    await persistTokenInStorage(
        REFRESH_TOKEN_STORAGE_KEY,
        REFRESH_TOKEN_IV,
        token,
        pickleKey,
        HAS_REFRESH_TOKEN_STORAGE_KEY,
    );
}
