import { AudioCapture } from "./audio.js";
import { languageRows, sessionTiming } from "./display.js";
const $ = (id) => document.getElementById(id);
const screen = location.pathname === "/screen";
$("control").hidden = screen;
$("projection").hidden = !screen;
let state = {
  status: "idle",
  rows: [],
  display: { mode: "bilingual", fontSize: 44, lines: 3, theme: "dark" },
};
let socket,
  capture,
  localRun = false,
  awaitingStart = false,
  preparing = false,
  connected = false,
  config;
let renderQueued = false,
  frozenRows = null,
  wasFrozen = false,
  retry = 0;
const active = () =>
  ["connecting", "live", "demo", "stopping"].includes(state.status);
const notify = (message) => {
  $("notice").textContent = message;
  $("notice").hidden = !message;
};
const send = (data) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
};
const labels = {
  idle: "待开始",
  connecting: "连接模型…",
  live: "正在同传",
  demo: "演示模式",
  stopping: "等待末句…",
  stopped: "已停止",
  error: "连接异常",
};
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("kicon-settings") || "{}");
  } catch {
    return {};
  }
})();
if (saved.terms) $("terms").value = saved.terms;
if (saved.direction) $("direction").value = saved.direction;
function persist() {
  try {
    localStorage.setItem(
      "kicon-settings",
      JSON.stringify({
        terms: $("terms").value,
        direction: $("direction").value,
      }),
    );
  } catch {}
}

