import { createCoreContext, type CoreContext } from "./core/CoreContext";
import { loadAndSetSdkConfig } from "./core/config/loadConfig";
import type { CoreConfig } from "./core/config/configTypes";

export interface BootstrapCoreOptions {
    configBasePath?: string;
    autoRestoreSession?: boolean;
    ignoreGuestSession?: boolean;
}

export interface BootstrapCoreResult {
    core: CoreContext;
    config: CoreConfig;
    restoredSession: boolean;
}

export async function bootstrapCore(options: BootstrapCoreOptions = {}): Promise<BootstrapCoreResult> {
    const core = createCoreContext();
    const config = await loadAndSetSdkConfig(options.configBasePath ?? "");

    let restoredSession = false;
    if (options.autoRestoreSession !== false) {
        restoredSession = await core.session.restoreSession(Boolean(options.ignoreGuestSession));
    }

    return {
        core,
        config,
        restoredSession,
    };
}
