// ============================================================================
// LEGION — TauriSerialTransport: USB-UART через tauri-plugin-serialplugin v3
// (факт T2: внутри Rust serialport 4.5; API сверено с dist-js/*.d.ts v3.0.2:
//  SerialPort.available_ports(), new SerialPort({path, baudRate}),
//  open(), write(string), watch({onData}), close())
// ============================================================================
import { SerialPort } from "tauri-plugin-serialplugin-api";

import type {
  SerialPortDescriptor,
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "./types";

const BAUD = 115200;

export class TauriSerialTransport implements Transport {
  readonly kind: TransportKind = "tauri-serial";
  private port: SerialPort | null = null;
  private ev: TransportEvents | null = null;
  private lineBuf = "";
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  setEvents(ev: TransportEvents): void {
    this.ev = ev;
  }

  static async listPorts(): Promise<SerialPortDescriptor[]> {
    const ports = await SerialPort.available_ports();
    return Object.entries(ports).map(([path, info]) => ({
      path,
      label: `${path} — ${info.product !== "Unknown" ? info.product : info.type}`,
    }));
  }

  private emitState(s: TransportState, detail?: string) {
    this.ev?.onState(s, detail);
  }

  async connect(): Promise<void> {
    this.emitState("connecting");
    this.port = new SerialPort({ path: this.path, baudRate: BAUD });
    await this.port.open();
    await this.port.watch(
      {
        onData: (data) => this.onChunk(data),
        onDisconnect: (reason) => this.emitState("disconnected", reason),
        onError: (message) => this.emitState("error", message),
      },
      { decode: true },
    );
    this.emitState("connected");
  }

  private onChunk(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.lineBuf += text;
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (line.length > 0) {
        this.ev?.onLine(line);
      }
    }
  }

  async writeLine(line: string): Promise<void> {
    if (!this.port) throw new Error("port not open");
    await this.port.write(line + "\n");
  }

  async disconnect(): Promise<void> {
    const p = this.port;
    this.port = null;
    if (p) {
      await p.close();
    }
    this.emitState("disconnected");
  }
}
