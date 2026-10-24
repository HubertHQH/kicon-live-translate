export function sessionTiming(state, now = Date.now()) {
  const running = ["connecting", "live", "demo", "stopping"].includes(
    state.status,
  );
  const end = Number.isFinite(state.endedAt)
    ? state.endedAt
    : running
      ? now
      : null;
  const durationMs =
    Number.isFinite(state.startedAt) && end !== null
      ? Math.max(0, end - state.startedAt)
      : null;
  const seconds = Math.floor((durationMs ?? 0) / 1000);
  const clock = [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const cost = state.usage?.estimatedCost;
  const perMinute =
    durationMs >= 1000 && Number.isFinite(cost) && cost >= 0
      ? (cost * 60000) / durationMs
      : null;
  return { durationMs, clock, perMinute, running };
}

export function languageRows(state, language) {
  return state.rows.filter((row) => {
    if (!row.text) return false;
    if (state.mode === "auto" || state.demo)
      return row.kind === "translation" && row.language === language;
    const source = state.mode === "zh-en" ? "zh" : "en";
    return language === source
      ? row.kind === "source"
      : row.kind === "translation" && row.language === language;
  });
}

export function exportText(state) {
  const output = [
    `KiCon Asia 2026 · ${state.demo ? "演示字幕" : "会议字幕"}`,
    `模型：${state.model}`,
    "",
  ];
  if (state.usage) {
    const timing = sessionTiming(state);
    const u = state.usage,
      reported = u.reportedResponses > 0 || u.demo;
    output.push(
      `会话时长：${timing.durationMs === null ? "未记录" : timing.clock}（含连接与收尾，双向不重复计时）`,
      `平均每分钟预估费用${u.partial ? "（已定价部分）" : ""}：${timing.perMinute === null ? "—" : `CNY ${timing.perMinute.toFixed(6)} / 分钟`}`,
      `Token 合计：${reported ? u.totalTokens : "未回报"}（输入 ${reported ? u.inputTokens : "—"} / 输出 ${reported ? u.outputTokens : "—"}）`,
      `预估费用${u.partial ? "（已定价部分）" : ""}：${u.estimatedCost == null ? "未回报 / 未定价" : `CNY ${u.estimatedCost.toFixed(6)}`}`,
      `未定价 / 未分类 token：${u.unpricedTokens}；缺少用量的响应：${u.missingResponses}`,
      `统计口径：${u.mode}；单价（元/百万 token）：${JSON.stringify(u.pricing.rates)}`,
      "此为 API 回报用量的估算，未扣除免费额度或折扣，以平台账单为准。",
      "",
    );
  }
  for (const row of state.rows) {
    const time = new Date(row.startedAt).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
    output.push(
      `[${time}] ${row.kind === "source" ? "原文" : row.language === "zh" ? "中文" : "English"}${row.final ? "" : "（未定稿）"}`,
      row.text,
      "",
    );
  }
  return output.join("\n");
}

export function exportSRT(state, language) {
  const stamp = (ms) => {
    const n = Math.max(0, Math.round(ms));
    return `${String(Math.floor(n / 3600000)).padStart(2, "0")}:${String(Math.floor(n / 60000) % 60).padStart(2, "0")}:${String(Math.floor(n / 1000) % 60).padStart(2, "0")},${String(n % 1000).padStart(3, "0")}`;
  };
  const rows = languageRows(state, language);
  return rows
    .map((row, i) => {
      const start = row.startedAt - state.startedAt;
      const next = rows[i + 1]?.startedAt - state.startedAt;
      const end = Math.max(
        start + 1,
        Math.min(
          Number.isFinite(next) ? next : Infinity,
          Math.max(start + 1800, row.updatedAt - state.startedAt + 500),
        ),
      );
      return `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${row.text}\n`;
    })
    .join("\n");
}
