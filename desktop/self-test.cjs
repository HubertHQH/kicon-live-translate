// Offline diagnostics used by test:package. Runs only with an explicit test profile.
const assert = require("node:assert/strict");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
module.exports = async ({ controller, getOverlay, origin, dataDir }) => {
  const run = (code) => controller.webContents.executeJavaScript(code);
  const waitFor = async (fn, label, timeout = 12000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); }
    throw Error(`Timed out: ${label}`);
  };
  await waitFor(() => run("!document.getElementById('demo').disabled"), "controller connection");
  const previous = existsSync(path.join(dataDir, "config.env"));
  const config = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(config.configured, previous, "No personal key should be bundled; test configuration should survive restart");
  assert.equal(config.key, undefined);
  if (previous) {
    assert.equal(await run("document.getElementById('font-size').value"), "67");
    assert.equal(await run("document.getElementById('floating-opacity').value"), "100");
  } else {
    const saved = await run(`(async () => {
      const c = await (await fetch('/api/config')).json();
      const response = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kicon-Token': c.token },
        body: JSON.stringify({ baseURL: c.baseURL, realtimeURL: c.realtimeURL, model: c.model, key: 'packaging-self-test' }) });
      return response.ok;
    })()`);
    assert.equal(saved, true, "Save configuration outside the installation directory");
    await run(`(() => {
      for (const [id, value] of [['font-size', '67'], ['floating-opacity', '100'], ['floating-zh-color', '#abcdef']]) {
        const field = document.getElementById(id); field.value = value; field.dispatchEvent(new Event('input'));
      }
    })()`);
    await waitFor(() => {
      try { const d = JSON.parse(readFileSync(path.join(dataDir, "display.json"))); return d.fontSize === 67 && d.floatingOpacity === 0 && d.floatingZhColor === "#abcdef"; }
      catch { return false; }
    }, "display persistence");
  }
  await run("document.getElementById('open-desktop').click()");
  await waitFor(() => !!getOverlay(), "desktop overlay launch via HTTP/IPC");
  const overlay = getOverlay();
  await waitFor(() => overlay.webContents.executeJavaScript("document.body.classList.contains('native-overlay') && getComputedStyle(document.querySelector('.floating-stage')).backgroundColor.endsWith(', 0)')"), "transparent overlay styles");
  assert.equal(overlay.isAlwaysOnTop(), true);
  if (previous) {
    const saved = JSON.parse(readFileSync(path.join(dataDir, "desktop-window.json")));
    assert.equal(overlay.getBounds().width, saved.width);
    assert.equal(overlay.getBounds().height, saved.height);
  }
  overlay.setBounds({ ...overlay.getBounds(), width: 780, height: 220 });
  await run("document.getElementById('demo').click()");
  await waitFor(() => run("document.getElementById('status').textContent === '演示模式'"), "new demo started");
  await waitFor(() => run("document.getElementById('transcript').querySelectorAll('.transcript-row').length >= 2"), "streaming demo", 16000);
  const rows = await run("document.getElementById('transcript').innerText");
  assert.match(rows, /KiCon/);
  const font = await overlay.webContents.executeJavaScript("getComputedStyle(document.querySelector('.floating-stage .caption-text p')).fontSize");
  assert.equal(font, "67px");
  writeFileSync(path.join(dataDir, "controller.png"), (await controller.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  writeFileSync(path.join(dataDir, "overlay.png"), (await overlay.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await run("document.getElementById('open-screen').click()");
  await waitFor(() => require("electron").BrowserWindow.getAllWindows().some((w) => w !== overlay && w !== controller && w.webContents.getURL() === `${origin}/screen`), "projector window");
  const audioWorklet = await run(`(async () => { const c = new AudioContext({ sampleRate: 16000 }); await c.audioWorklet.addModule('/pcm-worklet.js'); await c.close(); return true; })()`);
  assert.equal(audioWorklet, true);
  await run("document.getElementById('start').click()");
  await waitFor(() => run("document.getElementById('status').textContent === '已停止' && !document.getElementById('demo').disabled"), "stop demo");
  overlay.close();
  return { restart: previous, packaged: require("electron").app.isPackaged, runtime: process.versions.electron,
    node: process.versions.node, checks: ["standalone service", "no bundled API key", "config save/reload", "display save/reload", "desktop overlay API", "transparent background", "67px font", "always on top", "window size save/reload", "streaming demo", "projector window", "audio worklet", "clean shutdown"] };
};
