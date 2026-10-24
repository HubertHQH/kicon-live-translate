import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import WebSocket from "ws";
import { readDisplayPreferences, writeDisplayPreferences } from "../server/display-preferences.js";
import geometry from "../desktop/window-preferences.cjs";

test("display settings retain zero alpha and explicit colors, exclude temporary session flags, and recover from corrupt files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-preferences-")), file = join(dir, "prefs.json");
  try {
    assert.deepEqual(readDisplayPreferences(file), {});
    writeDisplayPreferences(file, { mode: "en", theme: "light", fontSize: 65, lines: 1, floatingZhColor: "#123456", floatingOpacity: 0, frozen: true, blank: true });
    assert.deepEqual(readDisplayPreferences(file), { mode: "en", theme: "light", fontSize: 65, lines: 1, floatingZhColor: "#123456", floatingOpacity: 0 });
    writeDisplayPreferences(file, { floatingZhColor: null, floatingOpacity: 100 });
    assert.deepEqual(readDisplayPreferences(file), { floatingOpacity: 100 });
    await writeFile(file, "{broken");
    assert.deepEqual(readDisplayPreferences(file), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("desktop bounds survive reopening and remain visible after monitor removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-bounds-")), file = join(dir, "bounds.json");
  try {
    const b = { x: -1700, y: 200, width: 820, height: 340 };
    geometry.writeBounds(file, b);
    assert.deepEqual(geometry.readBounds(file), b);
    assert.deepEqual(geometry.fitBounds(b, { x: -1920, y: 0, width: 1920, height: 1080 }), b);
    const visible = geometry.fitBounds(b, { x: 0, y: 0, width: 1280, height: 720 });
    assert.equal(visible.x, 0);
    const fitted = geometry.fitBounds({ x: 5000, y: 5000, width: 3000, height: 2000 }, { x: 0, y: 0, width: 1280, height: 720 });
    assert.deepEqual(fitted, { x: 0, y: 0, width: 1280, height: 720 });
    await writeFile(file, '{"width":0}');
    assert.equal(geometry.readBounds(file), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a restarted server broadcasts saved appearance with pause and blank cleared", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-restart-"));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let child;
  const stop = async () => { if (child) { const exited = once(child, "exit"); child.kill(); await exited; child = null; } };
  const start = async () => {
    child = spawn(process.execPath, ["server/index.js"], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RECORDINGS_DIR: dir, DISPLAY_SETTINGS_FILE: join(dir, "display.json") }, stdio: ["ignore", "pipe", "pipe"] });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw Error("server exited"); })]);
    const config = await fetch(`http://127.0.0.1:${port}/api/config`).then((r) => r.json());
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=control&token=${config.token}`, { origin: `http://127.0.0.1:${port}` });
    const initial = JSON.parse((await once(ws, "message"))[0]);
    return { ws, initial };
  };
  try {
    const first = await start();
    const changed = once(first.ws, "message");
    first.ws.send(JSON.stringify({ type: "display", display: { fontSize: 67, mode: "en", lines: 2, floatingOpacity: 0, floatingBackground: "#123456", frozen: true, blank: true } }));
    await changed;
    first.ws.terminate();
    await stop();
    const second = await start();
    const d = second.initial.state.display;
    assert.equal(d.fontSize, 67);
    assert.equal(d.mode, "en");
    assert.equal(d.lines, 2);
    assert.equal(d.floatingOpacity, 0);
    assert.equal(d.floatingBackground, "#123456");
    assert.equal(d.frozen, false);
    assert.equal(d.blank, false);
    second.ws.terminate();
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
