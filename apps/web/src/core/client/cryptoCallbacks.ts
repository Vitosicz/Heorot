import type { CryptoCallbacks } from "matrix-js-sdk/src/crypto-api";
import type { SecretStorage } from "matrix-js-sdk/src/matrix";

type SecretStorageKey = Uint8Array<ArrayBuffer>;

interface SecretStorageKeyProviderArgs {
    keyIds: string[];
    secretName: string;
}

export type SecretStorageKeyProvider = (
    args: SecretStorageKeyProviderArgs,
) => Promise<[string, SecretStorageKey] | null>;

let secretStorageBeingAccessed = false;
let secretStorageKeyCache: Record<string, SecretStorageKey> = {};
let activeSecretStorageKeyProvider: SecretStorageKeyProvider | null = null;

function cacheSecretStorageKey(
    keyId: string,
    _keyInfo: SecretStorage.SecretStorageKeyDescription,
    key: SecretStorageKey,
): void {
    if (!secretStorageBeingAccessed) {
        return;
    }

    secretStorageKeyCache[keyId] = key;
}

function resolveRequestedKeyId(requestedKeyIds: string[], preferredKeyId: string): string {
    if (requestedKeyIds.includes(preferredKeyId)) {
        return preferredKeyId;
    }

    const fallbackKeyId = requestedKeyIds[0];
    if (!fallbackKeyId) {
        throw new Error("No secret storage key IDs available.");
    }

    return fallbackKeyId;
}

async function getSecretStorageKey(
    { keys }: { keys: Record<string, SecretStorage.SecretStorageKeyDescription> },
    secretName: string,
): Promise<[string, SecretStorageKey]> {
    const requestedKeyIds = Object.keys(keys);
    if (requestedKeyIds.length === 0) {
        throw new Error("No secret storage key IDs available.");
    }

    if (secretStorageBeingAccessed) {
        for (const keyId of requestedKeyIds) {
            const cachedKey = secretStorageKeyCache[keyId];
            if (cachedKey) {
                return [keyId, cachedKey];
            }
        }
    }

    const provider = activeSecretStorageKeyProvider;
    if (provider) {
        const provided = await provider({ keyIds: requestedKeyIds, secretName });
        if (provided) {
            const [providedKeyId, providedKey] = provided;
            const resolvedKeyId = resolveRequestedKeyId(requestedKeyIds, providedKeyId);
            cacheSecretStorageKey(resolvedKeyId, keys[resolvedKeyId], providedKey);
            return [resolvedKeyId, providedKey];
        }
    }

    throw new Error("No secret storage key is currently available for this operation.");
}

export const coreCryptoCallbacks: CryptoCallbacks = {
    getSecretStorageKey,
    cacheSecretStorageKey,
};

export async function withSecretStorageKeyCache<T>(operation: () => Promise<T>): Promise<T> {
    const hadActiveCache = secretStorageBeingAccessed;
    if (!hadActiveCache) {
        secretStorageBeingAccessed = true;
        secretStorageKeyCache = {};
    }

    try {
        return await operation();
    } finally {
        if (!hadActiveCache) {
            secretStorageBeingAccessed = false;
            secretStorageKeyCache = {};
        }
    }
}

export async function withSecretStorageKeyProvider<T>(
    provider: SecretStorageKeyProvider,
    operation: () => Promise<T>,
): Promise<T> {
    const previousProvider = activeSecretStorageKeyProvider;
    activeSecretStorageKeyProvider = provider;
    try {
        return await withSecretStorageKeyCache(operation);
    } finally {
        activeSecretStorageKeyProvider = previousProvider;
    }
}
