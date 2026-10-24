// Electron's bundled Node runtime runs this entry; no system Node is required.
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { parseEnv } = require("node:util");
const dir = process.env.KICON_DATA_DIR;
if (!dir || !process.parentPort) throw Error("Desktop service must be started by the application.");
mkdirSync(dir, { recursive: true });
const configFile = join(dir, "config.env");
for (const name of Object.keys(process.env)) if (name.startsWith("QWEN_")) delete process.env[name];
if (existsSync(configFile)) {
  const config = parseEnv(readFileSync(configFile, "utf8"));
  for (const [name, value] of Object.entries(config)) if (name.startsWith("QWEN_")) process.env[name] = value;
}
Object.assign(process.env, {
  HOST: "127.0.0.1", PORT: process.env.KICON_SERVICE_PORT || "3210",
  CONFIG_ENV_FILE: configFile,
  DISPLAY_SETTINGS_FILE: join(dir, "display.json"), RECORDINGS_DIR: join(dir, "recordings"),
});
import("../server/index.js").catch(() => {
  process.parentPort.postMessage({ type: "startup-error" });
  process.exitCode = 1;
});
