import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { PCMResampler } from "../public/resampler.js";
import { readPCM16Wav } from "../scripts/lib/wav.js";

const worklet = (await readFile(new URL("../public/pcm-worklet.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "");

test("shared diagnostic WAV reader handles metadata padding and rejects invalid uploads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-wav-"));
  t.after(async () => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, "fixture.wav");
  const chunk = (name, data) => {
    const b = Buffer.alloc(8 + data.length + data.length % 2);
    b.write(name); b.writeUInt32LE(data.length, 4); data.copy(b, 8);
    return b;
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const body = Buffer.concat([Buffer.from("WAVE"), chunk("JUNK", Buffer.from("x")), chunk("fmt ", fmt), chunk("data", pcm)]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(body.length, 4);
  const wav = Buffer.concat([header, body]);
  await writeFile(file, wav);
  assert.deepEqual(await readPCM16Wav(file), pcm);
  for (const invalid of [wav.subarray(0, 6), wav.subarray(0, wav.length - 1), Buffer.from(wav)]) {
    if (invalid.length === wav.length) invalid.writeUInt32LE(48000, 34); // fmt sample rate, after odd-sized metadata
    await writeFile(file, invalid);
    await assert.rejects(readPCM16Wav(file));
  }
});

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
