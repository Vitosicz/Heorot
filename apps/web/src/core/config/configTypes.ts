import type { IClientWellKnown } from "matrix-js-sdk/src/matrix";

export interface CoreConfig {
    default_server_config?: IClientWellKnown;
    default_server_name?: string;
    default_hs_url?: string;
    default_is_url?: string;
    disable_custom_urls?: boolean;
    disable_guests?: boolean;
    brand?: string;
    setting_defaults?: Record<string, unknown>;
    features?: Record<string, boolean>;
    sync_timeline_limit?: number;
    voice_enabled?: boolean;
    voice_service_url?: string;
    livekit_ws_url?: string;
    [key: string]: unknown;
}
