// Explicit paid diagnostic. Uses synthetic/local WAV fixtures, never records a mic.
// node --env-file-if-exists=.env scripts/compare-latency.js file.wav [...]
import WebSocket from "ws";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { sessionConfig, Transcript } from "../server/protocol.js";
import { readPCM16Wav } from "./lib/wav.js";

const paths = process.argv.slice(2);
assert.ok(paths.length, "Pass 16 kHz mono PCM16 WAV files");
assert.ok(process.env.QWEN_API_KEY, "Configure QWEN_API_KEY first");
const chunks = [], segments = [];
let duration = 0;
for (const path of paths) {
  const pcm = await readPCM16Wav(path);
  segments.push({ file: path, startMs: duration, endMs: duration + pcm.length / 32 });
  chunks.push(pcm, Buffer.alloc(64000));
  duration += pcm.length / 32 + 2000;
}
const pcm = Buffer.concat([...chunks, Buffer.alloc(64000)]);
const profiles = process.env.LATENCY_PROFILES?.split(",") || ["balanced", "fast"];
assert.ok(profiles.every(p => ["balanced", "fast", "speaker"].includes(p)), "Unknown comparison profile");
async function measure(profile, target) {
  const url = new URL(process.env.QWEN_REALTIME_URL || "wss://maas.qianwenaiapi.com/api-ws/v1/realtime");
  url.searchParams.set("model", process.env.QWEN_MODEL || "qwen3.8-livetranslate-flash-realtime");
  const result = { profile, target, segments, events: [], rows: [], effectiveDetection: null };
  const transcript = new Transcript(target, profile);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}` }, handshakeTimeout: 12000 });
    let start, timer, position = 0;
    const finish = (error) => {
      clearInterval(timer); clearTimeout(deadline); ws.terminate();
      if (error) reject(error);
      else { result.rows = [...transcript.rows.values()]; resolve(result); }
    };
    const deadline = setTimeout(() => finish(Error("Latency comparison timed out")), 90000);
    ws.on("error", () => finish(Error("Upstream connection failed")));
    ws.on("open", () => {
      const config = sessionConfig(target, [], profile);
      if (profile === "speaker") config.session.audio.input.turn_detection = { type: "speaker_detection", threshold: 0.5 };
      ws.send(JSON.stringify(config));
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw);
      if (e.type === "error") return finish(Error(`Provider error: ${e.error?.code || "unknown"}`));
      if (e.type === "session.updated" && !start) {
        result.effectiveDetection = e.session?.audio?.input?.turn_detection;
        start = performance.now();
        const packetMs = profile === "fast" ? 50 : 100, packetBytes = packetMs * 32;
        result.packetMs = packetMs;
        timer = setInterval(() => {
          if (position < pcm.length) {
            ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.subarray(position, position + packetBytes).toString("base64") }));
            position += packetBytes;
          } else { clearInterval(timer); ws.send(JSON.stringify({ type: "session.finish" })); }
        }, packetMs);
      }
      const row = transcript.accept(e);
      if (row || /speech_(started|stopped)/.test(e.type)) result.events.push({ atMs: Math.round(performance.now() - start), type: e.type, item: e.item_id, text: e.delta ?? e.text ?? e.transcript });
      if (e.type === "session.finished") finish();
    });
  });
}
const results = [];
// Sequential profiles avoid saturating account concurrency; each simulates dual mode.
for (const profile of profiles) {
  results.push(...await Promise.all([measure(profile, "en"), measure(profile, "zh")]));
  for (const r of results.filter(r => r.profile === profile)) console.log(JSON.stringify({
    profile, target: r.target, effectiveDetection: r.effectiveDetection,
    firstSourceMs: r.events.find(e => e.type.includes("transcription") && e.text)?.atMs,
    firstTranslationMs: r.events.find(e => e.type.startsWith("response.") && e.text)?.atMs,
    translationUpdates: r.events.filter(e => e.type === "response.text.delta").length,
    final: r.rows.filter(r => r.kind === "translation").map(r => ({ text: r.text, final: r.final })),
  }));
}
await mkdir("artifacts", { recursive: true });
const report = `artifacts/latency-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await writeFile(report, JSON.stringify(results, null, 2));
console.log(`Saved ${report}`);
