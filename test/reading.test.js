import test from "node:test";
import assert from "node:assert/strict";
import { ReadingQueue, readingDuration } from "../public/reading.js";

const row = (id, text, final = true) => ({ id, text, final });
const fit = (text) => text.slice(0, 6);
const live = () => new ReadingQueue({ realtime: true });

test("realtime combines short final segments without waiting for another API call", () => {
  const q = live();
  q.ingest([row("a", "你好"), row("b", "世界"), row("c", "欢迎")]);
  assert.equal(q.tick(0, (text) => text), "你好 世界 欢迎");
  assert.equal(q.pending, 0);
});
test("realtime drains a burst faster than fixed two-second pages", () => {
  const q = live();
  q.ingest(Array.from({ length: 8 }, (_, i) => row(String(i), `第${i}段文字!`)));
  clock(q, 0, 4000);
  assert.ok(q.queue.length <= 3, `still waiting: ${q.queue.length}`);
});
test("realtime catches up old queues and long single segments, with an explicit counter", () => {
  const q = live();
  q.ingest([row("a", "旧段落"), row("b", "最新发言内容结尾")], false, 0);
  q.tick(0, fit);
  q.tick(7000, fit, false);
  assert.equal(q.tick(7100, fit), "发言内容结尾");
  assert.equal(q.catchups, 1);
  assert.equal(q.entries.get("a").text, "旧段落");
});
test("realtime streaming growth does not reset the page clock on every token", () => {
  const q = live();
  q.ingest([row("a", "ab", false)]);
  q.tick(0, fit);
  for (let time = 100; time <= 500; time += 100) {
    q.ingest([row("a", "ab" + "c".repeat(time / 100), false)], false, time);
    q.tick(time, fit);
  }
  assert.equal(q.elapsed, 500);
});
test("late correction to a skipped segment never replays old content in realtime", () => {
  const q = live();
  q.ingest([row("a", "old"), row("b", "latest")]);
  q.tick(7000, fit);
  q.ingest([row("a", "corrected")], false, 7100);
  assert.equal(q.tick(7100, fit), "latest");
  assert.equal(q.queue.length, 1);
});
function clock(q, start, end, visible = true, measure = fit) {
  for (let time = start; time <= end; time += 100) q.tick(time, measure, visible);
  return q.page;
}

test("API burst is played in order with a full minimum dwell per page", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "第一段"), row("b", "第二段"), row("c", "第三段")]);
  assert.equal(clock(q, 0, 1900), "第一段");
  assert.equal(clock(q, 2000, 2000), "第二段");
  assert.equal(clock(q, 2100, 3900), "第二段");
  assert.equal(clock(q, 4000, 4000), "第三段");
  assert.equal(q.pending, 0);
});
test("every part of a long caption plays before the next caption, including after stop", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "abcdefghijklmn", false), row("b", "最后一段", false)], true);
  assert.equal(clock(q, 0, 1900), "abcdef");
  assert.equal(clock(q, 2000, 3900), "ghijkl");
  assert.equal(clock(q, 4000, 5900), "mn");
  assert.equal(clock(q, 6000, 8000), "最后一段");
});
test("late streaming tail and final correction each get reading time", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "你好", false)]);
  clock(q, 0, 1900);
  q.ingest([row("a", "你好世界", true), row("b", "下一段")]);
  assert.equal(clock(q, 2000, 3900), "你好世界");
  assert.equal(clock(q, 4000, 4000), "下一段");
  q.ingest([row("a", "修订内容", true)]);
  assert.equal(clock(q, 4100, 6000), "修订内容");
});
test("pause, blank and hidden time do not count; throttled ticks cannot drain a burst", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "原文"), row("b", "下一段")]);
  clock(q, 0, 1000);
  clock(q, 1100, 9000, false);
  assert.equal(clock(q, 9100, 10000), "原文");
  assert.equal(clock(q, 10100, 10100), "下一段");
  const other = new ReadingQueue();
  other.ingest([row("a", "原文"), row("b", "下一段")]);
  other.tick(0, fit);
  assert.equal(other.tick(60000, fit), "原文");
});
test("shrinking a window reflows unread text without dropping the tail", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "abcdefgh"), row("b", "next")]);
  clock(q, 0, 1900, true, (text) => text);
  assert.equal(clock(q, 2000, 3900, true, (text) => text.slice(0, 4)), "abcd");
  assert.equal(clock(q, 4000, 5900, true, (text) => text.slice(0, 4)), "efgh");
  assert.equal(clock(q, 6000, 6000, true, (text) => text.slice(0, 4)), "next");
});
test("an unmeasurable page does not advance; duration is bounded", () => {
  const q = new ReadingQueue();
  q.ingest([row("a", "内容"), row("b", "下文")]);
  clock(q, 0, 5000, true, () => "");
  assert.equal(clock(q, 5100, 7000), "内容");
  assert.equal(readingDuration("好"), 2000);
  assert.equal(readingDuration("测试".repeat(100)), 5000);
});
