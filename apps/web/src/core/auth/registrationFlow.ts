import { createClient, MatrixError, SSOAction, type MatrixClient, type SSOFlow } from "matrix-js-sdk/src/matrix";

export interface RegistrationFlow {
    stages: string[];
}

export interface RegistrationProbeResult {
    client: MatrixClient;
    flows: RegistrationFlow[];
    ssoFlow?: SSOFlow;
}

export type RegistrationProbeErrorCode =
    | "registration_disabled"
    | "registration_disabled_sso"
    | "registration_probe_failed";

export class RegistrationProbeError extends Error {
    public readonly code: RegistrationProbeErrorCode;
    public readonly cause: unknown;
    public readonly client?: MatrixClient;
    public readonly ssoFlow?: SSOFlow;

    public constructor(
        message: string,
        code: RegistrationProbeErrorCode,
        options?: {
            cause?: unknown;
            client?: MatrixClient;
            ssoFlow?: SSOFlow;
        },
    ) {
        super(message);
        this.code = code;
        this.cause = options?.cause;
        this.client = options?.client;
        this.ssoFlow = options?.ssoFlow;
    }
}

function normalizeFlows(value: unknown): RegistrationFlow[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const normalized: RegistrationFlow[] = [];
    for (const flow of value) {
        if (!flow || typeof flow !== "object") {
            continue;
        }

        const flowStages = (flow as { stages?: unknown }).stages;
        if (!Array.isArray(flowStages)) {
            continue;
        }

        const stages = flowStages.filter((stage): stage is string => typeof stage === "string" && stage.length > 0);
        if (stages.length === 0) {
            continue;
        }

        normalized.push({ stages });
    }

    return normalized;
}

export function authStepIsUsed(flows: RegistrationFlow[], step: string): boolean {
    return flows.some((flow) => flow.stages.includes(step));
}

export function authStepIsRequired(flows: RegistrationFlow[], step: string): boolean {
    if (flows.length === 0) {
        return false;
    }

    return flows.every((flow) => flow.stages.includes(step));
}

interface DiscoverRegistrationFlowOptions {
    homeserverUrl: string;
    identityServerUrl?: string;
}

export async function discoverRegistrationFlow(options: DiscoverRegistrationFlowOptions): Promise<RegistrationProbeResult> {
    const client = createClient({
        baseUrl: options.homeserverUrl,
        idBaseUrl: options.identityServerUrl,
    });

    let ssoFlow: SSOFlow | undefined;
    try {
        const loginFlowPayload = await client.loginFlows();
        const candidate = (loginFlowPayload.flows ?? []).find(
            (flow) => flow.type === "m.login.sso" || flow.type === "m.login.cas",
        );
        if (candidate && (candidate.type === "m.login.sso" || candidate.type === "m.login.cas")) {
            ssoFlow = candidate as SSOFlow;
        }
    } catch {
        // SSO discovery is best effort.
    }

    try {
        await client.registerRequest({});
        throw new RegistrationProbeError(
            "Registration unexpectedly succeeded without interactive authentication.",
            "registration_probe_failed",
            { client, ssoFlow },
        );
    } catch (error) {
        if (error instanceof MatrixError && error.httpStatus === 401) {
            const flows = normalizeFlows(error.data?.flows);
            return {
                client,
                flows,
                ssoFlow,
            };
        }

        if (error instanceof MatrixError && (error.httpStatus === 403 || error.errcode === "M_FORBIDDEN")) {
            if (ssoFlow) {
                throw new RegistrationProbeError(
                    "This homeserver has disabled password registration. It expects SSO registration.",
                    "registration_disabled_sso",
                    {
                        cause: error,
                        client,
                        ssoFlow,
                    },
                );
            }

            throw new RegistrationProbeError("Registration is disabled on this homeserver.", "registration_disabled", {
                cause: error,
                client,
                ssoFlow,
            });
        }

        throw new RegistrationProbeError(
            error instanceof Error ? error.message : "Unable to fetch registration methods from homeserver.",
            "registration_probe_failed",
            {
                cause: error,
                client,
                ssoFlow,
            },
        );
    }
}

export function buildRegistrationSsoUrl(options: {
    client: MatrixClient;
    loginType: "sso" | "cas";
    idpId?: string;
}): string {
    const callbackUrl = new URL(window.location.href);
    return options.client.getSsoLoginUrl(
        callbackUrl.toString(),
        options.loginType,
        options.idpId,
        SSOAction.REGISTER,
    );
}

export function formatRegistrationError(error: unknown): string {
    if (error instanceof RegistrationProbeError) {
        return error.message;
    }

    if (error instanceof MatrixError) {
        const message = typeof error.data?.error === "string" ? error.data.error : error.message;
        if (error.errcode) {
            return `${message} (${error.errcode})`;
        }
        return message;
    }

    return error instanceof Error ? error.message : String(error);
}

export function looksLikeEmail(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return false;
    }

    let atIndex = -1;
    for (let index = 0; index < trimmed.length; index++) {
        const char = trimmed[index];
        if (char.trim().length === 0) {
            return false;
        }

        if (char === "@") {
            if (atIndex !== -1) {
                return false;
            }
            atIndex = index;
        }
    }

    if (atIndex <= 0 || atIndex >= trimmed.length - 1) {
        return false;
    }

    const domain = trimmed.slice(atIndex + 1);
    const dotIndex = domain.indexOf(".");
    return dotIndex > 0 && dotIndex < domain.length - 1;
}
