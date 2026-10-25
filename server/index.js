import { createServer } from "node:http";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { Transcript, sessionConfig, validateStart } from "./protocol.js";
import { readJournal } from "./archive.js";
import { UsageMeter, pricingFor } from "./usage.js";
import { exportText, exportSRT } from "../public/display.js";
import { validateSettings, saveSettings } from "./settings.js";
import { createOverlayLauncher } from "./overlay.js";
import { readDisplayPreferences, writeDisplayPreferences } from "./display-preferences.js";

const root = fileURLToPath(new URL("../", import.meta.url));
let port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
let model = process.env.QWEN_MODEL || "qwen3.8-livetranslate-flash-realtime";
let key = process.env.QWEN_API_KEY;
let baseURL = process.env.QWEN_BASE_URL || "https://maas.qianwenaiapi.com/compatible-mode/v1";
let pricing = pricingFor(model);
const usageMode = process.env.QWEN_USAGE_MODE || "per_response";
const token = randomBytes(32).toString("hex");
let realtimeURL =
  process.env.QWEN_REALTIME_URL ||
  "wss://maas.qianwenaiapi.com/api-ws/v1/realtime";
let configSaving = false;
const configPath = process.env.CONFIG_ENV_FILE || join(root, ".env");
const displayPath = process.env.DISPLAY_SETTINGS_FILE || join(root, ".local", "display.json");
const launchOverlay = createOverlayLauncher(root, port);
const publicConfig = () => ({ baseURL, model, realtimeURL, configured: !!key && key !== "replace_with_your_key", token });
const archiveDir = process.env.RECORDINGS_DIR || join(root, "recordings");
await mkdir(archiveDir, { recursive: true });
const files = new Map(
  [
    "/index.html",
    "/app.js",
    "/style.css",
    "/audio.js",
    "/pcm-worklet.js",
    "/resampler.js",
    "/display.js",
  ].map((p) => [p, join(root, "public", p)]),
);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const clients = new Set();
let owner = null,
  run = null;
let state = {
  status: "idle",
  mode: "auto",
  model,
  rows: [],
  startedAt: null,
  error: null,
  demo: false,
  usage: new UsageMeter(pricing, usageMode).snapshot(),
  display: {
    mode: "bilingual",
    fontSize: 44,
    theme: "dark",
    lines: 3,
    maxLines: 2,
    frozen: false,
    blank: false,
    ...readDisplayPreferences(displayPath),
  },
};
const send = (ws, data) => {
  if (ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 2e6) ws.terminate();
    else ws.send(JSON.stringify(data));
  }
};
const broadcast = (data) => clients.forEach((ws) => send(ws, data));
const update = (patch) => {
  Object.assign(state, patch);
  broadcast({ type: "state", state });
};
const safeError = (e) =>
  String(e?.message || e || "连接失败")
    .replace(/sk-[\w-]+/g, "[redacted]")
    .slice(0, 350);
const record = (row) => {
  const i = state.rows.findIndex((r) => r.id === row.id);
  if (i < 0) state.rows.push(row);
  else state.rows[i] = row;
  if (state.rows.length > 2000) state.rows.shift();
  broadcast({ type: "row", row });
  // Text only; no microphone audio is written to disk. Journal every update
  // so a process interruption still preserves the latest received partial.
  run?.archive?.write(JSON.stringify({ type: "row", row }) + "\n");
};

