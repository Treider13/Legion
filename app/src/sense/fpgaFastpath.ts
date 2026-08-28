// ============================================================================
// LEGION — микросекундный detect→TX только внутри FPGA (lb_gated).
// Хост-скан / Soapy / React сюда не входят: USB retune = сотни µs…мс.
// Окно детектора: 2^shift сэмплов I²+Q². shift=4 → 16 сэмплов.
// x40 (LMS6002D): fs = analog BW (28 МГц) → окно ≈ 0.57 µs, эфир через
// CONTROL bit1/2. micro xA4/xA9 (AD9361): fs = 2 МГц → окно 8 µs, эфир через
// RFIC-команды 16x64 (NIOS). Полоса должна влезть в analog BW: hop ФАПЧ ≠ µs.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import { sameBin } from "./orchestrator";

export const LEGION_FPGA_FS_HZ = 2_000_000;
/** Окно 16 сэмплов @ 2 МГц = 8 µs. Минимум HDL (win_shift 4..12). */
export const FPGA_US_DET_SHIFT = 4;
/** Стартовый порог средней энергии; 0 открывает гейт на шум (шлюз отказывает). */
export const FPGA_DEFAULT_DET_THR = 5000;

/** Платы с ревизией legion и эфиром lb_*: x40 (LMS6002D) и micro (AD9361). */
const FPGA_AIR_HW: Record<string, "bladerf1" | "bladerf2"> = {
  "bladerf-x40": "bladerf1",
  "bladerf-micro-xa4": "bladerf2",
  "bladerf-micro-xa9": "bladerf2",
};

/** Класс железа для FPGA-эфира: hardwareKey libbladeRF, не драйвер (он общий). */
export function fpgaAirHw(sdrId: string): "bladerf1" | "bladerf2" | null {
  return FPGA_AIR_HW[sdrId] ?? null;
}

export function fpgaAirSupported(sdrId: string): boolean {
  return fpgaAirHw(sdrId) !== null;
}

/** fs тракта lb_*: micro — 2 MSPS (окно 16 = 8 µs), x40 — analog BW (28 МГц). */
export function fpgaAirFsHz(sdrId: string, analogBwMhz: number): number {
  return fpgaAirHw(sdrId) === "bladerf2"
    ? LEGION_FPGA_FS_HZ
    : Math.max(1, analogBwMhz) * 1e6;
}

export function clampDetShift(shift: number): number {
  if (!Number.isFinite(shift)) return FPGA_US_DET_SHIFT;
  return Math.min(12, Math.max(4, Math.round(shift)));
}

/** Длительность окна детектора в микросекундах. */
export function detectorWindowUs(winShift: number, fsHz = LEGION_FPGA_FS_HZ): number {
  if (!(fsHz > 0)) return Number.POSITIVE_INFINITY;
  const n = 1 << clampDetShift(winShift);
  return (n / fsHz) * 1e6;
}

export function parkSpanMhz(bands: readonly AllowBand[]): number {
  if (bands.length === 0) return 0;
  const f1 = Math.min(...bands.map((b) => b.f1Mhz));
  const f2 = Math.max(...bands.map((b) => b.f2Mhz));
  return f2 - f1;
}

export interface FpgaAirInput {
  sdrId: string;
  analogBwMhz: number;
  bands: readonly AllowBand[];
  loadOk: boolean;
  detThr: number;
  detShift: number;
}

export interface FpgaAirPlan {
  ok: boolean;
  reason: string;
  windowUs: number;
  detThr: number;
  detShift: number;
  spanMhz: number;
}

