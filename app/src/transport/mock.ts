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
  // Коридор (фаза 3)
  private corrActive = false;
  private corrMode: "SWEEP" | "HOP" | "CHIRP" = "SWEEP";
  private corrF1 = 2400;
  private corrF2 = 2500;
  private corrStepKhz = 1000;
  private corrCur = 2400;
  private corrTimer: ReturnType<typeof setInterval> | null = null;
  private hopState = 1;

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
    } else if (upper.startsWith("SET ATT")) {
      const db = parseFloat(t.split(/\s+/)[2] ?? "NaN");
      if (!Number.isFinite(db) || db < 0 || db > 31.75) {
        this.reply("ERR RANGE att 0-31.75");
      } else {
        this.reply(`OK ATT=${(Math.round(db / 0.25) * 0.25).toFixed(2)} dB`);
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
    } else if (upper.startsWith("SWEEP") || upper.startsWith("HOP") || upper.startsWith("CHIRP")) {
      const mode = upper.startsWith("SWEEP") ? "SWEEP" : upper.startsWith("HOP") ? "HOP" : "CHIRP";
      this.handleCorridor(t, mode);
    } else if (upper.startsWith("GLIDE")) {
      const parts = t.split(/\s+/);
      const target = parseFloat(parts[1] ?? "NaN");
      const dur = parseInt(parts[2] ?? "0", 10);
      if (!Number.isFinite(target) || !dur) {
        this.reply("ERR SYNTAX GLIDE <targetMHz> <durationMs>");
      } else {
        this.reply(`OK GLIDE RUNNING ${this.freqMhz.toFixed(6)} -> ${target.toFixed(6)}`);
        this.freqMhz = target;
      }
    } else if (upper.startsWith("FM")) {
      const parts = t.split(/\s+/);
      if ((parts[1] ?? "").toUpperCase() === "STOP") {
        this.stopCorridor();
        this.reply("OK IDLE");
      } else {
        this.reply(`OK FM RUNNING ${(parts[2] ?? "SIN").toUpperCase()}`);
      }
    } else if (upper === "STOP") {
      this.stopCorridor();
      this.reply("OK IDLE");
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
    this.stopCorridor();
    this.emitState("disconnected");
  }

  // --- Коридор (фаза 3) ---------------------------------------------------

  private handleCorridor(line: string, mode: "SWEEP" | "HOP" | "CHIRP"): void {
    const parts = line.split(/\s+/);
    const sub = (parts[1] ?? "").toUpperCase();
    if (sub === "STOP") {
      this.stopCorridor();
      this.reply("OK IDLE");
      return;
    }
    if (sub !== "START") {
      this.reply("ERR SYNTAX START|STOP expected");
      return;
    }
    const f1 = parseFloat(parts[2] ?? "NaN");
    const f2 = parseFloat(parts[3] ?? "NaN");
    if (!Number.isFinite(f1) || !Number.isFinite(f2) || f1 < 34.375 || f2 > 4400 || f1 >= f2) {
      this.reply("ERR RANGE corridor");
      return;
    }
    // SWEEP/HOP: STEP в кГц; CHIRP: STEP в Гц (как прошивка)
    let step = mode === "CHIRP" ? 100000 : 1000;
    let dwell = 10;
    let seed = 1;
    for (let i = 4; i + 1 < parts.length; i += 2) {
      const k = parts[i].toUpperCase();
      const v = parts[i + 1];
      if (k === "STEP") step = parseInt(v, 10);
      if (k === "DWELL" || k === "RATE") dwell = parseInt(v, 10);
      if (k === "SEED") seed = parseInt(v, 10);
    }
    if (dwell < 1) {
      this.reply("ERR DWELL min 1 ms");
      return;
    }
    this.corrMode = mode;
    this.corrF1 = f1;
    this.corrF2 = f2;
    this.corrStepKhz = mode === "CHIRP" ? step / 1000 : step;  // CHIRP: Гц → кГц
    this.corrCur = f1;
    this.hopState = seed || 0x9e3779b9;
    this.corrActive = true;
    this.reply(`OK ${this.corrMode} RUNNING`);

    // Телеметрия 10 Гц + перестройка по dwell (как прошивка)
    const dwellClamped = Math.max(dwell, 20); // в mock не быстрее 50 Гц — достаточно для UI
    this.corrTimer = setInterval(() => {
      if (!this.corrActive) return;
      if (this.corrMode === "SWEEP") {
        this.corrCur += this.corrStepKhz / 1000;
        if (this.corrCur > this.corrF2) this.corrCur = this.corrF1;
      } else {
        this.hopState ^= (this.hopState << 13) >>> 0;
        this.hopState ^= this.hopState >>> 17;
        this.hopState ^= (this.hopState << 5) >>> 0;
        const steps = Math.floor(((this.corrF2 - this.corrF1) * 1000) / this.corrStepKhz);
        this.corrCur =
          this.corrF1 + ((this.hopState % (steps + 1)) * this.corrStepKhz) / 1000;
      }
      this.ev?.onLine(
        JSON.stringify({
          t: Date.now() & 0xffffffff,
          freq: Math.round(this.corrCur * 1e6) / 1e6,
          lock: 1,
          mode: this.corrMode,
        }),
      );
    }, dwellClamped);
  }

  private stopCorridor(): void {
    this.corrActive = false;
    if (this.corrTimer) {
      clearInterval(this.corrTimer);
      this.corrTimer = null;
    }
  }
}
