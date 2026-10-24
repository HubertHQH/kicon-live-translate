import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal } from "../server/archive.js";
test("journal restores the complete session and newest revision after a truncated write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kicon-archive-"));
  try {
    const lines = [
      JSON.stringify({ type: "session", startedAt: 1000, mode: "auto" }),
    ];
    for (let i = 0; i < 2100; i++)
      lines.push(
        JSON.stringify({ type: "row", row: { id: String(i), text: "draft" } }),
      );
    lines.push(
      JSON.stringify({ type: "row", row: { id: "0", text: "final" } }),
      JSON.stringify({
        type: "usage",
        usage: { totalTokens: 120, estimatedCost: 0.0056 },
      }),
      JSON.stringify({ type: "end", at: 121000 }),
      '{"type":',
    );
    await writeFile(join(dir, "test.jsonl"), lines.join("\n"));
    const session = await readJournal(join(dir, "test.jsonl"));
    assert.equal(session.rows.length, 2100);
    assert.equal(session.rows[0].text, "final");
    assert.equal(session.startedAt, 1000);
    assert.equal(session.endedAt, 121000);
    assert.equal(session.usage.totalTokens, 120);
    assert.equal(session.usage.estimatedCost, 0.0056);
  } finally {
    await rm(dir, { recursive: true });
  }
});
