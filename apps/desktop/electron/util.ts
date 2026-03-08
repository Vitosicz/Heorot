import fs from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";

export interface WindowState {
    x?: number;
    y?: number;
    width: number;
    height: number;
    isMaximized?: boolean;
}

const DEFAULT_WINDOW_STATE: WindowState = {
    width: 1200,
    height: 800,
    isMaximized: false,
};

const WINDOW_STATE_FILE_NAME = "window-state.json";

function getWindowStatePath(): string {
    return path.join(app.getPath("userData"), WINDOW_STATE_FILE_NAME);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function readWindowState(): WindowState {
    const statePath = getWindowStatePath();

    try {
        if (!fs.existsSync(statePath)) {
            return { ...DEFAULT_WINDOW_STATE };
        }

        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<WindowState>;
        const width = isFiniteNumber(parsed.width) ? parsed.width : DEFAULT_WINDOW_STATE.width;
        const height = isFiniteNumber(parsed.height) ? parsed.height : DEFAULT_WINDOW_STATE.height;
        const x = isFiniteNumber(parsed.x) ? parsed.x : undefined;
        const y = isFiniteNumber(parsed.y) ? parsed.y : undefined;
        const isMaximized = typeof parsed.isMaximized === "boolean" ? parsed.isMaximized : false;

        return { width, height, x, y, isMaximized };
    } catch {
        return { ...DEFAULT_WINDOW_STATE };
    }
}

export function writeWindowState(window: BrowserWindow): void {
    try {
        const bounds = window.getNormalBounds();
        const state: WindowState = {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized: window.isMaximized(),
        };

        fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), "utf8");
    } catch {
        // Ignore persistence errors.
    }
}

function isAllowedExternalScheme(url: URL): boolean {
    return ["http:", "https:", "mailto:", "matrix:"].includes(url.protocol);
}

export async function openExternalSafely(rawUrl: string): Promise<void> {
    try {
        const parsed = new URL(rawUrl);
        if (!isAllowedExternalScheme(parsed)) {
            return;
        }

        const { shell } = await import("electron");
        await shell.openExternal(parsed.toString());
    } catch {
        // Ignore invalid URLs.
    }
}

