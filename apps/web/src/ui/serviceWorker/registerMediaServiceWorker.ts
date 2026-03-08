const USER_ID_STORAGE_KEY = "mx_user_id";
const DEVICE_ID_STORAGE_KEY = "mx_device_id";
const HOMESERVER_STORAGE_KEY = "mx_hs_url";

interface UserInfoRequestMessage {
    type?: unknown;
    responseKey?: unknown;
}

declare global {
    interface Window {
        __heorotMediaSwRegistered?: boolean;
    }
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

    const userId = window.localStorage.getItem(USER_ID_STORAGE_KEY) ?? undefined;
    const deviceId = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY) ?? undefined;
    const homeserver = window.localStorage.getItem(HOMESERVER_STORAGE_KEY) ?? undefined;

    source.postMessage({
        responseKey: data.responseKey,
        userId,
        deviceId,
        homeserver,
    });
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

    try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        await registration.update();
    } catch (error) {
        window.__heorotMediaSwRegistered = false;
        console.error("Failed to register media service worker", error);
    }
}
