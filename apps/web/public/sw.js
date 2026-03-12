const ACCESS_TOKEN_STORAGE_KEY = "mx_access_token";
const ACCESS_TOKEN_IV = "access_token";
const ACCOUNT_STORE_NAME = "account";
const PICKLE_KEY_STORE_NAME = "pickleKey";
const DB_NAME = "heorot-core";
const DB_VERSION = 1;
const SERVER_SUPPORT_TTL_MS = 2 * 60 * 60 * 1000;
const V3_MEDIA_PATH_PREFIX = "/_matrix/media/v3/";
const AUTH_MEDIA_PATH_PREFIX = "/_matrix/client/v1/media/";

const serverSupportMap = {};
let dbPromise;
let cachedUserInfo = null;

function normalizeUserInfoCandidate(candidate) {
    if (!candidate || typeof candidate !== "object") {
        return null;
    }

    const userId = typeof candidate.userId === "string" && candidate.userId ? candidate.userId : undefined;
    const deviceId = typeof candidate.deviceId === "string" && candidate.deviceId ? candidate.deviceId : undefined;
    const homeserver = typeof candidate.homeserver === "string" && candidate.homeserver ? candidate.homeserver : undefined;
    if (!userId || !deviceId || !homeserver) {
        return null;
    }

    return { userId, deviceId, homeserver };
}

function setCachedUserInfo(candidate) {
    cachedUserInfo = normalizeUserInfoCandidate(candidate);
    return cachedUserInfo;
}

self.addEventListener("message", (event) => {
    if (!event?.data || event.data.type !== "userinfo_sync") {
        return;
    }

    setCachedUserInfo(event.data);
});

self.addEventListener("install", (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") {
        return;
    }

    const url = new URL(event.request.url);
    if (!url.pathname.startsWith("/_matrix/media/v3/download") && !url.pathname.startsWith("/_matrix/media/v3/thumbnail")) {
        return;
    }

    event.respondWith(handleMediaRequest(event, url));
});

async function handleMediaRequest(event, url) {
    let authData;

    try {
        const clientApi = url.origin;

        await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

        const client = event.clientId ? await self.clients.get(event.clientId) : null;
        authData = await getAuthData(client);
        const homeserverOrigin = new URL(authData.homeserver).origin;

        if (url.origin !== homeserverOrigin) {
            throw new Error("Media request origin does not match homeserver origin");
        }

        await tryUpdateServerSupportMap(clientApi, authData.accessToken);

        const serverSupport = serverSupportMap[clientApi];
        const supportsAuthenticatedMedia = Boolean(serverSupport && serverSupport.supportsAuthedMedia);
        if (supportsAuthenticatedMedia && authData.accessToken) {
            if (url.pathname.startsWith(V3_MEDIA_PATH_PREFIX)) {
                url.pathname = `${AUTH_MEDIA_PATH_PREFIX}${url.pathname.slice(V3_MEDIA_PATH_PREFIX.length)}`;
            }
        }
    } catch (error) {
        authData = undefined;
        console.error("SW: Error in request rewrite.", error);
    }

    return fetch(url, fetchConfigForToken(authData && authData.accessToken));
}

async function tryUpdateServerSupportMap(origin, accessToken) {
    const cached = serverSupportMap[origin];
    if (cached && cached.cacheExpiryTimeMs > Date.now()) {
        return;
    }

    const config = fetchConfigForToken(accessToken);
    const versions = await (await fetch(`${origin}/_matrix/client/versions`, config)).json();
    const supportsAuthedMedia =
        Array.isArray(versions && versions.versions) &&
        versions.versions.includes("v1.11");

    serverSupportMap[origin] = {
        supportsAuthedMedia,
        cacheExpiryTimeMs: Date.now() + SERVER_SUPPORT_TTL_MS,
    };
}

