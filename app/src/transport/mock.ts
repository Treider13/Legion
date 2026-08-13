// ============================================================================
// LEGION — MockTransport: эмулятор связки ESP32+ADF4351 для разработки и
// e2e-тестов без железа. Отвечает на фаза-1 протокол (docs/protocol.md).
// LOCK эмулируется с задержкой ~30 мс (реалистично: band select 20 мкс +
// settling ~0.3 мс, факты F4/F5 — mock намеренно медленнее железа).
// ============================================================================
import type {
  Transport,
  TransportEvents,
  TransportKind,
  TransportState,
} from "./types";

export class MockTransport implements Transport {
  readonly kind: TransportKind = "mock";
  private ev: TransportEvents | null = null;
  private freqMhz = 2475.0;
  private power = 5;
  private rfOn = false;
  private ppm = 0;

  setEvents(ev: TransportEvents): void {
    this.ev = ev;
  }

  private emitState(s: TransportState, detail?: string) {
    this.ev?.onState(s, detail);
  }

  private reply(line: string, delayMs = 5): void {
    setTimeout(() => this.ev?.onLine(line), delayMs);
  }

  async connect(): Promise<void> {
    this.emitState("connecting");
    await new Promise((r) => setTimeout(r, 50));
    this.emitState("connected");
    this.reply("LEGION READY", 10);
  }

  async writeLine(line: string): Promise<void> {
    const t = line.trim();
    const upper = t.toUpperCase();

    if (upper === "HELLO") {
      this.reply("OK LEGION 0.1.0 mock");
    } else if (upper.startsWith("SET FREQ")) {
      const mhz = parseFloat(t.split(/\s+/)[2] ?? "NaN");
      if (!Number.isFinite(mhz) || mhz <= 0) {
        this.reply("ERR SYNTAX bad freq");
      } else if (mhz < 34.375 || mhz > 4400) {
        this.reply("ERR RANGE 35-4400 MHz");
      } else {
        this.freqMhz = mhz;
        // LOCK с реалистичной задержкой (см. заголовок)
        this.reply(`OK FREQ=${mhz.toFixed(6)} LOCK=1 ERR_HZ=0.0`, 30);
      }
    } else if (upper.startsWith("SET POWER")) {
      const p = parseInt(t.split(/\s+/)[2] ?? "0", 10);
      if ([-4, -1, 2, 5].includes(p)) {
        this.power = p;
        this.reply(`OK POWER=${p}`);
      } else {
        this.reply("ERR RANGE power -4|-1|+2|+5");
      }
    } else if (upper === "RF ON" || upper === "RF OFF") {
      this.rfOn = upper === "RF ON";
      this.reply(`OK RF ${this.rfOn ? "ON" : "OFF"}`);
    } else if (upper === "STATUS?") {
      this.reply(
        JSON.stringify({
          freq: this.freqMhz,
          mode: "MANUAL",
          lock: 1,
          rf: this.rfOn ? 1 : 0,
          power: this.power,
          version: "0.1.0",
          board: "mock",
        }),
      );
    } else if (upper === "REGS?") {
      // Правдоподобные регистры для int-N на текущей частоте (25 МГц PFD)
      const vco = this.freqMhz >= 2200 ? this.freqMhz : this.freqMhz * 2;
      const intVal = Math.floor(vco / 25);
      const r0 = (intVal << 15) >>> 0;
      this.reply(
        JSON.stringify({
          regs: [
            `0x${r0.toString(16).padStart(8, "0")}`,
            "0x00008011",
            "0x18004fc2",
            "0x00e0000b",
            "0x0083203c",
            "0x00580005",
          ],
        }),
      );
    } else if (upper === "SELFTEST") {
      this.reply(
        '{"selftest":{"mux_gnd":1,"mux_dvdd":1,"lock":1,"pass":1}}',
        40,
      );
    } else if (upper.startsWith("CAL REF")) {
      this.ppm = parseFloat(t.split(/\s+/)[2] ?? "0");
      this.reply(`OK CAL REF ${this.ppm.toFixed(3)} ppm`);
    } else {
      this.reply(`ERR SYNTAX unknown command: ${t.split(/\s+/)[0]}`);
    }
  }

  async disconnect(): Promise<void> {
    this.emitState("disconnected");
  }
}
