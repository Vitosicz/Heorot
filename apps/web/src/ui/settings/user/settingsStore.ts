export type AppTheme = "dark" | "light";

export interface AppearanceSettings {
    theme: AppTheme;
    compactMode: boolean;
    showTimestamps: boolean;
    closeOnWindowCloseMinimize: boolean;
    chatLineLengthCh: number;
    showSpaceChannelAvatars: boolean;
}

export interface NotificationsSettings {
    notificationsEnabled: boolean;
    notificationBodyEnabled: boolean;
    audioNotificationsEnabled: boolean;
    customMessageSoundDataUrl: string | null;
    customMessageSoundName: string | null;
}

export interface PrivacySettings {
    showReadReceipts: boolean;
    allowDmsFromServerMembers: boolean;
}

export interface AudioSettings {
    preferredAudioInputId: string;
    preferredAudioOutputId: string;
    micTestLoopbackEnabled: boolean;
    autoGainControlEnabled: boolean;
    echoCancellationEnabled: boolean;
    noiseSuppressionEnabled: boolean;
    voiceIsolationEnabled: boolean;
    micProfile: "speech" | "music";
}

export interface UserLocalSettings {
    appearance: AppearanceSettings;
    notifications: NotificationsSettings;
    privacy: PrivacySettings;
    audio: AudioSettings;
}

const SETTINGS_STORAGE_KEY = "heorot.user_settings.v1";

const DEFAULT_SETTINGS: UserLocalSettings = {
    appearance: {
        theme: "dark",
        compactMode: false,
        showTimestamps: true,
        closeOnWindowCloseMinimize: true,
        chatLineLengthCh: 0,
        showSpaceChannelAvatars: false,
    },
    notifications: {
        notificationsEnabled: false,
        notificationBodyEnabled: true,
        audioNotificationsEnabled: true,
        customMessageSoundDataUrl: null,
        customMessageSoundName: null,
    },
    privacy: {
        showReadReceipts: true,
        allowDmsFromServerMembers: true,
    },
    audio: {
        preferredAudioInputId: "default",
        preferredAudioOutputId: "default",
        micTestLoopbackEnabled: false,
        autoGainControlEnabled: true,
        echoCancellationEnabled: true,
        noiseSuppressionEnabled: true,
        voiceIsolationEnabled: true,
        micProfile: "speech",
    },
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSettings(raw: unknown): UserLocalSettings {
    if (!isRecord(raw)) {
        return { ...DEFAULT_SETTINGS };
    }

    const appearance = isRecord(raw.appearance) ? raw.appearance : {};
    const notifications = isRecord(raw.notifications) ? raw.notifications : {};
    const privacy = isRecord(raw.privacy) ? raw.privacy : {};
    const audio = isRecord(raw.audio) ? raw.audio : {};

    const theme = appearance.theme === "light" ? "light" : "dark";
    const compactMode = appearance.compactMode === true;
    const showTimestamps = appearance.showTimestamps !== false;
    const closeOnWindowCloseMinimize = appearance.closeOnWindowCloseMinimize !== false;
    const showSpaceChannelAvatars = appearance.showSpaceChannelAvatars === true;
    const chatLineLengthChRaw = typeof appearance.chatLineLengthCh === "number" ? appearance.chatLineLengthCh : 0;
    const chatLineLengthCh =
        Number.isFinite(chatLineLengthChRaw) && chatLineLengthChRaw > 0
            ? Math.min(120, Math.max(45, Math.round(chatLineLengthChRaw)))
            : 0;
    const customMessageSoundDataUrl =
        typeof notifications.customMessageSoundDataUrl === "string" &&
        notifications.customMessageSoundDataUrl.startsWith("data:")
            ? notifications.customMessageSoundDataUrl
            : null;
    const customMessageSoundName =
        typeof notifications.customMessageSoundName === "string" && notifications.customMessageSoundName.trim().length > 0
            ? notifications.customMessageSoundName
            : null;

    return {
        appearance: {
            theme,
            compactMode,
            showTimestamps,
            closeOnWindowCloseMinimize,
            chatLineLengthCh,
            showSpaceChannelAvatars,
        },
        notifications: {
            notificationsEnabled: notifications.notificationsEnabled === true,
            notificationBodyEnabled: notifications.notificationBodyEnabled !== false,
            audioNotificationsEnabled: notifications.audioNotificationsEnabled !== false,
            customMessageSoundDataUrl,
            customMessageSoundName,
        },
        privacy: {
            showReadReceipts: privacy.showReadReceipts !== false,
            allowDmsFromServerMembers: privacy.allowDmsFromServerMembers !== false,
        },
        audio: {
            preferredAudioInputId:
                typeof audio.preferredAudioInputId === "string" && audio.preferredAudioInputId.trim().length > 0
                    ? audio.preferredAudioInputId
                    : "default",
            preferredAudioOutputId:
                typeof audio.preferredAudioOutputId === "string" && audio.preferredAudioOutputId.trim().length > 0
                    ? audio.preferredAudioOutputId
                    : "default",
            micTestLoopbackEnabled: audio.micTestLoopbackEnabled === true,
            autoGainControlEnabled: audio.autoGainControlEnabled !== false,
            echoCancellationEnabled: audio.echoCancellationEnabled !== false,
            noiseSuppressionEnabled: audio.noiseSuppressionEnabled !== false,
            voiceIsolationEnabled: audio.voiceIsolationEnabled !== false,
            micProfile: audio.micProfile === "music" ? "music" : "speech",
        },
    };
}

export function loadUserLocalSettings(): UserLocalSettings {
    if (typeof window === "undefined") {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }
        return normalizeSettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveUserLocalSettings(settings: UserLocalSettings): void {
    if (typeof window === "undefined") {
        return;
    }

    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function applyAppearanceTheme(settings: AppearanceSettings): void {
    if (typeof document === "undefined") {
        return;
    }

    const root = document.documentElement;
    root.setAttribute("data-theme", settings.theme);
    root.style.setProperty(
        "--timeline-text-max-width",
        settings.chatLineLengthCh > 0 ? `${settings.chatLineLengthCh}ch` : "none",
    );
}

