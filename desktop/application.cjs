const { app, BrowserWindow, Menu, dialog, shell, utilityProcess, desktopCapturer } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createOverlayWindow } = require("./overlay-window.cjs");

const smoke = process.argv.includes("--smoke-test") && !!process.env.KICON_SMOKE_DIR;
app.setName("KiCon Live Translate");
app.setPath("userData", smoke ? path.resolve(process.env.KICON_SMOKE_DIR) : path.join(app.getPath("appData"), "KiConLiveTranslate"));
const dataDir = app.getPath("userData");
mkdirSync(dataDir, { recursive: true });
let controller, overlay, openingOverlay, service, origin, stopping = false, stopped = false;
const reveal = (win) => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } };
const fail = (message) => {
  if (smoke) writeFileSync(path.join(dataDir, "smoke-result.json"), JSON.stringify({ ok: false, message }));
  else dialog.showErrorBox("KiCon 同传无法启动", message);
  process.exitCode = 1;
  app.quit();
};

async function openOverlay() {
  if (overlay && !overlay.isDestroyed()) { if (!smoke) reveal(overlay); return overlay; }
  return openingOverlay ||= createOverlayWindow(origin, path.join(dataDir, "desktop-window.json"), { hidden: smoke })
    .then((win) => { overlay = win; return win; }).finally(() => { openingOverlay = null; });
}

function createController() {
  controller = new BrowserWindow({
    title: "KiCon Asia · 实时同传", width: 1440, height: 940, minWidth: 1000, minHeight: 680,
    show: false, backgroundColor: "#fafbf6", autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const ownController = (contents) => !controller.isDestroyed() && contents === controller.webContents
    && contents.getURL().startsWith(`${origin}/`);
  const ses = controller.webContents.session;
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    ownController(contents) && requestingOrigin === origin && ["media", "display-capture"].includes(permission)
    && (permission !== "media" || details.mediaType !== "video"));
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = ownController(contents) && details.isMainFrame !== false
      && ["media", "display-capture"].includes(permission)
      && (permission !== "media" || !(details.mediaTypes || []).includes("video"));
    callback(allowed);
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.securityOrigin !== origin || request.frame !== controller.webContents.mainFrame) return callback(null);
    try {
      const choice = await dialog.showMessageBox(controller, { type: "question", title: "采集电脑声音",
        message: "开始采集这台电脑正在播放的声音？", detail: "其他应用的声音也会进入同传。屏幕画面不会上传或保存。",
        buttons: ["开始采集", "取消"], defaultId: 0, cancelId: 1 });
      if (choice.response !== 0) return callback(null);
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      if (!sources[0]) return callback(null);
      callback({ video: sources[0], audio: "loopback" });
    } catch { callback(null); }
  });
  controller.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  controller.webContents.setWindowOpenHandler(({ url }) => {
    if (url === `${origin}/screen` || url === "about:blank") return { action: "allow", overrideBrowserWindowOptions: {
      autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    } };
    return { action: "deny" };
  });
  controller.on("closed", () => { app.quit(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "KiCon 同传", submenu: [
      { label: "配置", click: () => { controller.webContents.executeJavaScript("location.hash = '#settings'"); } },
      { label: "桌面字幕", click: () => { openOverlay().catch(() => dialog.showErrorBox("无法打开字幕", "请关闭程序后重试。")); } },
      { label: "打开本机数据文件夹", click: () => { shell.openPath(dataDir); } },
      { id: "user-guide", label: "使用说明", click: async () => {
        const guide = app.isPackaged ? path.join(process.resourcesPath, "安装与迁移说明.txt") : path.join(__dirname, "../docs/安装与迁移说明.txt");
        const error = await shell.openPath(guide);
        if (error) dialog.showErrorBox("无法打开使用说明", "请阅读交付压缩包中的安装与使用说明。");
      } },
      { id: "about-kicon", label: "关于", click: () => { dialog.showMessageBox(controller, {
        type: "info", title: "关于 KiCon 实时同传", message: `KiCon Live Translate ${app.getVersion()}`,
        detail: "Windows x64 · 中英实时字幕\n实时翻译需要联网和使用者自己的 API Key。\n使用说明和本机数据文件夹可从此菜单打开。", buttons: ["确定"],
      }); } },
      { type: "separator" }, { label: "退出", role: "quit" },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
  ]));
  return controller;
}

async function start() {
  let preferred = 3210;
  try {
    const saved = JSON.parse(readFileSync(path.join(dataDir, "service-port.json"), "utf8"));
    if (Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) preferred = saved.port;
  } catch {}
  const env = { ...process.env, KICON_DATA_DIR: dataDir, KICON_SERVICE_PORT: String(preferred) };
  for (const name of Object.keys(env)) if (name.startsWith("QWEN_") || ["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"].includes(name)) delete env[name];
  service = utilityProcess.fork(path.join(__dirname, "service.cjs"), [], {
    cwd: dataDir, env, stdio: "ignore", serviceName: "KiCon subtitle service",
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("本地服务启动超时。请关闭程序后重试。")), 20000);
    service.on("message", async (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        origin = `http://localhost:${message.port}`;
        writeFileSync(path.join(dataDir, "service-port.json"), JSON.stringify({ port: message.port }));
        resolve();
      } else if (message?.type === "startup-error") {
        clearTimeout(timer); reject(Error("本地服务启动失败。请检查数据文件夹是否可写。"));
      } else if (message?.type === "open-overlay") {
        let error = false;
        try { await openOverlay(); } catch { error = true; }
        service.postMessage({ type: "overlay-result", id: message.id, error });
      } else if (message?.type === "stopped") {
        service.kill(); stopped = true; app.quit();
      }
    });
    service.on("exit", () => {
      clearTimeout(timer);
      if (!stopping) { reject(Error("本地服务意外退出。")); if (controller) fail("本地服务意外退出，请重新启动程序。"); }
    });
  });
  const win = createController();
  await win.loadURL(origin);
  if (!smoke) win.show();
  else {
    try {
      const result = await require("./self-test.cjs")({ controller: win, getOverlay: () => overlay, origin, dataDir });
      writeFileSync(path.join(dataDir, "smoke-result.json"), JSON.stringify({ ok: true, ...result }, null, 2));
      app.quit();
    } catch (error) { fail(error.message); }
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => reveal(controller));
  app.whenReady().then(start).catch((error) => fail(error.message));
}
app.on("before-quit", (event) => {
  if (!service || stopped) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  service.postMessage({ type: "shutdown" });
  setTimeout(() => { service.kill(); stopped = true; app.quit(); }, 4000).unref();
});
app.on("will-quit", () => service?.kill());
