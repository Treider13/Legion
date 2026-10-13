// ============================================================================
// LEGION — строка водопада главного кадра.
// Хост-FFT (scanBins) или взгляд FPGA (LO + гейт). Не рисует глаз.
// ============================================================================
import { estimateNoiseFloor } from "../sdr/backend";
import type { ScanBin } from "../sdr/types";

export const WATERFALL_COLS = 256;
export const WATERFALL_ROWS = 96;
/** SDR++ / W4VA: пол у низа палитры, сверху запас на всплеск.
 *  Иначе шум садится в середину шкалы и водопад становится сплошным. */
export const WATERFALL_RANGE_DB = 50;

export type SdrangelScale = { refDb: number; rangeDb: number; floorDb: number };

/** GLSpectrumGUI::on_autoscale, логарифм.
 *  Низ = среднее самых тихих fft/32 бинов + 3 дБ.
 *  Верх (reference) = пик + 10 дБ. Диапазон ограничен 1…100, как спинбокс. */
export function sdrangelAutoscale(dbm: readonly number[]): SdrangelScale {
  const vals: number[] = [];
  for (let i = 0; i < dbm.length; i++) {
    const x = dbm[i]!;
    if (Number.isFinite(x)) vals.push(x);
  }
  if (vals.length === 0) return { refDb: 0, rangeDb: 100, floorDb: -100 };
  vals.sort((a, b) => a - b);
  const avgRange = Math.max(1, Math.min(vals.length, Math.floor(vals.length / 32) || 1));
  let minSum = 0;
  for (let i = 0; i < avgRange; i++) minSum += vals[i]!;
  const minLvl = minSum / avgRange + 3;
  let maxLvl = vals[vals.length - 1]! + 10;
  let range = maxLvl - minLvl;
  if (range < 1) {
    range = 1;
    maxLvl = minLvl + 1;
  }
  if (range > 100) range = 100;
  return { refDb: maxLvl, rangeDb: range, floorDb: maxLvl - range };
}

/** updateWaterfall: (dB − ref) * 2.4 * 100 / range + 240, затем clamp 0…239. */
export function sdrangelColorIndex(db: number, refDb: number, rangeDb: number): number {
  if (!Number.isFinite(db) || !(rangeDb > 0)) return 0;
  const v = ((db - refDb) * 240) / rangeDb + 240;
  if (v <= 0) return 0;
  if (v >= 239) return 239;
  return Math.trunc(v);
}

/** dBm → 0…1. Пол около −110, потолок около −40 (как полоса cinema). */
export function dbmToUnit(dbm: number): number {
  if (!Number.isFinite(dbm)) return 0;
  return Math.min(1, Math.max(0, (dbm + 110) / 70));
}

export function colOfMhz(mhz: number, f1: number, f2: number, cols: number): number {
  const span = Math.max(f2 - f1, 1e-6);
  const x = ((mhz - f1) / span) * cols;
  return Math.min(cols - 1, Math.max(0, Math.floor(x)));
}

/** Одна строка из живого Welch/FFT хоста. Колонки вне окна бинов — тишина,
 *  не «последний бин на весь коридор» (хост-FFT 40 МГц ≠ коридор 100 МГц). */
export function rowFromBins(
  bins: readonly ScanBin[],
  f1: number,
  f2: number,
  cols = WATERFALL_COLS,
): Float32Array {
  const row = new Float32Array(cols);
  if (bins.length === 0 || !(f2 > f1)) return row;
  let winLo = bins[0].freqMhz;
  let winHi = bins[0].freqMhz;
  for (let k = 1; k < bins.length; k++) {
    const f = bins[k].freqMhz;
    if (f < winLo) winLo = f;
    if (f > winHi) winHi = f;
  }
  const step = bins.length >= 2 ? Math.abs(bins[1].freqMhz - bins[0].freqMhz) : 0;
  const pad = step > 1e-9 ? step * 0.5 : 0;
  let i = 0;
  for (let c = 0; c < cols; c++) {
    const mhz = f1 + ((c + 0.5) / cols) * (f2 - f1);
    if (mhz < winLo - pad || mhz > winHi + pad) continue;
    while (i + 1 < bins.length && bins[i + 1].freqMhz < mhz) i += 1;
    const a = bins[i];
    const b = bins[Math.min(bins.length - 1, i + 1)];
    const span = b.freqMhz - a.freqMhz;
    const t = span > 1e-9 ? (mhz - a.freqMhz) / span : 0;
    const dbm = a.powerDbm + (b.powerDbm - a.powerDbm) * Math.min(1, Math.max(0, t));
    row[c] = dbmToUnit(dbm);
  }
  return row;
}

