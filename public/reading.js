// A separate playback clock for each visible language/window. Receipt time is
// deliberately not used: a burst of API responses must not skip unread pages.
export function readingDuration(text) {
  const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const words = (text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, " ").match(/[\p{L}\p{N}]+/gu) || []).length;
  return Math.max(2000, Math.min(5000, cjk * 180 + words * 300));
}

export class ReadingQueue {
  constructor({ realtime = false } = {}) {
    this.realtime = realtime;
    this.catchups = 0;
    this.entries = new Map();
    this.queue = [];
    this.page = "";
    this.elapsed = 0;
    this.lastTick = null;
    this.wasVisible = false;
  }
  ingest(rows, ended = false, now = this.lastTick ?? 0) {
    for (const row of rows) {
      if (!row.text) continue;
      const old = this.entries.get(row.id);
      if (!old) {
        const entry = { ...row, receivedAt: now, offset: 0, done: false, final: row.final || ended };
        this.entries.set(row.id, entry);
        this.queue.push(entry);
      } else {
        if (old.text !== row.text) {
          if (old.done && this.realtime) { old.text = row.text; continue; }
          if (this.realtime && !row.text.startsWith(old.text)) {
            this.plan = null;
            this.elapsed = 0;
          }
          // A correction to already-read text must be shown again in full.
          if (!row.text.startsWith(old.text.slice(0, old.offset))) old.offset = 0;
          if (old.done) {
            old.offset = 0;
            old.done = false;
            this.queue.push(old);
          }
          old.text = row.text;
        }
        old.final = row.final || ended;
      }
    }
    if (ended) for (const entry of this.queue) entry.final = true;
  }
  tick(now, fit, visible = true) {
    if (this.realtime) return this.tickRealtime(now, fit, visible);
    const delta = this.lastTick === null ? 0 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!visible) {
      this.wasVisible = false;
      return this.page;
    }
    let entry = this.queue[0];
    if (!entry) return "";
    let next = fit(entry.text.slice(entry.offset));
    if (!next) {
      this.wasVisible = false;
      return this.page;
    }
    if (next !== this.page) {
      this.page = next;
      this.elapsed = 0;
    } else if (this.wasVisible) {
      // Throttled/background timers cannot consume an entire unread page.
      this.elapsed += Math.min(delta, 250);
    }
    this.wasVisible = true;
    if (this.elapsed >= readingDuration(this.page)) {
      const end = entry.offset + this.page.length;
      if (end < entry.text.length || (entry.final && this.queue.length > 1)) {
        entry.offset = end;
        if (end >= entry.text.length) {
          entry.done = true;
          this.queue.shift();
        }
        entry = this.queue[0];
        this.page = fit(entry.text.slice(entry.offset));
        this.elapsed = 0;
      }
    }
    return this.page;
  }
  get pending() { return Math.max(0, this.queue.length - (this.realtime ? this.plan?.length || 1 : 1)); }

  tickRealtime(now, fit, visible) {
    const delta = this.lastTick === null ? 0 : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!visible || !this.queue.length) { this.wasVisible = false; return this.page; }
    // First check that this window can actually display a page.
    if (!fit(this.queue[0].text.slice(this.queue[0].offset))) {
      this.wasVisible = false;
      return this.page;
    }
    if (this.wasVisible) this.elapsed += Math.min(delta, 250);
    this.wasVisible = true;
    // Bound *local playback* lag. This cannot remove upstream model latency.
    // Keep the newest segment on a burst, including when resuming a hidden window.
    const unread = !this.plan || this.plan.length < this.queue.length ||
      this.plan.at(-1)?.count < this.plan.at(-1)?.entry.text.length - this.plan.at(-1)?.entry.offset;
    if (unread && now - this.queue[0].receivedAt > 6000 &&
        now - (this.lastCatchupAt ?? -Infinity) >= 1200) {
      let caughtUp = false;
      while (this.queue.length > 1) {
        this.queue.shift().done = true;
        caughtUp = true;
      }
      const entry = this.queue[0], rest = entry.text.slice(entry.offset);
      if (fit(rest) !== rest) {
        const parts = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(rest), (s) => s.segment);
        let lo = 0, hi = parts.length;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2), tail = parts.slice(mid).join("");
          if (fit(tail) === tail) hi = mid; else lo = mid + 1;
        }
        entry.offset += parts.slice(0, lo).join("").length;
        caughtUp = true;
      }
      if (caughtUp) {
        this.lastCatchupAt = now;
        this.catchups++; this.elapsed = 0; this.page = ""; this.plan = null;
      }
    }
    const backlog = this.queue.reduce((n, e) => n + e.text.length - e.offset, 0);
    const dwell = backlog > Math.max(1, this.page.length) * 3 ? 600 :
      Math.max(800, Math.min(1800, readingDuration(this.page) * 0.5));
    if (this.plan && this.elapsed >= dwell && now - this.changedAt >= 250 && now >= (this.addedUntil || 0)) {
      const last = this.plan.at(-1);
      const more = this.queue.length > this.plan.length || last.count < last.entry.text.length - last.entry.offset;
      if (more) {
        for (const { entry, count } of this.plan) {
          entry.offset += count;
          if (entry.offset >= entry.text.length) {
            entry.done = true;
            this.queue.shift();
          } else break;
        }
        this.page = ""; this.elapsed = 0;
      }
    }
    let page = "", plan = [];
    for (const entry of this.queue) {
      const rest = entry.text.slice(entry.offset), separator = page ? " " : "";
      const candidate = fit(page + separator + rest);
      const count = candidate.length - page.length - separator.length;
      if (count <= 0) break;
      page = candidate;
      plan.push({ entry, count });
      if (count < rest.length || !entry.final) break;
    }
    // Word-boundary fitting may return a shorter prefix as a new word grows.
    // Keep already-visible text until the next page, unless it was corrected
    // or the window really shrank. Never flash a suffix off and back on.
    if (page && this.page.startsWith(page) && this.plan && fit(this.page) === this.page) {
      page = this.page;
      plan = this.plan;
    }
    if (page !== this.page) {
      // Streaming growth must not restart a multi-second timer on every token.
      if (!page.startsWith(this.page)) this.elapsed = 0;
      this.changedAt = now;
      this.page = page;
    }
    if (plan.some(({ entry }) => !this.plan?.some((old) => old.entry === entry)))
      this.addedUntil = now + 600;
    this.plan = plan;
    return this.page;
  }
}

