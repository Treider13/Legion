// ============================================================================
// LEGION — smoke-тест WebSocketTransport (фаза 4): поднимаем локальный
// WS-сервер (пакет ws), эмулирующий ASCII-протокол ESP32, гоняем клиент.
// Запуск: npx tsx scripts/smoke_ws.ts
// ============================================================================
import { WebSocketServer } from "ws";

import { LegionClient } from "../src/protocol/client";
import { WebSocketTransport } from "../src/transport/websocket";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name} ${cond ? "" : detail}`);
  if (!cond) failures++;
}

async function main(): Promise<void> {
  // Мини-эмулятор ESP32 по WS (те же ASCII-строки)
  const wss = new WebSocketServer({ port: 18181, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const line = String(data).trim();
      if (line === "HELLO") ws.send("OK LEGION 0.1.0 ws-emu\n");
      else if (line.startsWith("SET FREQ")) ws.send("OK FREQ=2475.000000 LOCK=1 ERR_HZ=0.0\n");
      else if (line === "STATUS?") ws.send('{"freq":2475.0,"mode":"MANUAL","lock":1,"rf":0,"power":3,"version":"0.1.0","board":"ws-emu"}\n');
      else ws.send("ERR SYNTAX\n");
    });
  });

  const transport = new WebSocketTransport("ws://127.0.0.1:18181/ws");
  const client = new LegionClient(transport);

  await transport.connect();
  check("WS connect", true);

  let r = await client.hello();
  check("HELLO over WS", r.ok && r.statusLine.includes("ws-emu"), r.statusLine);

  r = await client.setFreq(2475);
  check("SET FREQ over WS", r.ok && r.statusLine.includes("LOCK=1"), r.statusLine);

  r = await client.status();
  let ok = false;
  try {
    ok = JSON.parse(r.statusLine).board === "ws-emu";
  } catch { /* noop */ }
  check("STATUS? over WS", r.ok && ok, r.statusLine);

  await transport.disconnect();
  wss.close();
  console.log(failures === 0 ? "\nWS SMOKE: ALL PASS" : `\nWS SMOKE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
