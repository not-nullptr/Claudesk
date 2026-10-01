import { readFile, writeFile } from "node:fs/promises";

const [packagePath, releasePath = "/opt/claude-cowork-bridge/release.json"] = process.argv.slice(2);
if (!packagePath) throw new Error("package.json path is required");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
if (packageJson.name !== "@ant/desktop") {
  throw new Error(`unexpected official package name: ${packageJson.name || "missing"}`);
}
if (packageJson.main !== ".vite/build/index.pre.js") {
  throw new Error("unsupported official Desktop entry point");
}
const release = JSON.parse(await readFile(releasePath, "utf8"));
if (packageJson.version !== release.desktopVersion) {
  throw new Error(`unsupported Desktop package version: ${packageJson.version}`);
}
if (process.env.CLAUDE_COWORK_HOST_BASH === "1") {
  throw new Error("Desktop 2.x requires Cowork VM mode; set CLAUDE_COWORK_HOST_BASH=0");
}
packageJson.claudeCoworkBridgeOriginalMain = packageJson.main;
packageJson.main = "bridge-wrapper/loader.cjs";
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
