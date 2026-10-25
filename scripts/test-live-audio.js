// Explicit live integration check; consumes API audio tokens.
// Usage: node scripts/test-live-audio.js path/to/16k-mono-pcm16.wav [...]
import WebSocket from "ws";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { readPCM16Wav } from "./lib/wav.js";
const filenames = process.argv.slice(2);
if (!filenames.length) throw Error("Pass a 16 kHz mono PCM16 WAV fixture.");
const chunks = [];
for (const file of filenames) {
  const pcm = await readPCM16Wav(file);
  chunks.push(pcm, Buffer.alloc(32000 * 2));
}
const pcm = Buffer.concat(chunks),
  origin = "http://localhost:3210";
const { token } = await fetch(`${origin}/api/config`).then((r) => r.json());
const ws = new WebSocket(`ws://localhost:3210/ws?role=control&token=${token}`, {
  origin,
});
const rows = new Map();
let timer,
  lastUsage,
  accepted = false,
  position = 0,
  streaming = false;
await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => {
    clearInterval(timer);
    ws.close();
    reject(Error("Live test timeout"));
  }, 90000);
  const fail = (e) => {
    clearInterval(timer);
    clearTimeout(deadline);
    ws.close();
    reject(e);
  };
  ws.on("error", fail);
  ws.on("open", () =>
    ws.send(
      JSON.stringify({
        type: "start",
        mode: "auto",
        terms: [
          ["开源硬件", "open source hardware"],
          ["印刷电路板", "printed circuit board"],
        ],
      }),
    ),
  );
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.type === "started") accepted = true;
    if (m.type === "usage") lastUsage = m.usage;
    if (m.state?.usage) lastUsage = m.state.usage;
    if (m.type === "error" || (accepted && m.state?.status === "error"))
      return fail(Error(m.message || m.state.error));
    if (m.type === "row") {
      rows.set(m.row.id, m.row);
      if (m.row.final) console.log(m.row.kind, m.row.language, m.row.text);
    }
    if (m.state?.status === "live" && !streaming) {
      streaming = true;
      timer = setInterval(() => {
        if (position < pcm.length) {
          ws.send(pcm.subarray(position, position + 3200));
          position += 3200;
        } else {
          clearInterval(timer);
          ws.send(JSON.stringify({ type: "stop" }));
        }
      }, 100);
    }
    if (m.state?.status === "stopped" && streaming) {
      clearTimeout(deadline);
      ws.close();
      resolve();
    }
  });
});
const result = [...rows.values()];
assert.ok(lastUsage?.totalTokens > 0, "Token usage missing");
assert.ok(lastUsage.estimatedCost > 0, "Cost estimate missing");
assert.equal(lastUsage.missingResponses, 0, "Missing usage reports");
console.log(`USAGE: ${lastUsage.totalTokens} tokens; CNY ${lastUsage.estimatedCost.toFixed(6)}${lastUsage.partial ? " (priced items only)" : ""}; ${lastUsage.reportedResponses} reports`);
assert.ok(
  result.some((r) => r.kind === "source" && r.final),
  "ASR final missing",
);
assert.ok(
  result.some(
    (r) => r.kind === "translation" && r.language === "en" && r.final,
  ),
  "English translation missing",
);
assert.ok(
  result.some(
    (r) => r.kind === "translation" && r.language === "zh" && r.final,
  ),
  "Chinese translation missing",
);
if (filenames.some((f) => f.endsWith("test-zh.wav")))
  assert.ok(
    result.some(
      (r) =>
        r.kind === "source" && /电路板设计/.test(r.text.replaceAll(" ", "")),
    ),
    "Chinese final sentence was truncated",
  );
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/live-test-result.json",
  JSON.stringify({ testedAt: new Date().toISOString(), rows: result, usage: lastUsage }, null, 2),
);
console.log(
  `PASS: streamed ${(pcm.length / 32000).toFixed(1)} s of audio; received ${result.length} source/translation items and flushed final captions.`,
);
