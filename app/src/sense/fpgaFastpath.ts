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
import { catalogById } from "../sdr/catalog";
import { planCenters, planParkCenters } from "./scan";

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
/** Стагнация det_count → «энергия пропала». Раньше: 3 опроса × 400 мс = 1.2 с.
 *  Интервал наблюдения (80 мс для водопада) не должен ускорять возврат в скан.
 *  Слепое пятно: сильная утечка собственного TX обратно в RX (одночастотный
 *  ретранслятор — литература: SI на 60–120 дБ выше принимаемого) держит гейт
 *  открытым после смерти цели — стагнации нет, автовозврат не сработает.
 *  Это физика тракта, не код: ответ — изоляция антенн/выдержка усиления,
 *  операторский СТОП и watchdog работают всегда. */
export const FPGA_AIR_GONE_MS = 1200;

/** Счётчик опросов без роста det_count: время, не «3 тика». Тик 80 мс × 3 = 240 мс. */
export function detCountStagnant(
  prevCount: number | null,
  detCount: number,
  stagnantSinceMs: number | null,
  nowMs: number,
  goneMs = FPGA_AIR_GONE_MS,
): { stagnantSinceMs: number | null; gone: boolean } {
  if (prevCount !== null && detCount === prevCount) {
    const since = stagnantSinceMs ?? nowMs;
    return { stagnantSinceMs: since, gone: nowMs - since >= goneMs };
  }
  return { stagnantSinceMs: null, gone: false };
}

/** ОБЫЧНЫЙ в FPGA-перехвате: сколько держать LO на найденном взгляде
 *  после первого det, затем шаг дальше (даже если энергия ещё есть).
 *  Пример оператора 0.4 мс. Ниже 0.1 мс — короче окна детектора на 2 MSPS
 *  с запасом; выше минуты — уже удержание, а не очередь. USB-handoff к
 *  выдержке не относится (его в круге нет). */
export const FPGA_TURN_DWELL_DEFAULT_MS = 3000;
export const FPGA_TURN_DWELL_MIN_MS = 0.1;
export const FPGA_TURN_DWELL_MAX_MS = 60_000;

