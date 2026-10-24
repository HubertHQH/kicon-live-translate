import { AudioCapture } from "./audio.js";
import { languageRows, sessionTiming } from "./display.js";
const $ = (id) => document.getElementById(id);
const screen = location.pathname === "/screen";
const nativeOverlay = screen && window.kiconDesktop?.isOverlay === true;
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
let floatingWindow = null,
  floatingStage = null,
  openingFloating = false;
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
  // The controller's animation frames may stop when another app covers it.
  // Render the visible PiP directly from incoming events in that case.
  if (nativeOverlay || (floatingWindow && !floatingWindow.closed)) {
    render();
    return;
  }
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
  if (stage.classList.contains("floating-stage")) applyFloatingAppearance(stage, nativeOverlay);
  stage.querySelector(".stage-indicator").textContent = state.demo
    ? "DEMO · 演示字幕"
    : "LIVE TRANSLATION";
  stage.querySelector(".stage-state").textContent = !connected
    ? "连接中断 / OFFLINE"
    : d.frozen
      ? "画面暂停 / HOLD"
      : `${labels[state.status]} / ${state.status.toUpperCase()}`;
  stage.dataset.alert = !connected || state.demo || d.frozen || state.status === "error" ? "true" : "false";
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
  if (floatingStage && floatingWindow && !floatingWindow.closed) {
    renderStage(floatingStage, frozenRows || state.rows);
    const toolbar = floatingWindow.document.querySelector(".floating-toolbar");
    toolbar.querySelector("select").value = d.mode;
    toolbar.querySelector("select").disabled = !connected;
    toolbar.querySelector('[data-action="smaller"]').disabled = !connected || d.fontSize <= 24;
    toolbar.querySelector('[data-action="larger"]').disabled = !connected || d.fontSize >= 88;
  }
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
  const colors = floatingAppearance(d);
  $("floating-zh-color").value = colors.zh;
  $("floating-en-color").value = colors.en;
  $("floating-background").value = colors.background;
  const transparency = 100 - colors.opacity;
  $("floating-opacity").value = transparency;
  $("floating-opacity-value").textContent = `${transparency}%${transparency === 100 ? " · 全透明" : transparency === 0 ? " · 实色" : ""}`;
  applyFloatingAppearance($("floating-color-sample"), true);
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
function floatingAppearance(d) {
  const light = d.theme === "light";
  return {
    zh: d.floatingZhColor || (light ? "#24392e" : "#edf2e6"),
    en: d.floatingEnColor || (light ? "#3f623e" : "#d7e8bd"),
    background: d.floatingBackground || (light ? "#f0f0dc" : "#192923"),
    opacity: d.floatingOpacity ?? 100,
  };
}
function applyFloatingAppearance(stage, transparent) {
  const colors = floatingAppearance(state.display);
  stage.style.setProperty("--floating-zh", colors.zh);
  stage.style.setProperty("--floating-en", colors.en);
  const rgb = colors.background.slice(1).match(/../g).map((part) => parseInt(part, 16));
  stage.style.setProperty("--floating-bg", `rgba(${rgb.join(", ")}, ${transparent ? colors.opacity / 100 : 1})`);
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
for (const [id, key] of [["floating-zh-color", "floatingZhColor"], ["floating-en-color", "floatingEnColor"], ["floating-background", "floatingBackground"]]) {
  $(id).oninput = () => setDisplay({ [key]: $(id).value });
}
$("floating-opacity").oninput = () => setDisplay({ floatingOpacity: 100 - Number($("floating-opacity").value) });
$("floating-reset-colors").onclick = () => setDisplay({ floatingZhColor: null, floatingEnColor: null, floatingBackground: null, floatingOpacity: 100 });
$("open-screen").onclick = () => {
  const opened = window.open("/screen", "kicon-screen");
  if (!opened)
    notify("浏览器拦截了投屏窗口，请允许弹出窗口，或点击顶部“观众屏幕”。");
};
const floatingSupported = typeof window.documentPictureInPicture?.requestWindow === "function";
function updateFloatingButton() {
  const opened = floatingWindow && !floatingWindow.closed;
  $("open-floating").textContent = opened ? "▣ 关闭悬浮字幕" : "▣ 打开悬浮字幕";
  $("open-floating").setAttribute("aria-pressed", String(!!opened));
  $("open-floating").disabled = openingFloating;
  $("floating-hint").textContent = !floatingSupported
    ? "当前浏览器不支持桌面置顶。请在桌面版 Chrome / Edge 中打开本页后使用悬浮字幕。"
    : opened
      ? "悬浮字幕已置顶。拖动标题栏移动，拖动边缘缩放；请保持控制台打开。"
      : "独立置顶于其他窗口之上。拖动标题栏移动，拖动窗口边缘调整大小。";
}
async function toggleFloating() {
  if (openingFloating) return;
  if (floatingWindow && !floatingWindow.closed) {
    floatingWindow.close();
    return;
  }
  if (!floatingSupported) {
    notify(`当前浏览器不支持悬浮置顶。请用桌面版 Chrome / Edge 打开 ${location.origin}，再点击“打开悬浮字幕”。`);
    return;
  }
  openingFloating = true;
  updateFloatingButton();
  let opened;
  try {
    // Must run within the user's click. Let the browser remember placement.
    opened = await window.documentPictureInPicture.requestWindow({ width: 800, height: 340 });
    floatingWindow = opened;
    const doc = opened.document;
    doc.documentElement.lang = "zh-CN";
    doc.title = "KiCon · 悬浮字幕";
    const style = doc.createElement("link");
    style.rel = "stylesheet";
    style.href = new URL("/style.css", location.href).href;
    doc.head.append(style);
    doc.body.className = "floating-body";
    floatingStage = $("projection-stage").cloneNode(true);
    floatingStage.id = "floating-stage";
    floatingStage.className = "stage floating-stage";
    floatingStage.querySelectorAll(".language-label").forEach((label) => label.remove());
    const toolbar = $("floating-toolbar-template").content.cloneNode(true);
    doc.body.replaceChildren(toolbar, floatingStage);
    doc.querySelector("select").onchange = (event) => setDisplay({ mode: event.target.value });
    for (const [action, delta] of [["smaller", -4], ["larger", 4]]) {
      doc.querySelector(`[data-action="${action}"]`).onclick = () =>
        setDisplay({ fontSize: Math.max(24, Math.min(88, state.display.fontSize + delta)) });
    }
    doc.querySelector('[data-action="close"]').onclick = () => opened.close();
    opened.addEventListener("pagehide", () => {
      if (floatingWindow !== opened) return;
      floatingWindow = null;
      floatingStage = null;
      updateFloatingButton();
      $("floating-hint").textContent = "悬浮字幕已关闭，同传不受影响。若窗口未能保持打开，请改用桌面版 Chrome / Edge。";
      scheduleRender();
    }, { once: true });
    render();
  } catch {
    opened?.close();
    floatingWindow = null;
    floatingStage = null;
    notify("无法打开悬浮字幕。请在桌面版 Chrome / Edge 中重试，并允许浏览器使用画中画功能。");
  } finally {
    openingFloating = false;
    updateFloatingButton();
  }
}
$("open-floating").onclick = toggleFloating;
updateFloatingButton();
if (nativeOverlay) {
  document.documentElement.classList.add("floating-root");
  document.body.classList.add("native-overlay");
  $("projection-stage").className = "stage floating-stage";
  $("projection-stage").querySelectorAll(".language-label").forEach((label) => label.remove());
  const bar = document.createElement("div");
  bar.className = "native-drag-bar";
  bar.title = "拖动移动字幕窗口";
  const close = document.createElement("button");
  close.textContent = "×";
  close.setAttribute("aria-label", "关闭桌面字幕");
  close.onclick = () => window.kiconDesktop.close();
  bar.append(close);
  const grip = document.createElement("button");
  grip.className = "native-resize-grip";
  grip.textContent = "◢";
  grip.setAttribute("aria-label", "拖动调整字幕窗口大小，方向键微调");
  let drag = null;
  grip.onpointerdown = (e) => {
    if (e.button !== 0) return;
    grip.setPointerCapture(e.pointerId);
    drag = { x: e.screenX, y: e.screenY, width: window.innerWidth, height: window.innerHeight };
  };
  grip.onpointermove = (e) => {
    if (drag) window.kiconDesktop.resize(drag.width + e.screenX - drag.x, drag.height + e.screenY - drag.y);
  };
  grip.onpointerup = grip.onpointercancel = grip.onlostpointercapture = () => { drag = null; };
  grip.onkeydown = (e) => {
    const sizes = { ArrowRight: [20, 0], ArrowLeft: [-20, 0], ArrowDown: [0, 20], ArrowUp: [0, -20] };
    if (!sizes[e.key]) return;
    e.preventDefault();
    window.kiconDesktop.resize(window.innerWidth + sizes[e.key][0], window.innerHeight + sizes[e.key][1]);
  };
  document.body.append(bar, grip);
}
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
  floatingWindow?.close();
  capture?.stream?.getTracks().forEach((t) => t.stop());
  socket?.close();
});
setInterval(() => {
  if (!screen) renderTiming();
}, 1000);
if (!screen) void devices();
void connect();
