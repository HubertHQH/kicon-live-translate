// Qwen 3.8 ASR and translation IDs are different. Link only using the
// provider's previous_item_id; never assume arrival order means alignment.
export class Transcript {
  constructor(channel, sessionId, now = Date.now) {
    this.channel = channel;
    this.sessionId = sessionId;
    this.now = now;
    this.rows = new Map();
    this.links = new Map();
    this.speakers = new Map();
    this.seen = new Set();
  }
  accept(e) {
    if (e.event_id && this.seen.has(e.event_id)) return null;
    if (e.event_id) this.seen.add(e.event_id);
    if (this.seen.size > 10000)
      this.seen.delete(this.seen.values().next().value);
    if (e.type === "input_audio_buffer.speech_started") {
      this.speakers.set(e.item_id, e.speaker_id);
      return null;
    }
    if (
      e.type === "conversation.item.created" &&
      e.item?.role === "assistant"
    ) {
      this.links.set(e.item.id, e.previous_item_id);
      return null;
    }
    const source = e.type?.startsWith(
      "conversation.item.input_audio_transcription.",
    );
    const translation =
      /^response\.(text|audio_transcript)\.(delta|text|done)$/.test(
        e.type || "",
      );
    if (!source && !translation) return null;
    if (source && !/\.(delta|text|completed)$/.test(e.type)) return null;
    const item = e.item_id || e.response_id;
    if (!item) return null;
    const kind = source ? "source" : "translation";
    const id = `${this.sessionId}:${this.channel}:${kind}:${item}:${e.content_index || 0}`;
    const previous = this.rows.get(id);
    const sourceId = source ? item : this.links.get(item);
    const row = previous || {
      id,
      channel: this.channel,
      kind,
      text: "",
      final: false,
      startedAt: this.now(),
    };
    if (row.final && e.type.endsWith(".delta")) return null;
    if (e.type.endsWith(".delta")) row.text += e.delta || "";
    else if (e.type.endsWith(".completed")) {
      row.text = e.transcript ?? row.text;
      row.final = true;
    } else if (e.type.endsWith(".done")) {
      row.text = e.text ?? e.transcript ?? row.text;
      row.final = true;
    } else if (source) row.text = (e.text || "") + (e.stash || "");
    else row.text += e.text || "";
    row.language = source ? e.language || row.language || "auto" : this.channel;
    row.sourceItemId = sourceId;
    row.speaker = this.speakers.get(sourceId) ?? row.speaker;
    row.updatedAt = this.now();
    this.rows.set(id, row);
    if (this.rows.size > 2000) this.rows.delete(this.rows.keys().next().value);
    if (this.links.size > 2000)
      this.links.delete(this.links.keys().next().value);
    if (this.speakers.size > 2000)
      this.speakers.delete(this.speakers.keys().next().value);
    return { ...row };
  }
}

export function sessionConfig(target, terms = [], responsiveness = "fast") {
  const phrases = Object.fromEntries(
    terms.map(([zh, en]) => (target === "en" ? [zh, en] : [en, zh])),
  );
  return {
    type: "session.update",
    session: {
      output_modalities: ["text"],
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: responsiveness === "balanced" ? 600 : 300,
          },
        },
      },
      translation: {
        language: target,
        ...(terms.length ? { corpus: { phrases } } : {}),
      },
    },
  };
}

export function validateStart(value) {
  if (!["auto", "zh-en", "en-zh"].includes(value.mode))
    throw new Error("请选择有效的翻译方向。");
  const terms = value.terms ?? [];
  const responsiveness = value.responsiveness ?? "fast";
  if (!["fast", "balanced"].includes(responsiveness))
    throw new Error("请选择有效的字幕响应方式。");
  if (
    !Array.isArray(terms) ||
    terms.length > 100 ||
    terms.some(
      (x) =>
        !Array.isArray(x) ||
        x.length !== 2 ||
        x.some((s) => typeof s !== "string" || !s.trim() || s.length > 100),
    )
  ) {
    throw new Error("术语应为最多 100 组中英词汇，每个词汇不超过 100 字。");
  }
  return { mode: value.mode, terms, responsiveness };
}