function endRun(error = null) {
  const old = run;
  if (!old) return;
  run = null;
  clearTimeout(old.timer);
  clearInterval(old.demoTimer);
  clearInterval(old.drainTimer);
  old.archive?.end(
    JSON.stringify({ type: "end", at: Date.now(), error, usage: state.usage }) +
      "\n",
  );
  old.sockets.forEach((ws) => {
    ws.removeAllListeners("message");
    ws.terminate();
  });
  owner = null;
  update({ status: error ? "error" : "stopped", error, endedAt: Date.now() });
}
function finish() {
  if (!run || state.status === "stopping") return;
  if (state.demo) return endRun();
  const current = run;
  clearTimeout(current.timer);
  update({ status: "stopping" });
  current.timer = setTimeout(() => {
    if (run === current)
      endRun("等待末句超时；已保留收到的字幕，请检查最后一句。");
  }, 20000);
  if (current.ready.size !== current.targets.length)
    return endRun("会话尚未就绪，已停止。");
  // Live testing showed session.finish immediately after speech could truncate
  // the last sentence. Supply a short PCM silence tail so turn detection
  // closes the turn before requesting the provider to finish the session.
  let tail = 0;
  const silence = JSON.stringify({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(3200).toString("base64"),
  });
  current.drainTimer = setInterval(() => {
    if (run !== current) return clearInterval(current.drainTimer);
    if (tail++ < 40)
      current.sockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(silence);
      });
    else {
      clearInterval(current.drainTimer);
      current.sockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "session.finish" }));
      });
    }
  }, 100);
}

function connectTarget(current, target, terms) {
  const url = new URL(realtimeURL);
  url.searchParams.set("model", model);
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 12000,
    maxPayload: 2e6,
  });
  current.sockets.push(ws);
  const transcript = new Transcript(target, current.id);
  ws.on("open", () => ws.send(JSON.stringify(sessionConfig(target, terms, current.responsiveness))));
  ws.on("message", (raw) => {
    if (run !== current) return;
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      return endRun("上游返回了无效的数据。");
    }
    if (e.type === "error") return endRun(`Qwen：${safeError(e.error)}`);
    const usage = current.meter.accept(target, e);
    if (usage) {
      state.usage = usage;
      broadcast({ type: "usage", usage });
      current.archive.write(
        JSON.stringify({
          type: "usage",
          usage,
          channel: target,
          responseId: e.response?.id,
          rawUsage: e.response?.usage ?? null,
          at: Date.now(),
        }) + "\n",
      );
    }
    if (e.type === "session.updated") {
      current.ready.add(target);
      if (
        current.ready.size === current.targets.length &&
        state.status === "connecting"
      ) {
        clearTimeout(current.timer);
        update({ status: "live" });
      }
    }
    if (e.type === "session.finished") {
      current.finished.add(target);
      if (current.finished.size === current.targets.length) endRun();
      return;
    }
    if (
      e.type === "response.done" &&
      ["failed", "cancelled", "incomplete"].includes(e.response?.status)
    ) {
      return endRun(
        "Qwen 返回未完成的翻译；已保留接收到的字幕，请检查末句并重新开始。",
      );
    }
    const row = transcript.accept(e);
    // In dual mode ASR is identical in meaning across both sessions. Keep one
    // authoritative source stream and two independently timed target streams.
    if (row && (row.kind !== "source" || target === current.targets[0]))
      record(row);
  });
  ws.on("error", (e) => {
    if (run === current) endRun(`Qwen 连接失败：${safeError(e)}`);
  });
  ws.on("unexpected-response", (_req, res) => {
    res.resume();
    if (run === current)
      endRun(`Qwen HTTP ${res.statusCode}：请检查 Key、模型权限和接口地址。`);
  });
  ws.on("close", () => {
    if (run === current && !current.finished.has(target))
      endRun(
        "实时连接已中断。已保存字幕；请重新开始，断线期间的语音不会补传。",
      );
  });
}