/** Строка прохода: пол = медиана нижних 60% (DIO-sys), как чёрный уровень
 *  QSpectrumAnalyzer. Колонки вне измеренных бинов остаются тишиной. */
export function rowAboveFloor(
  bins: readonly ScanBin[],
  f1: number,
  f2: number,
  cols = WATERFALL_COLS,
): Float32Array {
  const row = new Float32Array(cols);
  if (bins.length === 0 || !(f2 > f1)) return row;
  const finite: ScanBin[] = [];
  let winLo = Number.POSITIVE_INFINITY;
  let winHi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < bins.length; k++) {
    const b = bins[k];
    if (!Number.isFinite(b.powerDbm)) continue;
    finite.push(b);
    if (b.freqMhz < winLo) winLo = b.freqMhz;
    if (b.freqMhz > winHi) winHi = b.freqMhz;
  }
  if (finite.length === 0) return row;
  finite.sort((a, b) => a.freqMhz - b.freqMhz);
  const floor = estimateNoiseFloor(finite);
  const step = finite.length >= 2 ? Math.abs(finite[1].freqMhz - finite[0].freqMhz) : 0;
  const pad = step > 1e-9 ? step * 0.5 : 0;
  let i = 0;
  for (let c = 0; c < cols; c++) {
    const mhz = f1 + ((c + 0.5) / cols) * (f2 - f1);
    if (mhz < winLo - pad || mhz > winHi + pad) continue;
    while (i + 1 < finite.length && finite[i + 1].freqMhz < mhz) i += 1;
    const a = finite[i];
    const b = finite[Math.min(finite.length - 1, i + 1)];
    if (!Number.isFinite(a.powerDbm) || !Number.isFinite(b.powerDbm)) continue;
    const span = b.freqMhz - a.freqMhz;
    const t = span > 1e-9 ? (mhz - a.freqMhz) / span : 0;
    const dbm = a.powerDbm + (b.powerDbm - a.powerDbm) * Math.min(1, Math.max(0, t));
    row[c] = Math.min(1, Math.max(0, (dbm - floor) / WATERFALL_RANGE_DB));
  }
  return row;
}

/** Та же геометрия окна, что у строки водопада, но в дБм.
 *  Вне измеренных бинов — NaN, не 0 дБм: 0 дБм у SDRangel это верх шкалы. */
export function rowDbmFromBins(
  bins: readonly ScanBin[],
  f1: number,
  f2: number,
  cols = WATERFALL_COLS,
): Float32Array {
  const row = new Float32Array(cols);
  row.fill(Number.NaN);
  if (bins.length === 0 || !(f2 > f1)) return row;
  const finite: ScanBin[] = [];
  let winLo = Number.POSITIVE_INFINITY;
  let winHi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < bins.length; k++) {
    const b = bins[k]!;
    if (!Number.isFinite(b.powerDbm)) continue;
    finite.push(b);
    if (b.freqMhz < winLo) winLo = b.freqMhz;
    if (b.freqMhz > winHi) winHi = b.freqMhz;
  }
  if (finite.length === 0) return row;
  finite.sort((a, b) => a.freqMhz - b.freqMhz);
  const step = finite.length >= 2 ? Math.abs(finite[1]!.freqMhz - finite[0]!.freqMhz) : 0;
  const pad = step > 1e-9 ? step * 0.5 : 0;
  let i = 0;
  for (let c = 0; c < cols; c++) {
    const mhz = f1 + ((c + 0.5) / cols) * (f2 - f1);
    if (mhz < winLo - pad || mhz > winHi + pad) continue;
    while (i + 1 < finite.length && finite[i + 1]!.freqMhz < mhz) i += 1;
    const a = finite[i]!;
    const b = finite[Math.min(finite.length - 1, i + 1)]!;
    if (!Number.isFinite(a.powerDbm) || !Number.isFinite(b.powerDbm)) continue;
    const span = b.freqMhz - a.freqMhz;
    const t = span > 1e-9 ? (mhz - a.freqMhz) / span : 0;
    row[c] = a.powerDbm + (b.powerDbm - a.powerDbm) * Math.min(1, Math.max(0, t));
  }
  return row;
}

