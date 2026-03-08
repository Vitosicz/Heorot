const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

async function afterPack(context) {
    if (process.platform !== "darwin") {
        return;
    }

    const appOutDir = context?.appOutDir;
    if (typeof appOutDir !== "string" || appOutDir.length === 0 || !fs.existsSync(appOutDir)) {
        return;
    }

    // macOS metadata xattrs can break codesign with "resource fork ... not allowed".
    console.log(`[heorot-builder] Clearing xattrs in ${appOutDir}`);
    execFileSync("xattr", ["-cr", appOutDir], { stdio: "inherit" });
}

module.exports = afterPack;
module.exports.default = afterPack;
