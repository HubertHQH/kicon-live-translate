import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { languageRows, sessionTiming } from "../public/display.js";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "");

async function setup(t, { supported = true, reject = false, native = false } = {}) {
  const dom = new JSDOM(html, { url: `http://localhost:3210/${native ? "screen" : ""}`, runScripts: "outside-only" });
  const w = dom.window, frames = [], sent = [], windows = [], requestedSizes = [];
  let socket, requests = 0;
  Object.assign(w, {
    languageRows, sessionTiming, structuredClone,
    requestAnimationFrame: (cb) => frames.push(cb),
    fetch: async () => ({ ok: true, json: async () => ({ model: "test", token: "test", baseURL: "https://example.com/v1", realtimeURL: "wss://example.com/api-ws/v1/realtime", configured: true }) }),
    WebSocket: class extends w.EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor() { super(); socket = this; }
      send(data) { sent.push(JSON.parse(data)); }
      close() {}
    },
  });
  if (native) w.kiconDesktop = { isOverlay: true, close: () => sent.push({ native: "close" }), resize: (width, height) => sent.push({ native: "resize", width, height }) };
  if (supported) w.documentPictureInPicture = {
    async requestWindow(options) {
      requestedSizes.push(options);
      requests++;
      if (reject) throw Error("browser denied PiP");
      const pip = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
        url: "http://localhost:3210/",
      });
      const nativeClose = pip.window.close.bind(pip.window);
      pip.window.innerWidth = options.width;
      pip.window.innerHeight = options.height;
      pip.window.closed = false;
      pip.window.close = () => {
        if (pip.window.closed) return;
        pip.window.closed = true;
        pip.window.dispatchEvent(new pip.window.Event("pagehide"));
        nativeClose();
      };
      windows.push(pip.window);
      return pip.window;
    },
  };
  t.after(() => { windows.forEach((p) => p.close()); w.close(); });
  runInContext(app, dom.getInternalVMContext());
  await new Promise(setImmediate);
  socket.dispatchEvent(new w.Event("open"));
  const state = {
    status: "live", rows: [], mode: "zh-en", startedAt: Date.now(),
    display: { mode: "bilingual", fontSize: 44, lines: 3, theme: "dark" },
  };
  const receive = (msg) => socket.dispatchEvent(new w.MessageEvent("message", { data: JSON.stringify(msg) }));
  receive({ type: "state", state });
  while (frames.length) frames.shift()();
  return { w, windows, sent, frames, state, receive, requestedSizes, requests: () => requests,
    open: () => w.document.getElementById("open-floating").onclick() };
}

test("floating captions update while controller animation frames are suspended; controls, freeze and blank stay in sync", async (t) => {
  const f = await setup(t);
  await f.open();
  const pip = f.windows[0], doc = pip.document;
  assert.equal(f.w.document.getElementById("open-floating").getAttribute("aria-pressed"), "true");
  const row = { id: "zh1", kind: "source", language: "zh", text: "后台持续更新", final: true };
  f.receive({ type: "row", row });
  assert.match(doc.querySelector('[data-lane="zh"]').textContent, /后台持续更新/);
  assert.equal(f.frames.length, 0, "visible PiP does not depend on hidden controller frames");
  doc.querySelector("select").value = "en";
  doc.querySelector("select").dispatchEvent(new pip.Event("change"));
  assert.deepEqual(f.sent.at(-1), { type: "display", display: { mode: "en" } });
  f.state.rows = [row];
  f.state.display.mode = "en";
  f.receive({ type: "state", state: f.state });
  assert.equal(doc.querySelector('[data-lane="zh"]').hidden, true);
  assert.equal(doc.querySelector('[data-lane="en"]').hidden, false);
  doc.querySelector('[data-action="larger"]').click();
  assert.deepEqual(f.sent.at(-1), { type: "display", display: { fontSize: 48 } });
  f.state.display = { ...f.state.display, mode: "bilingual", frozen: true };
  f.state.frozenRows = [row];
  f.receive({ type: "state", state: f.state });
  f.receive({ type: "row", row: { ...row, text: "冻结后新句" } });
  assert.match(doc.querySelector('[data-lane="zh"]').textContent, /后台持续更新/);
  assert.doesNotMatch(doc.querySelector('[data-lane="zh"]').textContent, /冻结后新句/);
  f.state.display.blank = true;
  f.receive({ type: "state", state: f.state });
  assert.equal(doc.getElementById("floating-stage").classList.contains("blank"), true);
  f.state.display = { ...f.state.display, blank: false, frozen: false, theme: "light" };
  f.state.rows = [{ ...row, text: "恢复更新" }];
  f.receive({ type: "state", state: f.state });
  assert.match(doc.querySelector('[data-lane="zh"]').textContent, /恢复更新/);
  assert.equal(doc.getElementById("floating-stage").dataset.theme, "light");
  doc.querySelector('[data-action="close"]').click();
  assert.equal(f.w.document.getElementById("open-floating").getAttribute("aria-pressed"), "false");
  assert.equal(f.sent.some((m) => m.type === "stop"), false, "closing captions must not stop translation");
  await f.open();
  assert.equal(f.requests(), 2);
  assert.match(f.windows[1].document.body.textContent, /恢复更新/);
});

