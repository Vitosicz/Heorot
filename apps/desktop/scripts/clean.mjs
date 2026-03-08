import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const targets = [
    path.resolve(projectRoot, "dist"),
    path.resolve(projectRoot, "web"),
    path.resolve(projectRoot, "dist-electron"),
];

for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true });
}

console.log("[heorot-desktop] Cleaned build folders.");

