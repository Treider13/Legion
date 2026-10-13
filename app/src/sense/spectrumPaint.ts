// SDRangel рисует спектр отдельно от потока окна: FFT в SpectrumVis,
// картинка около 20 раз в секунду (m_fpsPeriodMs = 50). Здесь то же деление.
// Поток окна получает уже свёрнутые колонки и не сортирует FFT на каждом кадре.
// Колонка — максимум попавших в неё бинов, поэтому узкий пик не пропадает.

import type { ScanBin } from "../sdr/types";
import { rowDbmFromBins, sdrangelAutoscale, sdrangelColorIndex, type SdrangelScale } from "./waterfall";

/** glspectrumgui.cpp: m_fpsPeriodMs по умолчанию. */
export const SDRANGEL_FRAME_MS = 50;

export type PackedTrace = { freq: Float64Array; dbm: Float64Array };

export function packTrace(bins: readonly { freqMhz: number; powerDbm: number }[]): PackedTrace {
  const n = bins.length;
  const freq = new Float64Array(n);
  const dbm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bins[i]!;
    freq[i] = b.freqMhz;
    dbm[i] = b.powerDbm;
  }
  return { freq, dbm };
}

/** Максимум дБм на колонку пикселя. Бин ровно на F2 садится в последнюю колонку. */
export function columnMaxDbm(
  freqMhz: ArrayLike<number>,
  powerDbm: ArrayLike<number>,
  f1: number,
  f2: number,
  cols: number,
): Float32Array {
  const nCols = Math.max(1, cols | 0);
  const out = new Float32Array(nCols);
  out.fill(Number.NaN);
  const span = f2 - f1;
  if (!(span > 0)) return out;
  const n = Math.min(freqMhz.length, powerDbm.length);
  for (let i = 0; i < n; i++) {
    const f = freqMhz[i]!;
    const p = powerDbm[i]!;
    if (!Number.isFinite(f) || !Number.isFinite(p) || f < f1 || f > f2) continue;
    let c = Math.floor(((f - f1) / span) * nCols);
    if (c >= nCols) c = nCols - 1;
    if (c < 0) c = 0;
    const prev = out[c]!;
    if (!Number.isFinite(prev) || p > prev) out[c] = p;
  }
  return out;
}

export type SpectrumPaintRequest = {
  f1: number;
  f2: number;
  cols: number;
  traces: readonly PackedTrace[];
  waterfall: { freq: Float64Array; dbm: Float64Array; cols: number } | null;
};

export type SpectrumPaintBuilt = {
  scales: SdrangelScale[];
  columns: Float32Array[];
  waterfall: Float32Array | null;
};

function colorIndexRow(freq: Float64Array, dbm: Float64Array, f1: number, f2: number, cols: number): Float32Array {
  const bins: ScanBin[] = new Array(freq.length);
  for (let i = 0; i < freq.length; i++) bins[i] = { freqMhz: freq[i]!, powerDbm: dbm[i]! };
  const dbmRow = rowDbmFromBins(bins, f1, f2, cols);
  const scale = sdrangelAutoscale(dbm);
  const idx = new Float32Array(dbmRow.length);
  idx.fill(Number.NaN);
  for (let c = 0; c < dbmRow.length; c++) {
    const db = dbmRow[c]!;
    if (Number.isFinite(db)) idx[c] = sdrangelColorIndex(db, scale.refDb, scale.rangeDb);
  }
  return idx;
}

export function buildSpectrumPaint(req: SpectrumPaintRequest): SpectrumPaintBuilt {
  const scales: SdrangelScale[] = [];
  const columns: Float32Array[] = [];
  for (const trace of req.traces) {
    scales.push(sdrangelAutoscale(trace.dbm));
    columns.push(columnMaxDbm(trace.freq, trace.dbm, req.f1, req.f2, req.cols));
  }
  const waterfall = req.waterfall
    ? colorIndexRow(req.waterfall.freq, req.waterfall.dbm, req.f1, req.f2, req.waterfall.cols)
    : null;
  return { scales, columns, waterfall };
}
