const { readFileSync, writeFileSync, mkdirSync, renameSync } = require("node:fs");
const { dirname } = require("node:path");
function readBounds(file) {
  try {
    const b = JSON.parse(readFileSync(file, "utf8"));
    if (["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])) && b.width > 0 && b.height > 0)
      return Object.fromEntries(["x", "y", "width", "height"].map((k) => [k, Math.round(b[k])]));
  } catch {}
  return null;
}
function fitBounds(saved, area) {
  const width = Math.min(area.width, Math.max(300, saved?.width || 1000));
  const height = Math.min(area.height, Math.max(100, saved?.height || 280));
  const x = saved?.x ?? area.x + Math.round((area.width - width) / 2);
  const y = saved?.y ?? area.y + area.height - height - 40;
  return { width, height,
    x: Math.max(area.x, Math.min(area.x + area.width - width, x)),
    y: Math.max(area.y, Math.min(area.y + area.height - height, y)),
  };
}
function writeBounds(file, bounds) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(bounds) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
module.exports = { readBounds, fitBounds, writeBounds };
