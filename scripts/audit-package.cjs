const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");
const { parseEnv } = require("node:util");
const root = path.resolve(__dirname, "..");
const archive = path.join(root, "release/win-unpacked/resources/app.asar");
const files = asar.listPackage(archive).map((p) => p.replaceAll("\\", "/").replace(/^\//, ""));
for (const file of files) {
  assert(!/(^|\/)(\.env[^/]*|\.local|recordings|artifacts|test|\.git)(\/|$)/.test(file), `Private/development file in package: ${file}`);
  if (file.startsWith("node_modules/")) assert(file === "node_modules/ws" || file.startsWith("node_modules/ws/"), `Unexpected dependency: ${file}`);
}
for (const file of ["desktop/application.cjs", "desktop/service.cjs", "desktop/preload.cjs", "server/index.js", "public/index.html", "public/pcm-worklet.js", "node_modules/ws/index.js"])
  assert(files.includes(file), `Missing runtime component: ${file}`);
const appPackage = JSON.parse(asar.extractFile(archive, "package.json"));
assert.equal(appPackage.main, "desktop/application.cjs");
assert.equal(appPackage.devDependencies, undefined, "Development dependencies should be removed from packaged metadata");
if (fs.existsSync(path.join(root, ".env"))) {
  const key = parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8")).QWEN_API_KEY;
  if (key && key !== "replace_with_your_key") assert(!fs.readFileSync(archive).includes(Buffer.from(key)), "Personal API key must not appear in the archive");
}
console.log(`PASS: package allowlist (${files.length} entries), bundled runtime modules, production-only dependencies, personal key excluded.`);
