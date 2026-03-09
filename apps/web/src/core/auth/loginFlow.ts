import { createClient } from "matrix-js-sdk/src/matrix";

import type { SessionLifecycle } from "../lifecycle/SessionLifecycle";
import type { MatrixCredentials } from "../types/credentials";

type UserIdentifier = { type: "m.id.user"; user: string };
type EmailIdentifier = { type: "m.id.thirdparty"; medium: "email"; address: string };
type PasswordIdentifier = UserIdentifier | EmailIdentifier;

export function normalizeHomeserverUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("Homeserver URL is required.");
    }

    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    return parsed.toString().replace(/\/$/, "");
}

export function buildPasswordIdentifier(username: string): PasswordIdentifier {
    const trimmed = username.trim();
    const isEmail = trimmed.indexOf("@") > 0;

    if (isEmail) {
        return {
            type: "m.id.thirdparty",
            medium: "email",
            address: trimmed,
        };
    }

    return {
        type: "m.id.user",
        user: trimmed,
    };
}

export async function assertPasswordLoginSupported(
    homeserverUrl: string,
    identityServerUrl?: string,
): Promise<void> {
    const tempClient = createClient({
        baseUrl: homeserverUrl,
        idBaseUrl: identityServerUrl,
    });
    const payload = await tempClient.loginFlows();

    const flowTypes = new Set(
        (payload.flows ?? [])
            .map((flow) => (typeof flow.type === "string" ? flow.type : ""))
            .filter((value) => value.length > 0),
    );

    if (flowTypes.has("m.login.password")) {
        return;
    }

    if (flowTypes.has("m.login.sso") || flowTypes.has("m.login.cas")) {
        throw new Error("This homeserver requires SSO login. Password login is disabled.");
    }

    throw new Error("This homeserver does not support password login.");
}

export function shouldTryFallbackLogin(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }

    const matrixError = error as {
        httpStatus?: unknown;
        statusCode?: unknown;
    };

    const status =
        typeof matrixError.httpStatus === "number"
            ? matrixError.httpStatus
            : typeof matrixError.statusCode === "number"
              ? matrixError.statusCode
              : null;

    return status === 403;
}

interface PasswordLoginOptions {
    session: SessionLifecycle;
    homeserverUrl: string;
    identityServerUrl?: string;
    username: string;
    password: string;
    initialDeviceDisplayName?: string;
}

export async function loginWithPasswordLikeElement(options: PasswordLoginOptions): Promise<MatrixCredentials> {
    const identifier = buildPasswordIdentifier(options.username);

    return options.session.loginWithPassword(
        options.homeserverUrl,
        identifier as UserIdentifier,
        options.password,
        options.identityServerUrl,
        options.initialDeviceDisplayName,
    );
}
