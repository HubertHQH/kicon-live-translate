import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";

const wait = (ws, predicate) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(Error("Event timeout"));
    }, 10000);
    const handler = (raw) => {
      const m = JSON.parse(raw);
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(m);
      }
    };
    ws.on("message", handler);
  });
test("full relay handles source text, viewer permissions, owner lock, freeze recovery, complete export and upstream failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-server-"));
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const mock = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(mock, "listening");
  let failNext = false,
    sessions = 0;
  const detections = [];
  mock.on("connection", (ws) => {
    let target,
      emitted = false;
    ws.on("message", (raw) => {
      const e = JSON.parse(raw);
      if (e.type === "session.update") {
        sessions++;
        detections.push(e.session.audio.input.turn_detection);
        target = e.session.translation.language;
        if (failNext)
          return ws.send(
            JSON.stringify({
              type: "error",
              error: { message: "test upstream failure" },
            }),
          );
        ws.send(
          JSON.stringify({ type: "session.updated", session: e.session }),
        );
      }
      if (e.type === "input_audio_buffer.append" && !emitted) {
        emitted = true;
        for (const event of [
          { type: "response.text.delta", item_id: "out", delta: target === "en" ? "Test" : "测试" },
          {
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "src",
            transcript: "测试原文",
            language: "zh",
          },
          {
            type: "response.text.done",
            item_id: "out",
            text: target === "en" ? "Test source" : "测试译文",
          },
          {
            type: "response.done",
            response: {
              id: "same-id",
              status: "completed",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_tokens_details: { audio_tokens: 100 },
                output_tokens_details: { text_tokens: 20 },
              },
            },
          },
          {
            type: "response.done",
            response: {
              id: "same-id",
              status: "completed",
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_tokens_details: { audio_tokens: 100 },
                output_tokens_details: { text_tokens: 20 },
              },
            },
          },
        ])
          ws.send(JSON.stringify(event));
      }
      if (e.type === "session.finish")
        ws.send(JSON.stringify({ type: "session.finished" }));
    });
    ws.on("error", () => {});
  });
  const child = spawn(process.execPath, ["server/index.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      RECORDINGS_DIR: dir,
      CONFIG_ENV_FILE: join(dir, ".env"),
      DISPLAY_SETTINGS_FILE: join(dir, "display.json"),
      QWEN_API_KEY: "test-secret",
      QWEN_REALTIME_URL: `ws://127.0.0.1:${mock.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const sockets = [];
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw Error("Server failed to start");
      }),
    ]);
    const origin = `http://127.0.0.1:${port}`;
    const config = await fetch(origin + "/api/config").then((r) => r.json());
    assert.ok(!JSON.stringify(config).includes("test-secret"));
    assert.equal((await fetch(origin + "/.env")).status, 404);
    assert.equal(config.baseURL, "https://maas.qianwenaiapi.com/compatible-mode/v1");
    for (const route of ["/api/config", "/api/overlay"]) {
      assert.equal((await fetch(origin + route, { method: "POST" })).status, 403);
      assert.equal((await fetch(origin + route, { method: "POST", headers: { origin: "https://untrusted.example", "x-kicon-token": config.token } })).status, 403);
    }
    const postConfig = (data) => fetch(origin + "/api/config", { method: "POST", headers: {
      origin, "x-kicon-token": config.token, "content-type": "application/json",
    }, body: JSON.stringify(data) });
    async function connect(role) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws?role=${role}&token=${config.token}`,
        { origin },
      );
      sockets.push(ws);
      const initial = wait(ws, (m) => m.type === "state");
      await once(ws, "open");
      await initial;
      return ws;
    }
    const controller = await connect("control"),
      viewer = await connect("viewer"),
      rival = await connect("control");
    const appearance = wait(viewer, (m) => m.state?.display.floatingOpacity === 0);
    controller.send(JSON.stringify({ type: "display", display: {
      floatingZhColor: "#ff8800", floatingEnColor: "#00aaff", floatingBackground: "#123456", floatingOpacity: -20,
    } }));
    const appearanceState = (await appearance).state.display;
    assert.equal(appearanceState.floatingZhColor, "#ff8800");
    assert.equal(appearanceState.floatingEnColor, "#00aaff");
    const invalid = wait(viewer, (m) => m.state?.display.floatingOpacity === 100);
    controller.send(JSON.stringify({ type: "display", display: {
      floatingZhColor: "url(https://invalid)", floatingEnColor: null, floatingOpacity: 200,
    } }));
    const sanitized = (await invalid).state.display;
    assert.equal(sanitized.floatingZhColor, "#ff8800");
    assert.equal(sanitized.floatingEnColor, undefined);
    viewer.send(JSON.stringify({ type: "start", mode: "auto" }));
    const live = wait(viewer, (m) => m.state?.status === "live");
    controller.send(JSON.stringify({ type: "start", mode: "auto", terms: [] }));
    await live;
    assert.equal((await postConfig({})).status, 409, "running sessions cannot change configuration");
    assert.equal(sessions, 2);
    assert.deepEqual(detections.map(d => d.silence_duration_ms), [300, 300]);
    const rejection = wait(rival, (m) => m.type === "error");
    rival.send(JSON.stringify({ type: "start", mode: "auto" }));
    assert.match((await rejection).message, /已有/);
    const row = wait(
      viewer,
      (m) => m.row?.language === "zh" && m.row?.kind === "translation",
    );
    const partial = wait(viewer, m => m.row?.kind === "translation" && m.row.language === "en" && !m.row.final);
    const usageUpdate = wait(
      viewer,
      (m) => m.type === "usage" && m.usage.totalTokens === 240,
    );
    controller.send(Buffer.alloc(3200));
    assert.equal((await partial).row.text, "Test", "relay must forward partial text before completion");
    await row;
    const totals = (await usageUpdate).usage;
    assert.equal(totals.estimatedCost, 0.012);
    const frozen = wait(viewer, (m) => m.state?.display.frozen);
    controller.send(
      JSON.stringify({ type: "display", display: { frozen: true } }),
    );
    const snapshot = (await frozen).state;
    assert.equal(snapshot.frozenRows.length, 3);
    const reconnect = new WebSocket(
      `ws://127.0.0.1:${port}/ws?role=viewer&token=${config.token}`,
      { origin },
    );
    sockets.push(reconnect);
    const restored = (await wait(reconnect, (m) => m.type === "state")).state;
    assert.deepEqual(restored.frozenRows, snapshot.frozenRows);
    assert.deepEqual(restored.display, snapshot.display, "new desktop and browser viewers receive identical display settings");
    assert.equal(restored.usage.totalTokens, 240);
    const exportResult = await fetch(
      `${origin}/api/export/${snapshot.sessionId}.txt`,
    ).then((r) => r.text());
    assert.match(exportResult, /Test source/);
    assert.match(exportResult, /测试原文/);
    assert.match(exportResult, /Token 合计：240/);
    assert.match(
      await fetch(`${origin}/api/export/${snapshot.sessionId}.zh.srt`).then(
        (r) => r.text(),
      ),
      /测试译文/,
    );
    const stopped = wait(viewer, (m) => m.state?.status === "stopped");
    controller.send(JSON.stringify({ type: "stop" }));
    await stopped;
    const blanked = wait(viewer, (m) => m.state?.display.blank);
    controller.send(JSON.stringify({ type: "display", display: { blank: true } }));
    await blanked;
    const demoState = wait(viewer, (m) => m.state?.status === "demo");
    const firstComplete = wait(viewer, (m) => m.row?.id.endsWith(":demo:0:en") && m.row.final);
    const nextSentence = wait(viewer, (m) => m.row?.id.endsWith(":demo:1:zh"));
    controller.send(JSON.stringify({ type: "demo", mode: "auto", terms: [] }));
    const freshDemo = (await demoState).state;
    assert.equal(freshDemo.display.frozen, false);
    assert.equal(freshDemo.display.blank, false);
    assert.equal(freshDemo.frozenRows, null);
    assert.equal(freshDemo.display.floatingZhColor, "#ff8800");
    assert.match((await firstComplete).row.text, /open-source hardware/);
    assert.ok((await nextSentence).row.text);
    const demoStopped = wait(viewer, (m) => m.state?.status === "stopped");
    controller.send(JSON.stringify({ type: "stop" }));
    await demoStopped;
    failNext = true;
    const failed = wait(viewer, (m) => m.state?.status === "error");
    controller.send(JSON.stringify({ type: "start", mode: "en-zh", responsiveness: "balanced" }));
    assert.match((await failed).state.error, /test upstream failure/);
    assert.equal(detections.at(-1).silence_duration_ms, 600);
    assert.equal((await postConfig({ baseURL: "javascript:alert(1)", model: "test" })).status, 400);
    const replacement = { baseURL: "https://example.com/compatible-mode/v1", model: "new-model", key: "replacement-test-key" };
    const savedConfig = wait(viewer, (m) => m.type === "config");
    const response = await postConfig(replacement);
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.realtimeURL, "wss://example.com/api-ws/v1/realtime");
    assert.equal(saved.configured, true);
    assert.ok(!JSON.stringify(saved).includes("replacement-test-key"));
    assert.equal((await savedConfig).config.model, "new-model");
    assert.ok(!(await fetch(origin + "/api/config").then((r) => r.text())).includes("replacement-test-key"));
  } finally {
    sockets.forEach((ws) => ws.terminate());
    const exited = once(child, "exit");
    child.kill();
    await exited;
    mock.clients.forEach((ws) => ws.terminate());
    await new Promise((r) => mock.close(r));
    await rm(dir, { recursive: true });
  }
});
