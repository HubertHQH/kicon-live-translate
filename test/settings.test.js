import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { validateSettings, saveSettings } from "../server/settings.js";

test("configuration derives the realtime endpoint, preserves blank keys and rejects env injection", () => {
  const current = { key: "existing-test-key" };
  const input = { baseURL: "https://example.com/compatible-mode/v1/", model: "qwen-test", key: "" };
  const saved = validateSettings(input, current);
  assert.equal(saved.key, current.key);
  assert.equal(saved.baseURL, "https://example.com/compatible-mode/v1");
  assert.equal(saved.realtimeURL, "wss://example.com/api-ws/v1/realtime");
  assert.equal(validateSettings({ ...input, realtimeURL: "wss://other.example/custom" }, current).realtimeURL, "wss://other.example/custom");
  for (const bad of [{ key: "a\nPORT=3" }, { model: "test\nKEY=value" }, { baseURL: "https://user:secret@example.com" }, { realtimeURL: "file:///test" }])
    assert.throws(() => validateSettings({ ...input, ...bad }, current));
});

test("saved .env survives restart parsing, replaces duplicate keys and retains unrelated settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-settings-"));
  try {
    const path = join(dir, ".env");
    await writeFile(path, "# pricing\nPORT=3210\nQWEN_PRICE_INPUT_AUDIO=40\nQWEN_MODEL=old\nexport QWEN_MODEL=duplicate\nQWEN_API_KEY=old-secret\n");
    const expected = validateSettings({ baseURL: "https://example.com/v1", model: "new-model", key: "new-test-key" }, {});
    await saveSettings(path, expected);
    const text = await readFile(path, "utf8"), parsed = parseEnv(text);
    assert.equal(parsed.QWEN_API_KEY, expected.key);
    assert.equal(parsed.QWEN_MODEL, expected.model);
    assert.equal(parsed.QWEN_BASE_URL, expected.baseURL);
    assert.equal(parsed.QWEN_REALTIME_URL, expected.realtimeURL);
    assert.equal(parsed.PORT, "3210");
    assert.equal(parsed.QWEN_PRICE_INPUT_AUDIO, "40");
    assert.equal((text.match(/QWEN_MODEL=/g) || []).length, 1);
    await saveSettings(path, validateSettings({ ...expected, key: "" }, expected));
    assert.equal(parseEnv(await readFile(path, "utf8")).QWEN_API_KEY, expected.key);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
