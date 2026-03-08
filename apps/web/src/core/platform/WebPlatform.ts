import { encodeUnpaddedBase64 } from "matrix-js-sdk/src/base64";
import type { MatrixClient, SSOAction } from "matrix-js-sdk/src/matrix";

import { buildAndEncodePickleKey, encryptPickleKey, type EncryptedPickleKey } from "../storage/pickling";
import { idbDelete, idbLoad, idbSave } from "../storage/storageAccess";

export const SSO_HOMESERVER_URL_KEY = "mx_sso_hs_url";
export const SSO_ID_SERVER_URL_KEY = "mx_sso_is_url";
export const SSO_IDP_ID_KEY = "mx_sso_idp_id";

export class WebPlatform {
    public getSSOCallbackUrl(fragmentAfterLogin = ""): URL {
        const url = new URL(window.location.href);
        url.hash = fragmentAfterLogin;
        return url;
    }

    public startSingleSignOn(
        client: MatrixClient,
        loginType: "sso" | "cas",
        fragmentAfterLogin?: string,
        idpId?: string,
        action?: SSOAction,
    ): void {
        localStorage.setItem(SSO_HOMESERVER_URL_KEY, client.getHomeserverUrl());

        if (client.getIdentityServerUrl()) {
            localStorage.setItem(SSO_ID_SERVER_URL_KEY, client.getIdentityServerUrl()!);
        }

        if (idpId) {
            localStorage.setItem(SSO_IDP_ID_KEY, idpId);
        }

        const callbackUrl = this.getSSOCallbackUrl(fragmentAfterLogin);
        window.location.href = client.getSsoLoginUrl(callbackUrl.toString(), loginType, idpId, action);
    }

    public async getPickleKey(userId: string, deviceId: string): Promise<string | null> {
        const data = await idbLoad<EncryptedPickleKey>("pickleKey", [userId, deviceId]);
        const pickledKey = await buildAndEncodePickleKey(data, userId, deviceId);
        return pickledKey ?? null;
    }

    public async createPickleKey(userId: string, deviceId: string): Promise<string | null> {
        if (!crypto?.subtle) {
            return null;
        }

        const randomKey = new Uint8Array(32);
        crypto.getRandomValues(randomKey);

        const encrypted = await encryptPickleKey(randomKey, userId, deviceId);
        if (!encrypted) {
            return null;
        }

        await idbSave("pickleKey", [userId, deviceId], encrypted);
        return encodeUnpaddedBase64(randomKey);
    }

    public async destroyPickleKey(userId: string, deviceId: string): Promise<void> {
        await idbDelete("pickleKey", [userId, deviceId]);
    }
}