test("physical line limit syncs across preview, PiP and desktop without dropping transcript text", async (t) => {
  for (const native of [false, true]) {
    const f = await setup(t, { native });
    if (!native) await f.open();
    const field = f.w.document.getElementById("caption-max-lines");
    field.value = "1";
    field.dispatchEvent(new f.w.Event("change"));
    assert.deepEqual(f.sent.at(-1), { type: "display", display: { maxLines: 1 } });
    f.state.display.maxLines = 1;
    const fullText = "长句必须保留完整记录，不因显示行数限制丢失。".repeat(20);
    f.state.rows = [{ id: "long", kind: "source", language: "zh", text: fullText, final: true }];
    f.receive({ type: "state", state: f.state });
    const stages = [f.w.document.getElementById(native ? "projection-stage" : "preview")];
    if (!native) stages.push(f.windows[0].document.getElementById("floating-stage"));
    for (const stage of stages) {
      assert.equal(stage.classList.contains("line-limited"), true);
      assert.equal(stage.style.getPropertyValue("--caption-max-lines"), "1");
      assert.equal(stage.querySelector('[data-lane="zh"] .caption-text p').textContent, fullText);
    }
    f.state.display.maxLines = 0;
    f.receive({ type: "state", state: f.state });
    for (const stage of stages) assert.equal(stage.classList.contains("line-limited"), false);
    assert.equal(f.w.document.querySelector("button[data-theme]"), null);
  }
});

test("unsupported or rejected PiP shows a useful message and leaves the controller usable", async (t) => {
  for (const options of [{ supported: false }, { reject: true }]) {
    const f = await setup(t, options);
    await f.open();
    assert.match(f.w.document.getElementById("notice").textContent, /Chrome \/ Edge/);
    assert.equal(f.w.document.getElementById("open-floating").disabled, false);
    assert.equal(f.w.document.getElementById("open-floating").getAttribute("aria-pressed"), "false");
    assert.equal(f.sent.length, 0);
  }
});

test("rapid repeated clicks create only one floating window", async (t) => {
  const f = await setup(t);
  await Promise.all([f.open(), f.open()]);
  assert.equal(f.requests(), 1);
});

test("PiP dimensions restore from local storage and resize/close updates them", async (t) => {
  const f = await setup(t);
  f.w.localStorage.setItem("kicon-floating-size", JSON.stringify({ width: 920, height: 410 }));
  await f.open();
  assert.equal(f.requestedSizes[0].width, 920);
  assert.equal(f.requestedSizes[0].height, 410);
  const pip = f.windows[0];
  pip.innerWidth = 1100;
  pip.innerHeight = 320;
  pip.dispatchEvent(new pip.Event("resize"));
  pip.close();
  await f.open();
  assert.equal(f.requestedSizes[1].width, 1100);
  assert.equal(f.requestedSizes[1].height, 320);
  f.windows[1].close();
  f.w.localStorage.setItem("kicon-floating-size", '{"width":-1,"height":999999}');
  await f.open();
  assert.equal(f.requestedSizes[2].width, 800);
  assert.equal(f.requestedSizes[2].height, 340);
});

test("floating colors update independently and browser PiP never claims desktop transparency", async (t) => {
  const f = await setup(t);
  await f.open();
  f.state.display = { ...f.state.display, floatingZhColor: "#ff8800", floatingEnColor: "#00aaff", floatingBackground: "#123456", floatingOpacity: 0 };
  f.receive({ type: "state", state: f.state });
  const doc = f.windows[0].document, stage = doc.getElementById("floating-stage");
  assert.equal(doc.querySelector(".floating-badge"), null);
  assert.equal(doc.querySelector(".language-label"), null);
  assert.equal(stage.style.getPropertyValue("--floating-zh"), "#ff8800");
  assert.equal(stage.style.getPropertyValue("--floating-en"), "#00aaff");
  assert.equal(stage.style.getPropertyValue("--floating-bg"), "rgba(18, 52, 86, 1)");
  assert.equal(f.w.document.getElementById("floating-color-sample").style.getPropertyValue("--floating-bg"), "rgba(18, 52, 86, 0)");
  const transparency = f.w.document.getElementById("floating-opacity");
  assert.equal(transparency.value, "100");
  assert.match(f.w.document.getElementById("floating-opacity-value").textContent, /100% · 全透明/);
  for (const [value, expected] of [["100", 0], ["40", 60], ["0", 100]]) {
    transparency.value = value;
    transparency.dispatchEvent(new f.w.Event("input"));
    assert.deepEqual(f.sent.at(-1), { type: "display", display: { floatingOpacity: expected } });
  }
  const input = f.w.document.getElementById("floating-en-color");
  input.value = "#abcdef";
  input.dispatchEvent(new f.w.Event("input"));
  assert.deepEqual(f.sent.at(-1), { type: "display", display: { floatingEnColor: "#abcdef" } });
  f.w.document.getElementById("floating-reset-colors").click();
  assert.deepEqual(f.sent.at(-1).display, { floatingZhColor: null, floatingEnColor: null, floatingBackground: null, floatingOpacity: 100 });
});

