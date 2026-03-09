import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import type { GeneratedSecretStorageKey } from "matrix-js-sdk/src/crypto-api";
import { MatrixClient as MatrixClientSdk, MatrixError, type MatrixClient } from "matrix-js-sdk/src/matrix";

import { bootstrapCore } from "../../bootstrap";
import type { CoreContext } from "../../core/CoreContext";
import type { CoreConfig } from "../../core/config/configTypes";
import type { MatrixCredentials } from "../../core/types/credentials";
import {
    assertPasswordLoginSupported,
    loginWithPasswordLikeElement,
    normalizeHomeserverUrl,
    shouldTryFallbackLogin,
} from "../adapters/loginAdapter";
import { waitForClientReady } from "../../core/client/clientReady";
import { getDefaultIdentityServer, getFallbackHomeserver } from "../../core/config/serverDefaults";
import {
    attemptAutomaticKeyBackupRestore,
    bootstrapSecretStorageSetup,
    createSecretStorageSetupKey,
    type RecoveryCredentialType,
    type SecurityRecoveryFlow,
    restoreKeyBackupWithRecoveryKey,
    restoreKeyBackupWithSecretStorageCredential,
    triggerRoomHistoryDecryption,
} from "../adapters/securityRecoveryAdapter";

export type MatrixSessionStatus =
    | "booting"
    | "login_required"
    | "starting"
    | "security_verification"
    | "security_recovery"
    | "ready"
    | "error";

interface MatrixState {
    core: CoreContext | null;
    config: CoreConfig | null;
    client: MatrixClient | null;
    status: MatrixSessionStatus;
    error: string | null;
    securityRecoveryFlow: SecurityRecoveryFlow;
    securityRecoveryMode: RecoveryCredentialType;
    securityRecoveryBackupVersion: string | null;
    localDeviceVerified: boolean;
}

type MatrixAction =
    | {
          type: "set_core";
          core: CoreContext;
          config: CoreConfig;
      }
    | {
          type: "set_status";
          status: MatrixSessionStatus;
          error?: string | null;
      }
    | {
          type: "set_client";
          client: MatrixClient | null;
      }
    | {
          type: "set_security_recovery";
          flow: SecurityRecoveryFlow;
          mode: RecoveryCredentialType;
          backupVersion: string | null;
      }
    | {
          type: "set_local_device_verified";
          verified: boolean;
      };

const initialState: MatrixState = {
    core: null,
    config: null,
    client: null,
    status: "booting",
    error: null,
    securityRecoveryFlow: "restore",
    securityRecoveryMode: "recovery_key",
    securityRecoveryBackupVersion: null,
    localDeviceVerified: false,
};

function reducer(state: MatrixState, action: MatrixAction): MatrixState {
    switch (action.type) {
        case "set_core":
            return {
                ...state,
                core: action.core,
                config: action.config,
            };
        case "set_status":
            return {
                ...state,
                status: action.status,
                error: action.error ?? null,
            };
        case "set_client":
            return {
                ...state,
                client: action.client,
            };
        case "set_security_recovery":
            return {
                ...state,
                securityRecoveryFlow: action.flow,
                securityRecoveryMode: action.mode,
                securityRecoveryBackupVersion: action.backupVersion,
            };
        case "set_local_device_verified":
            return {
                ...state,
                localDeviceVerified: action.verified,
            };
        default:
            return state;
    }
}

interface MatrixContextValue extends MatrixState {
    login: (homeserverUrl: string, username: string, password: string) => Promise<void>;
    loginWithCredentials: (credentials: MatrixCredentials) => Promise<void>;
    logout: () => Promise<void>;
    startDeviceVerification: () => Promise<void>;
    refreshDeviceVerification: () => Promise<void>;
    skipDeviceVerification: () => Promise<void>;
    forceVerificationEnabled: boolean;
    prepareSecurityRecoverySetup: () => Promise<string>;
    completeSecurityRecoverySetup: () => Promise<void>;
    completeSecurityRecovery: (credential: string) => Promise<void>;
    skipSecurityRecovery: () => void;
}

