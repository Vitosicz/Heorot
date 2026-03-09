import type { CoreConfig } from "./configTypes";

export function getDefaultHomeserver(config: CoreConfig | null): string {
    const serverConfig = config?.default_server_config;
    const homeserver =
        serverConfig && typeof serverConfig === "object"
            ? (serverConfig["m.homeserver"] as { base_url?: string } | undefined)
            : undefined;

    return homeserver?.base_url ?? config?.default_hs_url?.toString() ?? "https://matrix.org";
}

export function getDefaultIdentityServer(config: CoreConfig | null): string | undefined {
    const serverConfig = config?.default_server_config;
    const identityServer =
        serverConfig && typeof serverConfig === "object"
            ? (serverConfig["m.identity_server"] as { base_url?: string } | undefined)
            : undefined;

    const value = identityServer?.base_url ?? config?.default_is_url?.toString();
    return value && value.trim().length > 0 ? value : undefined;
}

export function getFallbackHomeserver(config: CoreConfig | null): string | null {
    const value =
        config && typeof config.fallback_hs_url === "string" && config.fallback_hs_url.trim().length > 0
            ? config.fallback_hs_url.trim()
            : null;

    return value;
}

export function isCustomHomeserverDisabled(config: CoreConfig | null): boolean {
    return config?.disable_custom_urls === true;
}
