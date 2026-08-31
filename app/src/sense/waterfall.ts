// ============================================================================
// LEGION — строка водопада главного кадра.
// Хост-FFT (scanBins) или взгляд FPGA (LO + гейт). Не рисует глаз.
// ============================================================================
import type { ScanBin } from "../sdr/types";

export const WATERFALL_COLS = 256;
export const WATERFALL_ROWS = 96;

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

/** Одна строка из живого Welch/FFT хоста. */
export function rowFromBins(
  bins: readonly ScanBin[],
  f1: number,
  f2: number,
  cols = WATERFALL_COLS,
): Float32Array {
  const row = new Float32Array(cols);
  if (bins.length === 0 || !(f2 > f1)) return row;
  let i = 0;
  for (let c = 0; c < cols; c++) {
    const mhz = f1 + ((c + 0.5) / cols) * (f2 - f1);
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
    return rowFromBins(sample.bins, f1, f2, cols);
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