const MatrixContext = createContext<MatrixContextValue | null>(null);

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatLoginError(error: unknown): string {
    const fallbackMessage = toErrorMessage(error);

    if (!error || typeof error !== "object") {
        return fallbackMessage;
    }

    const matrixError = error as {
        errcode?: unknown;
        httpStatus?: unknown;
        statusCode?: unknown;
        data?: {
            errcode?: unknown;
            error?: unknown;
        };
    };

    const messageFromData = typeof matrixError.data?.error === "string" ? matrixError.data.error : null;
    const message = messageFromData && messageFromData.trim().length > 0 ? messageFromData : fallbackMessage;

    const errcode =
        typeof matrixError.errcode === "string"
            ? matrixError.errcode
            : typeof matrixError.data?.errcode === "string"
              ? matrixError.data.errcode
              : null;

    const httpStatus =
        typeof matrixError.httpStatus === "number"
            ? matrixError.httpStatus
            : typeof matrixError.statusCode === "number"
              ? matrixError.statusCode
              : null;

    const suffixParts: string[] = [];
    if (errcode) {
        suffixParts.push(errcode);
    }
    if (httpStatus) {
        suffixParts.push(`HTTP ${httpStatus}`);
    }

    if (suffixParts.length === 0) {
        return message;
    }

    return `${message} (${suffixParts.join(", ")})`;
}

function shouldRetryWithCleanStorage(error: unknown): boolean {
    const message = toErrorMessage(error).toLowerCase();
    return message.includes("unpickling") || message.includes("failed to be decrypted");
}

function formatSecurityRecoveryError(error: unknown): string {
    if (error instanceof MatrixError && error.errcode === MatrixClientSdk.RESTORE_BACKUP_ERROR_BAD_KEY) {
        return "Security key does not match the current key backup on the server.";
    }

    const message = toErrorMessage(error).trim();
    const lowered = message.toLowerCase();

    if (lowered.includes("key backup on server does not match the decryption key")) {
        return "Security key does not match the current key backup on the server.";
    }

    if (lowered.includes("incorrect parity") || lowered.includes("incorrect prefix")) {
        return "Invalid security key format.";
    }

    return message.length > 0 ? message : "Unable to recover encryption keys.";
}

function buildSecurityRecoveryPrompt(error: string | undefined): string {
    const baseMessage = "Enter your security key to decrypt older encrypted messages.";

    if (!error || error.length === 0) {
        return baseMessage;
    }

    return `${baseMessage} (${error})`;
}

const MUST_VERIFY_DEVICE_KEY = "must_verify_device";

function getDesktopBridge(): Window["heorotDesktop"] | null {
    if (typeof window === "undefined") {
        return null;
    }

    return window.heorotDesktop ?? null;
}

function isForceVerificationEnabled(config: CoreConfig | null): boolean {
    return config?.force_verification === true;
}

function hasMustVerifyFlag(): boolean {
    if (typeof window === "undefined") {
        return false;
    }

    return window.localStorage.getItem(MUST_VERIFY_DEVICE_KEY) === "true";
}

function setMustVerifyFlag(): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(MUST_VERIFY_DEVICE_KEY, "true");
}

async function isCrossSigningReady(client: MatrixClient): Promise<boolean> {
    try {
        return Boolean(await client.getCrypto()?.isCrossSigningReady());
    } catch {
        return false;
    }
}

async function isLocalDeviceVerified(client: MatrixClient): Promise<boolean> {
    const userId = client.getUserId();
    if (!userId) {
        return false;
    }

    try {
        const verificationStatus = await client.getCrypto()?.getUserVerificationStatus(userId);
        return verificationStatus?.isCrossSigningVerified() ?? false;
    } catch {
        return false;
    }
}

function buildDeviceVerificationPrompt(localDeviceVerified: boolean): string {
    if (localDeviceVerified) {
        return "Verification handshake was detected. If the app still blocks access, click Continue to re-check trust state.";
    }

    return "Verify this session from a trusted device (SAS or QR), then continue.";
}

async function shouldForceDeviceVerification(client: MatrixClient, config: CoreConfig | null): Promise<boolean> {
    if (!isForceVerificationEnabled(config)) {
        return false;
    }

    if (!hasMustVerifyFlag()) {
        return false;
    }

    if (client.isGuest()) {
        return false;
    }

    return !(await isCrossSigningReady(client));
}

interface PostLoginState {
    status: "ready" | "security_recovery" | "security_verification";
    error: string | null;
    recoveryFlow: SecurityRecoveryFlow;
    recoveryMode: RecoveryCredentialType;
    recoveryBackupVersion: string | null;
    localDeviceVerified: boolean;
}

