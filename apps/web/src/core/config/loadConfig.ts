import { SdkConfig } from "./SdkConfig";
import type { CoreConfig } from "./configTypes";

function looksLikeHtmlPayload(value: string): boolean {
    const normalized = value.trimStart().toLowerCase();
    return normalized.startsWith("<!doctype") || normalized.startsWith("<html");
}

async function parseConfigPayload(response: Response, configJsonFilename: string): Promise<CoreConfig> {
    const raw = await response.text();
    if (raw.trim().length === 0) {
        return {};
    }

    if (looksLikeHtmlPayload(raw)) {
        console.warn(`Config '${configJsonFilename}' returned HTML instead of JSON. Falling back to defaults.`);
        return {};
    }

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error(`Config '${configJsonFilename}' must be a JSON object.`);
        }

        return parsed as CoreConfig;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to parse config '${configJsonFilename}': ${message}`);
    }
}

async function getConfig(configJsonFilename: string): Promise<CoreConfig> {
    const url = new URL(configJsonFilename, window.location.href);
    url.searchParams.set("cachebuster", Date.now().toString());

    const response = await fetch(url, {
        cache: "no-cache",
        method: "GET",
    });

    if (response.status === 404 || response.status === 0) {
        return {};
    }

    if (!response.ok) {
        throw new Error(`Unable to load config '${configJsonFilename}': HTTP ${response.status}`);
    }

    return await parseConfigPayload(response, configJsonFilename);
}

export async function loadDomainAwareConfig(relativeLocation = ""): Promise<CoreConfig> {
    let basePath = relativeLocation;
    if (basePath !== "" && !basePath.endsWith("/")) {
        basePath += "/";
    }

    let domain = window.location.hostname.trimEnd();
    if (domain.endsWith(".")) {
        domain = domain.slice(0, -1);
    }

    const domainConfigPromise = getConfig(`${basePath}config.${domain}.json`);
    const defaultConfigPromise = getConfig(`${basePath}config.json`);

    try {
        const domainConfig = await domainConfigPromise;
        if (Object.keys(domainConfig).length > 0) {
            return domainConfig;
        }
    } catch {
        // fall back to default config.
    }

    return defaultConfigPromise;
}

export async function loadAndSetSdkConfig(relativeLocation = ""): Promise<CoreConfig> {
    const config = await loadDomainAwareConfig(relativeLocation);
    SdkConfig.put(config);
    return SdkConfig.get();
}
