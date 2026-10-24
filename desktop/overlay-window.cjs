const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const { readBounds, fitBounds, writeBounds } = require("./window-preferences.cjs");

async function createOverlayWindow(origin, boundsFile, { hidden = false, save = true } = {}) {
  const saved = readBounds(boundsFile);
  const area = (saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()).workArea;
  const win = new BrowserWindow({
    title: "KiCon · 桌面透明字幕", ...fitBounds(saved, area),
    transparent: true, backgroundColor: "#00000000", frame: false,
    resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      // Separate permissions from the controller, which needs microphone access.
      partition: "caption-overlay", contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false,
    },
  });
  let timer;
  const saveBounds = () => {
    clearTimeout(timer);
    if (!save || win.isDestroyed()) return;
    try { writeBounds(boundsFile, win.getBounds()); }
    catch { console.error("桌面字幕窗口位置和大小无法保存。"); }
  };
  const scheduleSave = () => { clearTimeout(timer); timer = setTimeout(saveBounds, 150); };
  win.on("move", scheduleSave);
  win.on("resize", scheduleSave);
  win.on("close", saveBounds);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_c, _p, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  const authorized = (event) => !win.isDestroyed() && event.sender === win.webContents
    && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === `${origin}/screen`;
  const close = (event) => { if (authorized(event)) win.close(); };
  const resize = (event, width, height) => {
    if (!authorized(event) || !Number.isFinite(width) || !Number.isFinite(height)) return;
    const bounds = win.getBounds(), work = screen.getDisplayMatching(bounds).workArea;
    win.setBounds({ ...bounds,
      width: Math.round(Math.max(300, Math.min(work.width, width))),
      height: Math.round(Math.max(100, Math.min(work.height, height))),
    });
  };
  ipcMain.on("caption:close", close);
  ipcMain.on("caption:resize", resize);
  win.on("closed", () => {
    clearTimeout(timer);
    ipcMain.removeListener("caption:close", close);
    ipcMain.removeListener("caption:resize", resize);
  });
  try { await win.loadURL(`${origin}/screen`); }
  catch (error) { win.destroy(); throw error; }
  // Apply again after native window creation to avoid Windows DPI/frame rounding.
  win.setBounds(fitBounds(saved, area));
  if (!hidden) win.show();
  return win;
}
module.exports = { createOverlayWindow };
