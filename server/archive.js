import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function readJournal(path) {
  const rows = new Map();
  let session,
    usage,
    endedAt = null,
    error = null;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "session") session = event;
    if (event.type === "row") rows.set(event.row.id, event.row);
    if (event.usage) usage = event.usage;
    if (event.type === "end" && Number.isFinite(event.at)) {
      endedAt = event.at;
      error = event.error ?? null;
    }
  }
  if (!session) throw Error("No session in archive");
  return { ...session, usage, endedAt, error, rows: [...rows.values()] };
}
