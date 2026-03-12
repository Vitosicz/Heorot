const USER_ID_STORAGE_KEY = "mx_user_id";
const DEVICE_ID_STORAGE_KEY = "mx_device_id";
const HOMESERVER_STORAGE_KEY = "mx_hs_url";

interface UserInfoRequestMessage {
    type?: unknown;
    responseKey?: unknown;
}

interface StoredUserInfo {
    userId?: string;
    deviceId?: string;
    homeserver?: string;
}

interface UserInfoSyncMessage extends StoredUserInfo {
    type: "userinfo_sync";
}

interface PostMessageTarget {
    postMessage: (message: unknown) => void;
}

declare global {
    interface Window {
        __heorotMediaSwRegistered?: boolean;
    }
}

function readStoredUserInfo(): StoredUserInfo {
    return {
        userId: window.localStorage.getItem(USER_ID_STORAGE_KEY) ?? undefined,
        deviceId: window.localStorage.getItem(DEVICE_ID_STORAGE_KEY) ?? undefined,
        homeserver: window.localStorage.getItem(HOMESERVER_STORAGE_KEY) ?? undefined,
    };
}

function postUserInfoSync(target: PostMessageTarget | null | undefined): void {
    if (!target) {
        return;
    }

    const payload: UserInfoSyncMessage = {
        type: "userinfo_sync",
        ...readStoredUserInfo(),
    };
    target.postMessage(payload);
}

async function syncUserInfoToServiceWorker(registration?: ServiceWorkerRegistration): Promise<void> {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
        postUserInfoSync(controller);
        return;
    }

    const readyRegistration = registration ?? (await navigator.serviceWorker.ready);
    postUserInfoSync(readyRegistration.active);
}

function onServiceWorkerMessage(event: MessageEvent<UserInfoRequestMessage>): void {
    const data = event.data;
    if (!data || data.type !== "userinfo" || typeof data.responseKey !== "string") {
        return;
    }

    const source = event.source;
    if (!source || !("postMessage" in source)) {
        return;
    }

    const userInfo = readStoredUserInfo();
    source.postMessage({
        responseKey: data.responseKey,
        ...userInfo,
    });

    postUserInfoSync(source);
}

export async function registerMediaServiceWorker(): Promise<void> {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
        return;
    }

    if (window.__heorotMediaSwRegistered) {
        return;
    }

    window.__heorotMediaSwRegistered = true;
    navigator.serviceWorker.addEventListener("message", onServiceWorkerMessage);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        void syncUserInfoToServiceWorker();
    });

    window.addEventListener("storage", (event) => {
        if (
            event.key === USER_ID_STORAGE_KEY ||
            event.key === DEVICE_ID_STORAGE_KEY ||
            event.key === HOMESERVER_STORAGE_KEY
        ) {
            void syncUserInfoToServiceWorker();
        }
    });

    try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        await registration.update();
        void syncUserInfoToServiceWorker(registration);
        navigator.serviceWorker.ready
            .then((readyRegistration) => {
                postUserInfoSync(readyRegistration.active);
            })
            .catch(() => {
                // Ignore ready() failures; media requests will still use request/response handshake.
            });
    } catch (error) {
        window.__heorotMediaSwRegistered = false;
        console.error("Failed to register media service worker", error);
    }
}
