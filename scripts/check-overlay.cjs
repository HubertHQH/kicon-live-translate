const path = require("node:path");
if (!process.versions.electron) {
  const { spawn } = require("node:child_process");
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const profile = mkdtempSync(path.join(tmpdir(), "kicon-overlay-test-"));
  const env = { ...process.env };
  env.KICON_TEST_PROFILE = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.QWEN_API_KEY;
  const child = spawn(require("electron"), [__filename], { env, stdio: "inherit", windowsHide: true });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
    if (path.dirname(profile) === path.resolve(tmpdir())) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  });
} else {
  const { app, BrowserWindow, ipcMain } = require("electron");
  app.setPath("userData", process.env.KICON_TEST_PROFILE);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 800, height: 280, show: false, transparent: true, frame: false, resizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, "../test/fixtures/overlay-preload.cjs") } });
    const timer = setTimeout(() => { console.error("Renderer test timed out"); app.exit(1); }, 15000);
    const reported = new Promise((resolve) => ipcMain.once("overlay-test:result", (event, result) => {
      if (event.sender === win.webContents) resolve(result);
    }));
    try {
      await win.loadFile(path.join(__dirname, "../test/fixtures/overlay-rendering.html"));
      const result = await reported;
      clearTimeout(timer);
      console.log(result.ok ? "PASS: fonts, transparency and colors; actual 1/2-line CJK/English/emoji wrapping retains latest text across preview/projector/floating sizes (Chromium)." : `FAIL: ${result.message}`);
      app.exit(result.ok ? 0 : 1);
    }
    catch (error) { console.error(error.message); app.exit(1); }
  });
}
