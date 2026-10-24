const { spawn } = require("node:child_process");
const { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const root = path.resolve(__dirname, "..");
const source = process.argv.includes("--source");
const installed = process.argv.find((arg) => arg.startsWith("--exe="))?.slice(6);
const exe = installed || (source ? require("electron") : path.join(root, "release/win-unpacked/KiCon Live Translate.exe"));
const profile = mkdtempSync(path.join(tmpdir(), "kicon-package-test-"));
const reports = [];
async function launch() {
  const env = { ...process.env, KICON_SMOKE_DIR: profile };
  for (const key of Object.keys(env)) {
    if (["path", "node_options", "node_path", "electron_run_as_node"].includes(key.toLowerCase()) || key.startsWith("QWEN_")) delete env[key];
  }
  // Only Windows system directories: a target machine with no Node/npm on PATH.
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  const child = spawn(exe, [...(source ? [path.join(root, "desktop/application.cjs")] : []), "--smoke-test"], { env, cwd: profile, windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error("Packaged app timed out")); }, 65000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Packaged app exit ${code}`)); });
  });
  const report = JSON.parse(readFileSync(path.join(profile, "smoke-result.json")));
  if (!report.ok) throw Error(report.message);
  if (!source && !report.packaged) throw Error("Test must use the packaged application");
  reports.push(report);
  console.log(`PASS: packaged app ${report.restart ? "restart" : "first launch"}; ${report.checks.join(", ")}`);
}
(async () => {
  if (!existsSync(exe)) throw Error("Run npm run pack:win first");
  await launch(); await launch();
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  writeFileSync(path.join(root, "artifacts/package-test.json"), JSON.stringify({ profile, reports }, null, 2));
})().catch((error) => {
  console.error(error.message);
  const report = path.join(profile, "smoke-result.json");
  if (existsSync(report)) console.error(readFileSync(report, "utf8"));
  console.error(`Diagnostic profile: ${profile}`); process.exitCode = 1;
});
