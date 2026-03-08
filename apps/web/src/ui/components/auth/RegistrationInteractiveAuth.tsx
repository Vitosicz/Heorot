import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AuthType,
    type AuthDict,
    type IStageStatus,
    InteractiveAuth,
    MatrixError,
    type IRegisterRequestParams,
    type MatrixClient,
    type RegisterResponse,
} from "matrix-js-sdk/src/matrix";

import type { MatrixCredentials } from "../../../core/types/credentials";

interface RegistrationInteractiveAuthProps {
    client: MatrixClient;
    username: string;
    password: string;
    emailAddress?: string;
    initialDeviceDisplayName?: string;
    onCompleted: (credentials: MatrixCredentials) => Promise<void>;
    onBack: () => void;
}

interface TermsPolicy {
    id: string;
    name: string;
    url: string;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatInteractiveAuthError(error: unknown): string {
    if (error instanceof MatrixError) {
        const message = typeof error.data?.error === "string" ? error.data.error : error.message;
        if (error.errcode === "M_USER_IN_USE") {
            return "Username is already in use.";
        }
        if (error.errcode === "M_THREEPID_IN_USE") {
            return "This email address is already linked to another account.";
        }
        if (error.errcode === "M_RESOURCE_LIMIT_EXCEEDED") {
            return message.length > 0 ? message : "This homeserver has reached its registration limit.";
        }
        if (error.errcode) {
            return `${message} (${error.errcode})`;
        }
        return message;
    }

    return toErrorMessage(error);
}

function findLocalizedEntry(record: Record<string, unknown>): Record<string, unknown> | null {
    for (const [language, candidate] of Object.entries(record)) {
        if (language !== "version" && candidate && typeof candidate === "object") {
            return candidate as Record<string, unknown>;
        }
    }
    return null;
}

function extractTermsPolicies(stageParams: Record<string, unknown> | undefined): TermsPolicy[] {
    const policies = stageParams?.policies;
    if (!policies || typeof policies !== "object") {
        return [];
    }

    const results: TermsPolicy[] = [];
    for (const [policyId, policyValue] of Object.entries(policies)) {
        if (!policyValue || typeof policyValue !== "object") {
            continue;
        }

        const localized = findLocalizedEntry(policyValue as Record<string, unknown>);
        if (!localized) {
            continue;
        }

        const name = typeof localized.name === "string" ? localized.name : policyId;
        const url = typeof localized.url === "string" ? localized.url : "";
        if (url.length === 0) {
            continue;
        }

        results.push({ id: policyId, name, url });
    }

    return results;
}

function stageLabel(stage: string | null): string {
    switch (stage) {
        case AuthType.Terms:
            return "Terms";
        case AuthType.Email:
            return "Email verification";
        case AuthType.RegistrationToken:
        case AuthType.UnstableRegistrationToken:
            return "Registration token";
        case AuthType.Sso:
        case AuthType.SsoUnstable:
            return "Single sign-on";
        case AuthType.Password:
            return "Password confirmation";
        case AuthType.Recaptcha:
            return "Captcha";
        case AuthType.Msisdn:
            return "Phone verification";
        default:
            return "Interactive authentication";
    }
}

export function RegistrationInteractiveAuth({
    client,
    username,
    password,
    emailAddress,
    initialDeviceDisplayName = "Heorot Web",
    onCompleted,
    onBack,
}: RegistrationInteractiveAuthProps): React.ReactElement {
    const authLogicRef = useRef<InteractiveAuth<RegisterResponse> | null>(null);
    const popupWindowRef = useRef<Window | null>(null);
    const [stage, setStage] = useState<string | null>(null);
    const [stageState, setStageState] = useState<IStageStatus | null>(null);
    const [stageParams, setStageParams] = useState<Record<string, unknown> | undefined>(undefined);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [registrationToken, setRegistrationToken] = useState("");
    const [stagePassword, setStagePassword] = useState("");
    const [termsAccepted, setTermsAccepted] = useState<Record<string, boolean>>({});
    const [emailRequestBusy, setEmailRequestBusy] = useState(false);
    const [ssoStarted, setSsoStarted] = useState(false);

    const termsPolicies = useMemo(() => extractTermsPolicies(stageParams), [stageParams]);
    const showStageSummary =
        stage !== AuthType.RegistrationToken && stage !== AuthType.UnstableRegistrationToken;

    useEffect(() => {
        if (stage !== AuthType.Terms) {
            return;
        }

        setTermsAccepted((previous) => {
            const next: Record<string, boolean> = {};
            for (const policy of termsPolicies) {
                next[policy.id] = previous[policy.id] ?? false;
            }
            return next;
        });
    }, [stage, termsPolicies]);

    const onTermsPolicyChange = useCallback((policyId: string, checked: boolean): void => {
        setTermsAccepted((previous) => ({ ...previous, [policyId]: checked }));
    }, []);

    const submitAuthDict = useCallback((auth: AuthDict): void => {
        const authLogic = authLogicRef.current;
        if (!authLogic) {
            return;
        }

        setBusy(true);
        authLogic.submitAuthDict(auth).catch((submitError) => {
            setBusy(false);
            setError(formatInteractiveAuthError(submitError));
        });
    }, []);

    const openFallbackAuth = useCallback((): void => {
        const authLogic = authLogicRef.current;
        if (!authLogic || !stage) {
            return;
        }

        const sessionId = authLogic.getSessionId();
        if (!sessionId) {
            setError("Homeserver did not provide an interactive-auth session id.");
            return;
        }

        const popupUrl = client.getFallbackAuthUrl(stage, sessionId);
        popupWindowRef.current?.close();
        popupWindowRef.current = window.open(popupUrl, "_blank");
    }, [client, stage]);

    const requestEmailToken = useCallback(async (): Promise<void> => {
        const authLogic = authLogicRef.current;
        if (!authLogic) {
            return;
        }

        setEmailRequestBusy(true);
        try {
            await authLogic.requestEmailToken();
            setError(null);
        } catch (requestError) {
            setError(formatInteractiveAuthError(requestError));
        } finally {
            setEmailRequestBusy(false);
        }
    }, []);

    const pollForEmailCompletion = useCallback((): void => {
        const authLogic = authLogicRef.current;
        if (!authLogic) {
            return;
        }

        authLogic.poll().catch(() => {
            // Polling errors are non-fatal and the SDK already treats them as best-effort.
        });
    }, []);

    useEffect(() => {
        const onReceiveMessage = (event: MessageEvent): void => {
            if (event.data !== "authDone" || event.source !== popupWindowRef.current) {
                return;
            }

            popupWindowRef.current?.close();
            popupWindowRef.current = null;
            setSsoStarted(true);
        };

        window.addEventListener("message", onReceiveMessage);
        return () => {
            window.removeEventListener("message", onReceiveMessage);
        };
    }, []);

    useEffect(() => {
        let disposed = false;

        const makeRegisterRequest = (auth: AuthDict | null): Promise<RegisterResponse> => {
            const params: IRegisterRequestParams = {
                username: username.trim(),
                password,
                initial_device_display_name: initialDeviceDisplayName,
                auth: auth ?? undefined,
                refresh_token: true,
            };
            return client.registerRequest(params);
        };

        const authLogic = new InteractiveAuth<RegisterResponse>({
            matrixClient: client,
            doRequest: makeRegisterRequest,
            busyChanged: (isBusy) => {
                if (disposed || !isBusy) {
                    return;
                }
                setBusy(true);
                setError(null);
            },
            inputs: {
                emailAddress: emailAddress && emailAddress.trim().length > 0 ? emailAddress.trim() : undefined,
            },
            stateUpdated: (nextStage, status) => {
                if (disposed) {
                    return;
                }

                setStage(nextStage);
                setStageParams(authLogic.getStageParams(nextStage));
                setStageState(status);
                setBusy(false);
                setError(status.error ?? null);
            },
            requestEmailToken: (email, secret, attempt) => client.requestRegisterEmailToken(email, secret, attempt),
            supportedStages: [
                AuthType.Password,
                AuthType.Recaptcha,
                AuthType.Email,
                AuthType.Msisdn,
                AuthType.Terms,
                AuthType.RegistrationToken,
                AuthType.UnstableRegistrationToken,
                AuthType.Sso,
                AuthType.SsoUnstable,
            ],
        });

        authLogicRef.current = authLogic;
        const pollIntervalId = window.setInterval(() => {
            authLogic.poll().catch(() => {
                // Polling errors are intentionally ignored.
            });
        }, 2000);

        authLogic
            .attemptAuth()
            .then(async (response) => {
                if (disposed) {
                    return;
                }

                const userId = response.user_id;
                const accessToken = response.access_token;
                if (!userId || !accessToken) {
                    throw new Error("Registration succeeded but homeserver did not return a login token.");
                }

                await onCompleted({
                    homeserverUrl: client.getHomeserverUrl(),
                    identityServerUrl: client.getIdentityServerUrl() ?? undefined,
                    userId,
                    deviceId: response.device_id,
                    accessToken,
                    refreshToken: response.refresh_token,
                    guest: false,
                });
            })
            .catch((authError) => {
                if (disposed) {
                    return;
                }
                setBusy(false);
                setError(formatInteractiveAuthError(authError));
            });

        return () => {
            disposed = true;
            window.clearInterval(pollIntervalId);
            popupWindowRef.current?.close();
            popupWindowRef.current = null;
            authLogicRef.current = null;
        };
    }, [client, emailAddress, initialDeviceDisplayName, onCompleted, password, username]);

    const renderStageBody = (): React.ReactNode => {
        if (!stage) {
            return <p className="login-inline-note">Preparing interactive authentication...</p>;
        }

        if (stage === AuthType.Terms) {
            const allAccepted =
                termsPolicies.length > 0 && termsPolicies.every((policy) => Boolean(termsAccepted[policy.id]));

            return (
                <>
                    <p className="login-inline-note">Accept server terms to continue creating your account.</p>
                    <div className="login-terms-list">
                        {termsPolicies.map((policy) => (
                            <label key={policy.id} className="login-terms-item">
                                <input
                                    type="checkbox"
                                    checked={Boolean(termsAccepted[policy.id])}
                                    onChange={(event) => onTermsPolicyChange(policy.id, event.target.checked)}
                                />
                                <a href={policy.url} target="_blank" rel="noreferrer noopener">
                                    {policy.name}
                                </a>
                            </label>
                        ))}
                    </div>
                    <button
                        type="button"
                        className="login-secondary-button"
                        disabled={!allAccepted || busy}
                        onClick={() => submitAuthDict({ type: AuthType.Terms })}
                    >
                        Accept and continue
                    </button>
                </>
            );
        }

        if (stage === AuthType.Email) {
            return (
                <>
                    <p className="login-inline-note">
                        Confirm the verification email for <strong>{emailAddress ?? "your email address"}</strong>, then
                        continue.
                    </p>
                    <div className="login-actions-row">
                        <button
                            type="button"
                            className="login-secondary-button"
                            disabled={busy || emailRequestBusy}
                            onClick={requestEmailToken}
                        >
                            {emailRequestBusy ? "Resending..." : "Resend email"}
                        </button>
                        <button
                            type="button"
                            className="login-secondary-button"
                            disabled={busy}
                            onClick={pollForEmailCompletion}
                        >
                            Check again
                        </button>
                    </div>
                </>
            );
        }

        if (stage === AuthType.RegistrationToken || stage === AuthType.UnstableRegistrationToken) {
            return (
                <>
                    <label>
                        Registration token
                        <input
                            type="text"
                            value={registrationToken}
                            onChange={(event) => setRegistrationToken(event.target.value)}
                            placeholder="Enter invitation token"
                            autoComplete="off"
                        />
                    </label>
                    <button
                        type="button"
                        disabled={busy || registrationToken.trim().length === 0}
                        onClick={() =>
                            submitAuthDict({
                                type: stage,
                                token: registrationToken.trim(),
                            } as AuthDict)
                        }
                    >
                        Continue
                    </button>
                </>
            );
        }

        if (stage === AuthType.Password) {
            return (
                <>
                    <label>
                        Account password
                        <input
                            type="password"
                            value={stagePassword}
                            onChange={(event) => setStagePassword(event.target.value)}
                            placeholder="Enter password"
                            autoComplete="current-password"
                        />
                    </label>
                    <button
                        type="button"
                        disabled={busy || stagePassword.trim().length === 0}
                        onClick={() =>
                            submitAuthDict({
                                type: AuthType.Password,
                                identifier: {
                                    type: "m.id.user",
                                    user: username.trim(),
                                },
                                password: stagePassword,
                            })
                        }
                    >
                        Continue
                    </button>
                </>
            );
        }

        const requiresFallback =
            stage === AuthType.Sso ||
            stage === AuthType.SsoUnstable ||
            stage === AuthType.Recaptcha ||
            stage === AuthType.Msisdn;

        if (requiresFallback) {
            return (
                <>
                    <p className="login-inline-note">
                        This stage is completed in a browser popup. When finished, return and confirm.
                    </p>
                    <div className="login-actions-row">
                        <button type="button" className="login-secondary-button" disabled={busy} onClick={openFallbackAuth}>
                            Open authentication window
                        </button>
                        <button
                            type="button"
                            className="login-secondary-button"
                            disabled={busy || (stage === AuthType.Sso || stage === AuthType.SsoUnstable ? !ssoStarted : false)}
                            onClick={() => submitAuthDict({})}
                        >
                            I completed this step
                        </button>
                    </div>
                </>
            );
        }

        return (
            <>
                <p className="login-inline-note">
                    Homeserver requested an auth stage that does not have a dedicated UI here.
                </p>
                <div className="login-actions-row">
                    <button type="button" className="login-secondary-button" disabled={busy} onClick={openFallbackAuth}>
                        Open fallback auth
                    </button>
                    <button type="button" className="login-secondary-button" disabled={busy} onClick={() => submitAuthDict({})}>
                        Continue
                    </button>
                </div>
            </>
        );
    };

    return (
        <div className="login-uia">
            <div className="login-uia-header">
                <h2>Complete account setup</h2>
                {showStageSummary ? (
                    <p className="login-inline-note">
                        Current stage: <strong>{stageLabel(stage)}</strong>
                    </p>
                ) : null}
            </div>
            {stageState?.error ? <p className="login-error">{stageState.error}</p> : null}
            {error ? <p className="login-error">{error}</p> : null}
            {busy ? <p className="login-inline-note">Contacting homeserver...</p> : null}
            {renderStageBody()}
            <button type="button" className="login-link-button" onClick={onBack} disabled={busy}>
                Back to registration form
            </button>
        </div>
    );
}
