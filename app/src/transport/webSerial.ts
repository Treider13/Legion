// ============================================================================
// LEGION — WebSerialTransport: USB-UART прямо из браузера (факт T1:
// Chrome/Edge 89+, Firefox 151+, Android Chrome 138+; требует HTTPS).
// Бонусный транспорт: та же web-сборка работает без установки Tauri.
// ============================================================================
import type {
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "./types";

const BAUD = 115200;

// Минимальные ambient-типы Web Serial (в lib.dom TS они могут отсутствовать)
interface WebSerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface WebSerialNavigator extends Navigator {
  serial: {
    requestPort(): Promise<WebSerialPort>;
    getPorts(): Promise<WebSerialPort[]>;
  };
}

export class WebSerialTransport implements Transport {
  readonly kind: TransportKind = "web-serial";
  private port: WebSerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private ev: TransportEvents | null = null;
  private lineBuf = "";
  private closed = false;

  setEvents(ev: TransportEvents): void {
    this.ev = ev;
  }

  private emitState(s: TransportState, detail?: string) {
    this.ev?.onState(s, detail);
  }

  async connect(): Promise<void> {
    this.emitState("connecting");
    const nav = navigator as WebSerialNavigator;
    this.port = await nav.serial.requestPort(); // выбор пользователем (user gesture)
    await this.port.open({ baudRate: BAUD });
    this.closed = false;
    this.emitState("connected");
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    if (!this.port?.readable) return;
    this.reader = this.port.readable.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done || this.closed) break;
        if (value) {
          this.lineBuf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
            const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
            this.lineBuf = this.lineBuf.slice(idx + 1);
            if (line.length > 0) this.ev?.onLine(line);
          }
        }
      }
    } catch {
      this.emitState("error", "web serial read failed");
    } finally {
      this.reader?.releaseLock();
      this.reader = null;
    }
  }

  async writeLine(line: string): Promise<void> {
    if (!this.port?.writable) throw new Error("port not open");
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(line + "\n"));
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
    this.emitState("disconnected");
  }
}
