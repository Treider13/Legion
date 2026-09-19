// ============================================================================
// LEGION — лабораторный PSD поверх живого Welch (sdr_worker.welch_dbm).
// Алгоритмы сняты с рабочих анализаторов, не с README:
//   qspectrumanalyzer (xmikos): peak-hold / min-hold / persistence fade /
//     baseline subtract — побиновая max/min и вычитание накопленной полки.
//   soapy_power: hop-окно рисуется на общую ось коридора (не растягивать
//     текущие 40 МГц на весь F1…F2).
//   CGurity/bladerf-jamming-poc: полка копится 120 с (их default), занятость
//     = бин ≥ полка + 12 дБ. 40 % coverage / 75 % duty — ИХ политика TX,
//     у нас только метрики журнала, не порог гейта FPGA.
//   rtl-sdr-analyzer: 3 дБ ширина от пика. min_duration живёт в labJournal
//     и только в логе — гейт lb_gated не ждёт 0.1 с.
// Не подменяет FPGA. Не выдумывает STA/SMA PASS. Пустые бины = NaN, не −∞.
// ============================================================================
import { estimateNoiseFloor } from "../sdr/backend";
import type { ScanBin } from "../sdr/types";

/** CGurity/bladerf-jamming-poc: 120 с сбора полки, не «30–60». */
export const LAB_BASELINE_DEFAULT_SEC = 120;
/** qspectrumanalyzer persistence: кадр гаснет, пик держится дольше live. */
export const LAB_PERSIST_DECAY = 0.94;
/** poc: бин «занят», если выше полки на 12 дБ. Не det_thr FPGA. */
export const LAB_OCCUPANCY_MARGIN_DB = 12;
/** Ось коридора: достаточно для UI и тестов, меньше USB-FFT 4096. */
export const LAB_GRID_MAX = 2048;
export const LAB_GRID_MIN = 64;

export interface LabPsdState {
  composite: ScanBin[];
  peakHold: ScanBin[];
  minHold: ScanBin[];
  persistence: ScanBin[];
  baseline: ScanBin[];
  /** Сколько раз каждый бин коридора видел живое окно (soapy_power per-bin). */
  baselineHits: number[];
  baselineStartedMs: number | null;
  baselineTargetSec: number;
  baselineFrozen: boolean;
  gridF1: number;
  gridF2: number;
}

export function emptyLabPsd(targetSec = LAB_BASELINE_DEFAULT_SEC): LabPsdState {
  return {
    composite: [],
    peakHold: [],
    minHold: [],
    persistence: [],
    baseline: [],
    baselineHits: [],
    baselineStartedMs: null,
    baselineTargetSec: targetSec,
    baselineFrozen: false,
    gridF1: Number.NaN,
    gridF2: Number.NaN,
  };
}

export function finiteDbm(v: number): boolean {
  return Number.isFinite(v);
}

/** Шаг оси: как у входного окна, иначе равномерно по коридору. */
export function gridSize(f1: number, f2: number, window: readonly ScanBin[]): number {
  const span = Math.max(f2 - f1, 1e-6);
  if (window.length >= 2) {
    const step = Math.abs(window[1].freqMhz - window[0].freqMhz);
    if (step > 1e-9) {
      const n = Math.round(span / step) + 1;
      return Math.min(LAB_GRID_MAX, Math.max(LAB_GRID_MIN, n));
    }
  }
  return Math.min(LAB_GRID_MAX, Math.max(LAB_GRID_MIN, window.length || LAB_GRID_MIN));
}

export function makeGrid(f1: number, f2: number, n: number, fill = Number.NaN): ScanBin[] {
  const count = Math.min(LAB_GRID_MAX, Math.max(1, Math.floor(n)));
  const out: ScanBin[] = new Array(count);
  if (count === 1) {
    out[0] = { freqMhz: (f1 + f2) / 2, powerDbm: fill };
    return out;
  }
  const span = f2 - f1;
  for (let i = 0; i < count; i++) {
    out[i] = { freqMhz: f1 + (span * i) / (count - 1), powerDbm: fill };
  }
  return out;
}

export function sameLabAxis(prev: LabPsdState, f1: number, f2: number, n: number): boolean {
  return (
    prev.composite.length === n &&
    Number.isFinite(prev.gridF1) &&
    Number.isFinite(prev.gridF2) &&
    Math.abs(prev.gridF1 - f1) <= 1e-9 &&
    Math.abs(prev.gridF2 - f2) <= 1e-9
  );
}

export function indexOfMhz(grid: readonly ScanBin[], mhz: number): number {
  if (grid.length === 0) return 0;
  if (grid.length === 1) return 0;
  const f1 = grid[0].freqMhz;
  const f2 = grid[grid.length - 1].freqMhz;
  const span = f2 - f1;
  if (!(span > 0)) return 0;
  const i = Math.round(((mhz - f1) / span) * (grid.length - 1));
  return Math.min(grid.length - 1, Math.max(0, i));
}

