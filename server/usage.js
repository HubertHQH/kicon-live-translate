const MODEL = "qwen3.8-livetranslate-flash-realtime";
const validCount = (v) => Number.isSafeInteger(v) && v >= 0;
const count = (v) => (validCount(v) ? v : 0);
const FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "inputAudio",
  "inputText",
  "inputImage",
  "outputText",
  "outputAudio",
  "unclassified",
];
const empty = () => Object.fromEntries(FIELDS.map((k) => [k, 0]));

export function pricingFor(model, env = process.env) {
  const known = model === MODEL;
  const rate = (name, fallback) => {
    const value = env[name];
    if (value === undefined || value.trim() === "")
      return known ? fallback : null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    currency: "CNY",
    perTokens: 1_000_000,
    source:
      "https://www.qianwenai.com/models/qwen3.8-livetranslate-flash-realtime",
    verifiedAt: "2026-09-21",
    rates: {
      inputAudio: rate("QWEN_PRICE_INPUT_AUDIO", 40),
      inputText: rate("QWEN_PRICE_INPUT_TEXT", null),
      inputImage: rate("QWEN_PRICE_INPUT_IMAGE", 3.3),
      outputText: rate("QWEN_PRICE_OUTPUT_TEXT", 100),
      outputAudio: rate("QWEN_PRICE_OUTPUT_AUDIO", 160),
    },
  };
}

function normalize(u) {
  if (!u || !validCount(u.input_tokens) || !validCount(u.output_tokens))
    return null;
  const input = u.input_tokens_details || {},
    output = u.output_tokens_details || {};
  const counts = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: validCount(u.total_tokens)
      ? u.total_tokens
      : u.input_tokens + u.output_tokens,
    inputAudio: count(input.audio_tokens),
    inputText: count(input.text_tokens),
    inputImage: count(input.image_tokens),
    outputText: count(output.text_tokens),
    outputAudio: count(output.audio_tokens),
  };
  if (
    counts.inputAudio + counts.inputText + counts.inputImage >
      counts.inputTokens ||
    counts.outputText + counts.outputAudio > counts.outputTokens ||
    counts.totalTokens !== counts.inputTokens + counts.outputTokens
  )
    return null;
  counts.unclassified =
    counts.totalTokens -
    counts.inputAudio -
    counts.inputText -
    counts.inputImage -
    counts.outputText -
    counts.outputAudio;
  return counts;
}

export class UsageMeter {
  constructor(pricing, mode = "per_response", demo = false) {
    if (!["per_response", "cumulative"].includes(mode))
      throw Error("QWEN_USAGE_MODE must be per_response or cumulative");
    this.pricing = pricing;
    this.mode = mode;
    this.demo = demo;
    this.responses = new Map();
  }
  accept(channel, event) {
    if (this.demo || event.type !== "response.done") return null;
    const id = event.response?.id || event.event_id;
    if (!id) return null;
    const key = `${channel}:${id}`,
      value = { channel, counts: normalize(event.response?.usage) };
    // Replayed response IDs replace their previous report, never double count.
    if (JSON.stringify(this.responses.get(key)) === JSON.stringify(value))
      return null;
    this.responses.set(key, value);
    return this.snapshot();
  }
  snapshot() {
    const totals = empty(),
      channels = {};
    let reportedResponses = 0,
      missingResponses = 0;
    for (const { channel, counts } of this.responses.values()) {
      if (!counts) {
        missingResponses++;
        continue;
      }
      reportedResponses++;
      channels[channel] ||= empty();
      for (const k of FIELDS)
        channels[channel][k] =
          this.mode === "cumulative"
            ? counts[k]
            : channels[channel][k] + counts[k];
    }
    for (const channel of Object.values(channels))
      for (const k of FIELDS) totals[k] += channel[k];
    let cost = 0,
      pricedTokens = 0,
      unpricedTokens = totals.unclassified;
    for (const [kind, rate] of Object.entries(this.pricing.rates)) {
      if (rate === null) unpricedTokens += totals[kind];
      else {
        pricedTokens += totals[kind];
        cost += (totals[kind] * rate) / this.pricing.perTokens;
      }
    }
    const hasReport = reportedResponses > 0 || this.demo;
    return {
      ...totals,
      channels,
      reportedResponses,
      missingResponses,
      unpricedTokens,
      estimatedCost:
        hasReport && (pricedTokens > 0 || totals.totalTokens === 0)
          ? cost
          : null,
      partial: missingResponses > 0 || unpricedTokens > 0,
      mode: this.mode,
      demo: this.demo,
      pricing: this.pricing,
    };
  }
}
