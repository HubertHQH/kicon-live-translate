const { spawn } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.QWEN_API_KEY;
const child = spawn(require("electron"), [path.join(__dirname, "main.cjs"), ...process.argv.slice(2)], {
  env, stdio: "inherit", windowsHide: true,
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
