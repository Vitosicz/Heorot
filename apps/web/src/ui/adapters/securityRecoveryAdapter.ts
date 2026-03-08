import type { GeneratedSecretStorageKey } from "matrix-js-sdk/src/crypto-api";
import { decodeRecoveryKey } from "matrix-js-sdk/src/crypto-api/recovery-key";
import type { MatrixClient, Room } from "matrix-js-sdk/src/matrix";

import { withSecretStorageKeyProvider } from "../../core/client/cryptoCallbacks";

export type RecoveryCredentialType = "recovery_key";
export type SecurityRecoveryFlow = "restore" | "setup";

export type AutomaticRecoveryStatus = "not_supported" | "no_backup" | "restored" | "needs_recovery_key";

export interface AutomaticRecoveryResult {
    status: AutomaticRecoveryStatus;
    error?: string;
    backupVersion: string | null;
}

interface BackupInfoLike {
    version?: string;
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function normalizeErrorMessage(message: string): string {
    return message.replace(/\s+/g, " ").trim();
}

function requiresManualRecoveryKey(message: string): boolean {
    const lowered = message.toLowerCase();
    return (
        lowered.includes("decryption key") ||
        lowered.includes("secret storage") ||
        lowered.includes("no backup info") ||
        lowered.includes("not found") ||
        lowered.includes("callback")
    );
}

export async function attemptAutomaticKeyBackupRestore(client: MatrixClient): Promise<AutomaticRecoveryResult> {
    const crypto = client.getCrypto();
    if (!crypto) {
        return {
            status: "not_supported",
            backupVersion: null,
        };
    }

    const backupInfo = (await crypto.getKeyBackupInfo()) as BackupInfoLike | null;
    if (!backupInfo?.version) {
        return {
            status: "no_backup",
            backupVersion: null,
        };
    }

    try {
        await crypto.restoreKeyBackup();
        return {
            status: "restored",
            backupVersion: backupInfo.version,
        };
    } catch {
        // Continue with secret-storage-based recovery.
    }

    const has4S = await client.secretStorage.hasKey();
    const backupKeyStored = has4S ? await client.isKeyBackupKeyStored() : null;
    if (!backupKeyStored) {
        return {
            status: "needs_recovery_key",
            backupVersion: backupInfo.version,
        };
    }

    try {
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
        await crypto.restoreKeyBackup();
        return {
            status: "restored",
            backupVersion: backupInfo.version,
        };
    } catch (error) {
        const message = normalizeErrorMessage(toErrorMessage(error));
        if (requiresManualRecoveryKey(message)) {
            return {
                status: "needs_recovery_key",
                error: message,
                backupVersion: backupInfo.version,
            };
        }

        return {
            status: "needs_recovery_key",
            error: `Automatic key restore failed: ${message}`,
            backupVersion: backupInfo.version,
        };
    }
}

export function isRecoveryKeyValid(recoveryKey: string): boolean {
    try {
        decodeRecoveryKey(recoveryKey);
        return true;
    } catch {
        return false;
    }
}

export async function restoreKeyBackupWithRecoveryKey(
    client: MatrixClient,
    recoveryKey: string,
    backupVersion?: string | null,
): Promise<void> {
    const crypto = client.getCrypto();
    if (!crypto) {
        return;
    }

    const trimmedKey = recoveryKey.trim();
    if (!trimmedKey) {
        throw new Error("Recovery key is required.");
    }

    const resolvedBackupVersion = backupVersion ?? (await crypto.getKeyBackupInfo())?.version ?? null;
    if (!resolvedBackupVersion) {
        throw new Error("No key backup is available on the homeserver.");
    }

    const decodedKey = decodeRecoveryKey(trimmedKey);
    try {
        await crypto.storeSessionBackupPrivateKey(decodedKey, resolvedBackupVersion);
        await crypto.restoreKeyBackup();
    } catch (error) {
        const message = toErrorMessage(error).toLowerCase();
        const keyMismatch = message.includes("key backup on server does not match the decryption key");
        if (!keyMismatch) {
            throw error;
        }

        const latestVersion = (await crypto.getKeyBackupInfo())?.version ?? null;
        if (!latestVersion || latestVersion === resolvedBackupVersion) {
            throw error;
        }

        await crypto.storeSessionBackupPrivateKey(decodedKey, latestVersion);
        await crypto.restoreKeyBackup();
    }
}

export async function restoreKeyBackupWithSecretStorageCredential(
    client: MatrixClient,
    credential: string,
): Promise<void> {
    const crypto = client.getCrypto();
    if (!crypto) {
        return;
    }

    const trimmedCredential = credential.trim();
    if (!trimmedCredential) {
        throw new Error("Security key is required.");
    }

    const secretStorage = client.secretStorage as unknown as {
        getDefaultKeyId: () => Promise<string | null>;
        checkKey: (key: Uint8Array<ArrayBuffer>, info: unknown) => Promise<boolean>;
    };

    const keyInfos = (await client.isKeyBackupKeyStored()) as Record<string, unknown> | null;
    if (!keyInfos || Object.keys(keyInfos).length === 0) {
        throw new Error("No key backup secret is stored in secret storage.");
    }

    const defaultKeyId = await secretStorage.getDefaultKeyId();
    const selectedKeyId = defaultKeyId && keyInfos[defaultKeyId] ? defaultKeyId : Object.keys(keyInfos)[0];
    const selectedKeyInfo = keyInfos[selectedKeyId];
    const privateKey = decodeRecoveryKey(trimmedCredential);

    try {
        const isValidForSecretStorage = await secretStorage.checkKey(privateKey, selectedKeyInfo);
        if (!isValidForSecretStorage) {
            throw new Error("Provided security key does not unlock secret storage.");
        }

        await withSecretStorageKeyProvider(
            async ({ keyIds }) => {
                const resolvedKeyId = keyIds.includes(selectedKeyId) ? selectedKeyId : keyIds[0];
                if (!resolvedKeyId) {
                    throw new Error("No matching secret storage key IDs available.");
                }

                return [resolvedKeyId, privateKey];
            },
            async () => {
                await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
                await crypto.restoreKeyBackup();
            },
        );
    } finally {
        privateKey.fill(0);
    }
}

export function triggerRoomHistoryDecryption(client: MatrixClient): void {
    for (const room of client.getRooms()) {
        const decryptAllEvents = (room as Room & { decryptAllEvents?: () => void }).decryptAllEvents;
        decryptAllEvents?.call(room);
    }
}

export async function createSecretStorageSetupKey(client: MatrixClient): Promise<GeneratedSecretStorageKey> {
    const crypto = client.getCrypto();
    if (!crypto) {
        throw new Error("Encryption is not available for this session.");
    }

    const generatedKey = await crypto.createRecoveryKeyFromPassphrase(undefined);
    if (!generatedKey.encodedPrivateKey || generatedKey.encodedPrivateKey.trim().length === 0) {
        generatedKey.privateKey.fill(0);
        throw new Error("Failed to generate a valid security key.");
    }

    return generatedKey;
}

export async function bootstrapSecretStorageSetup(
    client: MatrixClient,
    secretStorageKey: GeneratedSecretStorageKey,
): Promise<void> {
    const crypto = client.getCrypto();
    if (!crypto) {
        throw new Error("Encryption is not available for this session.");
    }

    const backupInfo = await crypto.getKeyBackupInfo();
    await withSecretStorageKeyProvider(
        async ({ keyIds }) => {
            const firstRequestedKeyId = keyIds[0];
            if (!firstRequestedKeyId) {
                throw new Error("No secret storage key IDs available for setup.");
            }

            return [firstRequestedKeyId, secretStorageKey.privateKey];
        },
        async () => {
            await crypto.bootstrapSecretStorage({
                createSecretStorageKey: async () => secretStorageKey,
                setupNewSecretStorage: true,
                setupNewKeyBackup: !backupInfo?.version,
            });
        },
    );
}
