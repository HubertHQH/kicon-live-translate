import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export function createOverlayLauncher(root, port) {
  let launching;
  return () => launching ||= (async () => {
    if (process.parentPort) {
      await new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const done = (error) => {
          clearTimeout(timer); process.parentPort.removeListener("message", onMessage);
          error ? reject(Error("无法打开桌面字幕，请重启程序后重试。")) : resolve();
        };
        const onMessage = ({ data }) => { if (data?.type === "overlay-result" && data.id === id) done(data.error); };
        const timer = setTimeout(() => done(true), 15000);
        process.parentPort.on("message", onMessage);
        process.parentPort.postMessage({ type: "open-overlay", id });
      });
      return;
    }
    if (process.platform !== "win32") throw Error("桌面字幕启动按钮目前支持 Windows。");
    try { await access(join(root, "node_modules/electron/dist/electron.exe")); }
    catch { throw Error("桌面组件尚未安装，请先运行项目中的 start-overlay.cmd 完成安装。"); }
    const env = { ...process.env, PORT: String(port) };
    delete env.QWEN_API_KEY;
    delete env.ELECTRON_RUN_AS_NODE;
    // Same entry point as start-overlay.cmd; no shell or user-supplied command.
    const child = spawn(process.execPath, [join(root, "desktop/launch.cjs")], {
      cwd: root, env, windowsHide: true, detached: true, stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 1200);
      child.once("error", () => { clearTimeout(timer); reject(Error("无法启动桌面字幕，请检查组件安装。")); });
      child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(Error("桌面字幕启动失败，请运行 start-overlay.cmd 查看详情。")); });
    });
    child.unref();
  })().finally(() => { launching = null; });
}
