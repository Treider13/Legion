// ============================================================================
// LEGION — LegionClient: протокольный слой поверх Transport.
// cmd(): отправка команды, сбор ответа до OK/ERR/JSON, таймаут.
// Сырой поток строк пробрасывается в журнал.
// ============================================================================
import type { Transport } from "../transport/types";

/** Телеметрия коридора (прошивка шлёт 10 Гц в режиме SWEEP/HOP/...) */
export interface TelemetryLine {
  t: number;
  freq: number;
  lock: number;
  mode: "SWEEP" | "HOP" | "CHIRP" | "GLIDE" | "FM_SIN" | "FM_TRI" | "FM_RAND";
}

/** Событие движка (напр. завершение GLIDE) — без поля freq */
export interface EngineEvent {
  t: number;
  event: string;  // напр. "GLIDE DONE"
}

export interface CmdResult {
  ok: boolean;
  lines: string[];
  /** Первая строка OK/ERR */
  statusLine: string;
}

const RESP_TIMEOUT_MS = 2000;

export class LegionClient {
  private waiters: Array<{
    resolve: (r: CmdResult) => void;
    lines: string[];
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.setEvents({
      onLine: (line) => this.dispatch(line),
      onState: (st, detail) => this.onStateChange?.(st, detail),
    });
  }

  /** Сырой поток (для журнала) */
  onRawLine: ((line: string) => void) | null = null;
  /** Телеметрия коридора (JSON с полем "t") — приходит незапрошенной */
  onTelemetry: ((t: TelemetryLine) => void) | null = null;
  /** События движка (GLIDE DONE и пр.) */
  onEngineEvent: ((e: EngineEvent) => void) | null = null;
  /** Состояние транспорта */
  onStateChange:
    | ((state: import("../transport/types").TransportState, detail?: string) => void)
    | null = null;

  private dispatch(line: string): void {
    // Телеметрия/события: JSON с маркером "t" — не ответ на команду.
    // В журнал НЕ пишем: при dwell 10 мс это флуд, который пересобирает
    // 500-строчный лог десятки раз в секунду и подвешивает UI
    // (для телеметрии есть live-маркер коридора).
    if (line.startsWith("{") && line.includes("\"t\":")) {
      try {
        const j = JSON.parse(line);
        if (typeof j.freq === "number") {
          this.onTelemetry?.(j as TelemetryLine);
        } else if (typeof j.event === "string") {
          this.onEngineEvent?.(j as EngineEvent);  // напр. GLIDE DONE
        }
      } catch {
        /* повреждённая телеметрия — пропускаем */
      }
      return;
    }
    this.onRawLine?.(line);
    const w = this.waiters[0];
    if (!w) return;
    w.lines.push(line);
    // Завершение ответа: строка OK/ERR или JSON-объект
    if (line.startsWith("OK") || line.startsWith("ERR") || line.startsWith("{")) {
      clearTimeout(w.timer);
      this.waiters.shift();
      w.resolve({
        ok: line.startsWith("OK") || line.startsWith("{"),
        lines: w.lines,
        statusLine: line,
      });
    }
  }

  async cmd(command: string, timeoutMs = RESP_TIMEOUT_MS): Promise<CmdResult> {
    const p = new Promise<CmdResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, lines: [], statusLine: "ERR TIMEOUT" });
      }, timeoutMs);
      this.waiters.push({ resolve, lines: [], timer });
    });
    await this.transport.writeLine(command);
    return p;
  }

  /** Удобные обёртки фазы 1 */
  hello() { return this.cmd("HELLO"); }
  setFreq(mhz: number) { return this.cmd(`SET FREQ ${mhz.toFixed(6)}`); }
  setPower(dbm: number) { return this.cmd(`SET POWER ${dbm}`); }
  setAtt(db: number) { return this.cmd(`SET ATT ${db.toFixed(2)}`); }
  // Выравнивание уровня через PE43702 (фаза 10)
  setLevel(dbm: number) { return this.cmd(`SET LEVEL ${dbm.toFixed(2)}`); }
  levelOff() { return this.cmd("SET LEVEL OFF"); }
  calLevel(freqMhz: number, dbm: number) {
    return this.cmd(`CAL LEVEL ${freqMhz.toFixed(3)} ${dbm.toFixed(2)}`);
  }
  calLevelClear() { return this.cmd("CAL LEVEL CLEAR"); }
  levelStatus() { return this.cmd("LEVEL?"); }
  rf(on: boolean) { return this.cmd(on ? "RF ON" : "RF OFF"); }
  status() { return this.cmd("STATUS?"); }
  regs() { return this.cmd("REGS?"); }
  selftest() { return this.cmd("SELFTEST", 5000); }
  calRef(ppm: number) { return this.cmd(`CAL REF ${ppm}`); }

  /** Коридор (фаза 3) + CHIRP/GLIDE/FM (фаза 6) */
  sweepStart(f1: number, f2: number, stepKhz: number, dwellMs: number) {
    return this.cmd(`SWEEP START ${f1} ${f2} STEP ${stepKhz} DWELL ${dwellMs}`);
  }
  hopStart(f1: number, f2: number, rateMs: number, seed: number, stepKhz: number) {
    return this.cmd(`HOP START ${f1} ${f2} RATE ${rateMs} SEED ${seed} STEP ${stepKhz}`);
  }
  chirpStart(f1: number, f2: number, stepHz: number, dwellMs: number) {
    return this.cmd(`CHIRP START ${f1} ${f2} STEP ${stepHz} DWELL ${dwellMs}`);
  }
  glide(targetMhz: number, durationMs: number) {
    return this.cmd(`GLIDE ${targetMhz} ${durationMs}`);
  }
  fmStart(shape: "SIN" | "TRI" | "RAND", centerMhz: number, depthKhz: number, rateMs: number) {
    return this.cmd(`FM START ${shape} CENTER ${centerMhz} DEPTH ${depthKhz} RATE ${rateMs}`);
  }
  stop() { return this.cmd("STOP"); }
}
