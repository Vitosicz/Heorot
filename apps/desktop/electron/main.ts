import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, session } from "electron";

import { openExternalSafely, readWindowState, writeWindowState } from "./util";

const APP_TITLE = "Heorot";
const DEFAULT_DEV_URL = "http://127.0.0.1:5173";
const DEV_URL = process.env.HEOROT_DESKTOP_DEV_URL?.trim()
    || (process.env.HEOROT_DESKTOP_DEV === "1" ? DEFAULT_DEV_URL : undefined);
const APP_PROTOCOL = "heorot";
const APP_PROTOCOL_HOST = "app";
const APP_ENTRY_URL = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}/index.html`;
const SYSTEM_AUDIO_CAPTURE_MODE_ENV = process.env.HEOROT_DESKTOP_SYSTEM_AUDIO_CAPTURE_MODE?.trim().toLowerCase();
const SYSTEM_AUDIO_CAPTURE_MODE: "loopback" | "loopbackWithMute" =
    SYSTEM_AUDIO_CAPTURE_MODE_ENV === "loopbackwithmute" ? "loopbackWithMute" : "loopback";
const WINDOW_BACKGROUND_COLOR = "#0e141b";
const TITLEBAR_OVERLAY_COLOR = "#121a23";
const TITLEBAR_OVERLAY_SYMBOL_COLOR = "#e6edf3";
const TITLEBAR_OVERLAY_HEIGHT = 32;
let mainWindow: BrowserWindow | null = null;
let mediaAuthInterceptorConfigured = false;
let appProtocolConfigured = false;
let closeOnWindowCloseMinimize = true;
let isAppQuitting = false;
let preferredDisplayMediaSourceId: string | null = null;

protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_PROTOCOL,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            allowServiceWorkers: true,
        },
    },
]);

interface DesktopMediaAuthState {
    accessToken?: string;
    homeserverUrl?: string;
    versions?: string[];
}

const mediaAuthState: DesktopMediaAuthState = {};

function clearMediaAuthState(): void {
    mediaAuthState.accessToken = undefined;
    mediaAuthState.homeserverUrl = undefined;
    mediaAuthState.versions = undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const filtered = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return filtered.length > 0 ? filtered : undefined;
}

function setMediaAuthState(rawState: unknown): void {
    if (!rawState || typeof rawState !== "object") {
        clearMediaAuthState();
        return;
    }

    const value = rawState as {
        accessToken?: unknown;
        homeserverUrl?: unknown;
        versions?: unknown;
    };

    mediaAuthState.accessToken =
        typeof value.accessToken === "string" && value.accessToken.length > 0 ? value.accessToken : undefined;
    mediaAuthState.homeserverUrl =
        typeof value.homeserverUrl === "string" && value.homeserverUrl.length > 0 ? value.homeserverUrl : undefined;
    mediaAuthState.versions = normalizeStringArray(value.versions);
}

function serverSupportsAuthenticatedMedia(): boolean {
    return Boolean(mediaAuthState.versions?.includes("v1.11"));
}

function isV3MediaPath(pathname: string): boolean {
    return pathname.startsWith("/_matrix/media/v3/download") || pathname.startsWith("/_matrix/media/v3/thumbnail");
}

function isAuthenticatedMediaPath(pathname: string): boolean {
    return pathname.startsWith("/_matrix/client/v1/media");
}

function isHomeserverOriginMatch(target: URL): boolean {
    if (!mediaAuthState.homeserverUrl) {
        return false;
    }

    try {
        return target.origin === new URL(mediaAuthState.homeserverUrl).origin;
    } catch {
        return false;
    }
}

function rewriteV3ToAuthenticatedMediaUrl(rawUrl: string): string {
    const url = new URL(rawUrl);
    url.pathname = url.pathname.replace("/_matrix/media/v3/", "/_matrix/client/v1/media/");
    url.searchParams.set("allow_redirect", "true");
    return url.toString();
}

function configureMediaAuthInterceptor(): void {
    if (mediaAuthInterceptorConfigured) {
        return;
    }
    mediaAuthInterceptorConfigured = true;

    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        try {
            const url = new URL(details.url);

            if (!isV3MediaPath(url.pathname)) {
                callback({});
                return;
            }

            if (!isHomeserverOriginMatch(url)) {
                callback({});
                return;
            }

            if (!serverSupportsAuthenticatedMedia() || !mediaAuthState.accessToken) {
                callback({});
                return;
            }

            callback({ redirectURL: rewriteV3ToAuthenticatedMediaUrl(details.url) });
        } catch {
            callback({});
        }
    });

    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const url = new URL(details.url);
            if (!isAuthenticatedMediaPath(url.pathname) || !isHomeserverOriginMatch(url) || !mediaAuthState.accessToken) {
                callback({});
                return;
            }

            callback({
                requestHeaders: {
                    ...details.requestHeaders,
                    Authorization: `Bearer ${mediaAuthState.accessToken}`,
                },
            });
        } catch {
            callback({});
        }
    });
}

function configureDisplayMediaCapture(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
        async (request, callback) => {
            try {
                const sources = await desktopCapturer.getSources({
                    types: ["screen", "window"],
                    fetchWindowIcons: true,
                    thumbnailSize: { width: 320, height: 180 },
                });
                const selectedSource =
                    (preferredDisplayMediaSourceId
                        ? sources.find((source) => source.id === preferredDisplayMediaSourceId)
                        : undefined)
                    ?? sources.find((source) => source.id.startsWith("window:"))
                    ?? sources.find((source) => source.id.startsWith("screen:"))
                    ?? sources[0];
                preferredDisplayMediaSourceId = null;

                if (!selectedSource) {
                    callback({});
                    return;
                }

                if (request.audioRequested && process.platform === "win32" && selectedSource.id.startsWith("screen:")) {
                    callback({
                        video: selectedSource,
                        audio: SYSTEM_AUDIO_CAPTURE_MODE,
                    });
                    return;
                }

                callback({ video: selectedSource });
            } catch {
                preferredDisplayMediaSourceId = null;
                callback({});
            }
        },
        { useSystemPicker: true },
    );
}

function resolvePreloadPath(): string {
    return path.join(__dirname, "preload.js");
}

function resolveRendererRootPath(): string {
    const appPath = app.getAppPath();
    const asarWebPath = path.join(appPath, "web");

    if (fs.existsSync(asarWebPath)) {
        return asarWebPath;
    }

    return path.resolve(__dirname, "../../web");
}

function resolveRendererPath(): string {
    return path.join(resolveRendererRootPath(), "index.html");
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
    const resolvedRoot = path.resolve(rootPath);
    const resolvedTarget = path.resolve(targetPath);

    if (process.platform === "win32") {
        const lowerRoot = resolvedRoot.toLowerCase();
        const lowerTarget = resolvedTarget.toLowerCase();
        return lowerTarget === lowerRoot || lowerTarget.startsWith(`${lowerRoot}${path.sep}`);
    }

    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function configureAppProtocol(): void {
    if (appProtocolConfigured || DEV_URL) {
        return;
    }
    appProtocolConfigured = true;

    protocol.handle(APP_PROTOCOL, async (request) => {
        try {
            const requestUrl = new URL(request.url);
            if (requestUrl.host !== APP_PROTOCOL_HOST) {
                return new Response("Not found", { status: 404 });
            }

            const rootPath = resolveRendererRootPath();
            const decodedPath = decodeURIComponent(requestUrl.pathname);
            const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
            const normalizedRelativePath = path.normalize(relativePath);

            if (normalizedRelativePath.startsWith("..") || path.isAbsolute(normalizedRelativePath)) {
                return new Response("Not found", { status: 404 });
            }

            const targetPath = path.join(rootPath, normalizedRelativePath);
            if (!isPathInsideRoot(rootPath, targetPath)) {
                return new Response("Not found", { status: 404 });
            }

            if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
                return new Response("Not found", { status: 404 });
            }

            return net.fetch(pathToFileURL(targetPath).toString());
        } catch {
            return new Response("Not found", { status: 404 });
        }
    });
}

function canNavigateInsideApp(rawUrl: string): boolean {
    try {
        const target = new URL(rawUrl);

        if (DEV_URL) {
            const devOrigin = new URL(DEV_URL).origin;
            return target.origin === devOrigin;
        }

        return target.protocol === `${APP_PROTOCOL}:` && target.host === APP_PROTOCOL_HOST;
    } catch {
        return false;
    }
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
    if (DEV_URL) {
        await window.loadURL(DEV_URL);
        return;
    }

    await window.loadURL(APP_ENTRY_URL);
}

function configureNavigationSafety(window: BrowserWindow): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
        void openExternalSafely(url);
        return { action: "deny" };
    });

    window.webContents.on("will-navigate", (event, targetUrl) => {
        if (canNavigateInsideApp(targetUrl)) {
            return;
        }

        event.preventDefault();
        void openExternalSafely(targetUrl);
    });
}

function createMainWindow(): BrowserWindow {
    const windowState = readWindowState();

    const window = new BrowserWindow({
        title: APP_TITLE,
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        minWidth: 960,
        minHeight: 640,
        backgroundColor: WINDOW_BACKGROUND_COLOR,
        show: false,
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: TITLEBAR_OVERLAY_COLOR,
            symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
            height: TITLEBAR_OVERLAY_HEIGHT,
        },
        webPreferences: {
            preload: resolvePreloadPath(),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
        },
    });

    configureNavigationSafety(window);

    window.once("ready-to-show", () => {
        if (windowState.isMaximized) {
            window.maximize();
        }
        window.show();
    });

    window.on("close", (event) => {
        const shouldMinimizeOnClose = !isAppQuitting && closeOnWindowCloseMinimize && process.platform !== "darwin";
        if (shouldMinimizeOnClose && !window.isMinimized()) {
            event.preventDefault();
            window.minimize();
            return;
        }

        writeWindowState(window);
    });

    window.on("closed", () => {
        if (mainWindow === window) {
            mainWindow = null;
        }
    });

    return window;
}

function focusMainWindow(): void {
    if (!mainWindow) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.focus();
}

function registerIpc(): void {
    ipcMain.handle("heorot:openExternal", async (_event, rawUrl: unknown) => {
        if (typeof rawUrl !== "string") {
            return;
        }

        await openExternalSafely(rawUrl);
    });

    ipcMain.handle("heorot:setMediaAuthState", (_event, rawState: unknown) => {
        setMediaAuthState(rawState);
    });

    ipcMain.handle("heorot:clearMediaAuthState", () => {
        clearMediaAuthState();
    });

    ipcMain.handle("heorot:setCloseOnWindowCloseMinimize", (_event, enabled: unknown) => {
        closeOnWindowCloseMinimize = enabled !== false;
    });

    ipcMain.handle("heorot:getDesktopCapturerSources", async () => {
        const sources = await desktopCapturer.getSources({
            types: ["window", "screen"],
            fetchWindowIcons: true,
            thumbnailSize: { width: 320, height: 180 },
        });
        return sources.map((source) => ({
            id: source.id,
            name: source.name,
        }));
    });

    ipcMain.handle("heorot:setPreferredDisplayMediaSource", (_event, sourceId: unknown) => {
        preferredDisplayMediaSourceId = typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
    });

    ipcMain.handle("heorot:quitApp", () => {
        isAppQuitting = true;
        app.quit();
    });
}

async function bootstrap(): Promise<void> {
    app.on("before-quit", () => {
        isAppQuitting = true;
    });

    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
        app.quit();
        return;
    }

    app.on("second-instance", () => {
        focusMainWindow();
    });

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") {
            app.quit();
        }
    });

    app.on("activate", async () => {
        if (mainWindow) {
            focusMainWindow();
            return;
        }

        mainWindow = createMainWindow();
        await loadRenderer(mainWindow);
    });

    await app.whenReady();
    configureAppProtocol();
    configureMediaAuthInterceptor();
    configureDisplayMediaCapture();
    registerIpc();

    mainWindow = createMainWindow();
    await loadRenderer(mainWindow);

    // Auto updater stub (infrastructure intentionally not implemented in MVP).
    if (app.isPackaged) {
        console.log("[heorot-desktop] auto-updater stub: disabled");
    }
}

void bootstrap();
