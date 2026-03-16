import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const desktopPackageJsonPath = path.resolve(projectRoot, "package.json");

function readCurrentDesktopVersion() {
    const packageJson = JSON.parse(fs.readFileSync(desktopPackageJsonPath, "utf8"));
    if (typeof packageJson.version !== "string" || packageJson.version.trim().length === 0) {
        throw new Error("Unable to resolve desktop version from package.json");
    }
    return packageJson.version.trim();
}

function isValidVersion(value) {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function resolvePackageManagerCommand(action, args) {
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) {
        return null;
    }

    const npmExecBasename = path.basename(npmExecPath).toLowerCase();
    if (npmExecBasename.endsWith(".js")) {
        return {
            command: process.execPath,
            args: [npmExecPath, action, ...args],
        };
    }

    return {
        command: npmExecPath,
        args: [action, ...args],
    };
}

function runNpmScript(scriptName) {
    const managerCommand = resolvePackageManagerCommand("run", [scriptName]);

    const result = managerCommand
        ? spawnSync(managerCommand.command, managerCommand.args, {
            cwd: projectRoot,
            stdio: "inherit",
        })
        : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", scriptName], {
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

function runElectronBuilder(version, extraArgs) {
    const electronBuilderArgs = [
        "--config",
        "electron-builder.json",
        `--config.extraMetadata.version=${version}`,
        ...extraArgs,
    ];

    const managerCommand = resolvePackageManagerCommand("exec", ["electron-builder", "--", ...electronBuilderArgs]);
    if (managerCommand) {
        const managerResult = spawnSync(managerCommand.command, managerCommand.args, {
            cwd: projectRoot,
            stdio: "inherit",
        });

        if (!managerResult.error && managerResult.status === 0) {
            return;
        }
    }

    const builderBinPath = path.resolve(
        projectRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
    );
    const directResult = spawnSync(builderBinPath, electronBuilderArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
    });

    if (directResult.error) {
        throw directResult.error;
    }
    if (directResult.status !== 0) {
        process.exit(directResult.status ?? 1);
    }
}

async function resolveTargetVersion() {
    const currentVersion = readCurrentDesktopVersion();
    const envVersion = (process.env.HEOROT_DESKTOP_VERSION || "").trim();
    const defaultVersion = envVersion.length > 0 ? envVersion : currentVersion;

    if (process.env.CI === "true" || !process.stdin.isTTY) {
        return defaultVersion;
    }

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    try {
        const enteredVersion = (await rl.question(`Desktop build version [${defaultVersion}]: `)).trim();
        return enteredVersion.length > 0 ? enteredVersion : defaultVersion;
    } finally {
        rl.close();
    }
}

async function main() {
    const version = await resolveTargetVersion();
    if (!isValidVersion(version)) {
        throw new Error(`Invalid version "${version}". Expected semver, for example 0.2.0 or 1.0.0-beta.1.`);
    }

    console.log(`[heorot-desktop] Building desktop installer version ${version}`);
    runNpmScript("build");
    runElectronBuilder(version, process.argv.slice(2));
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[heorot-desktop] ${message}`);
    process.exit(1);
});
