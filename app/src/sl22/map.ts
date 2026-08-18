// ============================================================================
// LEGION ↔ HTOOL SL22 — только команды из разбора SCPI (Python-класс / гайд).
// На проводе проверены строками:
//   *IDN?
//   GENErator:POINt <MHz>
//   GENErator:STATus ON|OFF
//   FREQuency:LOPW 0..7
//   GENErator:SINGle start,stop,step,t_ms
//   GENErator:CYCLe start,stop,t_ms     ← шага в сериализованной строке нет
//
// Коридор LEGION (бесконечный + шаг из UI) через CYCLe не воспроизвести
// без домыслов: в коде гайда step у CYCLe принимается и не отправляется.
// Поэтому SWEEP в мосте = план для хоста: только POINt + STATus (они в списке).
// SINGle/CYCLe с провода мост не шлёт.
//
// Полоса 45–22600 МГц — из тех же текстов и из даташита LMX2820, не «22 МГц».
// LOCK в SCPI нет — в ответах LOCK не пишем.
// P0 ниже P7 (гайд). Четыре кнопки UI → LOPW 0,1,2,3 (не дБм).
// ============================================================================

export const SL22_FMIN_MHZ = 45;
export const SL22_FMAX_MHZ = 22600;

/** Кнопки −4/−1/+2/+5 → младшие ступени P0…P3. Не дБм прибора. */
export const POWER_DBM_TO_LOPW: Record<number, number> = {
  [-4]: 0,
  [-1]: 1,
  [2]: 2,
  [5]: 3,
};

export interface Sl22SweepPlan {
  f1: number;
  f2: number;
  stepMhz: number;
  dwellMs: number;
}

export interface Sl22Mapped {
  scpi: string[];
  reply: string;
  sweep?: Sl22SweepPlan;
}

function inBand(mhz: number): boolean {
  return Number.isFinite(mhz) && mhz >= SL22_FMIN_MHZ && mhz <= SL22_FMAX_MHZ;
}

export function stepKhzToMhz(stepKhz: number): number {
  return stepKhz / 1000;
}

/** Как firmware `engine_sweep_next`: cur += step; если cur > f2 → f1. */
export function sweepNextMhz(cur: number, f1: number, f2: number, stepMhz: number): number {
  const next = cur + stepMhz;
  return next > f2 ? f1 : next;
}

export function mapLegionToSl22(line: string): Sl22Mapped {
  const t = line.trim();
  const u = t.toUpperCase();

  if (u === "HELLO") {
    return { scpi: ["*IDN?"], reply: "OK LEGION SL22 htool" };
  }

  if (u.startsWith("SET FREQ")) {
    const mhz = parseFloat(t.split(/\s+/)[2] ?? "NaN");
    if (!Number.isFinite(mhz)) {
      return { scpi: [], reply: "ERR SYNTAX bad freq" };
    }
    if (!inBand(mhz)) {
      return { scpi: [], reply: `ERR RANGE ${SL22_FMIN_MHZ}-${SL22_FMAX_MHZ} MHz` };
    }
    return {
      scpi: [`GENErator:POINt ${mhz.toFixed(3)}`],
      reply: `OK FREQ=${mhz.toFixed(6)}`,
    };
  }

  if (u.startsWith("SET POWER")) {
    const dbm = parseInt(t.split(/\s+/)[2] ?? "", 10);
    const lopw = POWER_DBM_TO_LOPW[dbm];
    if (lopw === undefined) {
      return { scpi: [], reply: "ERR RANGE power -4|-1|+2|+5 (LOPW 0..3)" };
    }
    return { scpi: [`FREQuency:LOPW ${lopw}`], reply: `OK POWER=${dbm} LOPW=${lopw}` };
  }

  if (u === "RF ON" || u === "RF OFF") {
    const on = u.endsWith("ON");
    return {
      scpi: [`GENErator:STATus ${on ? "ON" : "OFF"}`],
      reply: on ? "OK RF ON" : "OK RF OFF",
    };
  }

  if (u === "STOP") {
    return { scpi: ["GENErator:STATus OFF"], reply: "OK IDLE" };
  }

  if (u.startsWith("SWEEP START")) {
    const m = /SWEEP START\s+(\S+)\s+(\S+)\s+STEP\s+(\S+)\s+DWELL\s+(\S+)/i.exec(t);
    if (!m) return { scpi: [], reply: "ERR SYNTAX SWEEP" };
    const f1 = parseFloat(m[1]);
    const f2 = parseFloat(m[2]);
    const stepKhz = parseFloat(m[3]);
    const dwell = parseFloat(m[4]);
    if (![f1, f2, stepKhz, dwell].every(Number.isFinite)) {
      return { scpi: [], reply: "ERR SYNTAX SWEEP" };
    }
    if (dwell < 1) return { scpi: [], reply: "ERR DWELL min 1 ms" };
    if (!inBand(f1) || !inBand(f2)) {
      return { scpi: [], reply: `ERR RANGE ${SL22_FMIN_MHZ}-${SL22_FMAX_MHZ} MHz` };
    }
    // Как прошивка LEGION: f1 < f2, иначе ERR RANGE.
    if (f1 >= f2) return { scpi: [], reply: "ERR RANGE f1>=f2" };
    if (stepKhz < 1) return { scpi: [], reply: "ERR RANGE STEP min 1 kHz" };
    return {
      scpi: ["GENErator:STATus ON"],
      reply: "OK SWEEP RUNNING",
      sweep: {
        f1,
        f2,
        stepMhz: stepKhzToMhz(stepKhz),
        dwellMs: Math.round(dwell),
      },
    };
  }

  if (u.startsWith("HOP START") || u.startsWith("CHIRP START") || u.startsWith("GLIDE") || u.startsWith("FM START")) {
    return { scpi: [], reply: "ERR STATE SL22: only SWEEP" };
  }

  if (u === "STATUS?") {
    return { scpi: [], reply: "__STATUS__" };
  }

  if (
    u === "REGS?" ||
    u === "SELFTEST" ||
    u.startsWith("CAL ") ||
    u.startsWith("SET ATT") ||
    u.startsWith("SET LEVEL") ||
    u.startsWith("LEVEL?")
  ) {
    return { scpi: [], reply: "ERR STATE SL22: ADF4351-only command" };
  }

  return { scpi: [], reply: "ERR SYNTAX" };
}

export function sl22StatusJson(st: {
  freqMhz: number;
  rfOn: boolean;
  powerDbm: number;
  mode: string;
}): string {
  return JSON.stringify({
    freq: st.freqMhz,
    mode: st.mode,
    lock: 0,
    rf: st.rfOn ? 1 : 0,
    power: st.powerDbm,
    version: "sl22",
    board: "htool-sl22",
  });
}
