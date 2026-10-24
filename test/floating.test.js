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
  const w = dom.window, frames = [], sent = [], windows = [];
  let socket, requests = 0;
  Object.assign(w, {
    languageRows, sessionTiming, structuredClone,
    requestAnimationFrame: (cb) => frames.push(cb),
    fetch: async () => ({ ok: true, json: async () => ({ model: "test", token: "test" }) }),
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
    async requestWindow() {
      requests++;
      if (reject) throw Error("browser denied PiP");
      const pip = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
        url: "http://localhost:3210/",
      });
      const nativeClose = pip.window.close.bind(pip.window);
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
  return { w, windows, sent, frames, state, receive, requests: () => requests,
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
