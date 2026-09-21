// ============================================================================
// LEGION — честные ширины и признаки спектра Атаки.
// −3 дБ: rtl-sdr-analyzer / labPsd.width3dbMhz (тот же обход от пика).
// −26 дБ и 99%: ITU-R SM.443 / SM.328. Плоскость: MPEG-7 / Wiener.
// Цепстр: JTIT 2008 picket-fence. Не трогает журнал лаборатории.
// ============================================================================
import { finiteDbm } from "./labPsd";
import type { ScanBin } from "../sdr/types";

function peakIndex(bins: readonly ScanBin[], peakMhz: number): number {
  let best = 0;
  let dmin = Number.POSITIVE_INFINITY;
  for (let i = 0; i < bins.length; i++) {
    const d = Math.abs(bins[i].freqMhz - peakMhz);
    if (d < dmin) {
      dmin = d;
      best = i;
    }
  }
  return best;
}

function dbmToLin(dbm: number): number {
  return Math.pow(10, dbm / 10);
}

/** x дБ ниже пика, непрерывный проход влево/вправо. */
export function widthXdBMhz(bins: readonly ScanBin[], peakMhz: number, xDb: number): number {
  if (bins.length === 0) return 0;
  const i = peakIndex(bins, peakMhz);
  const peak = bins[i].powerDbm;
  if (!finiteDbm(peak)) return 0;
  const thr = peak - xDb;
  let lo = i;
  let hi = i;
  while (lo > 0 && finiteDbm(bins[lo - 1].powerDbm) && bins[lo - 1].powerDbm >= thr) lo -= 1;
  while (hi + 1 < bins.length && finiteDbm(bins[hi + 1].powerDbm) && bins[hi + 1].powerDbm >= thr) hi += 1;
  return Math.max(0, bins[hi].freqMhz - bins[lo].freqMhz);
}

export function width3dbMhzAttack(bins: readonly ScanBin[], peakMhz: number): number {
  return widthXdBMhz(bins, peakMhz, 3);
}

export function width26dbMhz(bins: readonly ScanBin[], peakMhz: number): number {
  return widthXdBMhz(bins, peakMhz, 26);
}

/** ITU-R SM.443 §3: span ≈ 1.5× ожидаемой полосы вокруг пика, затем β/2 = 0.5%. */
export function occupied99Mhz(bins: readonly ScanBin[], peakMhz: number): number {
  if (bins.length < 4) return 0;
  const i = peakIndex(bins, peakMhz);
  const w26 = widthXdBMhz(bins, peakMhz, 26);
  const w3 = widthXdBMhz(bins, peakMhz, 3);
  let expected = Math.max(w26, w3);
  const df = bins.length > 1 ? Math.abs(bins[1]!.freqMhz - bins[0]!.freqMhz) : 0;
  if (expected < df * 2) expected = Math.max(df * 4, expected);
  const half = 0.75 * Math.max(expected, df);
  let lo = i;
  let hi = i;
  while (lo > 0 && bins[lo - 1]!.freqMhz >= peakMhz - half) lo -= 1;
  while (hi + 1 < bins.length && bins[hi + 1]!.freqMhz <= peakMhz + half) hi += 1;
  const lin = bins.map((b) => (finiteDbm(b.powerDbm) ? dbmToLin(b.powerDbm) : 0));
  let total = 0;
  for (let k = lo; k <= hi; k++) total += lin[k]!;
  if (!(total > 0)) return Math.max(0, bins[hi]!.freqMhz - bins[lo]!.freqMhz);
  const cut = 0.005 * total;
  let acc = 0;
  let left = lo;
  while (left < hi && acc + lin[left]! < cut) {
    acc += lin[left]!;
    left += 1;
  }
  acc = 0;
  let right = hi;
  while (right > left && acc + lin[right]! < cut) {
    acc += lin[right]!;
    right -= 1;
  }
  return Math.max(0, bins[right]!.freqMhz - bins[left]!.freqMhz);
}

