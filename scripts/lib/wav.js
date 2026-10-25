import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Shared input validation for paid diagnostics, before any audio is uploaded.
export async function readPCM16Wav(path) {
  const wav = await readFile(path);
  assert.ok(wav.length >= 12, "Truncated WAV header");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  let pcm, formatValid = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4), data = offset + 8;
    assert.ok(data + length <= wav.length, "Truncated WAV chunk");
    if (kind === "fmt ") {
      assert.ok(length >= 16, "Truncated WAV format");
      assert.equal(wav.readUInt16LE(data), 1, "WAV must use uncompressed PCM");
      assert.equal(wav.readUInt16LE(data + 2), 1, "WAV must be mono");
      assert.equal(wav.readUInt32LE(data + 4), 16000, "WAV must be 16 kHz");
      assert.equal(wav.readUInt16LE(data + 14), 16, "WAV must be PCM16");
      formatValid = true;
    }
    if (kind === "data") pcm = wav.subarray(data, data + length);
    offset = data + length + length % 2;
  }
  assert.ok(formatValid && pcm?.length && pcm.length % 2 === 0, "Missing or invalid PCM16 audio");
  return pcm;
}
