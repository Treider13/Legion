// ============================================================================
// LEGION ↔ HTOOL SL22: чистый переводчик протокола (без serial).
//
// Источник команд: разбор SCPI живого прибора (гайд 2026 + Python-класс):
//   *IDN?  → вход в SCPI, дальше строки с \r\n
//   GENErator:POINt <MHz>
//   GENErator:STATus ON|OFF
//   FREQuency:LOPW 0..7
//   GENErator:SINGle start,stop,step,t_ms     (шаг в МГц)
//   GENErator:CYCLe  start,stop,step,t_ms     (4 поля: в гайде у CYCLe шаг
//                                              забыт — шлём как у SINGle,
//                                              иначе коридор 1 МГц потеряется)
//
// Диапазон прибора в тех же текстах: 45 … 22600 МГц (заголовок «22 МГц»
// противоречит командам и даташиту LMX2820 — берём 45).
// LOCK у SL22 нет — отвечаем LOCK=1 после принятой команды.
// ============================================================================

export const SL22_FMIN_MHZ = 45;
export const SL22_FMAX_MHZ = 22600;

/** ADF4351 дБм → ближайшая ступень P0…P7 (не калиброванные дБм). */
export const POWER_DBM_TO_LOPW: Record<number, number> = {
  [-4]: 0,
  [-1]: 2,
  [2]: 4,
  [5]: 6,
};

export interface Sl22Mapped {
  /** Команды на провод (без \r\n). Пусто — только синтетический ответ. */
  scpi: string[];
  reply: string;
}

function inBand(mhz: number): boolean {
  return Number.isFinite(mhz) && mhz >= SL22_FMIN_MHZ && mhz <= SL22_FMAX_MHZ;
}

/** LEGION STEP в кГц → МГц для SL22. 1000 кГц = 1.000 МГц. */
export function stepKhzToMhz(stepKhz: number): number {
  return stepKhz / 1000;
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
      reply: `OK FREQ=${mhz.toFixed(6)} LOCK=1 ERR_HZ=0.0`,
    };
  }

  if (u.startsWith("SET POWER")) {
    const raw = t.split(/\s+/)[2] ?? "";
    const dbm = parseInt(raw, 10);
    const lopw = POWER_DBM_TO_LOPW[dbm];
    if (lopw === undefined) {
      return { scpi: [], reply: "ERR RANGE power -4|-1|+2|+5 (→ LOPW 0/2/4/6)" };
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
    // SWEEP START <f1> <f2> STEP <kHz> DWELL <ms>
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
    if (f1 === f2) return { scpi: [], reply: "ERR RANGE f1=f2" };
    if (stepKhz <= 0) return { scpi: [], reply: "ERR RANGE STEP" };
    const stepMhz = stepKhzToMhz(stepKhz);
    const ms = Math.round(dwell);
    // CYCLe = бесконечный коридор LEGION. 4 поля — шаг не теряем.
    const scpi = `GENErator:CYCLe ${f1.toFixed(3)},${f2.toFixed(3)},${stepMhz.toFixed(3)},${ms}`;
    return { scpi: [scpi, "GENErator:STATus ON"], reply: "OK SWEEP RUNNING" };
  }

  if (u.startsWith("HOP START") || u.startsWith("CHIRP START") || u.startsWith("GLIDE") || u.startsWith("FM START")) {
    return { scpi: [], reply: "ERR STATE SL22: only SWEEP (no HOP/CHIRP/GLIDE/FM)" };
  }

  if (u === "STATUS?") {
    return { scpi: [], reply: "__STATUS__" };
  }

  if (u === "REGS?" || u === "SELFTEST" || u.startsWith("CAL ") || u.startsWith("SET ATT") || u.startsWith("SET LEVEL") || u.startsWith("LEVEL?")) {
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
    lock: 1,
    rf: st.rfOn ? 1 : 0,
    power: st.powerDbm,
    version: "sl22",
    board: "htool-sl22",
  });
}
