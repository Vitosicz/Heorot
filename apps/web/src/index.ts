export { bootstrapCore } from "./bootstrap";

export { createCoreContext } from "./core/CoreContext";
export type { CoreContext } from "./core/CoreContext";

export { MatrixClientManager } from "./core/client/MatrixClientManager";
export type { MatrixClientManagerOptions } from "./core/client/MatrixClientManager";

export { SessionLifecycle } from "./core/lifecycle/SessionLifecycle";
export type { SessionLifecycleOptions, SetLoggedInOptions } from "./core/lifecycle/SessionLifecycle";

export { WebPlatform } from "./core/platform/WebPlatform";

export { SdkConfig } from "./core/config/SdkConfig";
export { loadAndSetSdkConfig, loadDomainAwareConfig } from "./core/config/loadConfig";
export type { CoreConfig } from "./core/config/configTypes";

export type { MatrixCredentials, MatrixClientAssignOpts, StoredSession } from "./core/types/credentials";