export function spectralFlatness(bins: readonly ScanBin[]): number {
  const lin: number[] = [];
  for (const b of bins) {
    if (finiteDbm(b.powerDbm)) lin.push(Math.max(1e-20, dbmToLin(b.powerDbm)));
  }
  if (lin.length === 0) return 0;
  let logSum = 0;
  let sum = 0;
  for (const v of lin) {
    logSum += Math.log(v);
    sum += v;
  }
  const g = Math.exp(logSum / lin.length);
  const a = sum / lin.length;
  if (!(a > 0)) return 0;
  return Math.min(1, Math.max(0, g / a));
}

export function powerVarDb(bins: readonly ScanBin[]): number {
  const xs = bins.filter((b) => finiteDbm(b.powerDbm)).map((b) => b.powerDbm);
  if (xs.length < 2) return 0;
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) * (x - mean);
  return v / xs.length;
}

/** Вырез вокруг пика: AMC считает признаки на сигнале, не на всём окне 56 МГц. */
export function binsAroundPeak(
  bins: readonly ScanBin[],
  peakMhz: number,
  halfMhz: number,
  maxN = 512,
): ScanBin[] {
  if (bins.length === 0) return [];
  const half = Math.max(halfMhz, 0.3);
  const lo = peakMhz - half;
  const hi = peakMhz + half;
  const slice: ScanBin[] = [];
  for (const b of bins) {
    if (b.freqMhz >= lo && b.freqMhz <= hi) slice.push(b);
  }
  const src = slice.length >= 8 ? slice : bins.slice();
  if (src.length <= maxN) return src;
  const out: ScanBin[] = [];
  const last = src.length - 1;
  for (let i = 0; i < maxN; i++) {
    out.push(src[Math.round((i * last) / Math.max(maxN - 1, 1))]!);
  }
  return out;
}

/** Пик |цепстра| лог-PSD: решётка OFDM vs гладкий шум. 0…1. */
export function cepstrumPeak(bins: readonly ScanBin[]): number {
  let xs = bins.filter((b) => finiteDbm(b.powerDbm)).map((b) => b.powerDbm);
  const n0 = xs.length;
  if (n0 < 16) return 0;
  const maxN = 256;
  if (n0 > maxN) {
    const dec: number[] = [];
    const last = n0 - 1;
    for (let i = 0; i < maxN; i++) dec.push(xs[Math.round((i * last) / (maxN - 1))]!);
    xs = dec;
  }
  const n = xs.length;
  if (n < 16) return 0;
  const out = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const ang = (2 * Math.PI * k * t) / n;
      re += xs[t] * Math.cos(ang);
      im -= xs[t] * Math.sin(ang);
    }
    out[k] = Math.hypot(re, im) / n;
  }
  const skip = Math.max(2, Math.floor(n / 32));
  const hi = Math.floor(n / 2);
  let peak = 0;
  let sum = 0;
  let cnt = 0;
  for (let i = skip; i < hi; i++) {
    if (out[i] > peak) peak = out[i];
  }
  for (let i = skip; i < n; i++) {
    sum += out[i];
    cnt += 1;
  }
  const mean = cnt > 0 ? sum / cnt : 0;
  if (!(mean > 1e-12)) return 0;
  return Math.min(1, Math.max(0, (peak / mean - 1) / 8));
}

export interface AttackWidths {
  width3Mhz: number;
  width26Mhz: number;
  occ99Mhz: number;
}

export function measureHitWidths(bins: readonly ScanBin[], peakMhz: number): AttackWidths {
  return {
    width3Mhz: width3dbMhzAttack(bins, peakMhz),
    width26Mhz: width26dbMhz(bins, peakMhz),
    occ99Mhz: occupied99Mhz(bins, peakMhz),
  };
}

/** Для рамки/подсказки берём −26, если она живая, иначе 99%, иначе −3. */
export function honestWidthMhz(w: AttackWidths, cfarWidth: number): number {
  if (w.width26Mhz >= 0.15) return w.width26Mhz;
  if (w.occ99Mhz >= 0.15) return w.occ99Mhz;
  if (w.width3Mhz >= 0.15) return w.width3Mhz;
  return cfarWidth;
}
