// Source checkout entry point; the installer uses application.cjs instead.
const { app, dialog } = require("electron");
const path = require("node:path");
const { createOverlayWindow } = require("./overlay-window.cjs");
const origin = `http://localhost:${Number(process.env.PORT || 3210)}`;
let window;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    window.webContents.reload(); window.show(); window.focus();
  });
  app.whenReady().then(async () => {
    try {
      const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error("服务不可用");
    } catch {
      dialog.showErrorBox("字幕服务未启动", "请先双击 start.cmd 启动同传项目，再打开桌面透明字幕。");
      app.quit(); return;
    }
    try {
      const verify = process.argv.includes("--verify-window");
      window = await createOverlayWindow(origin, path.join(__dirname, "../.local/desktop-window.json"), { hidden: verify, save: !verify });
      if (verify) {
        window.showInactive();
        const background = window.getBackgroundColor();
        console.log(JSON.stringify({ alwaysOnTop: window.isAlwaysOnTop(), background }));
        if (!window.isAlwaysOnTop() || background !== "#000000") throw Error("Window configuration failed");
        console.log("Caption window: renderer loaded and always-on-top verified; transparency configured.");
        app.quit();
      }
    } catch (error) { console.error(error.message); app.exit(1); }
  });
}
app.on("window-all-closed", () => app.quit());
