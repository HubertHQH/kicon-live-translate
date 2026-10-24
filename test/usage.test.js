import test from "node:test";
import assert from "node:assert/strict";
import { UsageMeter, pricingFor } from "../server/usage.js";
import { exportText } from "../public/display.js";
const pricing = pricingFor("qwen3.8-livetranslate-flash-realtime", {});
const event = (id, usage) => ({
  type: "response.done",
  response: { id, status: "completed", usage },
});
const usage = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  input_tokens_details: { audio_tokens: 90, text_tokens: 10 },
  output_tokens_details: { text_tokens: 20 },
};

test("actual response reports aggregate across channels and exclude unknown rates", () => {
  const meter = new UsageMeter(pricing);
  meter.accept("en", event("same-id", usage));
  const s = meter.accept("zh", event("same-id", usage));
  assert.equal(s.totalTokens, 240);
  assert.equal(s.inputAudio, 180);
  assert.equal(s.unpricedTokens, 20);
  assert.equal(s.partial, true);
  assert.ok(Math.abs(s.estimatedCost - 0.0112) < 1e-12);
  assert.equal(s.channels.zh.outputText, 20);
  assert.equal(meter.accept("en", event("same-id", usage)), null);
  assert.equal(meter.snapshot().totalTokens, 240);
});
test("corrected usage replaces old report and failed responses still count", () => {
  const meter = new UsageMeter(pricing);
  meter.accept("en", event("1", usage));
  const corrected = {
    ...usage,
    output_tokens: 30,
    total_tokens: 130,
    output_tokens_details: { text_tokens: 30 },
  };
  const e = event("1", corrected);
  e.response.status = "failed";
  assert.equal(meter.accept("en", e).totalTokens, 130);
  assert.equal(meter.snapshot().reportedResponses, 1);
});
test("missing or malformed usage is unknown, not zero; later report recovers it", () => {
  const meter = new UsageMeter(pricing);
  assert.equal(meter.snapshot().estimatedCost, null);
  const missing = meter.accept("en", event("1", null));
  assert.equal(missing.missingResponses, 1);
  assert.equal(missing.estimatedCost, null);
  meter.accept("en", event("2", { ...usage, input_tokens: -1 }));
  assert.equal(meter.snapshot().missingResponses, 2);
  assert.equal(meter.accept("en", event("1", usage)).missingResponses, 1);
  const noDetails = new UsageMeter(pricing).accept(
    "en",
    event("3", { input_tokens: 10, output_tokens: 3 }),
  );
  assert.equal(noDetails.unpricedTokens, 13);
  assert.equal(noDetails.estimatedCost, null);
});
test("demo is free and a new session resets counters", () => {
  const demo = new UsageMeter(pricing, "per_response", true);
  assert.equal(demo.accept("en", event("1", usage)), null);
  assert.equal(demo.snapshot().estimatedCost, 0);
  assert.equal(demo.snapshot().totalTokens, 0);
  assert.equal(new UsageMeter(pricing).snapshot().reportedResponses, 0);
});
test("explicit cumulative providers keep latest totals per channel without multiplying sessions", () => {
  const m = new UsageMeter(pricing, "cumulative");
  m.accept("en", event("1", usage));
  m.accept("en", event("2", usage));
  assert.equal(m.snapshot().totalTokens, 120);
  m.accept("zh", event("1", usage));
  assert.equal(m.snapshot().totalTokens, 240);
});
test("pricing overrides support explicit zero and never reuse model pricing for unknown models", () => {
  const custom = pricingFor("other-model", {
    QWEN_PRICE_INPUT_AUDIO: "50",
    QWEN_PRICE_INPUT_TEXT: "0",
    QWEN_PRICE_OUTPUT_TEXT: "bad",
  });
  assert.equal(custom.rates.inputAudio, 50);
  assert.equal(custom.rates.inputText, 0);
  assert.equal(custom.rates.outputText, null);
  assert.equal(custom.rates.inputImage, null);
  const known = pricingFor("qwen3.8-livetranslate-flash-realtime", {
    QWEN_PRICE_INPUT_TEXT: "0",
  });
  assert.equal(
    new UsageMeter(known).accept("en", event("1", usage)).partial,
    false,
  );
});
test("TXT exports include usage, pricing and incomplete-billing notice", () => {
  const m = new UsageMeter(pricing);
  m.accept("en", event("1", usage));
  const text = exportText({ rows: [], model: "test", usage: m.snapshot() });
  assert.match(text, /Token 合计：120/);
  assert.match(text, /CNY 0.005600/);
  assert.match(text, /已定价部分/);
});