function start(ws, options, demo = false) {
  if (configSaving) throw Error("配置正在保存，请稍后开始。");
  if (run) throw new Error("已有控制台正在运行，请先停止当前会话。");
  const { mode, terms, responsiveness } = validateStart(options);
  if (!demo && (!key || key === "replace_with_your_key"))
    throw new Error("请先在“配置”页面填写并保存 API Key。");
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const targets =
    mode === "auto" ? ["en", "zh"] : [mode === "zh-en" ? "en" : "zh"];
  const current = {
    id,
    responsiveness,
    targets,
    sockets: [],
    ready: new Set(),
    finished: new Set(),
    archive: null,
    meter: new UsageMeter(pricing, usageMode, demo),
  };
  run = current;
  owner = ws;
  send(ws, { type: "started" });
  current.archive = createWriteStream(join(archiveDir, `${id}.jsonl`), {
    flags: "a",
  });
  current.archive.on("error", () => {
    if (run === current)
      endRun("字幕存档写入失败，请检查 recordings 目录和磁盘空间。");
  });
  current.archive.write(
    JSON.stringify({
      type: "session",
      id,
      mode,
      responsiveness,
      demo,
      model,
      startedAt: Date.now(),
      usage: current.meter.snapshot(),
    }) + "\n",
  );
  update({
    status: demo ? "demo" : "connecting",
    model,
    mode,
    responsiveness,
    rows: [],
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    demo,
    sessionId: id,
    usage: current.meter.snapshot(),
    // A new demo must not inherit a previous session's held/blank projection.
    ...(demo ? { display: { ...state.display, frozen: false, blank: false }, frozenRows: null } : {}),
  });
  if (demo) {
    const pairs = [
      [
        "欢迎来到 KiCon Asia 2026，让我们一起探索开源硬件的未来。",
        "Welcome to KiCon Asia 2026. Let’s explore the future of open-source hardware.",
      ],
      [
        "从原理图到 PCB 布局，KiCad 让每一个创意都有实现的可能。",
        "From schematics to PCB layout, KiCad helps bring every idea to life.",
      ],
      [
        "今天我们将讨论差分对布线，以及如何通过设计规则检查提高电路板质量。",
        "Today we’ll discuss differential pair routing and improving board quality with design rule checks.",
      ],
    ];
    let step = 0;
    const tick = () => {
      const index = Math.floor(step / 24) % pairs.length,
        count = (step % 24) + 1;
      for (const [n, language] of ["zh", "en"].entries()) {
        const full = pairs[index][n];
        record({
          id: `${id}:demo:${Math.floor(step / 24)}:${language}`,
          channel: language,
          kind: "translation",
          language,
          text: full.slice(0, Math.ceil((full.length * count) / 24)),
          final: count === 24,
          startedAt: Date.now() - count * 160,
          updatedAt: Date.now(),
        });
      }
      step++;
    };
    tick();
    current.demoTimer = setInterval(tick, 160);
  } else {
    current.timer = setTimeout(() => {
      if (run === current) endRun("实时会话配置超时，请检查网络后重新开始。");
    }, 20000);
    try {
      targets.forEach((target) => connectTarget(current, target, terms));
    } catch (e) {
      endRun(safeError(e));
    }
  }
}

