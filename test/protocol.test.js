import test from "node:test";
import assert from "node:assert/strict";
import {
  Transcript,
  sessionConfig,
  validateStart,
} from "../server/protocol.js";
import { PCMResampler } from "../public/resampler.js";
import { languageRows, exportSRT } from "../public/display.js";

test("source and translation use explicit item links and preserve speaker", () => {
  const t = new Transcript("en", "session", () => 1000);
  t.accept({
    type: "input_audio_buffer.speech_started",
    item_id: "asr1",
    speaker_id: 2,
  });
  t.accept({
    type: "conversation.item.created",
    previous_item_id: "asr1",
    item: { id: "out1", role: "assistant" },
  });
  const source = t.accept({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "asr1",
    delta: "电路板",
  });
  const target = t.accept({
    type: "response.text.delta",
    item_id: "out1",
    delta: "Circuit board",
  });
  assert.equal(source.sourceItemId, target.sourceItemId);
  assert.equal(target.speaker, 2);
  assert.notEqual(source.id, target.id);
});
test("deltas append, duplicate events are ignored, final text replaces partial", () => {
  const t = new Transcript("zh", "s");
  const e = {
    type: "response.text.delta",
    item_id: "a",
    event_id: "e1",
    delta: "电路",
  };
  assert.equal(t.accept(e).text, "电路");
  assert.equal(t.accept(e), null);
  assert.equal(t.accept({ ...e, event_id: "e2", delta: "图" }).text, "电路图");
  const row = t.accept({
    type: "response.text.done",
    item_id: "a",
    text: "电路板。",
  });
  assert.equal(row.text, "电路板。");
  assert.equal(row.final, true);
  assert.equal(t.accept({ ...e, event_id: "e3" }), null);
});
test("interleaved items do not overwrite each other; missing IDs are ignored", () => {
  const t = new Transcript("en", "s");
  t.accept({ type: "response.text.delta", item_id: "a", delta: "Hello " });
  t.accept({ type: "response.text.delta", item_id: "b", delta: "World" });
  assert.equal(
    t.accept({ type: "response.text.delta", item_id: "a", delta: "there" })
      .text,
    "Hello there",
  );
  assert.equal(
    t.accept({ type: "response.text.delta", delta: "unknown" }),
    null,
  );
});
test("ASR completed event replaces accumulated draft", () => {
  const t = new Transcript("en", "s");
  t.accept({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "x",
    delta: "欢迎",
  });
  const r = t.accept({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "x",
    transcript: "欢迎来到大会。",
    language: "zh",
  });
  assert.equal(r.text, "欢迎来到大会。");
  assert.equal(r.language, "zh");
  assert.equal(r.final, true);
});
test("term direction reverses and 3.8 configuration uses output_modalities", () => {
  const cfg = sessionConfig("zh", [["原理图", "schematic"]]);
  assert.equal(cfg.session.translation.corpus.phrases.schematic, "原理图");
  assert.deepEqual(cfg.session.output_modalities, ["text"]);
  assert.equal(cfg.session.modalities, undefined);
  assert.throws(() => validateStart({ mode: "invalid" }));
  assert.throws(() => validateStart({ mode: "auto", terms: [["a"]] }));
});

test("response profiles shorten silence without disabling continuous text output", () => {
  assert.equal(validateStart({ mode: "auto" }).responsiveness, "fast");
  for (const [profile, silence] of [["fast", 300], ["balanced", 600]]) {
    assert.equal(validateStart({ mode: "zh-en", responsiveness: profile }).responsiveness, profile);
    const config = sessionConfig("en", [], profile).session;
    assert.deepEqual(config.output_modalities, ["text"]);
    assert.deepEqual(config.audio.input.turn_detection, { type: "server_vad", threshold: 0.5, silence_duration_ms: silence });
  }
  assert.throws(() => validateStart({ mode: "auto", responsiveness: "unknown" }));
});
test("resampler preserves phase across arbitrary packet boundaries at 44.1k and 48k", () => {
  for (const rate of [16000, 44100, 48000]) {
    const input = Float32Array.from(
      { length: rate },
      (_, i) => Math.sin((i / rate) * 2 * Math.PI * 400) * 0.7,
    );
    const all = new PCMResampler(rate).push(input),
      r = new PCMResampler(rate),
      streamed = [];
    for (let i = 0; i < input.length; i += 128)
      streamed.push(...r.push(input.slice(i, i + 128)));
    assert.ok(Math.abs(all.length - 16000) <= 1);
    assert.equal(streamed.length, all.length);
    assert.ok(all.every((n, i) => Math.abs(n - streamed[i]) <= 1));
    assert.ok(all.every((n) => n >= -32768 && n <= 32767));
  }
});
test("single direction displays original + translation and dual mode uses target lanes", () => {
  const rows = [
    { kind: "source", language: "auto", text: "原文" },
    { kind: "translation", language: "en", text: "Source" },
    { kind: "translation", language: "zh", text: "译文" },
  ];
  assert.equal(languageRows({ mode: "zh-en", rows }, "zh")[0].text, "原文");
  assert.equal(languageRows({ mode: "auto", rows }, "zh")[0].text, "译文");
});
test("SRT times are positive and bounded by next cue", () => {
  const s = {
    mode: "auto",
    startedAt: 10000,
    rows: [
      {
        kind: "translation",
        language: "en",
        text: "Hello",
        startedAt: 11000,
        updatedAt: 12000,
      },
      {
        kind: "translation",
        language: "en",
        text: "World",
        startedAt: 13000,
        updatedAt: 14000,
      },
    ],
  };
  const output = exportSRT(s, "en");
  assert.match(output, /00:00:01,000 --> 00:00:02,800/);
  assert.match(output, /2\n00:00:03,000/);
});
