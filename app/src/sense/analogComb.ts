// ============================================================================
// LEGION — гребёнка analog FPV на IQ. Не PortaPack (там только мощность).
// Метод: isaacbentley/orecchiette-fpv-drone-analog-rs + DragonSig
//   FM = arg(z[n] · conj(z[n-1])), затем гармоники строчной
//   PAL 15625 Гц / NTSC 15734 Гц (625×25 и ≈15734.26).
// Цифра (OFDM/10/20/40) гребёнки не даёт — так отличаем от аналога на 5.8.
// ============================================================================

export const PAL_LINE_HZ = 15625;
export const NTSC_LINE_HZ = 15734;
export const ANALOG_COMB_HARMONICS = 4;
/** Нижняя половина окна, Гц. PAL/NTSC (109 Гц) различимы только если bin < 109. */
export const ANALOG_COMB_BIN_HZ = 80;
/** После channelize xA4 fs≈20 МГц: строчная ≪ Найквиста, 250 кГц хватает на 4-ю гармонику. */
export const ANALOG_COMB_FS_HZ = 250_000;
/** Отношение гармоник к межгармоническому полу. Синтез PAL даёт ≫ 3. */
export const ANALOG_COMB_HIT = 2.4;
/** Локальный пик на f0 / 2f0. Ниже — 1/f (OFDM FM) похож на гребёнку. */
export const ANALOG_COMB_SHARP_F0 = 1.55;
export const ANALOG_COMB_SHARP_H2 = 1.4;
/** Грубый бин (channelize 1 мс) размазывает пик; сильный fund/floor всё равно analog. */
export const ANALOG_COMB_STRONG = 80;
/** Потолок FFT гребёнки после децимации FM. Не весь ring 2^24. */
export const ANALOG_COMB_MAX_N = 16384;

export type AnalogCombKind = "pal" | "ntsc" | "none";

export interface AnalogComb {
  kind: AnalogCombKind;
  score: number;
  palScore: number;
  ntscScore: number;
  hit: boolean;
}

export const ANALOG_COMB_NONE: AnalogComb = {
  kind: "none",
  score: 0,
  palScore: 0,
  ntscScore: 0,
  hit: false,
};

export function fmDemod(iq: ArrayLike<number>): Float64Array {
  const n = Math.floor(iq.length / 2);
  if (n < 2) return new Float64Array(0);
  const fm = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) {
    const re = iq[2 * i];
    const im = iq[2 * i + 1];
    const pre = iq[2 * i - 2];
    const pim = iq[2 * i - 1];
    // z · conj(z−1) = (re+j im)(pre − j pim)
    const pr = re * pre + im * pim;
    const pi = im * pre - re * pim;
    fm[i - 1] = Math.atan2(pi, pr);
  }
  return fm;
}

function decimateMean(x: Float64Array, decim: number): Float64Array {
  if (decim <= 1) return x;
  const n = Math.floor(x.length / decim);
  if (n < 1) return x;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * decim;
    for (let k = 0; k < decim; k++) s += x[base + k]!;
    out[i] = s / decim;
  }
  return out;
}

function combHalfHz(freqs: Float64Array): number {
  // 80 Гц << bin @ 20.48 МГц/16384 (1250 Гц) — окно пустое, analog на xA4 молчал.
  // orecchiette: пик на строчной, не маска уже бина. half ≥ 0.55·Δf ловит ближайший бин.
  const df = freqs.length > 1 ? Math.abs(freqs[1]! - freqs[0]!) : ANALOG_COMB_BIN_HZ;
  return Math.max(ANALOG_COMB_BIN_HZ, 0.55 * df);
}

function binEnergy(mag: Float64Array, freqs: Float64Array, hz: number, bw: number): number {
  let s = 0;
  for (let i = 0; i < mag.length; i++) {
    if (Math.abs(freqs[i]! - hz) <= bw) s += mag[i]!;
  }
  return s;
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : 0.5 * (a[m - 1]! + a[m]!);
}

/** orecchiette: пол — медиана бинов 1–80 кГц, не дырка между гармониками. */
function bandFloor(mag: Float64Array, freqs: Float64Array): number {
  const vals: number[] = [];
  for (let i = 1; i < mag.length; i++) {
    const f = freqs[i]!;
    if (f >= 1000 && f <= 80_000) vals.push(mag[i]!);
  }
  return medianOf(vals) || 1e-20;
}

function linePeakHz(mag: Float64Array, freqs: Float64Array): number | null {
  let bestI = -1;
  let bestM = -1;
  for (let i = 0; i < mag.length; i++) {
    const f = freqs[i]!;
    if (f < 14_000 || f > 18_000) continue;
    if (mag[i]! > bestM) {
      bestM = mag[i]!;
      bestI = i;
    }
  }
  return bestI < 0 ? null : freqs[bestI]!;
}

/** 1/f шум даёт «гребёнку» на f,2f,3f против 1.5f. Нужен локальный пик. */
function localRatio(mag: Float64Array, freqs: Float64Array, hz: number, rad = 2): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < freqs.length; i++) {
    const d = Math.abs(freqs[i]! - hz);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best <= 0 || best >= mag.length - 1) return 0;
  let neigh = 0;
  for (let d = 1; d <= rad; d++) {
    if (best - d >= 0) neigh = Math.max(neigh, mag[best - d]!);
    if (best + d < mag.length) neigh = Math.max(neigh, mag[best + d]!);
  }
  return mag[best]! / (neigh + 1e-20);
}

