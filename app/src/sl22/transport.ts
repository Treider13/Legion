// ============================================================================
// SL22 USB: SCPI \r\n. LegionClient видит только синтетические OK/ERR.
// Коридор: таймер на ПК, на провод только GENErator:POINt (есть в гайде).
// ============================================================================
import { SerialPort } from "tauri-plugin-serialplugin-api";

import type {
  SerialPortDescriptor,
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "../transport/types";
import { mapLegionToSl22, sl22StatusJson, sweepNextMhz, type Sl22SweepPlan } from "./map";

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
  private sweep: Sl22SweepPlan | null = null;
  private sweepGen = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private firstLineWait: ((line: string) => void) | null = null;

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

  private stopSweep(): void {
    this.sweepGen += 1;
    this.sweep = null;
  }

  private enqueueScpi(cmd: string): Promise<void> {
    const run = this.writeChain.then(() => this.writeScpi(cmd));
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async point(mhz: number): Promise<void> {
    this.freqMhz = mhz;
    await this.enqueueScpi(`GENErator:POINt ${mhz.toFixed(3)}`);
    this.ev?.onLine(
      JSON.stringify({ t: Date.now(), freq: mhz, lock: 0, mode: "SWEEP" as const }),
    );
  }

  private startSweep(plan: Sl22SweepPlan): void {
    this.stopSweep();
    this.sweep = plan;
    this.mode = "SWEEP";
    this.rfOn = true;
    this.freqMhz = plan.f1;
    const gen = this.sweepGen;
    // f1 и STATus ON уже ушли в mapped.scpi (порядок как в гайде).
    this.ev?.onLine(
      JSON.stringify({ t: Date.now(), freq: plan.f1, lock: 0, mode: "SWEEP" as const }),
    );
    void this.runSweep(gen);
  }

  private async runSweep(gen: number): Promise<void> {
    while (this.sweep && this.port && gen === this.sweepGen) {
      const dwell = this.sweep.dwellMs;
      await new Promise((r) => setTimeout(r, dwell));
      if (!this.sweep || !this.port || gen !== this.sweepGen) return;
      const next = sweepNextMhz(this.freqMhz, this.sweep.f1, this.sweep.f2, this.sweep.stepMhz);
      try {
        await this.point(next);
      } catch {
        return;
      }
    }
  }

  private waitFirstLine(ms: number): Promise<string | null> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.firstLineWait = null;
        resolve(null);
      }, ms);
      this.firstLineWait = (line) => {
        clearTimeout(t);
        this.firstLineWait = null;
        resolve(line);
      };
    });
  }

  async connect(): Promise<void> {
    this.emitState("connecting");
    this.port = new SerialPort({ path: this.path, baudRate: BAUD, timeout: 100 });
    await this.port.open();
    this.reading = true;
    void this.readLoop();
    // Гайд: первая команда обязана быть *IDN?\r\n, иначе SCPI не включается.
    const pending = this.waitFirstLine(500);
    await this.writeScpi("*IDN?");
    const first = await pending;
    if (first?.startsWith("ERR")) {
      await this.hardClose();
      const msg = `not SL22 SCPI: port replied "${first.slice(0, 60)}" (ESP32/LEGION ASCII on this COM?)`;
      this.emitState("error", msg);
      throw new Error(msg);
    }
    if (first) this.idn = first.slice(0, 80);
    this.emitState("connected", "SL22 SCPI");
  }

  private async hardClose(): Promise<void> {
    this.stopSweep();
    this.reading = false;
    const p = this.port;
    this.port = null;
    if (p) await p.close();
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
      if (this.firstLineWait) this.firstLineWait(line);
      if (/HTOOL|SL22/i.test(line)) this.idn = line.slice(0, 80);
    }
  }

  private async writeScpi(cmd: string): Promise<void> {
    if (!this.port) throw new Error("SL22 port not open");
    await this.port.write(cmd + "\r\n");
  }

  async writeLine(line: string): Promise<void> {
    const mapped = mapLegionToSl22(line);
    const u = line.trim().toUpperCase();

    if (u.startsWith("SET FREQ") || u === "STOP" || u === "RF OFF") {
      this.stopSweep();
      if (u === "STOP") this.mode = "IDLE";
    }

    for (const scpi of mapped.scpi) {
      await this.enqueueScpi(scpi);
    }

    if (u.startsWith("SET FREQ")) {
      const mhz = parseFloat(line.trim().split(/\s+/)[2] ?? "");
      if (Number.isFinite(mhz) && mapped.reply.startsWith("OK")) {
        this.freqMhz = mhz;
        this.mode = "MANUAL";
      }
    } else if (u === "RF ON") this.rfOn = true;
    else if (u === "RF OFF" || u === "STOP") this.rfOn = false;
    else if (u.startsWith("SET POWER")) {
      const p = parseInt(line.trim().split(/\s+/)[2] ?? "", 10);
      if (Number.isFinite(p)) this.powerDbm = p;
    }

    if (mapped.sweep && mapped.reply.startsWith("OK")) {
      this.startSweep(mapped.sweep);
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
    this.stopSweep();
    try {
      if (this.port) await this.enqueueScpi("GENErator:STATus OFF");
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