// Measure with the actual Chromium font and width, including emoji clusters.
// Never rely on character counts to decide which glyphs fit on the screen.
export function fitCaptionPage(box, text) {
  const width = box.clientWidth, height = box.clientHeight;
  if (!width || !height || !text) return "";
  const probe = box.ownerDocument.createElement("p");
  const view = box.ownerDocument.defaultView;
  const style = view.getComputedStyle(box.querySelector("p") || box);
  probe.style.cssText = `position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${width}px;margin:0;padding:0;border:0;max-height:none;box-sizing:border-box;`;
  for (const property of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
    "lineHeight", "letterSpacing", "wordSpacing", "whiteSpace", "overflowWrap", "wordBreak", "textTransform"])
    probe.style[property] = style[property];
  // A probe inside the live box changes :last-child opacity/margins while
  // forcing layout. Measure outside the caption tree instead.
  box.ownerDocument.body.append(probe);
  const fits = (value) => {
    probe.textContent = value;
    return probe.getBoundingClientRect().height <= height + 0.5;
  };
  try {
    if (fits(text)) return text;
    const parts = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
    let lo = 0, hi = parts.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(parts.slice(0, mid).join(""))) lo = mid;
      else hi = mid - 1;
    }
    const prefix = parts.slice(0, lo).join("");
    // Prefer a nearby phrase/word boundary; retain whitespace in the queue.
    const boundaries = [...prefix.matchAll(/[\s，。！？；、,.!?;:]+/gu)];
    const boundary = boundaries.at(-1);
    const end = boundary ? boundary.index + boundary[0].length : 0;
    return end >= prefix.length * 0.65 ? prefix.slice(0, end) : prefix;
  } finally { probe.remove(); }
}