function combRatio(mag: Float64Array, freqs: Float64Array, f0: number, halfHz: number, floor: number): number {
  // Строчная f0 обязана быть. OFDM на 2 МГц даёт шаг fs/64 = 2×PAL без 15625.
  const peaks: number[] = [];
  for (let k = 1; k <= ANALOG_COMB_HARMONICS; k++) {
    peaks.push(binEnergy(mag, freqs, f0 * k, halfHz));
  }
  const fund = peaks[0] ?? 0;
  const peak = Math.max(...peaks);
  if (fund < 0.2 * peak) return 0;
  if (fund < ANALOG_COMB_HIT * floor) return 0;
  const nStrong = peaks.filter((p) => p >= 1.5 * floor).length;
  if (nStrong < 2) return 0;
  const sharp =
    localRatio(mag, freqs, f0) >= ANALOG_COMB_SHARP_F0 &&
    localRatio(mag, freqs, f0 * 2) >= ANALOG_COMB_SHARP_H2;
  const loud = fund >= ANALOG_COMB_STRONG * floor && (peaks[1] ?? 0) >= 10 * floor;
  if (!sharp && !loud) return 0;
  return fund / floor;
}

/** Спектр FM: DC-block + Ханна + rFFT. orecchiette: пик на 15625/15734, не окно 80 Гц. */
export function analogCombFromFm(fm: ArrayLike<number>, fsHz: number): AnalogComb {
  if (fm.length < 256 || !(fsHz > 0)) return { ...ANALOG_COMB_NONE };
  // Явный тип: в TS ≥5.7 `new Float64Array(n)` выводится как
  // Float64Array<ArrayBuffer>, а decimateMean возвращает Float64Array<ArrayBufferLike>.
  let work: Float64Array = new Float64Array(fm.length);
  for (let i = 0; i < fm.length; i++) work[i] = fm[i]!;
  let fs = fsHz;
  const decim = Math.max(1, Math.floor(fs / ANALOG_COMB_FS_HZ));
  if (decim > 1 && Math.floor(work.length / decim) >= 256) {
    work = decimateMean(work, decim);
    fs = fs / decim;
  }
  const n0 = work.length;
  if (n0 < 256) return { ...ANALOG_COMB_NONE };
  const start = n0 > ANALOG_COMB_MAX_N ? n0 - ANALOG_COMB_MAX_N : 0;
  const n = n0 - start;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += work[start + i]!;
  mean /= n;
  const win = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    win[i] = (work[start + i]! - mean) * w;
    acc += w * w;
  }
  const nfft = 1 << Math.ceil(Math.log2(Math.max(n, 8)));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = win[i]!;
  fftRadix2(re, im);
  const half = nfft / 2 + 1;
  const mag = new Float64Array(half);
  const freqs = new Float64Array(half);
  const norm = Math.sqrt(acc) || 1;
  for (let k = 0; k < half; k++) {
    mag[k] = Math.hypot(re[k]!, im[k]!) / norm;
    freqs[k] = (k * fs) / nfft;
  }
  const halfHz = combHalfHz(freqs);
  const floor = bandFloor(mag, freqs);
  const palScore = combRatio(mag, freqs, PAL_LINE_HZ, halfHz, floor);
  const ntscScore = combRatio(mag, freqs, NTSC_LINE_HZ, halfHz, floor);
  const score = Math.max(palScore, ntscScore);
  const hit = score >= ANALOG_COMB_HIT;
  let kind: AnalogCombKind = "none";
  if (hit) {
    const pk = linePeakHz(mag, freqs);
    if (pk != null) kind = Math.abs(pk - PAL_LINE_HZ) <= Math.abs(pk - NTSC_LINE_HZ) ? "pal" : "ntsc";
    else kind = palScore >= ntscScore ? "pal" : "ntsc";
  }
  return { kind, score, palScore, ntscScore, hit };
}

export function analogCombFromIq(iq: ArrayLike<number>, fsHz: number): AnalogComb {
  return analogCombFromFm(fmDemod(iq), fsHz);
}

/** Cooley–Tukey in-place, n степень двойки. Только для гребёнки, не водопад. */
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wnr = Math.cos(ang);
    const wni = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + half] * wr - im[i + k + half] * wi;
        const vi = re[i + k + half] * wi + im[i + k + half] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + half] = ur - vr;
        im[i + k + half] = ui - vi;
        const nwr = wr * wnr - wi * wni;
        wi = wr * wni + wi * wnr;
        wr = nwr;
      }
    }
  }
}

export function parseAnalogComb(raw: Record<string, unknown> | undefined): AnalogComb {
  if (!raw) return { ...ANALOG_COMB_NONE };
  const kindRaw = String(raw.analogKind ?? "none");
  const kind: AnalogCombKind = kindRaw === "pal" || kindRaw === "ntsc" ? kindRaw : "none";
  const palScore = Number(raw.palScore) || 0;
  const ntscScore = Number(raw.ntscScore) || 0;
  const score = Number(raw.analogScore ?? raw.score) || Math.max(palScore, ntscScore);
  const hit = kind !== "none" && (raw.hit === true || score >= ANALOG_COMB_HIT);
  return { kind: hit ? kind : "none", score, palScore, ntscScore, hit };
}

export function analogCombRu(comb: AnalogComb | undefined): string {
  if (!comb || !comb.hit) return "";
  const std = comb.kind === "pal" ? "PAL 15625" : "NTSC 15734";
  return `гребёнка ${std} · ${comb.score.toFixed(1)}`;
}