test("desktop renderer uses genuine alpha, keeps caption text intact and provides close/resize without stopping translation", async (t) => {
  const f = await setup(t, { native: true });
  f.state.display = { ...f.state.display, floatingBackground: "#123456", floatingOpacity: 0 };
  f.receive({ type: "state", state: f.state });
  while (f.frames.length) f.frames.shift()();
  const doc = f.w.document, stage = doc.getElementById("projection-stage");
  assert.equal(doc.documentElement.classList.contains("floating-root"), true);
  assert.equal(stage.querySelector(".language-label"), null);
  assert.equal(stage.style.getPropertyValue("--floating-bg"), "rgba(18, 52, 86, 0)");
  f.state.display.floatingOpacity = 40;
  f.state.rows = [{ id: "1", kind: "source", language: "zh", text: "透明字幕", final: true }];
  f.receive({ type: "state", state: f.state });
  while (f.frames.length) f.frames.shift()();
  assert.equal(stage.style.getPropertyValue("--floating-bg"), "rgba(18, 52, 86, 0.4)");
  assert.match(stage.textContent, /透明字幕/);
  doc.querySelector(".native-resize-grip").dispatchEvent(new f.w.KeyboardEvent("keydown", { key: "ArrowRight" }));
  assert.deepEqual(f.sent.at(-1), { native: "resize", width: f.w.innerWidth + 20, height: f.w.innerHeight });
  doc.querySelector(".native-drag-bar button").click();
  assert.equal(f.sent.at(-1).native, "close");
  assert.equal(f.sent.some((m) => m.type === "stop"), false);
});

test("settings navigation preserves capture, save clears entered key, desktop button uses authenticated local endpoint", async (t) => {
  const f = await setup(t), doc = f.w.document;
  f.w.location.hash = "#settings";
  f.w.dispatchEvent(new f.w.Event("hashchange"));
  assert.equal(doc.getElementById("settings-page").hidden, false);
  assert.equal(doc.getElementById("workspace-page").hidden, true);
  assert.equal(doc.getElementById("save-settings").disabled, true);
  assert.equal(f.sent.some((m) => m.type === "stop"), false);
  assert.equal(doc.getElementById("settings-base-url").value, "https://example.com/v1");
  assert.equal(doc.getElementById("settings-key").value, "");
  f.state.status = "stopped";
  f.receive({ type: "state", state: f.state });
  while (f.frames.length) f.frames.shift()();
  const requests = [];
  f.w.fetch = async (path, options) => {
    requests.push({ path, options });
    return { ok: true, json: async () => ({ token: "test", model: "new-model", baseURL: "https://other.example/v1", realtimeURL: "wss://other.example/api-ws/v1/realtime", configured: true, message: "已保存" }) };
  };
  doc.getElementById("settings-base-url").value = "https://other.example/v1";
  doc.getElementById("settings-base-url").dispatchEvent(new f.w.Event("change"));
  assert.equal(doc.getElementById("settings-realtime-url").value, "wss://other.example/api-ws/v1/realtime");
  doc.getElementById("settings-key").value = "new-test-key";
  await doc.getElementById("settings-form").onsubmit(new f.w.Event("submit"));
  assert.equal(requests[0].path, "/api/config");
  assert.equal(JSON.parse(requests[0].options.body).key, "new-test-key");
  assert.equal(requests[0].options.headers["X-Kicon-Token"], "test");
  assert.equal(doc.getElementById("settings-key").value, "");
  assert.equal(f.w.localStorage.getItem("new-test-key"), null);
  await doc.getElementById("open-desktop").onclick();
  assert.equal(requests[1].path, "/api/overlay");
  assert.equal(requests[1].options.headers["X-Kicon-Token"], "test");
  assert.equal(doc.getElementById("open-desktop").disabled, false);
});