function fetchConfigForToken(accessToken) {
    if (!accessToken) {
        return undefined;
    }

    const headers = {};
    headers.Authorization = `Bearer ${accessToken}`;
    return { headers };
}

function generateResponseKey() {
    if (crypto?.randomUUID) {
        return crypto.randomUUID();
    }

    if (!crypto?.getRandomValues) {
        throw new Error("Secure random generator is not available in this runtime");
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    let out = "";
    for (let index = 0; index < bytes.length; index++) {
        out += bytes[index].toString(16).padStart(2, "0");
    }

    return out;
}

async function getAuthData(client) {
    let userInfo = cachedUserInfo;
    let handshakeClient = client;

    if (!handshakeClient && !userInfo) {
        const availableClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        handshakeClient = availableClients[0] ?? null;
    }

    if (handshakeClient) {
        try {
            userInfo = setCachedUserInfo(await askClientForUserInfo(handshakeClient));
        } catch {
            userInfo = cachedUserInfo;
        }
    }

    if (!userInfo) {
        throw new Error("Missing user info for service worker auth handshake");
    }

    const { userId, deviceId, homeserver } = userInfo;

    const storedAccessToken = await idbLoad(ACCOUNT_STORE_NAME, ACCESS_TOKEN_STORAGE_KEY);
    if (!storedAccessToken) {
        throw new Error("No access token found in IndexedDB");
    }

    const accessToken =
        typeof storedAccessToken === "string"
            ? storedAccessToken
            : await decryptStoredAccessToken(storedAccessToken, userId, deviceId);

    return { accessToken, homeserver };
}

async function askClientForUserInfo(client) {
    return await new Promise((resolve, reject) => {
        const responseKey = generateResponseKey();

        const timeoutId = setTimeout(() => {
            self.removeEventListener("message", onMessage);
            reject(new Error("Timed out waiting for user info"));
        }, 1000);

        const onMessage = (event) => {
            if (event.source?.id !== client.id) {
                return;
            }

            if (!event.data || event.data.responseKey !== responseKey) {
                return;
            }

            clearTimeout(timeoutId);
            self.removeEventListener("message", onMessage);
            resolve(event.data);
        };

        self.addEventListener("message", onMessage);
        client.postMessage({ type: "userinfo", responseKey });
    });
}

async function decryptStoredAccessToken(encryptedToken, userId, deviceId) {
    const pickleKeyData = await idbLoad(PICKLE_KEY_STORE_NAME, [userId, deviceId]);
    const pickleKey = await buildAndEncodePickleKey(pickleKeyData, userId, deviceId);
    if (!pickleKey) {
        throw new Error("Could not reconstruct pickle key");
    }

    return await tryDecryptToken(pickleKey, encryptedToken, ACCESS_TOKEN_IV);
}

async function openDatabase() {
    if (dbPromise) {
        return dbPromise;
    }

    dbPromise = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PICKLE_KEY_STORE_NAME)) {
                db.createObjectStore(PICKLE_KEY_STORE_NAME);
            }
            if (!db.objectStoreNames.contains(ACCOUNT_STORE_NAME)) {
                db.createObjectStore(ACCOUNT_STORE_NAME);
            }
        };
    });

    return dbPromise;
}

async function idbLoad(tableName, key) {
    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
        const transaction = db.transaction([tableName], "readonly");
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));

        const store = transaction.objectStore(tableName);
        const request = store.get(key);
        request.onerror = () => reject(request.error || new Error("IndexedDB get failed"));
        request.onsuccess = () => resolve(request.result);
    });
}

function encodeUnpaddedBase64(uint8Array) {
    let binary = "";
    for (let index = 0; index < uint8Array.length; index++) {
        binary += String.fromCharCode(uint8Array[index]);
    }

    const encoded = btoa(binary);
    const paddingIndex = encoded.indexOf("=");
    return paddingIndex === -1 ? encoded : encoded.slice(0, paddingIndex);
}