/** Поле оператора: «0,4» и «0.4» — одно число. Мусор → NaN, не 0. */
export function parseLocaleNumber(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const t = String(raw).trim().replace(/\s+/g, "").replace(",", ".");
  if (!t || t === "+" || t === "-" || t === ".") return Number.NaN;
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number.NaN;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function fpgaTurnDwellClamp(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return FPGA_TURN_DWELL_DEFAULT_MS;
  const c = Math.min(FPGA_TURN_DWELL_MAX_MS, Math.max(FPGA_TURN_DWELL_MIN_MS, ms));
  return Math.round(c * 10) / 10;
}

/** Регистр NIOS SCAN_DWELL — микросекунды. 0.4 мс → 400. */
export function fpgaTurnDwellUs(ms: number): number {
  return Math.round(fpgaTurnDwellClamp(ms) * 1000);
}

/** Полоса канала подавления lb_*-тракта: fs = max(полоса, минимум sample-rate
 *  чипа), analog BW = полоса. Дефолт 2 МГц — поведение до появления параметра.
 *  Потолок — analog платы (x40 28 / micro 56 МГц, каталог). */
export const FPGA_AIR_BW_DEFAULT_MHZ = 2;
/** AD9361 BW min 200 кГц (Nuand). x40 ниже 1.5 МГц — отказ до park/ARM. */
export const FPGA_AIR_BW_MIN_MHZ = 0.2;
/** LMS6002D: программируемые фильтры 1.5–28 МГц (каталог). */
export const FPGA_X40_ANALOG_MIN_MHZ = 1.5;
/** AD9361 sample-rate min (Nuand bladerf2_sample_rate_range): BW 200 кГц ≠ fs. */
export const FPGA_AIR_FS_MIN_HZ = 520_834;

export function clampAirBwMhz(want: number, analogMaxMhz: number): number {
  const cap = analogMaxMhz > 0 ? analogMaxMhz : FPGA_AIR_BW_DEFAULT_MHZ;
  const w = Number.isFinite(want) && want > 0 ? want : FPGA_AIR_BW_DEFAULT_MHZ;
  return Math.round(Math.min(Math.max(w, FPGA_AIR_BW_MIN_MHZ), cap) * 1000) / 1000;
}

export function airFsHz(bwMhz: number): number {
  const hz = bwMhz * 1e6;
  if (!Number.isFinite(hz) || hz <= 0) return LEGION_FPGA_FS_HZ;
  return Math.max(Math.round(hz), FPGA_AIR_FS_MIN_HZ);
}

/** Эфирный тракт под полосу оператора: fs/BW парковки и ARM. shift НЕ
 *  масштабируем под fs: статистика порога (χ²) зависит от числа сэмплов,
 *  не от скорости — 16 сэмплов валидны на любом fs, окно в мкс честно
 *  показываем от реального fs. */
export function airTractParams(
  bwRaw: number,
  analogMaxMhz: number,
  shiftUi: number,
): { bwMhz: number; fsHz: number; detShift: number; windowUs: number } {
  const bwMhz = clampAirBwMhz(bwRaw, analogMaxMhz);
  const fsHz = airFsHz(bwMhz);
  const detShift = clampDetShift(shiftUi);
  return { bwMhz, fsHz, detShift, windowUs: detectorWindowUs(detShift, fsHz) };
}

/** Окон захвата полки: win×windows ≤ половины IQ-кольца воркера (RING_CAP
 *  2^18, tools/sdr_worker.py) — иначе захват не наполнится и честно упадёт
 *  по таймауту. При shift 4..8 — 512 как раньше. */
export function detCaptureWindows(detShift: number): number {
  const win = 1 << clampDetShift(detShift);
  return Math.min(FPGA_DET_WINDOWS, Math.max(64, Math.floor(131072 / win)));
}

/** Таблица порогов air-обхода: thr_i = полка_i × K. Стоянка без живого
 *  захвата (мёртвый поток/отказ park) получает медиану успешных — не ноль
 *  (гейт на шум). Все упали → null: ARM без порога честно отказываем. */
export function airThrTable(medians: readonly (number | null)[], k = FPGA_DET_THR_K): number[] | null {
  const thrs = medians.map((m) => (m == null ? 0 : detThrFromMedian(m, k)));
  const ok = thrs.filter((t) => t > 0).sort((a, b) => a - b);
  if (ok.length === 0) return null;
  const fallback = ok[Math.floor(ok.length / 2)];
  return thrs.map((t) => (t > 0 ? t : fallback));
}

/** Пол порога: ниже — захват деградировал (мёртвый поток/ADC в нулях дают
 *  медиану 0..единицы; живая полка при MGC — сотни, фикстура воркера 400–2000).
 *  ARM с thr < floor = гейт на шум. 64 = медиана 16 при K=4: в 6 раз ниже
 *  нижней границы фикстуры, в разы выше деградированного захвата. */
export const FPGA_DET_THR_FLOOR = 64;

/** det_thr из захваченной шумовой полки: медиана × K, в единицы регистра.
 *  Ниже FPGA_DET_THR_FLOOR → 0 (отказ ARM, как при нулевой медиане). */
export function detThrFromMedian(medianEnergy: number, k = FPGA_DET_THR_K): number {
  if (!Number.isFinite(medianEnergy) || medianEnergy <= 0) return 0;
  const thr = Math.round(medianEnergy * k);
  if (thr < FPGA_DET_THR_FLOOR) return 0;
  return Math.min(0xffffffff, Math.max(0, thr));
}

/** LO для захвата шумовой полки: В СТОРОНУ от пика, за пределы окна ±bw/2.
 *  Захват на самом пике для непрерывного сигнала дал бы энергию сигнала,
 *  а не шума (тон живёт в каждом окне) — порог стал бы глухим навсегда.
 *  Геометрия без перекрытия: delta = bw/2 (край сигнала) + bw/2 (край фильтра
 *  захвата) + запас на скаты аналогового фильтра (они не кирпичные и растут
 *  с BW — запас пропорционален). 3.2 МГц при канале 2 МГц — это ровно 1.6×bw;
 *  у края диапазона уходим в минус. */
export const FPGA_DET_CAP_DELTA_MHZ = 3.2;

export function captureParkMhz(
  peakMhz: number,
  rxHiMhz: number,
  rxLoMhz: number,
  bwMhz = FPGA_AIR_BW_DEFAULT_MHZ,
): number {
  const delta = Math.max(FPGA_DET_CAP_DELTA_MHZ, bwMhz * 1.6);
  const up = peakMhz + delta;
  if (up <= rxHiMhz) return up;
  const down = peakMhz - delta;
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
  /** Полоса канала подавления, МГц. Дефолт 2 — поведение до параметра. */
  bwMhz?: number;
}

export interface FpgaAirPlan {
  ok: boolean;
  reason: string;
  windowUs: number;
  detThr: number;
  detShift: number;
  spanMhz: number;
  bwMhz: number;
  fsHz: number;
}

export function planFpgaAir(i: FpgaAirInput): FpgaAirPlan {
  const bwMhz = clampAirBwMhz(i.bwMhz ?? FPGA_AIR_BW_DEFAULT_MHZ, i.analogBwMhz);
  const fsHz = airFsHz(bwMhz);
  const detShift = clampDetShift(i.detShift);
  const windowUs = detectorWindowUs(detShift, fsHz);
  const spanMhz = parkSpanMhz(i.bands);
  const clipNote =
    i.bwMhz !== undefined && Number.isFinite(i.bwMhz) && i.bwMhz > i.analogBwMhz
      ? ` (урезана с ${i.bwMhz} — фильтр платы ≤${i.analogBwMhz} МГц)`
      : "";
  const fail = (reason: string): FpgaAirPlan => ({
    ok: false,
    reason,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
    bwMhz,
    fsHz,
  });
  if (!fpgaAirSupported(i.sdrId)) {
    return fail("FPGA эфир: ревизия legion на bladeRF 2.0 micro xA4/xA9 и bladeRF 1 x40");
  }
  if (!i.loadOk) {
    return fail("FPGA эфир: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
  }
  if (i.sdrId === "bladerf-x40" && bwMhz < FPGA_X40_ANALOG_MIN_MHZ) {
    return fail(
      `FPGA эфир: x40 канал ${bwMhz} МГц ниже фильтра LMS ${FPGA_X40_ANALOG_MIN_MHZ} МГц — отказ до park`,
    );
  }
  if (!(i.detThr > 0) || !Number.isFinite(i.detThr)) {
    return fail("FPGA эфир: задайте порог чувствительности больше нуля (нулевой порог — гейт открывается на шум)");
  }
  if (spanMhz > bwMhz) {
    return {
      ok: true,
      reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs в текущем LO · канал ${bwMhz} МГц${clipNote}. Коридор ${spanMhz.toFixed(1)} МГц не сканируется — hop ФАПЧ = мс`,
      windowUs,
      detThr: i.detThr,
      detShift,
      spanMhz,
      bwMhz,
      fsHz,
    };
  }
  return {
    ok: true,
    reason: `FPGA I²+Q² окно ${windowUs.toFixed(1)} µs · канал ${bwMhz} МГц${clipNote} → RX→TX внутри чипа → усилитель`,
    windowUs,
    detThr: i.detThr,
    detShift,
    spanMhz,
    bwMhz,
    fsHz,
  };
}

/** Онбордовый перехват: плата смотрит эфир в аналоговом окне и сама
 *  открывает TX. USB не в круге «увидел → усилитель». Два времени:
 *  гейт I²+Q² в текущем взгляде — микросекунды; обзор коридора — шаги LO
 *  шириной взгляда (аналоговый фильтр = шаг сетки). Две частоты ближе
 *  взгляда — одно TX-окно; 2450 и 2465 МГц раздельно при взгляде ≤15 МГц. */
export const FPGA_SCAN_QUIET_MS = 5;
/** Опрос STATUS для водопада/героя. Регистр дешёвый; 400 мс пропускал hop. */
export const FPGA_OBSERVE_MS = 80;
/** Hop LO AD9361/LMS: 6 мс × fs. NIOS дефолт 4096 сэмплов мал на 56e6. */
export const FPGA_LO_SETTLE_S = 0.006;

export function fpgaSettleN(fsHz: number): number {
  const fs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : LEGION_FPGA_FS_HZ;
  return Math.max(4096, Math.round(fs * FPGA_LO_SETTLE_S));
}

export interface OnboardInterceptInput {
  sdrId: string;
  analogBwMhz: number;
  bands: readonly AllowBand[];
  loadOk: boolean;
  detThr: number;
  detShift: number;
  lookMhz?: number;
  turn: boolean;
  dwellMs: number;
  /** ICE9: один LO на середине коридора, без плитки взглядов. */
  park?: boolean;
  /** Точный Гц: FFT-пик на FPGA. Дефолт false — walker как раньше. */
  fftEnable?: boolean;
  fireBwMhz?: number;
}

export interface OnboardInterceptPlan {
  ok: boolean;
  reason: string;
  lookMhz: number;
  fsHz: number;
  windowUs: number;
  spanMhz: number;
  centers: number[];
  firstMhz: number;
  detThr: number;
  detShift: number;
  dwellMs: number;
  turn: boolean;
  park: boolean;
  fftEnable: boolean;
  fireBwMhz: number;
  settleN: number;
}

export function planOnboardIntercept(i: OnboardInterceptInput): OnboardInterceptPlan {
  const analog = i.analogBwMhz > 0 ? i.analogBwMhz : FPGA_AIR_BW_DEFAULT_MHZ;
  const lookMhz = clampAirBwMhz(i.lookMhz ?? FPGA_AIR_BW_DEFAULT_MHZ, analog);
  const fsHz = airFsHz(lookMhz);
  const detShift = clampDetShift(i.detShift);
  const windowUs = detectorWindowUs(detShift, fsHz);
  const spanMhz = parkSpanMhz(i.bands);
  const park = !!i.park;
  const centers = park ? planParkCenters(i.bands) : planCenters(i.bands, lookMhz);
  const dwellMs = fpgaTurnDwellClamp(i.dwellMs);
  const fftEnable = !!i.fftEnable;
  const fireBwMhz = fftEnable
    ? clampAirBwMhz(i.fireBwMhz ?? FPGA_AIR_BW_DEFAULT_MHZ, analog)
    : FPGA_AIR_BW_DEFAULT_MHZ;
  const settleN = fftEnable ? fpgaSettleN(fsHz) : 0;
  const fail = (reason: string): OnboardInterceptPlan => ({
    ok: false,
    reason,
    lookMhz,
    fsHz,
    windowUs,
    spanMhz,
    centers,
    firstMhz: centers[0] ?? 0,
    detThr: i.detThr,
    detShift,
    dwellMs,
    turn: i.turn,
    park,
    fftEnable,
    fireBwMhz,
    settleN,
  });
  if (!fpgaAirSupported(i.sdrId)) {
    return fail("Автоперехват: ревизия legion на bladeRF 2.0 micro xA4/xA9 и bladeRF 1 x40");
  }
  if (!i.loadOk) {
    return fail("Автоперехват: подтвердите нагрузку 50 Ом на выходе усилителя SDR");
  }
  if (i.sdrId === "bladerf-x40" && lookMhz < FPGA_X40_ANALOG_MIN_MHZ) {
    return fail(
      `Автоперехват: x40 взгляд ${lookMhz} МГц ниже фильтра LMS ${FPGA_X40_ANALOG_MIN_MHZ} МГц — отказ до ARM`,
    );
  }
  if (!(i.detThr > 0) || !Number.isFinite(i.detThr)) {
    return fail("Автоперехват: задайте порог чувствительности больше нуля (нулевой порог — гейт на шум)");
  }
  if (centers.length === 0) {
    return fail("Автоперехват: задайте коридор F1…F2");
  }
  const rx = catalogById(i.sdrId)?.rxMhz;
  if (rx && i.bands.some((b) => b.f1Mhz < rx[0] || b.f2Mhz > rx[1])) {
    return fail(`Автоперехват: коридор вне RX ${rx[0]}–${rx[1]} МГц`);
  }
  const hops = Math.max(0, centers.length - 1);
  const survey = park
    ? `стоянка ${(centers[0] ?? 0).toFixed(1)} МГц · взгляд ${lookMhz} МГц (фильтр ≤${analog}) · хопы внутри окна — цифровой вырез на стоящем LO, PLL не гоняем`
    : fftEnable
    ? hops === 0
      ? `коридор ${spanMhz.toFixed(1)} МГц в взгляде ${lookMhz} МГц — FFT пик, цифровой вырез на стоящем LO (точный Гц, не hop PLL)`
      : `коридор ${spanMhz.toFixed(1)} МГц · ${centers.length} взглядов по ${lookMhz} МГц · FFT пик → точный Гц на стоящем LO (не hop PLL) · шаг взгляда на плате, не USB`
    : hops === 0
      ? `коридор ${spanMhz.toFixed(1)} МГц влезает в взгляд ${lookMhz} МГц — LO не шагает, гейт ${windowUs.toFixed(1)} µs`
      : `коридор ${spanMhz.toFixed(1)} МГц · ${centers.length} взглядов по ${lookMhz} МГц (фильтр платы ≤${analog} МГц) · шаг LO на плате (PLL), не USB`;
  return {
    ok: true,
    reason: `плата смотрит эфир сама · ${survey} · USB не в круге увидел→усилитель`,
    lookMhz,
    fsHz,
    windowUs,
    spanMhz,
    centers,
    firstMhz: centers[0],
    detThr: i.detThr,
    detShift,
    dwellMs,
    turn: i.turn,
    park,
    fftEnable,
    fireBwMhz,
    settleN,
  };
}

/** Строка наблюдения: ноутбук не в тракте, только телеметрия.
 *  det_count — счётчик КАЖДОГО окна с детектом (HDL, не фронт). */
export function fpgaObserveLine(st: {
  ok?: boolean;
  det_active?: boolean;
  det_count?: number;
  wd_fired?: boolean;
} | null): string {
  if (!st?.ok) return "ноутбук наблюдает · статус FPGA недоступен";
  if (st.wd_fired) return "сторожевой таймер погасил TX — ретрансляция остановлена";
  const gate = st.det_active ? "энергия → RX→TX на усилитель" : "тишина, гейт закрыт";
  return `наблюдение: ${gate} · окон с энергией ${st.det_count ?? 0}`;
}

/** Пауза перед повторным handoff на частоту, где он упал: 1-й страйк 10 с,
 *  дальше ×2 (10/20/40…). На 3-м страйке подряд — skip частоты (как у
 *  пропавшей энергии): не долбим мёртвый/недостижный ARM каждым циклом. */
export const FPGA_HANDOFF_RETRY_MS = 10_000;
export const FPGA_HANDOFF_MAX_STRIKES = 3;

export function handoffRetryMs(strikes: number): number {
  const s = Math.max(1, Math.round(strikes));
  return FPGA_HANDOFF_RETRY_MS * 2 ** (s - 1);
}

/** true — частоту пора пропускать (страйков ≥ MAX), а не ретраить. */
export function handoffSkipAfter(strikes: number): boolean {
  return strikes >= FPGA_HANDOFF_MAX_STRIKES;
}

/** Таймлайн handoff для лога: [имя, ts] → "park_полки +70мс · arm +540мс". */
export function handoffTimeline(t0: number, marks: Array<readonly [string, number]>): string {
  return marks.map(([n, t]) => `${n} +${t - t0}мс`).join(" · ");
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
  opts: {
    detThr: number;
    detShift: number;
    token: string;
    wd?: boolean;
    ncoFtw?: number;
    freqMhz?: number;
    /** fs/BW тракта (solo окно / эфирный канал / взгляд перехвата). Без них NIOS оставит 2 МГц. */
    fsHz?: number;
    bwMhz?: number;
    /** Онбордовый обзор коридора: плата шагает LO сама. */
    scanEnable?: boolean;
    scanF1Mhz?: number;
    scanF2Mhz?: number;
    scanTurn?: boolean;
    scanPark?: boolean;
    scanDwellMs?: number;
    scanDwellUs?: number;
    fftEnable?: boolean;
    fftDcNotch?: boolean;
    fireBwMhz?: number;
    searchBwMhz?: number;
    settleN?: number;
    scanBands?: readonly { f1Mhz: number; f2Mhz: number }[];
  },
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
  if (opts.fsHz !== undefined && Number.isFinite(opts.fsHz) && opts.fsHz > 0) {
    cmd.fs_hz = Math.round(opts.fsHz);
  }
  if (opts.bwMhz !== undefined && Number.isFinite(opts.bwMhz) && opts.bwMhz > 0) {
    cmd.bw_mhz = opts.bwMhz;
  }
    if (opts.scanEnable) {
    cmd.scan_enable = true;
    if (opts.scanF1Mhz !== undefined) cmd.scan_f1_mhz = opts.scanF1Mhz;
    if (opts.scanF2Mhz !== undefined) cmd.scan_f2_mhz = opts.scanF2Mhz;
    cmd.scan_turn = !!opts.scanTurn;
    cmd.scan_park = !!opts.scanPark;
    if (opts.scanDwellUs !== undefined && Number.isFinite(opts.scanDwellUs)) {
      cmd.scan_dwell_us = Math.max(0, Math.round(opts.scanDwellUs));
    } else if (opts.scanDwellMs !== undefined) {
      cmd.scan_dwell_us = fpgaTurnDwellUs(opts.scanDwellMs);
      cmd.scan_dwell_ms = fpgaTurnDwellClamp(opts.scanDwellMs);
    }
    if (opts.fftEnable) {
      cmd.fft_enable = true;
      cmd.fft_dc_notch = opts.fftDcNotch !== false;
      cmd.fire_bw_mhz = opts.fireBwMhz ?? FPGA_AIR_BW_DEFAULT_MHZ;
      if (opts.searchBwMhz !== undefined && Number.isFinite(opts.searchBwMhz) && opts.searchBwMhz > 0) {
        cmd.search_bw_mhz = opts.searchBwMhz;
      }
      if (opts.settleN !== undefined && Number.isFinite(opts.settleN) && opts.settleN > 0) {
        cmd.settle_n = Math.round(opts.settleN);
      }
      if (opts.scanBands && opts.scanBands.length > 0) {
        cmd.scan_bands = opts.scanBands.map((b) => ({ f1_mhz: b.f1Mhz, f2_mhz: b.f2Mhz }));
      }
    }
  }
  return cmd;
}
