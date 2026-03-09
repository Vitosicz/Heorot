export {
    attemptAutomaticKeyBackupRestore,
    bootstrapSecretStorageSetup,
    createSecretStorageSetupKey,
    isRecoveryKeyValid,
    restoreKeyBackupWithRecoveryKey,
    restoreKeyBackupWithSecretStorageCredential,
    triggerRoomHistoryDecryption,
} from "../../core/crypto/securityRecoveryFlow";
export type {
    AutomaticRecoveryResult,
    AutomaticRecoveryStatus,
    RecoveryCredentialType,
    SecurityRecoveryFlow,
} from "../../core/crypto/securityRecoveryFlow";
