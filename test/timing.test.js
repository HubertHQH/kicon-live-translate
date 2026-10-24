import test from "node:test";
import assert from "node:assert/strict";
import { sessionTiming, exportText } from "../public/display.js";

test("live timing counts elapsed time once for two translation sessions", () => {
  const state = {
    status: "live",
    startedAt: 1000,
    mode: "auto",
    usage: { estimatedCost: 0.06 },
  };
  assert.equal(sessionTiming(state, 121000).clock, "00:02:00");
  assert.equal(sessionTiming(state, 121000).perMinute, 0.03);
  assert.equal(sessionTiming(state, 3662000).clock, "01:01:01");
  assert.equal(
    sessionTiming({ ...state, display: { frozen: true, blank: true } }, 121000)
      .durationMs,
    120000,
  );
});
test("stopped or failed sessions keep time and cost rate after refresh", () => {
  const state = {
    status: "stopped",
    startedAt: 1000,
    endedAt: 61000,
    usage: { estimatedCost: 0.04 },
  };
  assert.equal(sessionTiming(state, 900000).clock, "00:01:00");
  assert.equal(sessionTiming(state, 1800000).perMinute, 0.04);
  assert.equal(
    sessionTiming({ ...state, status: "error" }, 900000).clock,
    "00:01:00",
  );
});
test("idle, missing usage, zero-duration and new sessions do not invent rates", () => {
  assert.equal(
    sessionTiming({ status: "idle", startedAt: null }).clock,
    "00:00:00",
  );
  assert.equal(
    sessionTiming({ status: "live", startedAt: 1000 }, 61000).perMinute,
    null,
  );
  const state = {
    status: "live",
    startedAt: 1000,
    usage: { estimatedCost: 0.02 },
  };
  assert.equal(sessionTiming(state, 1000).perMinute, null);
  assert.equal(
    sessionTiming({ ...state, startedAt: 61000 }, 62000).clock,
    "00:00:01",
  );
  assert.equal(
    sessionTiming(
      { ...state, status: "demo", usage: { estimatedCost: 0 } },
      61000,
    ).perMinute,
    0,
  );
});
test("export records session duration and matching cost per minute", () => {
  const text = exportText({
    rows: [],
    model: "test",
    startedAt: 1000,
    endedAt: 121000,
    usage: {
      estimatedCost: 0.06,
      reportedResponses: 1,
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      partial: true,
      unpricedTokens: 1,
      missingResponses: 0,
      pricing: { rates: {} },
    },
  });
  assert.match(text, /会话时长：00:02:00/);
  assert.match(text, /平均每分钟预估费用（已定价部分）：CNY 0.030000/);
});
