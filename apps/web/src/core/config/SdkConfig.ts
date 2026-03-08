import { DEFAULT_CORE_CONFIG } from "./defaultConfig";
import type { CoreConfig } from "./configTypes";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(base: CoreConfig, patch: Partial<CoreConfig>): CoreConfig {
    const output: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(patch)) {
        const current = output[key];

        if (Array.isArray(value)) {
            output[key] = value;
            continue;
        }

        if (isRecord(current) && isRecord(value)) {
            output[key] = mergeConfig(current as CoreConfig, value as Partial<CoreConfig>);
            continue;
        }

        if (value !== undefined) {
            output[key] = value;
        }
    }

    return output as CoreConfig;
}

export class SdkConfig {
    private static instance: CoreConfig = { ...DEFAULT_CORE_CONFIG };

    public static get(): CoreConfig;
    public static get<K extends keyof CoreConfig>(key: K): CoreConfig[K];
    public static get<K extends keyof CoreConfig>(key?: K): CoreConfig | CoreConfig[K] {
        if (typeof key === "undefined") {
            return SdkConfig.instance;
        }

        return SdkConfig.instance[key];
    }

    public static put(config: Partial<CoreConfig>): void {
        SdkConfig.instance = mergeConfig(DEFAULT_CORE_CONFIG, config);
    }

    public static add(config: Partial<CoreConfig>): void {
        SdkConfig.instance = mergeConfig(SdkConfig.instance, config);
    }

    public static reset(): void {
        SdkConfig.instance = { ...DEFAULT_CORE_CONFIG };
    }
}
