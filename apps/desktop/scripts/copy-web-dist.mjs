import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..", "..");
const sourceDir = path.resolve(workspaceRoot, "apps", "web", "dist");
const targetDir = path.resolve(projectRoot, "web");
const sourceConfigPath = path.resolve(workspaceRoot, "apps", "web", "config.json");
const sourceConfigExamplePath = path.resolve(workspaceRoot, "apps", "web", "config.example.json");
const targetIndexPath = path.resolve(targetDir, "index.html");
const targetConfigPath = path.resolve(targetDir, "config.json");
const targetConfigExamplePath = path.resolve(targetDir, "config.example.json");

if (!fs.existsSync(sourceDir)) {
    throw new Error(`Web dist folder not found: ${sourceDir}`);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

if (fs.existsSync(targetIndexPath)) {
    const indexHtml = fs.readFileSync(targetIndexPath, "utf8");
    const normalizedIndexHtml = indexHtml
        .replace(/src="\/assets\//g, 'src="./assets/')
        .replace(/href="\/assets\//g, 'href="./assets/');
    fs.writeFileSync(targetIndexPath, normalizedIndexHtml, "utf8");
}

if (fs.existsSync(sourceConfigPath)) {
    fs.copyFileSync(sourceConfigPath, targetConfigPath);
}

if (fs.existsSync(sourceConfigExamplePath)) {
    fs.copyFileSync(sourceConfigExamplePath, targetConfigExamplePath);
}

console.log(`[heorot-desktop] Copied web dist from ${sourceDir} to ${targetDir} (including config files).`);
