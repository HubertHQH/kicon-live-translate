const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const path = require("node:path");

const port = Number(process.env.PORT || 3210);
const origin = `http://localhost:${port}`;
let window;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (!window || window.isDestroyed()) return;
    // Re-running the launcher should also pick up updated caption styles.
    window.webContents.reload();
    window.show();
    window.focus();
  });
  app.whenReady().then(async () => {
    try {
      const response = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error("服务不可用");
    } catch {
      dialog.showErrorBox("字幕服务未启动", "请先双击 start.cmd 启动同传项目，再打开桌面透明字幕。");
      app.quit();
      return;
    }
    const work = screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({
      title: "KiCon · 桌面透明字幕",
      width: Math.min(1000, work.width), height: 280,
      x: work.x + Math.max(0, Math.round((work.width - 1000) / 2)),
      y: work.y + Math.max(0, work.height - 320),
      transparent: true, backgroundColor: "#00000000", frame: false,
      // Native resize can disable transparency on Windows. Use our resize grip.
      resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, hasShadow: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const authorized = (event) => !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && event.senderFrame.url === `${origin}/screen`;
    ipcMain.on("caption:close", (event) => { if (authorized(event)) window.close(); });
    ipcMain.on("caption:resize", (event, width, height) => {
      if (!authorized(event) || !Number.isFinite(width) || !Number.isFinite(height)) return;
      const bounds = window.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      window.setBounds({ ...bounds,
        width: Math.round(Math.max(300, Math.min(area.width, width))),
        height: Math.round(Math.max(100, Math.min(area.height, height))),
      });
    });
    try {
      await window.loadURL(`${origin}/screen`);
      if (process.argv.includes("--verify-window")) {
        window.showInactive();
        window.setAlwaysOnTop(true);
        const background = window.getBackgroundColor();
        console.log(JSON.stringify({ alwaysOnTop: window.isAlwaysOnTop(), background }));
        // getBackgroundColor() returns RGB only; it cannot verify alpha.
        if (!window.isAlwaysOnTop() || background !== "#000000") throw Error("Window configuration failed");
        console.log("Caption window: renderer loaded and always-on-top verified; transparency configured.");
        app.quit();
      } else window.show();
    } catch (error) {
      console.error(error.message);
      app.exit(1);
    }
  });
}
app.on("window-all-closed", () => app.quit());