/** Живой кадр — строка по времени, не только когда сменился ключ LO/бина.
 *  Иначе стоянка (тот же центр, та же полка) замораживает водопад. */
export function shouldPushWaterfallRow(
  elapsedMs: number,
  intervalMs: number,
  live: boolean,
  keyChanged: boolean,
): boolean {
  if (!(elapsedMs >= intervalMs)) return false;
  return live || keyChanged;
}

/** Колонки строки — индекс в текущем F1…F2, не МГц. Смена коридора
 *  без сброса истории рисует старый FFT на новой оси. */
export function waterfallBandChanged(
  prevLo: number,
  prevHi: number,
  lo: number,
  hi: number,
): boolean {
  if (!Number.isFinite(prevLo) || !Number.isFinite(prevHi)) return true;
  return Math.abs(prevLo - lo) > 1e-9 || Math.abs(prevHi - hi) > 1e-9;
}

/** Записать энергию текущего взгляда FPGA в композит (остальные колонки живы).
 *  Скат как у analog-фильтра (не кирпич): пик на LO, края взгляда тише. */
export function applyLook(
  row: Float32Array,
  f1: number,
  f2: number,
  centerMhz: number,
  lookMhz: number,
  energy01: number,
): void {
  if (!(f2 > f1) || !Number.isFinite(centerMhz) || row.length === 0) return;
  const half = Math.max(lookMhz, 0.2) / 2;
  const e = Math.min(1, Math.max(0, energy01));
  const lo = colOfMhz(centerMhz - half, f1, f2, row.length);
  const hi = colOfMhz(centerMhz + half, f1, f2, row.length);
  const span = f2 - f1;
  for (let c = lo; c <= hi; c++) {
    const mhz = f1 + ((c + 0.5) / row.length) * span;
    const u = Math.min(1, Math.abs(mhz - centerMhz) / half);
    const lobe = Math.exp(-2.8 * u * u);
    row[c] = Math.max(row[c], e * lobe);
  }
}

export function fpgaLookEnergy(detActive: boolean): number {
  return detActive ? 0.92 : 0.14;
}

/** Тепловая карта кадра: холодный пол → циан → янтарь → удар TX. */
export function heatRgb(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  if (x < 0.22) {
    const u = x / 0.22;
    return [8 + 12 * u, 10 + 32 * u, 16 + 62 * u];
  }
  if (x < 0.48) {
    const u = (x - 0.22) / 0.26;
    return [20 + 4 * u, 42 + 58 * u, 78 + 36 * u];
  }
  if (x < 0.72) {
    const u = (x - 0.48) / 0.24;
    return [24 + 156 * u, 100 + 58 * u, 114 - 44 * u];
  }
  const u = (x - 0.72) / 0.28;
  return [180 + 75 * u, 158 + 70 * u, 70 + 140 * u];
}

export type WaterfallSample = {
  bins: readonly ScanBin[];
  fpgaArmed: boolean;
  fpgaFreqMhz: number | null;
  lookMhz: number;
  detActive: boolean;
};

/** Следующая строка: хост-FFT если есть бины, иначе взгляд платы. */
export function nextWaterfallRow(
  prev: Float32Array | null,
  sample: WaterfallSample,
  f1: number,
  f2: number,
  cols = WATERFALL_COLS,
): Float32Array {
  if (sample.bins.length > 0 && !sample.fpgaArmed) {
    return rowAboveFloor(sample.bins, f1, f2, cols);
  }
  const row = prev && prev.length === cols ? new Float32Array(prev) : new Float32Array(cols);
  for (let c = 0; c < row.length; c++) {
    row[c] *= 0.88;
    row[c] = Math.max(row[c], 0.03 + ((c * 17 + row.length) % 7) * 0.004);
  }
  if (sample.fpgaArmed && sample.fpgaFreqMhz != null && sample.fpgaFreqMhz > 0) {
    applyLook(row, f1, f2, sample.fpgaFreqMhz, sample.lookMhz, fpgaLookEnergy(sample.detActive));
  } else if (sample.bins.length > 0) {
    return rowFromBins(sample.bins, f1, f2, cols);
  }
  return row;
}