/** soapy_power: текущее Welch-окно вписывается в ось коридора. */
export function paintWindow(grid: readonly ScanBin[], window: readonly ScanBin[]): ScanBin[] {
  const out = grid.map((b) => ({ freqMhz: b.freqMhz, powerDbm: b.powerDbm }));
  if (out.length === 0 || window.length === 0) return out;
  const lo = out[0].freqMhz;
  const hi = out[out.length - 1].freqMhz;
  for (const w of window) {
    if (!Number.isFinite(w.freqMhz) || !finiteDbm(w.powerDbm)) continue;
    if (w.freqMhz < lo - 1e-9 || w.freqMhz > hi + 1e-9) continue;
    const i = indexOfMhz(out, w.freqMhz);
    const prev = out[i].powerDbm;
    out[i] = {
      freqMhz: out[i].freqMhz,
      powerDbm: finiteDbm(prev) ? Math.max(prev, w.powerDbm) : w.powerDbm,
    };
  }
  return out;
}

export function peakHoldBin(prev: number, cur: number): number {
  if (!finiteDbm(cur)) return prev;
  if (!finiteDbm(prev)) return cur;
  return Math.max(prev, cur);
}

export function minHoldBin(prev: number, cur: number): number {
  if (!finiteDbm(cur)) return prev;
  if (!finiteDbm(prev)) return cur;
  return Math.min(prev, cur);
}

/** qspectrumanalyzer persistence: след гаснет в линейной мощности, не в dBm.
 *  Умножение dBm (−80×0.94 = −75) поднимало бы полку — это баг, не fade. */
export function persistBin(prev: number, cur: number, decay = LAB_PERSIST_DECAY): number {
  const faded = finiteDbm(prev) ? 10 * Math.log10(Math.max(1e-20, 10 ** (prev / 10) * decay)) : Number.NaN;
  if (!finiteDbm(cur)) return faded;
  if (!finiteDbm(faded)) return cur;
  return Math.max(cur, faded);
}

export function mapBins(
  grid: readonly ScanBin[],
  prev: readonly ScanBin[],
  merge: (prevDbm: number, curDbm: number, i: number) => number,
): ScanBin[] {
  return grid.map((b, i) => ({
    freqMhz: b.freqMhz,
    powerDbm: merge(prev[i]?.powerDbm ?? Number.NaN, b.powerDbm, i),
  }));
}

/** Вычитание полки (qspectrumanalyzer baseline). Неpainted → NaN. */
export function subtractBaseline(current: readonly ScanBin[], baseline: readonly ScanBin[]): ScanBin[] {
  const n = Math.min(current.length, baseline.length);
  const out: ScanBin[] = [];
  for (let i = 0; i < n; i++) {
    const c = current[i].powerDbm;
    const b = baseline[i].powerDbm;
    out.push({
      freqMhz: current[i].freqMhz,
      powerDbm: finiteDbm(c) && finiteDbm(b) ? c - b : Number.NaN,
    });
  }
  return out;
}

/**
 * Poc +12 дБ над полкой. Если полки нет — медиана нижних 60 % текущего кадра
 * (тот же estimate_noise_floor, что DIO-sys / sdr_worker).
 */
export function occupancyMask(
  current: readonly ScanBin[],
  baseline: readonly ScanBin[],
  marginDb = LAB_OCCUPANCY_MARGIN_DB,
): boolean[] {
  const floor =
    baseline.some((b) => finiteDbm(b.powerDbm))
      ? baseline
      : current.map((b) => ({
          freqMhz: b.freqMhz,
          powerDbm: estimateNoiseFloor(current.filter((x) => finiteDbm(x.powerDbm))),
        }));
  return current.map((b, i) => {
    if (!finiteDbm(b.powerDbm)) return false;
    const base = floor[i]?.powerDbm;
    const ref = finiteDbm(base) ? base : estimateNoiseFloor(current.filter((x) => finiteDbm(x.powerDbm)));
    return b.powerDbm >= ref + marginDb;
  });
}

/** Доля оси выше полки+margin. Poc писали 40 % как цель TX — мы только считаем. */
export function occupancyCoverage(mask: readonly boolean[]): number {
  if (mask.length === 0) return 0;
  let on = 0;
  for (const v of mask) if (v) on += 1;
  return on / mask.length;
}

/**
 * Ширина по −3 дБ от пика на живом окне (rtl-sdr-analyzer), не на композите
 * hop: иначе старые стоянки слиплись бы в фальшивую полосу.
 */
