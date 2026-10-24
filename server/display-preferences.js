import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export function displayPreferences(input) {
  const d = input && typeof input === "object" ? input : {}, result = {};
  if (["bilingual", "zh", "en"].includes(d.mode)) result.mode = d.mode;
  if (["dark", "light"].includes(d.theme)) result.theme = d.theme;
  if (Number.isFinite(d.fontSize)) result.fontSize = Math.max(24, Math.min(88, d.fontSize));
  if (Number.isFinite(d.lines)) result.lines = Math.max(1, Math.min(5, Math.round(d.lines)));
  for (const key of ["floatingZhColor", "floatingEnColor", "floatingBackground"])
    if (typeof d[key] === "string" && /^#[0-9a-f]{6}$/i.test(d[key])) result[key] = d[key];
  if (Number.isFinite(d.floatingOpacity)) result.floatingOpacity = Math.max(0, Math.min(100, d.floatingOpacity));
  return result;
}
export function readDisplayPreferences(path) {
  try { return displayPreferences(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return {}; }
}
export function writeDisplayPreferences(path, display) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(displayPreferences(display), null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}
