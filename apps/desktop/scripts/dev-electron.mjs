import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const defaultDevUrl = "http://127.0.0.1:5173";
const devUrl = process.env.HEOROT_DESKTOP_DEV_URL || defaultDevUrl;

function runBuildElectron() {
    const npmExecPath = process.env.npm_execpath;
    const npmExecBasename = npmExecPath ? path.basename(npmExecPath).toLowerCase() : "";

    const result = npmExecPath
        ? spawnSync(
            npmExecBasename.endsWith(".js") ? process.execPath : npmExecPath,
            npmExecBasename.endsWith(".js") ? [npmExecPath, "run", "build:electron"] : ["run", "build:electron"],
            {
                cwd: projectRoot,
                stdio: "inherit",
            },
        )
        : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:electron"], {
            cwd: projectRoot,
            stdio: "inherit",
        });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

async function waitForDevServer() {
    const timeoutMs = 90_000;
    const intervalMs = 500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(devUrl, { method: "GET" });
            if (response.ok || response.status === 404) {
                return;
            }
        } catch {
            // Retry until timeout.
        }

        await new Promise((resolve) => {
            setTimeout(resolve, intervalMs);
        });
    }

    throw new Error(`Timed out waiting for dev server at ${devUrl}`);
}

async function main() {
    runBuildElectron();
    await waitForDevServer();

    const electronEnv = { ...process.env };
    delete electronEnv.ELECTRON_RUN_AS_NODE;

    const child = spawn(String(electron), ["."], {
        cwd: projectRoot,
        stdio: "inherit",
        env: {
            ...electronEnv,
            HEOROT_DESKTOP_DEV_URL: devUrl,
            HEOROT_DESKTOP_DEV: "1",
        },
    });

    child.on("exit", (code) => {
        process.exit(code ?? 0);
    });
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[heorot-desktop] ${message}`);
    process.exit(1);
});
