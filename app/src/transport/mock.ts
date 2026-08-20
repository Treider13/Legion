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
  // Выравнивание уровня (фаза 10): калибровочная таблица + цель
  private levelPts: Array<{ f: number; dbm: number }> = [];
  private levelOn = false;
  private levelTarget = 0;
  // Коридор (фаза 3)
  private corrActive = false;
  private corrMode: "SWEEP" | "HOP" | "CHIRP" = "SWEEP";
  private corrF1 = 2400;
  private corrF2 = 2500;
  private corrStepKhz = 1000;
  private corrCur = 2400;
  private corrTimer: ReturnType<typeof setInterval> | null = null;
  private hopState = 1;
  // Политика актуатора (фаза 11) — зеркало firmware/policy.cpp
  private allow: Array<[number, number]> = [];
  private loadOk = true;
  private paMa = 0;
  private paOn = false;

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
        this.levelOn = false;  // ручной override отключает авто-выравнивание (как прошивка)
        this.reply(`OK ATT=${(Math.round(db / 0.25) * 0.25).toFixed(2)} dB`);
      }
    } else if (upper.startsWith("SET LEVEL")) {
      const a = t.split(/\s+/)[2] ?? "";
      if (a.toUpperCase() === "OFF") {
        this.levelOn = false;
        this.reply("OK LEVEL OFF");
      } else {
        const dbm = parseFloat(a);
        if (!Number.isFinite(dbm)) {
          this.reply("ERR SYNTAX bad level dBm");
        } else {
          this.levelOn = true;
          this.levelTarget = dbm;
          if (this.levelPts.length > 0) {
            const att = this.levelAtten(this.freqMhz);
            this.reply(`OK LEVEL=${dbm.toFixed(2)} ATT=${att.toFixed(2)} dB`);
          } else {
            this.reply(`OK LEVEL=${dbm.toFixed(2)} (no cal — add points via CAL LEVEL)`);
          }
        }
      }
    } else if (upper.startsWith("CAL LEVEL")) {
      const parts = t.split(/\s+/);
      if ((parts[2] ?? "").toUpperCase() === "CLEAR") {
        this.levelPts = [];
        this.reply("OK CAL LEVEL CLEAR n=0");
      } else {
        const f = parseFloat(parts[2] ?? "NaN");
        const dbm = parseFloat(parts[3] ?? "NaN");
        if (!Number.isFinite(f) || !Number.isFinite(dbm) || f <= 0) {
          this.reply("ERR SYNTAX CAL LEVEL <freqMHz> <dBm>|CLEAR");
        } else {
          const i = this.levelPts.findIndex((p) => Math.abs(p.f - f) < 1e-6);
          if (i >= 0) this.levelPts[i].dbm = dbm;
          else this.levelPts.push({ f, dbm });
          this.levelPts.sort((a, b) => a.f - b.f);
          this.reply(`OK CAL LEVEL ${f.toFixed(3)} ${dbm.toFixed(2)} n=${this.levelPts.length}`);
        }
      }
    } else if (upper === "LEVEL?") {
      this.reply(
        JSON.stringify({
          enabled: this.levelOn ? 1 : 0,
          target: this.levelTarget,
          points: this.levelPts.map((p) => [p.f, p.dbm]),
        }),
      );
    } else if (upper === "RF ON" || upper === "RF OFF") {
      const on = upper === "RF ON";
      if (on) {
        if (!this.loadOk) {
          this.reply("ERR LOAD dummy load required");
          return;
        }
        if (this.allow.length > 0 && !this.inAllow(this.freqMhz)) {
          this.reply("ERR ALLOW frequency not in allowlist");
          return;
        }
      }
      this.rfOn = on;
      this.reply(`OK RF ${this.rfOn ? "ON" : "OFF"}`);
    } else if (upper.startsWith("ALLOW") || upper === "ALLOW?") {
      this.handleAllow(t, upper);
    } else if (upper.startsWith("LOAD") || upper === "LOAD?") {
      this.handleLoad(upper);
    } else if (upper.startsWith("PA") || upper === "PA?") {
      this.handlePa(t, upper);
    } else if (upper.startsWith("CUE")) {
      this.handleCue(t);
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
          load: this.loadOk ? 1 : 0,
          pa: this.paOn ? 1 : 0,
          pa_ma: this.paMa,
          allow_n: this.allow.length,
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
    if (this.allow.length > 0 && !this.allow.some(([a, b]) => f1 >= a && f2 <= b)) {
      this.reply("ERR ALLOW corridor outside allowlist");
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

  // Выравнивание уровня: интерполяция измеренного + требуемое затухание
  // (зеркало leveling_math.h; PE43702 только ослабляет, квант 0.25 дБ).
  private levelAtten(freqMhz: number): number {
    const pts = this.levelPts;
    if (pts.length === 0) return 0;
    let measured: number;
    if (freqMhz <= pts[0].f) measured = pts[0].dbm;
    else if (freqMhz >= pts[pts.length - 1].f) measured = pts[pts.length - 1].dbm;
    else {
      measured = pts[pts.length - 1].dbm;
      for (let i = 1; i < pts.length; i++) {
        if (freqMhz <= pts[i].f) {
          const t = (freqMhz - pts[i - 1].f) / (pts[i].f - pts[i - 1].f);
          measured = pts[i - 1].dbm + t * (pts[i].dbm - pts[i - 1].dbm);
          break;
        }
      }
    }
    let db = measured - this.levelTarget;
    if (db < 0) db = 0;
    if (db > 31.75) db = 31.75;
    return Math.round(db / 0.25) * 0.25;
  }

  private inAllow(mhz: number): boolean {
    if (this.allow.length === 0) return true;
    return this.allow.some(([a, b]) => mhz >= a && mhz <= b);
  }

  private handleAllow(t: string, upper: string): void {
    const parts = t.split(/\s+/);
    const sub = (parts[1] ?? (upper.endsWith("?") ? "?" : "")).toUpperCase();
    if (upper === "ALLOW?" || sub === "?" || sub === "STATUS?") {
      this.reply(JSON.stringify({ n: this.allow.length, allow: this.allow }));
      return;
    }
    if (sub === "CLEAR") {
      this.allow = [];
      this.reply("OK ALLOW n=0");
      return;
    }
    if (sub !== "ADD") {
      this.reply("ERR SYNTAX ALLOW ADD|CLEAR|?");
      return;
    }
    const f1 = parseFloat(parts[2] ?? "NaN");
    const f2 = parseFloat(parts[3] ?? "NaN");
    if (!Number.isFinite(f1) || !Number.isFinite(f2) || f2 < f1 || f1 < 34.375 || f2 > 4400) {
      this.reply("ERR RANGE allow 35-4400 MHz");
      return;
    }
    if (this.allow.length >= 8) {
      this.reply("ERR RANGE allow table full");
      return;
    }
    this.allow.push([f1, f2]);
    this.reply(`OK ALLOW n=${this.allow.length}`);
  }

  private handleLoad(upper: string): void {
    const sub = upper === "LOAD?" ? "?" : upper.split(/\s+/)[1] ?? "";
    if (sub === "?") {
      this.reply(JSON.stringify({ load: this.loadOk ? 1 : 0 }));
      return;
    }
    if (sub === "OK") {
      this.loadOk = true;
      this.reply("OK LOAD OK");
      return;
    }
    if (sub === "FAULT") {
      this.loadOk = false;
      this.paOn = false;
      this.rfOn = false;
      this.reply("OK LOAD FAULT");
      return;
    }
    this.reply("ERR SYNTAX LOAD OK|FAULT|?");
  }

  private handlePa(t: string, upper: string): void {
    const parts = t.split(/\s+/);
    const sub = (parts[1] ?? (upper === "PA?" ? "?" : "")).toUpperCase();
    if (upper === "PA?" || sub === "?") {
      this.reply(JSON.stringify({ pa: this.paOn ? 1 : 0, ma: this.paMa }));
      return;
    }
    if (sub === "ON") {
      if (!this.loadOk) {
        this.reply("ERR LOAD dummy load required");
        return;
      }
      if (this.paMa === 0) {
        this.reply("ERR RANGE PA current");
        return;
      }
      this.paOn = true;
      this.reply(`OK PA ON I=${this.paMa}`);
      return;
    }
    if (sub === "OFF") {
      this.paOn = false;
      this.reply("OK PA OFF");
      return;
    }
    if (sub === "SET" && (parts[2] ?? "").toUpperCase() === "I") {
      const ma = parseInt(parts[3] ?? "NaN", 10);
      if (!Number.isFinite(ma) || ma < 0 || ma > 1500) {
        this.reply("ERR RANGE PA current 0-1500 mA");
        return;
      }
      this.paMa = ma;
      if (ma === 0) this.paOn = false;
      this.reply(`OK PA I=${ma}`);
      return;
    }
    this.reply("ERR SYNTAX PA SET|ON|OFF|?");
  }

  private handleCue(t: string): void {
    const mhz = parseFloat(t.split(/\s+/)[1] ?? "NaN");
    if (!Number.isFinite(mhz) || mhz <= 0) {
      this.reply("ERR SYNTAX bad freq");
      return;
    }
    if (this.allow.length === 0 || !this.inAllow(mhz)) {
      this.reply("ERR ALLOW cue requires allowlist hit");
      return;
    }
    if (mhz < 34.375 || mhz > 4400) {
      this.reply("ERR RANGE 35-4400 MHz");
      return;
    }
    this.freqMhz = mhz;
    this.corrActive = false;
    this.reply(`OK CUE FREQ=${mhz.toFixed(6)} LOCK=1`, 30);
  }

  private stopCorridor(): void {
    this.corrActive = false;
    if (this.corrTimer) {
      clearInterval(this.corrTimer);
      this.corrTimer = null;
    }
  }
}