export function planFpgaAir(i: FpgaAirInput): FpgaAirPlan {
  const detShift = clampDetShift(i.detShift);
  // Окно — на реальной fs тракта платы: x40 = analog BW (28 МГц), micro = 2 МГц.
  const windowUs = detectorWindowUs(detShift, fpgaAirFsHz(i.sdrId, i.analogBwMhz));
  const spanMhz = parkSpanMhz(i.bands);
  const fail = (reason: string): FpgaAirPlan => ({
    ok: false,
    reason,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
  });
  if (!fpgaAirSupported(i.sdrId)) {
    return fail("FPGA эфир: ревизия legion на bladeRF x40 / micro xA4/xA9");
  }
  if (!i.loadOk) {
    return fail("FPGA эфир: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
  }
  if (!(i.detThr > 0) || !Number.isFinite(i.detThr)) {
    return fail("FPGA эфир: задайте det_thr > 0 (порог 0 = гейт на шум)");
  }
  const usTxt = windowUs < 10 ? windowUs.toFixed(2) : windowUs.toFixed(1);
  if (spanMhz > i.analogBwMhz) {
    return {
      ok: true,
      reason: `FPGA I²+Q² окно ${usTxt} µs в текущем LO (≤${i.analogBwMhz} МГц). Полоса ${spanMhz.toFixed(1)} МГц не сканируется — hop ФАПЧ = мс`,
      windowUs,
      detThr: i.detThr,
      detShift,
      spanMhz,
    };
  }
  return {
    ok: true,
    reason: `FPGA I²+Q² окно ${usTxt} µs → RX→TX внутри чипа → усилитель`,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
  };
}

/** Строка наблюдения: ноутбук не в тракте, только телеметрия. */
export function fpgaObserveLine(st: {
  ok?: boolean;
  det_active?: boolean;
  det_count?: number;
  wd_fired?: boolean;
} | null): string {
  if (!st?.ok) return "ноутбук наблюдает · статус FPGA недоступен";
  if (st.wd_fired) return "watchdog погасил TX — конвейер на SDR остановлен";
  const gate = st.det_active ? "энергия → RX→TX на усилитель" : "тишина, гейт закрыт";
  return `наблюдение: ${gate} · детектов ${st.det_count ?? 0}`;
}

/** Выход «энергия пропала»: столько подряд опросов с det_active=0 (гейт
 *  закрыт) считаем сигнал ушедшим. Опрос 400 мс → 5 тиков = 2 с тишины.
 *  Критерий — уровень det_active: det_count для сплошного сигнала не растёт
 *  (HDL считает фронты окон с детектом), по приросту счётчика судить нельзя. */
export const FPGA_QUIET_TICKS_MAX = 5;

/** Счётчик тихих тиков: следующее значение по итогам опроса статуса. */
export function fpgaQuietTicksNext(
  prev: number,
  st: { ok?: boolean; det_active?: boolean },
  armedLive: boolean,
): number {
  if (!armedLive || !st.ok) return 0;
  return st.det_active === false ? prev + 1 : 0;
}

/** Пул кандидатов handoff конвейера скан→FPGA: живые детекты минус skip-лист
 *  (частота ушедшего сигнала, пока walker её не перепроверит тишиной).
 *  Маску withoutOwnTx сюда не применяем: в скан-фазе ретранслятор выключен,
 *  lastForwardMhz — не «свой TX», а прошлая частота ретрансляции. */
export function fpgaHandoffPool<T extends { freqMhz: number }>(
  dets: readonly T[],
  skipMhz: number | null,
): T[] {
  if (skipMhz == null) return [...dets];
  return dets.filter((d) => !sameBin(d.freqMhz, skipMhz));
}

/**
 * FTW NCO: fj·2³². fj=0 → fs/8, не DC (панель без cinema иначе ставила 0).
 * NCO — TX DDS, не анализатор.
 */
export function ncoFtwFromFrac(fj: number): number {
  let frac = Number.isFinite(fj) ? fj : 0.125;
  if (frac === 0) frac = 0.125;
  frac = Math.min(0.45, Math.max(-0.45, frac));
  return Math.round(frac * 2 ** 32) >>> 0;
}

/** Команда ARM для шлюза. det_thr/shift — только lb_gated. nco_ftw — только nco.
 *  parkMhz — припаркованный LO: на micro шлюз сверяет RFIC FREQUENCY readback. */
export function fpgaArmCmd(
  mode: "player" | "nco" | "lb_gated" | "lb_always",
  opts: { detThr: number; detShift: number; token: string; wd?: boolean; ncoFtw?: number; parkMhz?: number },
): Record<string, unknown> {
  const cmd: Record<string, unknown> = {
    op: "arm",
    mode,
    wd: opts.wd !== false,
    token: opts.token,
  };
  if (mode === "lb_gated") {
    cmd.det_thr = opts.detThr;
    cmd.det_shift = clampDetShift(opts.detShift);
  }
  if (mode === "nco") {
    cmd.nco_ftw = opts.ncoFtw ?? ncoFtwFromFrac(0.125);
  }
  if (opts.parkMhz !== undefined) {
    cmd.park_mhz = opts.parkMhz;
  }
  return cmd;
}
