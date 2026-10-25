import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { PCMResampler } from "../public/resampler.js";

const worklet = (await readFile(new URL("../public/pcm-worklet.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "");
test("audio streams within 50 ms plus one render quantum and flush preserves every sample", () => {
  for (const rate of [16000, 44100, 48000]) {
    let Recorder;
    const messages = [];
    runInNewContext(worklet, { sampleRate: rate, PCMResampler,
      AudioWorkletProcessor: class { port = { postMessage: (m) => messages.push(m) }; },
      registerProcessor: (_, value) => { Recorder = value; },
    });
    const recorder = new Recorder(), input = Float32Array.from({ length: 128 * 100 }, (_, i) => Math.sin(i * 0.1) / 2);
    let firstPacketAt;
    for (let offset = 0; offset < input.length; offset += 128) {
      recorder.process([[input.slice(offset, offset + 128)]]);
      if (firstPacketAt === undefined && messages.some(m => m.pcm)) firstPacketAt = (offset + 128) / rate;
    }
    assert.ok(firstPacketAt <= 0.05 + 128 / rate);
    recorder.port.onmessage({ data: "flush" });
    const actual = messages.filter(m => m.pcm).flatMap(m => [...new Int16Array(m.pcm)]);
    const expected = new PCMResampler(rate).push(input);
    assert.equal(actual.length, expected.length);
    assert.ok(actual.every((sample, i) => sample === expected[i]), "PCM payload must preserve sample values (including signed zero)");
    assert.equal(messages.at(-1).flushed, true);
    const count = messages.length;
    recorder.process([[new Float32Array(128)]]);
    assert.equal(messages.length, count, "flush stops capture without leaking later samples");
  }
});
