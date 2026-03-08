import { MatrixClientManager, type MatrixClientManagerOptions } from "./client/MatrixClientManager";
import { loadAndSetSdkConfig } from "./config/loadConfig";
import { SdkConfig } from "./config/SdkConfig";
import { SessionLifecycle } from "./lifecycle/SessionLifecycle";
import { WebPlatform } from "./platform/WebPlatform";

export interface CoreContextOptions {
    clientManager?: MatrixClientManager;
    platform?: WebPlatform;
    clientManagerOptions?: MatrixClientManagerOptions;
}

export interface CoreContext {
    sdkConfig: typeof SdkConfig;
    loadConfig: typeof loadAndSetSdkConfig;
    platform: WebPlatform;
    clientManager: MatrixClientManager;
    session: SessionLifecycle;
}

export function createCoreContext(options: CoreContextOptions = {}): CoreContext {
    const platform = options.platform ?? new WebPlatform();
    const clientManager = options.clientManager ?? new MatrixClientManager(options.clientManagerOptions);
    const session = new SessionLifecycle({ platform, clientManager });

    return {
        sdkConfig: SdkConfig,
        loadConfig: loadAndSetSdkConfig,
        platform,
        clientManager,
        session,
    };
}
