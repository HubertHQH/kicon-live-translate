import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export function validateSettings(input, current) {
  const fail = (message) => { throw Error(message); };
  function url(value, protocols, label) {
    if (typeof value !== "string" || value.length > 2048) fail(`${label} 格式无效。`);
    let parsed;
    try { parsed = new URL(value.trim()); } catch { fail(`${label} 必须是完整地址。`); }
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search)
      fail(`${label} 的协议或地址格式无效，不能包含凭据、查询参数或片段。`);
    return parsed.href.replace(/\/$/, "");
  }
  const baseURL = url(input.baseURL, ["https:", "http:"], "Base URL");
  const realtimeURL = url(input.realtimeURL || new URL("/api-ws/v1/realtime", baseURL).href.replace(/^http/, "ws"), ["wss:", "ws:"], "实时连接地址");
  if (typeof input.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model.trim())) fail("请输入有效的模型 ID。");
  if (input.key !== undefined && (typeof input.key !== "string" || /[\s\x00-\x1f\x7f"'`#]/.test(input.key) || input.key.length > 4096)) fail("密钥格式无效，不能包含空白或引号。");
  const key = input.key || current.key || "";
  return { baseURL, realtimeURL, model: input.model.trim(), key };
}

export async function saveSettings(path, settings) {
  let original = "";
  try { original = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const entries = {
    QWEN_BASE_URL: settings.baseURL, QWEN_REALTIME_URL: settings.realtimeURL,
    QWEN_MODEL: settings.model, QWEN_API_KEY: settings.key,
  };
  const lines = original.split(/\r?\n/).filter((line) => !Object.keys(entries).some((key) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)));
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(entries)) lines.push(`${key}=${JSON.stringify(value)}`);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
