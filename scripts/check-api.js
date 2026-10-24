import WebSocket from "ws";
import { sessionConfig } from "../server/protocol.js";
if (!process.env.QWEN_API_KEY) throw Error("Set QWEN_API_KEY in .env first.");
const model = process.env.QWEN_MODEL || "qwen3.8-livetranslate-flash-realtime";
const endpoint = new URL(
  process.env.QWEN_REALTIME_URL ||
    "wss://maas.qianwenaiapi.com/api-ws/v1/realtime",
);
endpoint.searchParams.set("model", model);
for (const lang of ["en", "zh"]) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}` },
      handshakeTimeout: 12000,
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(Error("Session configuration timeout"));
    }, 20000);
    ws.on("open", () =>
      ws.send(
        JSON.stringify(
          sessionConfig(lang, [
            ["原理图", "schematic"],
            ["KiCad", "KiCad"],
          ]),
        ),
      ),
    );
    ws.on("message", (data) => {
      const e = JSON.parse(data);
      if (e.type === "session.updated") {
        console.log(
          `OK ${e.session.model} → ${lang}; text-only + glossary accepted`,
        );
        clearTimeout(timer);
        ws.close();
        resolve();
      }
      if (e.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(Error(e.error?.message || "API error"));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