function decodeBase64(base64) {
    let normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
    const remainder = normalized.length % 4;
    if (remainder > 0) {
        normalized += "=".repeat(4 - remainder);
    }

    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        out[index] = binary.charCodeAt(index);
    }

    return out;
}

function getPickleAdditionalData(userId, deviceId) {
    const additionalData = new Uint8Array(userId.length + deviceId.length + 1);

    for (let index = 0; index < userId.length; index++) {
        additionalData[index] = userId.charCodeAt(index);
    }

    additionalData[userId.length] = 124;

    for (let index = 0; index < deviceId.length; index++) {
        additionalData[userId.length + 1 + index] = deviceId.charCodeAt(index);
    }

    return additionalData;
}

async function buildAndEncodePickleKey(data, userId, deviceId) {
    if (!data || !data.encrypted || !data.iv || !data.cryptoKey) {
        return undefined;
    }

    const additionalData = getPickleAdditionalData(userId, deviceId);
    const keyBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.iv, additionalData },
        data.cryptoKey,
        data.encrypted,
    );

    return encodeUnpaddedBase64(new Uint8Array(keyBuffer));
}

async function pickleKeyToAesKey(pickleKey) {
    const pickleKeyBuffer = new Uint8Array(pickleKey.length);
    for (let index = 0; index < pickleKey.length; index++) {
        pickleKeyBuffer[index] = pickleKey.charCodeAt(index);
    }

    const hkdfKey = await crypto.subtle.importKey("raw", pickleKeyBuffer, "HKDF", false, ["deriveBits"]);
    pickleKeyBuffer.fill(0);

    const bits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            hash: "SHA-256",
            salt: new Uint8Array(32),
            info: new Uint8Array(0),
        },
        hkdfKey,
        256,
    );

    return new Uint8Array(bits);
}

async function tryDecryptToken(pickleKey, token, tokenName) {
    if (typeof token === "string") {
        return token;
    }

    if (!pickleKey) {
        throw new Error(`Cannot decrypt ${tokenName}: missing pickle key`);
    }

    const encryptionKey = await pickleKeyToAesKey(pickleKey);
    try {
        return await decryptAESSecretStorageItem(token, encryptionKey, tokenName);
    } finally {
        encryptionKey.fill(0);
    }
}

async function decryptAESSecretStorageItem(data, key, name) {
    const [aesKey, hmacKey] = await deriveKeys(key, name);
    const ciphertext = decodeBase64(data.ciphertext);
    const mac = decodeBase64(data.mac);
    const isMacValid = await crypto.subtle.verify({ name: "HMAC" }, hmacKey, mac, ciphertext);
    if (!isMacValid) {
        throw new Error(`Error decrypting secret ${name}: bad MAC`);
    }

    const plaintext = await crypto.subtle.decrypt(
        {
            name: "AES-CTR",
            counter: decodeBase64(data.iv),
            length: 64,
        },
        aesKey,
        ciphertext,
    );

    return new TextDecoder().decode(new Uint8Array(plaintext));
}

async function deriveKeys(key, name) {
    const hkdfKey = await crypto.subtle.importKey("raw", key, { name: "HKDF" }, false, ["deriveBits"]);
    const keybits = await crypto.subtle.deriveBits(
        {
            name: "HKDF",
            salt: new Uint8Array(8),
            info: new TextEncoder().encode(name),
            hash: "SHA-256",
        },
        hkdfKey,
        512,
    );

    const aesKeyBytes = keybits.slice(0, 32);
    const hmacKeyBytes = keybits.slice(32);

    const aesKeyPromise = crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-CTR" }, false, ["encrypt", "decrypt"]);
    const hmacKeyPromise = crypto.subtle.importKey(
        "raw",
        hmacKeyBytes,
        {
            name: "HMAC",
            hash: { name: "SHA-256" },
        },
        false,
        ["sign", "verify"],
    );

    return await Promise.all([aesKeyPromise, hmacKeyPromise]);
}