async function connect() {
  try {
    config = await fetch("/api/config").then((r) => {
      if (!r.ok) throw Error("服务不可用");
      return r.json();
    });
    $("model-name").textContent = config.model;
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?role=${screen ? "viewer" : "control"}&token=${encodeURIComponent(config.token)}`,
    );
    socket.addEventListener("open", () => {
      connected = true;
      retry = 0;
      scheduleRender();
    });
    socket.addEventListener("message", async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === "started") {
        localRun = true;
        awaitingStart = false;
      } else if (msg.type === "state") {
        const old = state.status;
        state = msg.state;
        if (state.status === "live" && old !== "live" && localRun && capture) {
          try {
            capture.start();
          } catch (e) {
            notify(e.message);
            await stop();
          }
        }
        if (!active() && localRun) {
          localRun = false;
          const oldCapture = capture;
          capture = null;
          await oldCapture?.stop();
        }
        if (state.error && !screen) notify(state.error);
      } else if (msg.type === "row") {
        const i = state.rows.findIndex((r) => r.id === msg.row.id);
        if (i < 0) state.rows.push(msg.row);
        else state.rows[i] = msg.row;
        if (state.rows.length > 2000) state.rows.shift();
      } else if (msg.type === "usage") {
        state.usage = msg.usage;
      } else if (msg.type === "error") {
        notify(msg.message);
        if (awaitingStart) {
          awaitingStart = false;
          localRun = false;
          await capture?.stop();
          capture = null;
        }
      }
      scheduleRender();
    });
    socket.addEventListener("close", async () => {
      connected = false;
      if (localRun || awaitingStart || capture) {
        localRun = false;
        awaitingStart = false;
        const old = capture;
        capture = null;
        await old?.stop();
      }
      if (!screen)
        notify("工作台连接中断。字幕已保留；连接恢复后请重新开始采集。");
      scheduleRender();
      setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    });
    socket.addEventListener("error", () => {});
  } catch {
    connected = false;
    scheduleRender();
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
function renderStage(stage, rows) {
  const d = state.display;
  stage.dataset.theme = d.theme;
  stage.dataset.mode = d.mode;
  stage.classList.toggle("blank", !!d.blank);
  stage.style.setProperty("--caption-size", `${d.fontSize}px`);
  stage.querySelector(".stage-indicator").textContent = state.demo
    ? "DEMO · 演示字幕"
    : "LIVE TRANSLATION";
  stage.querySelector(".stage-state").textContent = !connected
    ? "连接中断 / OFFLINE"
    : d.frozen
      ? "画面暂停 / HOLD"
      : `${labels[state.status]} / ${state.status.toUpperCase()}`;
  for (const lang of ["zh", "en"]) {
    const lane = stage.querySelector(`[data-lane="${lang}"]`);
    lane.hidden = d.mode !== "bilingual" && d.mode !== lang;
    const box = lane.querySelector(".caption-text");
    const selected = languageRows({ ...state, rows }, lang).slice(-d.lines);
    box.replaceChildren();
    if (!selected.length) {
      const p = document.createElement("p");
      p.className = "waiting";
      p.textContent =
        lang === "zh" ? "等待发言，让交流开始。" : "Ready when you are.";
      box.append(p);
    } else {
      // Bottom-aligned, clipped flow keeps the newest speech visible using
      // actual browser text layout, without guessing English/CJK word widths.
      for (const row of selected) {
        const p = document.createElement("p");
        p.textContent = row.text;
        p.classList.toggle("partial", !row.final && active());
        box.append(p);
      }
    }
  }
}
function renderTiming() {
  const timing = sessionTiming(state);
  $("elapsed").textContent = timing.clock;
  $("usage-duration").textContent = timing.clock;
  $("usage-per-minute").textContent =
    timing.perMinute === null ? "—" : `¥${timing.perMinute.toFixed(6)}`;
  $("usage-per-minute-label").textContent = state.usage?.partial
    ? "平均每分钟 · 部分"
    : "平均每分钟";
}

function renderUsage() {
  renderTiming();
  const u = state.usage,
    hasReport = u && (u.reportedResponses > 0 || u.demo);
  const number = (n) => n.toLocaleString("zh-CN");
  for (const [id, key] of Object.entries({
    "usage-total": "totalTokens",
    "usage-input": "inputTokens",
    "usage-output": "outputTokens",
    "usage-audio": "inputAudio",
    "usage-input-text": "inputText",
    "usage-text": "outputText",
  })) {
    $(id).textContent = hasReport ? number(u[key]) : "—";
  }
  $("usage-cost").textContent =
    u?.estimatedCost == null ? "—" : `¥${u.estimatedCost.toFixed(6)}`;
  $("usage-cost-label").textContent = u?.partial
    ? "预估费用 · 部分"
    : "预估费用";
  $("usage-status").textContent = u?.demo
    ? "演示免费"
    : u?.missingResponses
      ? "回报不完整"
      : hasReport
        ? "API 已回报"
        : "等待回报";
  const notes = [];
  if (u?.demo) notes.push("演示不调用模型，token 与费用均为 0。");
  else if (!hasReport) notes.push("尚未收到有效用量，不能视为零费用。");
  else
    notes.push(
      `已收到 ${number(u.reportedResponses)} 次用量回报${state.mode === "auto" ? "，含两个翻译会话" : ""}。`,
    );
  if (u?.unpricedTokens)
    notes.push(
      `${number(u.unpricedTokens)} 个 token 缺少单价或分类，未计入费用。`,
    );
  if (u?.missingResponses)
    notes.push(
      `${number(u.missingResponses)} 次响应缺少有效用量，未计入合计。`,
    );
  if (!connected || state.status === "error")
    notes.push("连接异常期间未回报的消耗不在统计中。");
  $("usage-note").textContent = notes.join(" ");
  const rates = u?.pricing?.rates;
  $("usage-rates").textContent = rates
    ? `人民币 / 百万 token：音频输入 ${rates.inputAudio ?? "未定价"}，文本输出 ${rates.outputText ?? "未定价"}，文本输入 ${rates.inputText ?? "未定价"}。${u.mode === "cumulative" ? "按各会话最新累计值汇总" : "按响应回报累加"}。公开价核验：${u.pricing.verifiedAt}；可在 .env 覆盖单价。`
    : "正在读取服务端计费配置…";
}

function render() {
  const d = state.display;
  if (d.frozen && (!wasFrozen || state.frozenRows))
    frozenRows = state.frozenRows || structuredClone(state.rows);
  if (!d.frozen) frozenRows = null;
  wasFrozen = !!d.frozen;
  renderStage(
    screen ? $("projection-stage") : $("preview"),
    frozenRows || state.rows,
  );
  if (screen) {
    $("screen-status").textContent = connected
      ? state.demo
        ? "演示字幕 · 非实时翻译"
        : d.frozen
          ? "画面暂停"
          : labels[state.status]
      : "连接中断 · 正在重连";
    return;
  }
  $("connection").textContent = connected ? "● 工作台已连接" : "○ 工作台离线";
  $("connection").classList.toggle("offline", !connected);
  renderUsage();
  $("status").textContent = preparing ? "准备音频…" : labels[state.status];
  $("status-dot").className =
    state.status === "live" ? "on" : state.status === "demo" ? "demo" : "";
  $("start").disabled =
    !connected ||
    preparing ||
    awaitingStart ||
    state.status === "stopping" ||
    (active() && !localRun);
  $("start").textContent =
    localRun && active() ? "■  停止同传" : "●  开始同传   ↗";
  $("start").classList.toggle("running", localRun && active());
  $("demo").disabled = !connected || preparing || awaitingStart || active();
  for (const id of [
    "input-kind",
    "device",
    "direction",
    "terms",
    "refresh-devices",
  ])
    $(id).disabled = active() || preparing;
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.classList.toggle("selected", b.dataset.mode === d.mode);
    b.setAttribute("aria-pressed", String(b.dataset.mode === d.mode));
  }
  for (const b of document.querySelectorAll("button[data-theme]")) {
    b.classList.toggle("selected", b.dataset.theme === d.theme);
    b.setAttribute("aria-pressed", String(b.dataset.theme === d.theme));
  }
  $("font-size").value = d.fontSize;
  $("font-value").textContent = `${d.fontSize} px`;
  $("line-count").value = d.lines;
  $("freeze").textContent = d.frozen ? "▶ 恢复字幕更新" : "Ⅱ 暂停字幕更新";
  $("freeze").setAttribute("aria-pressed", String(d.frozen));
  $("blank").textContent = d.blank ? "▣ 恢复投屏画面" : "▱ 临时黑屏";
  $("blank").setAttribute("aria-pressed", String(d.blank));
  $("preview-mode").textContent = {
    bilingual: "中文 + English",
    zh: "仅中文",
    en: "English only",
  }[d.mode];
  if (state.rows.length) {
    const source = state.rows.filter((r) => r.kind === "source");
    const rows = (
      source.length ? source : state.rows.filter((r) => r.language === "zh")
    ).slice(-30);
    const box = $("transcript"),
      atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.replaceChildren();
    for (const row of rows) {
      const item = document.createElement("div");
      item.className = "transcript-row";
      const time = document.createElement("time");
      time.textContent = new Date(row.startedAt).toLocaleTimeString("zh-CN", {
        hour12: false,
      });
      const text = document.createElement("p");
      text.textContent = row.text;
      const tag = document.createElement("span");
      tag.textContent = row.final ? "已定稿" : active() ? "识别中" : "未定稿";
      tag.className = row.final ? "final-tag" : "partial-tag";
      item.append(time, text, tag);
      box.append(item);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  } else if (!$("transcript").querySelector(".empty-transcript")) {
    $("transcript").textContent = "等待音频输入…";
  }
}

async function devices(request = false) {
  try {
    if (request) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    }
    const list = await navigator.mediaDevices.enumerateDevices(),
      current = $("device").value;
    $("device").replaceChildren(new Option("系统默认麦克风", ""));
    list
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "default")
      .forEach((d, i) =>
        $("device").add(new Option(d.label || `麦克风 ${i + 1}`, d.deviceId)),
      );
    if ([...$("device").options].some((o) => o.value === current))
      $("device").value = current;
  } catch (e) {
    if (request) notify(`无法读取麦克风：${e.message}`);
  }
}
function parseTerms() {
  return $("terms")
    .value.split("\n")
    .filter((s) => s.trim())
    .map((s, i) => {
      const at = s.indexOf("=");
      if (at < 1 || !s.slice(at + 1).trim())
        throw Error(`术语第 ${i + 1} 行格式应为：中文 = English`);
      return [s.slice(0, at).trim(), s.slice(at + 1).trim()];
    });
}
async function begin(demo = false) {
  if (active() || preparing || awaitingStart || !connected) return;
  notify("");
  preparing = true;
  scheduleRender();
  try {
    const terms = parseTerms();
    persist();
    if (!demo) {
      if (!config.configured)
        throw Error("请在项目 .env 中配置 API Key，然后重新启动服务。");
      capture = new AudioCapture(
        (buffer) => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 320000) {
            notify("音频发送积压，已停止。请检查网络后重新开始。");
            void stop();
            return;
          }
          socket.send(buffer);
        },
        (level) => {
          $("level").style.width = `${Math.min(100, level * 350)}%`;
          $("level-value").textContent = level
            ? `${Math.round(20 * Math.log10(Math.max(level, 0.00001)))} dB`
            : "—";
        },
        () => {
          notify("音频设备已断开或共享已结束。");
          void stop();
        },
      );
      await capture.prepare($("input-kind").value, $("device").value);
      await devices();
      if (!connected) throw Error("服务连接已中断，请重试。");
    }
    awaitingStart = true;
    send({ type: demo ? "demo" : "start", mode: $("direction").value, terms });
  } catch (e) {
    await capture?.stop();
    capture = null;
    localRun = false;
    const friendly = {
      NotAllowedError: "音频权限未授予。请允许麦克风，或重新选择要共享的音频。",
      NotFoundError: "没有检测到音频输入设备。",
      NotReadableError: "无法读取音频设备，请检查设备连接或其他程序的占用。",
    };
    notify(friendly[e.name] || e.message);
  } finally {
    preparing = false;
    scheduleRender();
  }
}
let stopping = false;
async function stop() {
  if (stopping || !localRun) return;
  stopping = true;
  try {
    const old = capture;
    capture = null;
    await old?.stop();
    send({ type: "stop" });
  } finally {
    stopping = false;
  }
}
function setDisplay(patch) {
  send({ type: "display", display: patch });
}
function download(extension) {
  if (!state.rows.length) {
    notify("还没有可导出的字幕，请先开始同传或演示。");
    return;
  }
  if (!connected) {
    notify("请等待服务连接恢复后导出完整会话。");
    return;
  }
  const a = document.createElement("a");
  a.href = `/api/export/${encodeURIComponent(state.sessionId)}.${extension}`;
  a.download = `KiCon-${state.sessionId}.${extension}`;
  a.click();
}
$("start").onclick = () => (localRun && active() ? stop() : begin());
$("demo").onclick = () => begin(true);
$("refresh-devices").onclick = () => devices(true);
$("input-kind").onchange = () => {
  const system = $("input-kind").value === "system";
  $("device-wrap").hidden = system;
  $("audio-hint").textContent = system
    ? "在共享窗口勾选“共享音频”。支持范围取决于浏览器和所选屏幕 / 标签页。"
    : "会场建议连接调音台或 USB 声卡，获取清晰的人声。";
};
$("direction").onchange = () => {
  persist();
  $("direction-hint").textContent =
    $("direction").value === "auto"
      ? "自动双向使用 2 个实时会话，分别生成中、英文字幕。"
      : "固定演讲方向使用 1 个会话，同时显示原文与译文。";
};
$("direction").onchange();
$("terms").onchange = persist;
document
  .querySelectorAll("[data-mode]")
  .forEach((b) => (b.onclick = () => setDisplay({ mode: b.dataset.mode })));
document
  .querySelectorAll("button[data-theme]")
  .forEach((b) => (b.onclick = () => setDisplay({ theme: b.dataset.theme })));
$("font-size").oninput = () =>
  setDisplay({ fontSize: Number($("font-size").value) });
$("line-count").onchange = () =>
  setDisplay({ lines: Number($("line-count").value) });
$("freeze").onclick = () => setDisplay({ frozen: !state.display.frozen });
$("blank").onclick = () => setDisplay({ blank: !state.display.blank });
$("open-screen").onclick = () => {
  const opened = window.open("/screen", "kicon-screen");
  if (!opened)
    notify("浏览器拦截了投屏窗口，请允许弹出窗口，或点击顶部“观众屏幕”。");
};
$("export").onclick = () => download("txt");
$("srt-zh").onclick = () => download("zh.srt");
$("srt-en").onclick = () => download("en.srt");
$("load-recordings").onclick = async () => {
  try {
    const list = await fetch("/api/recordings").then((r) => r.json());
    $("recordings").replaceChildren();
    if (!list.length) $("recordings").textContent = "暂无存档";
    for (const name of list.slice(0, 30)) {
      const entry = document.createElement("div"),
        label = document.createElement("p");
      label.textContent = name.slice(0, 19).replace("T", " ") + " UTC";
      entry.append(label);
      for (const ext of ["txt", "zh.srt", "en.srt"]) {
        const a = document.createElement("a");
        a.href = `/api/export/${encodeURIComponent(name.slice(0, -6))}.${ext}`;
        a.textContent = `${ext.toUpperCase()} ↓`;
        entry.append(a);
      }
      $("recordings").append(entry);
    }
  } catch {
    notify("无法读取存档，请检查服务连接。");
  }
};
async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    $("screen-status").textContent = "浏览器未允许全屏，请按 F11。";
  }
}
$("fullscreen").onclick = fullscreen;
document.addEventListener("keydown", (e) => {
  if (screen && e.key.toLowerCase() === "f") {
    e.preventDefault();
    void fullscreen();
  }
});
document.addEventListener("fullscreenchange", () =>
  document.body.classList.toggle("is-fullscreen", !!document.fullscreenElement),
);
window.addEventListener("resize", scheduleRender);
window.addEventListener("beforeunload", () => {
  capture?.stream?.getTracks().forEach((t) => t.stop());
  socket?.close();
});
setInterval(() => {
  if (!screen) renderTiming();
}, 1000);
if (!screen) void devices();
void connect();