const server = createServer(async (req, res) => {
  const allowedHosts = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `${host}:${port}`,
  ]);
  if (!allowedHosts.has(req.headers.host)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  );
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && ["/api/config", "/api/overlay"].includes(url.pathname)) {
    const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.headers.origin !== `http://${req.headers.host}` || req.headers["x-kicon-token"] !== token)
      return json(403, { error: "请求未授权，请刷新控制台后重试。" });
    if (url.pathname === "/api/overlay") {
      try { await launchOverlay(); return json(200, { message: "已请求打开桌面字幕；已有窗口将刷新并显示。" }); }
      catch (error) { return json(500, { error: safeError(error) }); }
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(415, { error: "需要 JSON 格式。" });
    if (run || configSaving) return json(409, { error: "请先停止同传或演示，再保存配置。" });
    configSaving = true;
    try {
      let body = "", size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) { json(413, { error: "配置内容过长。" }); return; }
        body += chunk.toString("utf8");
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(400, { error: "配置格式无效。" }); }
      let settings;
      try { settings = validateSettings(input || {}, { key }); }
      catch (error) { return json(400, { error: safeError(error) }); }
      try { await saveSettings(configPath, settings); }
      catch { return json(500, { error: "无法保存配置，请检查本地配置文件的写入权限。" }); }
      ({ baseURL, model, realtimeURL, key } = settings);
      pricing = pricingFor(model);
      broadcast({ type: "config", config: publicConfig() });
      return json(200, { ...publicConfig(), message: "配置已保存，下次开始同传时生效。" });
    } catch {
      if (!res.headersSent) json(400, { error: "请求中断或格式无效，请重试。" });
    } finally { configSaving = false; }
  }
  if (req.method !== "GET") return res.writeHead(405).end();
  try {
    if (url.pathname === "/api/config") {
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify(publicConfig()),
      );
    }
    if (url.pathname === "/api/recordings") {
      res.setHeader("Content-Type", "application/json");
      const list = (await readdir(archiveDir))
        .filter((x) => /^[\w.-]+\.jsonl$/.test(x))
        .sort()
        .reverse();
      return res.end(JSON.stringify(list));
    }
    if (url.pathname.startsWith("/api/export/")) {
      const match = /^\/api\/export\/([\w.-]+)\.(txt|zh\.srt|en\.srt)$/.exec(
        url.pathname,
      );
      if (!match) return res.writeHead(400).end();
      const [, id, format] = match;
      const archived = await readJournal(join(archiveDir, `${id}.jsonl`));
      if (id === state.sessionId) {
        archived.status = state.status;
        archived.endedAt = state.endedAt ?? archived.endedAt;
      }
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="KiCon-${id}.${format}"`,
      );
      return res.end(
        "\ufeff" +
          (format === "txt"
            ? exportText(archived)
            : exportSRT(archived, format.slice(0, 2))),
      );
    }
    if (url.pathname.startsWith("/api/recordings/")) {
      const name = url.pathname.slice("/api/recordings/".length);
      if (!/^[\w.-]+\.jsonl$/.test(name)) return res.writeHead(400).end();
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      return res.end(await readFile(join(archiveDir, name)));
    }
    const path = ["/", "/screen"].includes(url.pathname)
      ? "/index.html"
      : url.pathname;
    if (!files.has(path)) return res.writeHead(404).end("Not found");
    res.setHeader("Content-Type", mime[extname(path)]);
    res.end(await readFile(files.get(path)));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`, `${host}:${port}`];
  if (
    !hosts.includes(req.headers.host) ||
    req.headers.origin !== `http://${req.headers.host}` ||
    url.pathname !== "/ws" ||
    url.searchParams.get("token") !== token
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.role = url.searchParams.get("role");
    wss.emit("connection", ws);
  });
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.alive = true;
  ws.on("pong", () => {
    ws.alive = true;
  });
  send(ws, { type: "state", state });
  ws.on("message", (raw, binary) => {
    if (ws.role !== "control") return;
    try {
      if (binary) {
        if (owner !== ws || !run || state.status !== "live" || state.demo)
          return;
        if (raw.length > 32000 || raw.length % 2)
          throw new Error("音频格式无效。");
        if (run.sockets.some((up) => up.bufferedAmount > 320000))
          return endRun("网络发送积压超过 10 秒，已停止以避免字幕持续落后。");
        const message = JSON.stringify({
          type: "input_audio_buffer.append",
          audio: raw.toString("base64"),
        });
        run.sockets.forEach((up) => {
          if (up.readyState === WebSocket.OPEN) up.send(message);
        });
        return;
      }
      const msg = JSON.parse(raw);
      if (msg.type === "start" || msg.type === "demo")
        start(ws, msg, msg.type === "demo");
      else if (msg.type === "stop" && owner === ws) finish();
      else if (msg.type === "display") {
        const d = msg.display || {},
          next = { ...state.display };
        if (["bilingual", "zh", "en"].includes(d.mode)) next.mode = d.mode;
        if (["dark", "light"].includes(d.theme)) next.theme = d.theme;
        if (Number.isFinite(d.fontSize))
          next.fontSize = Math.max(24, Math.min(88, d.fontSize));
        if (Number.isFinite(d.lines))
          next.lines = Math.max(1, Math.min(5, Math.round(d.lines)));
        if (Number.isFinite(d.maxLines))
          next.maxLines = Math.max(0, Math.min(5, Math.round(d.maxLines)));
        if (typeof d.frozen === "boolean") next.frozen = d.frozen;
        if (typeof d.blank === "boolean") next.blank = d.blank;
        for (const key of ["floatingZhColor", "floatingEnColor", "floatingBackground"]) {
          if (d[key] === null) delete next[key];
          else if (typeof d[key] === "string" && /^#[0-9a-f]{6}$/i.test(d[key])) next[key] = d[key];
        }
        if (Number.isFinite(d.floatingOpacity))
          next.floatingOpacity = Math.max(0, Math.min(100, d.floatingOpacity));
        const frozenRows = next.frozen
          ? state.display.frozen
            ? state.frozenRows
            : structuredClone(state.rows)
          : null;
        let saveFailed = false;
        try { writeDisplayPreferences(displayPath, next); }
        catch { saveFailed = true; }
        update({ display: next, frozenRows });
        if (saveFailed) send(ws, { type: "error", message: "显示设置已应用，但未能保存到本地，请检查项目目录写入权限。" });
      }
    } catch (e) {
      send(ws, { type: "error", message: safeError(e) });
    }
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    clients.delete(ws);
    if (owner === ws) finish();
  });
});
const heartbeat = setInterval(
  () =>
    clients.forEach((ws) => {
      if (!ws.alive) return ws.terminate();
      ws.alive = false;
      ws.ping();
    }),
  15000,
);
// Preserve the last completed session's time/cost comparison across restarts.
// Never restart microphone capture or a paid upstream session automatically.
try {
  const latest = (await readdir(archiveDir))
    .filter((name) => /^[\w.-]+\.jsonl$/.test(name))
    .sort()
    .at(-1);
  if (latest) {
    const previous = await readJournal(join(archiveDir, latest));
    if (Number.isFinite(previous.endedAt)) {
      Object.assign(state, {
        status: previous.error ? "error" : "stopped",
        error: previous.error,
        mode: previous.mode,
        demo: previous.demo,
        model: previous.model,
        sessionId: previous.id,
        startedAt: previous.startedAt,
        endedAt: previous.endedAt,
        rows: previous.rows.slice(-2000),
        usage: previous.usage ?? new UsageMeter(pricing, usageMode).snapshot(),
      });
    }
  }
} catch {
  /* A damaged old journal must not prevent a new session. */
}
server.on("error", (error) => {
  if (process.parentPort && error.code === "EADDRINUSE" && port !== 0) {
    port = 0;
    server.listen(port, host);
  } else {
    console.error("本地字幕服务无法启动：", error.code || "UNKNOWN");
    process.parentPort?.postMessage({ type: "startup-error" });
    shutdown();
    process.exitCode = 1;
  }
});
server.on("listening", () => {
  port = server.address().port;
  console.log(`KiCon Live · http://localhost:${port}\nProjection · http://localhost:${port}/screen\nModel · ${model}`);
  process.parentPort?.postMessage({ type: "ready", port });
});
server.listen(port, host);
function shutdown() {
  clearInterval(heartbeat);
  const journal = run?.archive;
  const flushed = !journal || journal.writableFinished || journal.destroyed ? Promise.resolve()
    : new Promise((resolve) => { journal.once("finish", resolve); journal.once("error", resolve); });
  endRun();
  clients.forEach((ws) => ws.terminate());
  server.close(() => { flushed.then(() => process.parentPort?.postMessage({ type: "stopped" })); });
  server.closeIdleConnections();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.parentPort?.on("message", ({ data }) => { if (data?.type === "shutdown") shutdown(); });
