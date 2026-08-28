// ============================================================================
// LEGION — микросекундный detect→TX только внутри FPGA (lb_gated).
// Хост-скан / Soapy / React сюда не входят: USB retune = сотни µs…мс.
// Окно детектора: 2^shift сэмплов I²+Q². Ревизия legion: fs = 2 МГц.
// shift=4 → 16 сэмплов → 8 µs. shift=8 (дефолт шлюза) → 256 → 128 µs.
// Полоса должна влезть в analog BW (x40 = 28 МГц): hop ФАПЧ ≠ микросекунды.
// Платы: bladeRF 2.0 micro xA4/xA9 (AD9361, эфир поднимает NIOS через
// AIR-регистры) и bladeRF 1 x40 (LMS6002D, CONTROL bit1/2 со шлюза).
// ============================================================================
import type { AllowBand } from "../policy/allowlist";

export const LEGION_FPGA_FS_HZ = 2_000_000;
/** Окно 16 сэмплов @ 2 МГц = 8 µs. Минимум HDL (win_shift 4..12). */
export const FPGA_US_DET_SHIFT = 4;
/** Стартовый порог средней энергии; 0 открывает гейт на шум (шлюз отказывает). */
export const FPGA_DEFAULT_DET_THR = 5000;
/** Платы с ревизией legion и эфирным трактом lb_*. Подмены каталога нет:
 *  micro паркуется через AD9361 как сама себя, x40 — через LMS6002D. */
export const FPGA_AIR_SDR_IDS: readonly string[] = [
  "bladerf-micro-xa4",
  "bladerf-micro-xa9",
  "bladerf-x40",
];

export function fpgaAirSupported(sdrId: string): boolean {
  return FPGA_AIR_SDR_IDS.includes(sdrId);
}

/** Окно детектора для захвата порога: 16 сэмплов = 8 мкс на 2 MSPS. */
export const FPGA_DET_WIN_SAMPLES = 1 << FPGA_US_DET_SHIFT;
/** Окон в захвате шумовой полки (512 × 16 = 8192 сэмпла ≈ 4 мс на 2 MSPS). */
export const FPGA_DET_WINDOWS = 512;
/** Множитель над медианой нижних 60% энергий окон. Окно 16 сэмплов — χ² с 32
 *  степенями: разброс среднего ~25%, K=4 ≈ +6 дБ над полкой. Тюнинг на стенде. */
export const FPGA_DET_THR_K = 4;
/** Опросы статуса без роста det_count подряд = «энергия пропала» (400 мс тик). */
export const FPGA_AIR_GONE_POLLS = 3;

/** det_thr из захваченной шумовой полки: медиана × K, в единицы регистра. */
export function detThrFromMedian(medianEnergy: number, k = FPGA_DET_THR_K): number {
  if (!Number.isFinite(medianEnergy) || medianEnergy <= 0) return 0;
  const thr = Math.round(medianEnergy * k);
  return Math.min(0xffffffff, Math.max(0, thr));
}

/** LO для захвата шумовой полки: на 3.2 МГц В СТОРОНУ от пика.
 *  Захват на самом пике для непрерывного сигнала дал бы энергию сигнала,
 *  а не шума (тон живёт в каждом окне) — порог стал бы глухим навсегда.
 *  3.2 МГц: вне окна 2 МГц (±1 МГц), внутри полосы чипа; у края диапазона
 *  уходим в минус. */
export const FPGA_DET_CAP_DELTA_MHZ = 3.2;

export function captureParkMhz(peakMhz: number, rxHiMhz: number, rxLoMhz: number): number {
  const up = peakMhz + FPGA_DET_CAP_DELTA_MHZ;
  if (up <= rxHiMhz) return up;
  const down = peakMhz - FPGA_DET_CAP_DELTA_MHZ;
  return down >= rxLoMhz ? down : up; // край чипа: лучше up с клипом, чем вне диапазона
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
  const windowUs = detectorWindowUs(detShift);
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
    return fail("FPGA эфир: ревизия legion на bladeRF 2.0 micro xA4/xA9 и bladeRF 1 x40");
  }
  if (!i.loadOk) {
    return fail("FPGA эфир: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
  }
  if (!(i.detThr > 0) || !Number.isFinite(i.detThr)) {
    return fail("FPGA эфир: задайте det_thr > 0 (порог 0 = гейт на шум)");
  }
  if (spanMhz > i.analogBwMhz) {
    return {
      ok: true,
      reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs в текущем LO (≤${i.analogBwMhz} МГц). Полоса ${spanMhz.toFixed(1)} МГц не сканируется — hop ФАПЧ = мс`,
      windowUs,
      detThr: i.detThr,
      detShift,
      spanMhz,
    };
  }
  return {
    ok: true,
    reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs → RX→TX внутри чипа → усилитель`,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
  };
}

/** Строка наблюдения: ноутбук не в тракте, только телеметрия.
 *  det_count — счётчик КАЖДОГО окна с детектом (HDL, не фронт): рост =
 *  энергия жива; стагнация N опросов = «пропала» → автовозврат к скану. */
export function fpgaObserveLine(st: {
  ok?: boolean;
  det_active?: boolean;
  det_count?: number;
  wd_fired?: boolean;
} | null): string {
  if (!st?.ok) return "ноутбук наблюдает · статус FPGA недоступен";
  if (st.wd_fired) return "watchdog погасил TX — конвейер на SDR остановлен";
  const gate = st.det_active ? "энергия → RX→TX на усилитель" : "тишина, гейт закрыт";
  return `наблюдение: ${gate} · окон с энергией ${st.det_count ?? 0}`;
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
 *  freq_mhz — LO парковки: на micro без неё шлюз честно отказывает (AD9361
 *  поднимает NIOS-прошивка, ей нужна частота); на x40 игнорируется. */
export function fpgaArmCmd(
  mode: "player" | "nco" | "lb_gated" | "lb_always",
  opts: { detThr: number; detShift: number; token: string; wd?: boolean; ncoFtw?: number; freqMhz?: number },
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
  if (opts.freqMhz !== undefined && Number.isFinite(opts.freqMhz) && opts.freqMhz > 0) {
    cmd.freq_mhz = opts.freqMhz;
  }
  return cmd;
}