interface RecoveryPostLoginState {
    status: "ready" | "security_recovery";
    error: string | null;
    recoveryFlow: SecurityRecoveryFlow;
    recoveryMode: RecoveryCredentialType;
    recoveryBackupVersion: string | null;
}

async function resolveRecoveryPostLoginState(client: MatrixClient): Promise<RecoveryPostLoginState> {
    try {
        const recovery = await attemptAutomaticKeyBackupRestore(client);
        if (recovery.status === "needs_recovery_key") {
            const formattedRecoveryError = recovery.error ? formatSecurityRecoveryError(recovery.error) : undefined;
            return {
                status: "security_recovery",
                error: buildSecurityRecoveryPrompt(formattedRecoveryError),
                recoveryFlow: "restore",
                recoveryMode: "recovery_key",
                recoveryBackupVersion: recovery.backupVersion,
            };
        }

        if (recovery.status === "no_backup") {
            return {
                status: "security_recovery",
                error: "Set up a security key now so encrypted history can be restored on new sessions.",
                recoveryFlow: "setup",
                recoveryMode: "recovery_key",
                recoveryBackupVersion: null,
            };
        }
    } catch {
        // Automatic recovery is best effort and should not block normal app startup.
    }

    triggerRoomHistoryDecryption(client);
    return {
        status: "ready",
        error: null,
        recoveryFlow: "restore",
        recoveryMode: "recovery_key",
        recoveryBackupVersion: null,
    };
}

async function resolvePostLoginState(client: MatrixClient, config: CoreConfig | null): Promise<PostLoginState> {
    const localDeviceVerified = await isLocalDeviceVerified(client);

    if (await shouldForceDeviceVerification(client, config)) {
        return {
            status: "security_verification",
            error: buildDeviceVerificationPrompt(localDeviceVerified),
            recoveryFlow: "restore",
            recoveryMode: "recovery_key",
            recoveryBackupVersion: null,
            localDeviceVerified,
        };
    }

    const recoveryState = await resolveRecoveryPostLoginState(client);
    return {
        ...recoveryState,
        localDeviceVerified,
    };
}

