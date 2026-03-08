const path = require("node:path");
const ts = require("typescript");

const projectRoot = process.cwd();
const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");

if (!configPath) {
    console.error("Unable to find tsconfig.json");
    process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
    reportDiagnostics([configFile.error]);
    process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
if (parsedConfig.errors.length > 0) {
    reportDiagnostics(parsedConfig.errors);
    process.exit(1);
}

const program = ts.createProgram({
    rootNames: parsedConfig.fileNames,
    options: parsedConfig.options,
});

const allDiagnostics = ts.getPreEmitDiagnostics(program);
const filteredDiagnostics = allDiagnostics.filter((diagnostic) => {
    if (diagnostic.code !== 2578) {
        return true;
    }

    const fileName = diagnostic.file?.fileName.replace(/\\/g, "/") ?? "";
    return !fileName.endsWith("/src/core/storage/tokens.ts");
});

if (filteredDiagnostics.length > 0) {
    reportDiagnostics(filteredDiagnostics);
    process.exit(1);
}

console.log("Typecheck passed (known core TS2578 in src/core/storage/tokens.ts ignored).");

function reportDiagnostics(diagnostics) {
    const host = {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => projectRoot,
        getNewLine: () => ts.sys.newLine,
    };

    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
