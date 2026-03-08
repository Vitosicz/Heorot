export interface HeorotDesktopMediaAuthState {
    accessToken?: string;
    homeserverUrl?: string;
    versions?: string[];
}

export interface HeorotDesktopCaptureSource {
    id: string;
    name: string;
}

export interface HeorotDesktopBridge {
    openExternal?: (url: string) => Promise<void>;
    setMediaAuthState?: (state: HeorotDesktopMediaAuthState) => Promise<void>;
    clearMediaAuthState?: () => Promise<void>;
    setCloseOnWindowCloseMinimize?: (enabled: boolean) => Promise<void>;
    quitApp?: () => Promise<void>;
    getDesktopCapturerSources?: () => Promise<HeorotDesktopCaptureSource[]>;
    setPreferredDisplayMediaSource?: (sourceId: string) => Promise<void>;
    platform?: string;
    versions?: {
        electron?: string;
        chrome?: string;
        node?: string;
    };
}

declare global {
    interface Window {
        heorotDesktop?: HeorotDesktopBridge;
    }
}
