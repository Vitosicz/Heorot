import type { AESEncryptedSecretStoragePayload } from "matrix-js-sdk/src/types";

export interface MatrixCredentials {
    homeserverUrl: string;
    identityServerUrl?: string;
    userId: string;
    deviceId?: string;
    accessToken: string;
    refreshToken?: string;
    guest?: boolean;
    pickleKey?: string;
    freshLogin?: boolean;
}

export interface StoredSession {
    hsUrl?: string;
    isUrl?: string;
    hasAccessToken?: boolean;
    accessToken?: string | AESEncryptedSecretStoragePayload;
    hasRefreshToken?: boolean;
    refreshToken?: string | AESEncryptedSecretStoragePayload;
    userId?: string;
    deviceId?: string;
    isGuest?: boolean;
}

export interface MatrixClientAssignOpts {
    rustCryptoStoreKey?: Uint8Array;
    rustCryptoStorePassword?: string;
}