export function width3dbMhz(window: readonly ScanBin[], peakMhz: number): number {
  if (window.length === 0) return 0;
  let peakI = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < window.length; i++) {
    const d = Math.abs(window[i].freqMhz - peakMhz);
    if (d < best) {
      best = d;
      peakI = i;
    }
  }
  const peak = window[peakI].powerDbm;
  if (!finiteDbm(peak)) return 0;
  const thr = peak - 3;
  let lo = peakI;
  let hi = peakI;
  while (lo > 0 && finiteDbm(window[lo - 1].powerDbm) && window[lo - 1].powerDbm >= thr) lo -= 1;
  while (hi + 1 < window.length && finiteDbm(window[hi + 1].powerDbm) && window[hi + 1].powerDbm >= thr) hi += 1;
  return Math.max(0, window[hi].freqMhz - window[lo].freqMhz);
}

export function strongestFinite(bins: readonly ScanBin[]): ScanBin | null {
  let best: ScanBin | null = null;
  for (const b of bins) {
    if (!finiteDbm(b.powerDbm)) continue;
    if (!best || b.powerDbm > best.powerDbm) best = b;
  }
  return best;
}

export function ingestLabFrame(
  prev: LabPsdState,
  window: readonly ScanBin[],
  f1: number,
  f2: number,
  nowMs: number,
): LabPsdState {
  if (!(f2 > f1) || window.length === 0) return prev;
  const n = sameLabAxis(prev, f1, f2, prev.composite.length)
    ? prev.composite.length
    : gridSize(f1, f2, window);
  const axisChanged = !sameLabAxis(prev, f1, f2, n);
  const blank = makeGrid(f1, f2, n);
  const baseGrid = axisChanged ? blank : prev.composite.length === n ? prev.composite : blank;
  const composite = paintWindow(baseGrid, window);

  const peakHold = mapBins(composite, axisChanged ? blank : prev.peakHold, (p, c) => peakHoldBin(p, c));
  const minHold = mapBins(composite, axisChanged ? blank : prev.minHold, (p, c) => minHoldBin(p, c));
  const persistence = mapBins(composite, axisChanged ? blank : prev.persistence, (p, c) => persistBin(p, c));

  let baseline = axisChanged ? blank.map((b) => ({ ...b })) : prev.baseline.length === n ? prev.baseline.map((b) => ({ ...b })) : blank.map((b) => ({ ...b }));
  let hits = axisChanged || prev.baselineHits.length !== n ? new Array(n).fill(0) : prev.baselineHits.slice();
  let started = prev.baselineStartedMs;
  let frozen = prev.baselineFrozen;
  const target = prev.baselineTargetSec > 0 ? prev.baselineTargetSec : LAB_BASELINE_DEFAULT_SEC;

  if (started != null && !frozen && nowMs - started >= target * 1000) {
    frozen = true;
  }
  if (started != null && !frozen) {
    for (let i = 0; i < n; i++) {
      const cur = composite[i].powerDbm;
      if (!finiteDbm(cur)) continue;
      hits[i] += 1;
      const prevB = baseline[i].powerDbm;
      baseline[i] = {
        freqMhz: baseline[i].freqMhz,
        powerDbm: finiteDbm(prevB) ? prevB + (cur - prevB) / hits[i] : cur,
      };
    }
  }

  return {
    composite,
    peakHold,
    minHold,
    persistence,
    baseline,
    baselineHits: hits,
    baselineStartedMs: started,
    baselineTargetSec: target,
    baselineFrozen: frozen,
    gridF1: f1,
    gridF2: f2,
  };
}

export function startLabBaseline(prev: LabPsdState, nowMs: number, targetSec = LAB_BASELINE_DEFAULT_SEC): LabPsdState {
  const n = prev.composite.length;
  return {
    ...prev,
    baseline: n ? makeGrid(prev.gridF1, prev.gridF2, n) : [],
    baselineHits: n ? new Array(n).fill(0) : [],
    baselineStartedMs: nowMs,
    baselineTargetSec: targetSec,
    baselineFrozen: false,
  };
}

export function freezeLabBaseline(prev: LabPsdState): LabPsdState {
  if (prev.baselineStartedMs == null) return prev;
  return { ...prev, baselineFrozen: true };
}

export function resetLabHolds(prev: LabPsdState): LabPsdState {
  const n = prev.composite.length;
  const blank = n && Number.isFinite(prev.gridF1) ? makeGrid(prev.gridF1, prev.gridF2, n) : [];
  return {
    ...prev,
    peakHold: blank.map((b) => ({ ...b })),
    minHold: blank.map((b) => ({ ...b })),
    persistence: blank.map((b) => ({ ...b })),
  };
}

export function resetLabPsd(targetSec = LAB_BASELINE_DEFAULT_SEC): LabPsdState {
  return emptyLabPsd(targetSec);
}

/** Сколько секунд полка уже копится. null — оператор не запускал. */
export function baselineElapsedSec(state: LabPsdState, nowMs: number): number | null {
  if (state.baselineStartedMs == null) return null;
  const end = state.baselineFrozen
    ? state.baselineStartedMs + state.baselineTargetSec * 1000
    : nowMs;
  return Math.max(0, (Math.min(end, nowMs) - state.baselineStartedMs) / 1000);
}
