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
/** Половина бина вокруг гармоники, Гц. 80 Гц << 109 Гц (NTSC−PAL). */
export const ANALOG_COMB_BIN_HZ = 80;
/** Отношение гармоник к межгармоническому полу. Синтез PAL даёт ≫ 3. */
export const ANALOG_COMB_HIT = 2.4;
/** Потолок FFT гребёнки: 16384 @ 2 МГц ≈ 8 мс (PAL bin 128). Не весь ring 2^24. */
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

function binEnergy(mag: Float64Array, freqs: Float64Array, hz: number, bw: number): number {
  let s = 0;
  for (let i = 0; i < mag.length; i++) {
    if (Math.abs(freqs[i] - hz) <= bw) s += mag[i];
  }
  return s;
}

function combRatio(mag: Float64Array, freqs: Float64Array, f0: number): number {
  // Строчная f0 обязана быть. OFDM на 2 МГц даёт шаг fs/64 = 2×PAL без 15625.
  const peaks: number[] = [];
  let den = 0;
  for (let k = 1; k <= ANALOG_COMB_HARMONICS; k++) {
    peaks.push(binEnergy(mag, freqs, f0 * k, ANALOG_COMB_BIN_HZ));
    den += binEnergy(mag, freqs, f0 * k + f0 / 2, ANALOG_COMB_BIN_HZ);
  }
  const fund = peaks[0] ?? 0;
  const peak = Math.max(...peaks);
  if (fund < 0.2 * peak) return 0;
  return peaks.reduce((s, v) => s + v, 0) / (den + 1e-20);
}

/** Спектр FM: окно Ханна + rFFT. Нужен fs ≫ 2·3·15734 (канал AMC 2 МГц хватает). */
export function analogCombFromFm(fm: ArrayLike<number>, fsHz: number): AnalogComb {
  const n0 = fm.length;
  if (n0 < 256 || !(fsHz > 0)) return { ...ANALOG_COMB_NONE };
  const start = n0 > ANALOG_COMB_MAX_N ? n0 - ANALOG_COMB_MAX_N : 0;
  const n = n0 - start;
  const win = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    win[i] = fm[start + i] * w;
    acc += w * w;
  }
  const nfft = 1 << Math.ceil(Math.log2(Math.max(n, 8)));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < n; i++) re[i] = win[i];
  fftRadix2(re, im);
  const half = nfft / 2 + 1;
  const mag = new Float64Array(half);
  const freqs = new Float64Array(half);
  const norm = Math.sqrt(acc) || 1;
  for (let k = 0; k < half; k++) {
    mag[k] = Math.hypot(re[k], im[k]) / norm;
    freqs[k] = (k * fsHz) / nfft;
  }
  const palScore = combRatio(mag, freqs, PAL_LINE_HZ);
  const ntscScore = combRatio(mag, freqs, NTSC_LINE_HZ);
  const score = Math.max(palScore, ntscScore);
  const hit = score >= ANALOG_COMB_HIT;
  let kind: AnalogCombKind = "none";
  if (hit && palScore >= ntscScore) kind = "pal";
  else if (hit) kind = "ntsc";
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
  const kindRaw = String(raw.analogKind ?? raw.kind ?? "none");
  const kind: AnalogCombKind = kindRaw === "pal" || kindRaw === "ntsc" ? kindRaw : "none";
  const palScore = Number(raw.palScore) || 0;
  const ntscScore = Number(raw.ntscScore) || 0;
  const score = Number(raw.analogScore ?? raw.score) || Math.max(palScore, ntscScore);
  const hit = raw.hit === true || (kind !== "none" && score >= ANALOG_COMB_HIT);
  return { kind: hit ? kind : "none", score, palScore, ntscScore, hit };
}

export function analogCombRu(comb: AnalogComb | undefined): string {
  if (!comb || !comb.hit) return "";
  const std = comb.kind === "pal" ? "PAL 15625" : "NTSC 15734";
  return `гребёнка ${std} · ${comb.score.toFixed(1)}`;
}
