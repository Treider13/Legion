// ============================================================================
// LEGION — WebSocketTransport: WiFi-транспорт (ESP32 AP/STA).
// Клиентская сторона готова в фазе 2; сервер на ESP32 — фаза 4.
// Протокол: те же ASCII-строки, по одной команде на WS-фрейм.
// ============================================================================
import type {
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "./types";

export class WebSocketTransport implements Transport {
  readonly kind: TransportKind = "websocket";
  private ws: WebSocket | null = null;
  private ev: TransportEvents | null = null;
  private lineBuf = "";
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  setEvents(ev: TransportEvents): void {
    this.ev = ev;
  }

  private emitState(s: TransportState, detail?: string) {
    this.ev?.onState(s, detail);
  }

  connect(): Promise<void> {
    this.emitState("connecting");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.emitState("connected");
        resolve();
      };
      ws.onerror = () => {
        this.emitState("error", "websocket error");
        reject(new Error("websocket error"));
      };
      ws.onclose = (e) => this.emitState("disconnected", e.reason);
      ws.onmessage = (m) => {
        this.lineBuf += String(m.data);
        let idx: number;
        while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
          const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
          this.lineBuf = this.lineBuf.slice(idx + 1);
          if (line.length > 0) this.ev?.onLine(line);
        }
      };
    });
  }

  async writeLine(line: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("websocket not open");
    }
    this.ws.send(line + "\n");
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.emitState("disconnected");
  }
}
