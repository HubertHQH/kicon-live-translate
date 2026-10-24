// End-to-end local transport test. Does not consume Qwen tokens or microphone input.
import WebSocket from "ws";
import assert from "node:assert/strict";
const origin = "http://localhost:3210";
const config = await fetch(`${origin}/api/config`).then((r) => r.json());
assert.ok(!JSON.stringify(config).includes("sk-"));
assert.equal((await fetch(`${origin}/.env`)).status, 404);
assert.equal((await fetch(`${origin}/server/index.js`)).status, 404);
const connect = (role) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:3210/ws?token=${config.token}&role=${role}`,
      { origin },
    );
    ws.on("error", reject);
    ws.once("open", () => resolve(ws));
  });
const wait = (ws, predicate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(Error("Timeout waiting for state"));
    }, 5000);
    const onMessage = (raw) => {
      const m = JSON.parse(raw);
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(m);
      }
    };
    ws.on("message", onMessage);
  });
const controller = await connect("control"),
  viewer = await connect("viewer");
try {
  const row = wait(viewer, (m) => m.type === "row");
  controller.send(JSON.stringify({ type: "demo", mode: "auto", terms: [] }));
  assert.ok((await row).row.text);
  const changed = wait(
    viewer,
    (m) => m.type === "state" && m.state.display.mode === "en",
  );
  controller.send(
    JSON.stringify({ type: "display", display: { mode: "en", fontSize: 60 } }),
  );
  assert.equal((await changed).state.display.fontSize, 60);
  const ended = wait(
    viewer,
    (m) => m.type === "state" && m.state.status === "stopped",
  );
  controller.send(JSON.stringify({ type: "stop" }));
  await ended;
  controller.send(
    JSON.stringify({
      type: "display",
      display: { mode: "bilingual", fontSize: 44 },
    }),
  );
  const names = await fetch(`${origin}/api/recordings`).then((r) => r.json());
  assert.ok(names.length);
  console.log(
    "PASS: secret isolation, static file allowlist, demo streaming, projection broadcast, stop, archive list.",
  );
} finally {
  controller.close();
  viewer.close();
}