export function MatrixProvider({ children }: React.PropsWithChildren): React.ReactElement {
    const [state, dispatch] = useReducer(reducer, initialState);
    const pendingSetupKeyRef = useRef<GeneratedSecretStorageKey | null>(null);

    const clearPendingSetupKey = useCallback((): void => {
        const pendingKey = pendingSetupKeyRef.current;
        if (!pendingKey) {
            return;
        }

        pendingKey.privateKey.fill(0);
        pendingSetupKeyRef.current = null;
    }, []);

    const applyPostLoginState = useCallback((postLoginState: PostLoginState): void => {
        dispatch({
            type: "set_security_recovery",
            flow: postLoginState.recoveryFlow,
            mode: postLoginState.recoveryMode,
            backupVersion: postLoginState.recoveryBackupVersion,
        });
        dispatch({
            type: "set_local_device_verified",
            verified: postLoginState.localDeviceVerified,
        });
        dispatch({
            type: "set_status",
            status: postLoginState.status,
            error: postLoginState.error,
        });
    }, []);

    useEffect(() => {
        return () => {
            clearPendingSetupKey();
        };
    }, [clearPendingSetupKey]);

    useEffect(() => {
        let isCancelled = false;

        const run = async (): Promise<void> => {
            dispatch({ type: "set_status", status: "booting", error: null });

            try {
                const result = await bootstrapCore({ autoRestoreSession: false });
                if (isCancelled) {
                    return;
                }

                dispatch({ type: "set_core", core: result.core, config: result.config });

                let restoredSession = false;
                let restoreError: string | null = null;

                try {
                    restoredSession = await result.core.session.restoreSession();
                } catch (error) {
                    if (!shouldRetryWithCleanStorage(error)) {
                        throw error;
                    }

                    result.core.clientManager.stop(true);
                    await result.core.session.clearStorage();
                    restoreError = "Stored encrypted session could not be restored. Please sign in again.";
                    restoredSession = false;
                }

                if (!restoredSession) {
                    dispatch({ type: "set_client", client: null });
                    dispatch({ type: "set_local_device_verified", verified: false });
                    dispatch({ type: "set_status", status: "login_required", error: restoreError });
                    return;
                }

                const client = result.core.clientManager.get();
                if (!client) {
                    dispatch({ type: "set_status", status: "login_required", error: null });
                    return;
                }

                dispatch({ type: "set_status", status: "starting", error: null });
                try {
                    await waitForClientReady(client);
                } catch {
                    result.core.clientManager.stop(true);
                    await result.core.session.clearStorage();
                    dispatch({ type: "set_client", client: null });
                    dispatch({ type: "set_local_device_verified", verified: false });
                    dispatch({
                        type: "set_status",
                        status: "login_required",
                        error: "Stored session could not finish startup. Please sign in again.",
                    });
                    return;
                }

                if (isCancelled) {
                    return;
                }

                dispatch({ type: "set_client", client });
                const postLoginState = await resolvePostLoginState(client, result.config);
                if (isCancelled) {
                    return;
                }

                applyPostLoginState(postLoginState);
            } catch (error) {
                if (isCancelled) {
                    return;
                }

                dispatch({
                    type: "set_status",
                    status: "error",
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };

        void run();

        return () => {
            isCancelled = true;
        };
    }, [applyPostLoginState]);

    useEffect(() => {
        let isCancelled = false;

        const syncDesktopMediaAuth = async (): Promise<void> => {
            const desktopBridge = getDesktopBridge();
            if (!desktopBridge?.setMediaAuthState || !desktopBridge.clearMediaAuthState) {
                return;
            }

            const client = state.client;
            if (!client) {
                await desktopBridge.clearMediaAuthState();
                return;
            }

            let versions: string[] = [];
            try {
                const versionsResponse = await client.getVersions();
                if (Array.isArray(versionsResponse?.versions)) {
                    versions = versionsResponse.versions.filter(
                        (entry): entry is string => typeof entry === "string" && entry.length > 0,
                    );
                }
            } catch {
                // Server versions are best-effort for desktop media handling.
            }

            if (isCancelled) {
                return;
            }

            await desktopBridge.setMediaAuthState({
                accessToken: client.getAccessToken() ?? undefined,
                homeserverUrl: client.getHomeserverUrl(),
                versions,
            });
        };

        void syncDesktopMediaAuth();

        return () => {
            isCancelled = true;
        };
    }, [state.client, state.status]);

    const loginWithCredentials = useCallback(
        async (credentials: MatrixCredentials): Promise<void> => {
            if (!state.core) {
                throw new Error("Core context is not initialized yet");
            }

            dispatch({ type: "set_status", status: "starting", error: null });

            try {
                let client: MatrixClient;
                try {
                    client = await state.core.session.setLoggedIn(credentials, {
                        clearStorage: false,
                        startSyncing: true,
                        persistSession: true,
                    });
                } catch (setLoggedInError) {
                    if (!shouldRetryWithCleanStorage(setLoggedInError)) {
                        throw setLoggedInError;
                    }

                    client = await state.core.session.setLoggedIn(credentials, {
                        clearStorage: true,
                        startSyncing: true,
                        persistSession: true,
                    });
                }

                await waitForClientReady(client);
                if (!credentials.guest) {
                    setMustVerifyFlag();
                }

                dispatch({ type: "set_client", client });
                const postLoginState = await resolvePostLoginState(client, state.config);
                applyPostLoginState(postLoginState);
            } catch (error) {
                dispatch({ type: "set_client", client: null });
                dispatch({ type: "set_local_device_verified", verified: false });
                dispatch({
                    type: "set_status",
                    status: "login_required",
                    error: formatLoginError(error),
                });
                throw error;
            }
        },
        [applyPostLoginState, state.config, state.core],
    );

    const login = useCallback(
        async (homeserverUrl: string, username: string, password: string): Promise<void> => {
            if (!state.core) {
                throw new Error("Core context is not initialized yet");
            }

            dispatch({ type: "set_status", status: "starting", error: null });

            try {
                const normalizedHomeserver = normalizeHomeserverUrl(homeserverUrl);
                const identityServerUrl = getDefaultIdentityServer(state.config);
                const fallbackHomeserverRaw = getFallbackHomeserver(state.config);
                const fallbackHomeserver = fallbackHomeserverRaw ? normalizeHomeserverUrl(fallbackHomeserverRaw) : null;

                let primaryHomeserver = normalizedHomeserver;

                try {
                    await assertPasswordLoginSupported(normalizedHomeserver, identityServerUrl);
                } catch (flowError) {
                    const canUseFallback = fallbackHomeserver && fallbackHomeserver !== normalizedHomeserver;
                    if (!canUseFallback) {
                        throw flowError;
                    }

                    await assertPasswordLoginSupported(fallbackHomeserver, identityServerUrl);
                    primaryHomeserver = fallbackHomeserver;
                }

                let credentials;
                try {
                    credentials = await loginWithPasswordLikeElement({
                        session: state.core.session,
                        homeserverUrl: primaryHomeserver,
                        identityServerUrl,
                        username,
                        password,
                        initialDeviceDisplayName: "Heorot Web",
                    });
                } catch (loginError) {
                    const shouldFallback =
                        fallbackHomeserver &&
                        fallbackHomeserver !== primaryHomeserver &&
                        shouldTryFallbackLogin(loginError);
                    if (!shouldFallback) {
                        throw loginError;
                    }

                    credentials = await loginWithPasswordLikeElement({
                        session: state.core.session,
                        homeserverUrl: fallbackHomeserver,
                        identityServerUrl,
                        username,
                        password,
                        initialDeviceDisplayName: "Heorot Web",
                    });
                }

                await loginWithCredentials(credentials);
            } catch (error) {
                dispatch({ type: "set_client", client: null });
                dispatch({ type: "set_local_device_verified", verified: false });
                dispatch({
                    type: "set_status",
                    status: "login_required",
                    error: formatLoginError(error),
                });
            }
        },
        [loginWithCredentials, state.config, state.core],
    );

    const startDeviceVerification = useCallback(async (): Promise<void> => {
        if (!state.client) {
            dispatch({ type: "set_status", status: "login_required", error: "Session expired. Please sign in again." });
            return;
        }

        const crypto = state.client.getCrypto();
        if (!crypto) {
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: "Encryption is not available for this session.",
            });
            return;
        }

        try {
            await crypto.requestOwnUserVerification();
            const localVerified = await isLocalDeviceVerified(state.client);
            dispatch({ type: "set_local_device_verified", verified: localVerified });
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: "Verification request sent. Complete verification on your other device, then click Continue.",
            });
        } catch (error) {
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: formatLoginError(error),
            });
        }
    }, [state.client]);

    const refreshDeviceVerification = useCallback(async (): Promise<void> => {
        if (!state.client) {
            dispatch({ type: "set_status", status: "login_required", error: "Session expired. Please sign in again." });
            return;
        }

        try {
            const postLoginState = await resolvePostLoginState(state.client, state.config);
            applyPostLoginState(postLoginState);
        } catch (error) {
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: formatLoginError(error),
            });
        }
    }, [applyPostLoginState, state.client, state.config]);

    const skipDeviceVerification = useCallback(async (): Promise<void> => {
        if (!state.client) {
            dispatch({ type: "set_status", status: "login_required", error: "Session expired. Please sign in again." });
            return;
        }

        if (isForceVerificationEnabled(state.config)) {
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: "Device verification is required by server policy.",
            });
            return;
        }

        try {
            const recoveryState = await resolveRecoveryPostLoginState(state.client);
            const localVerified = await isLocalDeviceVerified(state.client);
            applyPostLoginState({
                ...recoveryState,
                localDeviceVerified: localVerified,
            });
        } catch (error) {
            dispatch({
                type: "set_status",
                status: "security_verification",
                error: formatLoginError(error),
            });
        }
    }, [applyPostLoginState, state.client, state.config]);

    const prepareSecurityRecoverySetup = useCallback(
        async (): Promise<string> => {
            if (!state.client) {
                const errorMessage = "Session expired. Please sign in again.";
                dispatch({ type: "set_status", status: "login_required", error: errorMessage });
                throw new Error(errorMessage);
            }

            try {
                const secretStorageKey = await createSecretStorageSetupKey(state.client);
                const encodedKey = secretStorageKey.encodedPrivateKey?.trim();
                if (!encodedKey) {
                    secretStorageKey.privateKey.fill(0);
                    throw new Error("Failed to generate a valid security key.");
                }

                clearPendingSetupKey();
                pendingSetupKeyRef.current = secretStorageKey;
                return encodedKey;
            } catch (error) {
                dispatch({
                    type: "set_status",
                    status: "security_recovery",
                    error: formatLoginError(error),
                });
                throw error;
            }
        },
        [clearPendingSetupKey, state.client],
    );

    const completeSecurityRecoverySetup = useCallback(async (): Promise<void> => {
        if (!state.client) {
            dispatch({ type: "set_status", status: "login_required", error: "Session expired. Please sign in again." });
            return;
        }

        const pendingSetupKey = pendingSetupKeyRef.current;
        if (!pendingSetupKey) {
            dispatch({
                type: "set_status",
                status: "security_recovery",
                error: "Security key was not generated yet. Generate a key first.",
            });
            return;
        }

        dispatch({ type: "set_status", status: "starting", error: null });

        try {
            await bootstrapSecretStorageSetup(state.client, pendingSetupKey);
            triggerRoomHistoryDecryption(state.client);
            clearPendingSetupKey();
            dispatch({ type: "set_status", status: "ready", error: null });
        } catch (error) {
            dispatch({
                type: "set_status",
                status: "security_recovery",
                error: formatLoginError(error),
            });
        }
    }, [clearPendingSetupKey, state.client]);

    const completeSecurityRecovery = useCallback(
        async (credential: string): Promise<void> => {
            if (!state.client) {
                dispatch({ type: "set_status", status: "login_required", error: "Session expired. Please sign in again." });
                return;
            }

            if (credential.trim().length === 0) {
                dispatch({
                    type: "set_status",
                    status: "security_recovery",
                    error: "Security key is required.",
                });
                return;
            }

            dispatch({ type: "set_status", status: "starting", error: null });

            try {
                try {
                    await restoreKeyBackupWithRecoveryKey(state.client, credential, state.securityRecoveryBackupVersion);
                } catch (primaryError) {
                    await restoreKeyBackupWithSecretStorageCredential(state.client, credential);
                    if (primaryError) {
                        // Keep flow deterministic: if secret storage path works we proceed successfully.
                    }
                }
                triggerRoomHistoryDecryption(state.client);
                clearPendingSetupKey();
                dispatch({ type: "set_status", status: "ready", error: null });
            } catch (error) {
                dispatch({
                    type: "set_status",
                    status: "security_recovery",
                    error: formatSecurityRecoveryError(error),
                });
            }
        },
        [clearPendingSetupKey, state.client, state.securityRecoveryBackupVersion],
    );

    const skipSecurityRecovery = useCallback((): void => {
        if (!state.client) {
            dispatch({ type: "set_status", status: "login_required", error: null });
            return;
        }

        clearPendingSetupKey();
        triggerRoomHistoryDecryption(state.client);
        dispatch({ type: "set_status", status: "ready", error: null });
    }, [clearPendingSetupKey, state.client]);

    const logout = useCallback(async (): Promise<void> => {
        if (!state.core) {
            return;
        }

        dispatch({ type: "set_status", status: "starting", error: null });

        try {
            await state.core.session.logout(true);
            clearPendingSetupKey();
            dispatch({ type: "set_client", client: null });
            dispatch({ type: "set_local_device_verified", verified: false });
            dispatch({ type: "set_status", status: "login_required", error: null });
        } catch (error) {
            dispatch({
                type: "set_status",
                status: "error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }, [clearPendingSetupKey, state.core]);

    const value = useMemo<MatrixContextValue>(
        () => ({
            ...state,
            login,
            loginWithCredentials,
            logout,
            startDeviceVerification,
            refreshDeviceVerification,
            skipDeviceVerification,
            forceVerificationEnabled: isForceVerificationEnabled(state.config),
            prepareSecurityRecoverySetup,
            completeSecurityRecoverySetup,
            completeSecurityRecovery,
            skipSecurityRecovery,
        }),
        [
            state,
            login,
            loginWithCredentials,
            logout,
            startDeviceVerification,
            refreshDeviceVerification,
            skipDeviceVerification,
            prepareSecurityRecoverySetup,
            completeSecurityRecoverySetup,
            completeSecurityRecovery,
            skipSecurityRecovery,
        ],
    );

    return <MatrixContext.Provider value={value}>{children}</MatrixContext.Provider>;
}

export function useMatrix(): MatrixContextValue {
    const value = useContext(MatrixContext);
    if (!value) {
        throw new Error("useMatrix must be used inside MatrixProvider");
    }

    return value;
}
