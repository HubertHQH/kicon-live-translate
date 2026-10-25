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
assert.equal(appPackage.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version, "Stale package version");
assert.equal(appPackage.main, "desktop/application.cjs");
assert.equal(appPackage.devDependencies, undefined, "Development dependencies should be removed from packaged metadata");
for (const file of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) assert(fs.existsSync(path.join(root, "release/win-unpacked", file)), `Missing runtime license: ${file}`);
assert(files.includes("node_modules/ws/LICENSE"), "Missing ws license");
const archiveBytes = fs.readFileSync(archive);
assert(!/\bsk-[A-Za-z0-9_-]{16,}\b/.test(archiveBytes.toString("utf8")), "Credential-like value in packaged content");
for (const file of files) {
  if (!/^(desktop|server|public)\//.test(file)) continue;
  const source = path.join(root, file);
  if (fs.existsSync(source) && fs.statSync(source).isFile())
    assert(asar.extractFile(archive, file).equals(fs.readFileSync(source)), `Stale packaged source: ${file}`);
}
assert(fs.readFileSync(path.join(root, "release/win-unpacked/resources/安装与迁移说明.txt")).equals(
  fs.readFileSync(path.join(root, "docs/安装与迁移说明.txt"))), "Installed guide differs from the delivery guide");
if (fs.existsSync(path.join(root, ".env"))) {
  const key = parseEnv(fs.readFileSync(path.join(root, ".env"), "utf8")).QWEN_API_KEY;
  if (key && key !== "replace_with_your_key") assert(!fs.readFileSync(archive).includes(Buffer.from(key)), "Personal API key must not appear in the archive");
}
console.log(`PASS: package allowlist (${files.length} entries), bundled runtime modules, production-only dependencies, personal key excluded.`);
