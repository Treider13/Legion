// ============================================================================
// LEGION — Sl22Transport: COM SL22 + переводчик map.ts.
// На проводе — SCPI \r\n; в LegionClient — те же OK/ERR, что у ESP32.
// Ответы прибора на шину клиента не пускаем (ломают waiter: нет префикса OK).
// ============================================================================
import { SerialPort } from "tauri-plugin-serialplugin-api";

import type {
  SerialPortDescriptor,
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "../transport/types";
import { mapLegionToSl22, sl22StatusJson } from "./map";

const BAUD = 115200;

export class Sl22Transport implements Transport {
  readonly kind: TransportKind = "htool-sl22";
  private port: SerialPort | null = null;
  private ev: TransportEvents | null = null;
  private lineBuf = "";
  private path: string;
  private reading = false;
  private freqMhz = 2475;
  private rfOn = false;
  private powerDbm = 5;
  private mode = "IDLE";
  private idn = "htool-sl22";

  constructor(path: string) {
    this.path = path;
  }

  setEvents(ev: TransportEvents): void {
    this.ev = ev;
  }

  static listPorts(): Promise<SerialPortDescriptor[]> {
    return import("../transport/tauriSerial").then((m) => m.TauriSerialTransport.listPorts());
  }

  private emitState(s: TransportState, detail?: string) {
    this.ev?.onState(s, detail);
  }

  private reply(line: string, delayMs = 20): void {
    setTimeout(() => this.ev?.onLine(line), delayMs);
  }

  async connect(): Promise<void> {
    this.emitState("connecting");
    this.port = new SerialPort({ path: this.path, baudRate: BAUD, timeout: 100 });
    await this.port.open();
    this.reading = true;
    void this.readLoop();
    // Обязательный вход в SCPI (гайд: первая команда *IDN?).
    await this.writeScpi("*IDN?");
    this.emitState("connected", "SL22 SCPI");
  }

  private async readLoop(): Promise<void> {
    while (this.reading && this.port) {
      try {
        const chunk = await this.port.read({ timeout: 100 });
        if (chunk) this.onChunk(chunk);
      } catch (e) {
        const msg = String(e);
        if (!/timeout|timed out/i.test(msg)) {
          this.emitState("error", msg);
          break;
        }
      }
    }
  }

  private onChunk(data: string | Uint8Array): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.lineBuf += text;
    let idx: number;
    while ((idx = this.lineBuf.indexOf("\n")) >= 0) {
      const line = this.lineBuf.slice(0, idx).replace(/\r$/, "");
      this.lineBuf = this.lineBuf.slice(idx + 1);
      if (line.length === 0) continue;
      if (line.includes("HTOOL") || line.includes("SL22") || line.startsWith("HTOOL")) {
        this.idn = line.slice(0, 80);
      }
      // не forward в LegionClient
    }
  }

  private async writeScpi(cmd: string): Promise<void> {
    if (!this.port) throw new Error("SL22 port not open");
    await this.port.write(cmd + "\r\n");
  }

  async writeLine(line: string): Promise<void> {
    const mapped = mapLegionToSl22(line);
    for (const scpi of mapped.scpi) {
      await this.writeScpi(scpi);
    }

    const u = line.trim().toUpperCase();
    if (u.startsWith("SET FREQ")) {
      const mhz = parseFloat(line.trim().split(/\s+/)[2] ?? "");
      if (Number.isFinite(mhz)) {
        this.freqMhz = mhz;
        this.mode = "MANUAL";
      }
    } else if (u === "RF ON") this.rfOn = true;
    else if (u === "RF OFF" || u === "STOP") {
      this.rfOn = false;
      if (u === "STOP") this.mode = "IDLE";
    } else if (u.startsWith("SET POWER")) {
      const p = parseInt(line.trim().split(/\s+/)[2] ?? "", 10);
      if (Number.isFinite(p)) this.powerDbm = p;
    } else if (u.startsWith("SWEEP START") && mapped.reply.startsWith("OK")) {
      this.mode = "SWEEP";
      this.rfOn = true;
    }

    if (mapped.reply === "__STATUS__") {
      this.reply(
        sl22StatusJson({
          freqMhz: this.freqMhz,
          rfOn: this.rfOn,
          powerDbm: this.powerDbm,
          mode: this.mode,
        }),
      );
      return;
    }

    if (u === "HELLO") {
      this.reply(`OK LEGION SL22 ${this.idn}`);
      return;
    }

    this.reply(mapped.reply);
  }

  async disconnect(): Promise<void> {
    try {
      if (this.port) await this.writeScpi("GENErator:STATus OFF");
    } catch {
      /* ignore */
    }
    this.reading = false;
    const p = this.port;
    this.port = null;
    if (p) await p.close();
    this.emitState("disconnected");
  }
}
