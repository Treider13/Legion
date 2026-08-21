// ============================================================================
// LEGION — каталог типов сигнала (вкладка ТИП СИГНАЛА, режим SDR).
// Превью в браузере (pure TS) зеркалит синтез tools/sdr_worker.py: та же
// baseband-математика и те же дефолты. В эфир ничего не уходит до кнопки
// ЗАШИТЬ НА SDR — и только при подтверждённой нагрузке 50 Ом.
// Ось 0 Гц = центр запрошенной RF (воркер гетеродинирует +fs/8, LO = RF−fs/8).
// ============================================================================
import { mulberry32 } from "../sense/scan";

export const WAVE_FS = 2_000_000;
export const WAVE_PREVIEW_N = 4096;

export type WaveKind =
  | "sine" | "tone" | "square" | "sawtooth" | "triangle" | "chirp" | "awgn"
  | "bpsk" | "qpsk" | "qam16" | "fsk2" | "dsss" | "css" | "ofdm" | "am" | "fm";

export interface WaveParam {
  key: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  def: number;
}

export interface WaveMeta {
  id: WaveKind;
  title: string;
  desc: string;
  params: WaveParam[];
}

const AMP: WaveParam = { key: "amp", label: "АМПЛИТУДА", min: 0.05, max: 0.9, step: 0.05, def: 0.25 };
const FB: WaveParam = { key: "fbKhz", label: "ЧАСТОТА", unit: "кГц", min: 10, max: 900, step: 5, def: 125 };
const SEED: WaveParam = { key: "seed", label: "SEED", min: 1, max: 99999, step: 1, def: 1337 };
const SPS: WaveParam = { key: "sps", label: "SPS", min: 2, max: 16, step: 1, def: 4 };
const ALPHA: WaveParam = { key: "alpha", label: "RRC α", min: 0.03, max: 0.5, step: 0.005, def: 0.035 };

export const WAVE_CATALOG: WaveMeta[] = [
  {
    id: "sine",
    title: "СИНУС",
    desc: "Аналитический сигнал exp(j2πf·n): одна спектральная линия. fj=0 — ровно на центре RF.",
    params: [AMP, { key: "fj", label: "СМЕЩЕНИЕ fj", unit: "×fs", min: -0.45, max: 0.45, step: 0.01, def: 0 }],
  },
  {
    id: "tone",
    title: "ТОН Fj + СЛУЧ. ФАЗА",
    desc: "Узкополосный тон со смещением Fj от центра и фазой θ~U(0,2π) при каждом синтезе (модель tone_jammer).",
    params: [AMP, { key: "fj", label: "СМЕЩЕНИЕ fj", unit: "×fs", min: -0.45, max: 0.45, step: 0.01, def: 0.1 }],
  },
  {
    id: "square",
    title: "МЕАНДР",
    desc: "Реальный в I: нечётные гармоники fb, спад 1/k. Частота защёлкнута на целое число периодов буфера.",
    params: [AMP, FB],
  },
  {
    id: "sawtooth",
    title: "ПИЛА",
    desc: "Реальная в I: все гармоники fb, спад 1/k.",
    params: [AMP, FB],
  },
  {
    id: "triangle",
    title: "ТРЕУГОЛЬНИК",
    desc: "Реальный в I: нечётные гармоники fb, спад 1/k² (arcsin·sin).",
    params: [AMP, FB],
  },
  {
    id: "chirp",
    title: "ЧИРП",
    desc: "Линейная перестройка −span/2 → +span/2 за буфер. Симметричный размах — фаза стыкуется в петле.",
    params: [AMP, { key: "spanKhz", label: "РАЗМАХ", unit: "кГц", min: 50, max: 1000, step: 10, def: 1000 }],
  },
  {
    id: "awgn",
    title: "ГАУССОВ ШУМ (AWGN)",
    desc: "Комплексный шум: плоский спектр во всей полосе fs. RMS = amp/2, клип на amp (защита ЦАП).",
    params: [AMP, SEED],
  },
  {
    id: "bpsk",
    title: "BPSK + RRC",
    desc: "PRBS → BPSK → дифф. кодирование → ↑sps → RRC. Занятая полоса (1+α)·Rs.",
    params: [AMP, SPS, ALPHA, SEED],
  },
  {
    id: "qpsk",
    title: "QPSK + RRC",
    desc: "M=4, Gray, сдвиг π/4, дифф. кодирование, 4 sps, RRC α=0.035 — как generic_mod в GNU Radio.",
    params: [AMP, SPS, ALPHA, SEED],
  },
  {
    id: "qam16",
    title: "16-QAM + RRC",
    desc: "Gray PAM-4 на I и Q (1/√10), RRC. Выше спектральная эффективность — выше требования к линейности.",
    params: [AMP, SPS, ALPHA, SEED],
  },
  {
    id: "fsk2",
    title: "2-FSK (CPFSK)",
    desc: "Непрерыная фаза: девиация ±dev, интегратор фазы. Две линии ±dev при чередовании.",
    params: [AMP, { key: "devKhz", label: "ДЕВИАЦИЯ", unit: "кГц", min: 10, max: 500, step: 10, def: 250 }, SEED],
  },
  {
    id: "dsss",
    title: "DSSS (m-seq Gp=31)",
    desc: "BPSK-данные × m-последовательность 31 чип (LFSR x⁵+x³+1), 2 сэмпла/чип — модель 802.11b.",
    params: [AMP, SEED],
  },
  {
    id: "css",
    title: "CSS (LoRa-подобный)",
    desc: "Chirp spread spectrum: символ = циклический сдвиг чирпа, 2^SF чипов на символ.",
    params: [AMP, { key: "sf", label: "SF", min: 5, max: 10, step: 1, def: 6 }, SEED],
  },
  {
    id: "ofdm",
    title: "OFDM (802.11a-подобный)",
    desc: "NFFT=64, CP=16, 52 поднесущие QPSK. Гребёнка с провалом на DC.",
    params: [AMP, SEED],
  },
  {
    id: "am",
    title: "AM",
    desc: "Несущая fb + тон fm с индексом m: линии fb и fb±fm.",
    params: [AMP, FB, { key: "fmKhz", label: "МОДУЛЯЦИЯ", unit: "кГц", min: 1, max: 500, step: 1, def: 31.25 }, { key: "m", label: "ИНДЕКС m", min: 0.05, max: 1, step: 0.05, def: 0.5 }],
  },
  {
    id: "fm",
    title: "FM",
    desc: "Несущая fb, тон fm, индекс β: гребёнка Бесселя fb ± k·fm, ширина Карсона 2(β+1)fm.",
    params: [AMP, FB, { key: "fmKhz", label: "МОДУЛЯЦИЯ", unit: "кГц", min: 1, max: 500, step: 1, def: 31.25 }, { key: "beta", label: "ИНДЕКС β", min: 0.1, max: 50, step: 0.5, def: 5 }],
  },
];

export function waveMeta(kind: WaveKind): WaveMeta {
  return WAVE_CATALOG.find((w) => w.id === kind) ?? WAVE_CATALOG[0];
}

export function defaultParams(kind: WaveKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of waveMeta(kind).params) out[p.key] = p.def;
  return out;
}

export function clampParams(kind: WaveKind, pr: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of waveMeta(kind).params) {
    const v = pr[p.key];
    out[p.key] = Number.isFinite(v) ? Math.min(Math.max(v, p.min), p.max) : p.def;
  }
  return out;
}

// ---------------------------------------------------------------------------
// БПФ (radix-2, итеративное) — для спектра превью и циклической свёртки RRC.
// ---------------------------------------------------------------------------

function fftInPlace(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (invert ? 1 : -1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Спектр мощности в дБ, fftshift, длина = fftN (степень двойки). */
export function spectrumDb(re: Float64Array, im: Float64Array, fftN = 1024): Float64Array {
  const n = Math.min(re.length, fftN);
  const pre = new Float64Array(fftN);
  const pim = new Float64Array(fftN);
  // Окно Ханна — как в _read_fft воркера.
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    pre[i] = re[i] * w;
    pim[i] = im[i] * w;
  }
  fftInPlace(pre, pim, false);
  const out = new Float64Array(fftN);
  for (let i = 0; i < fftN; i++) {
    const j = (i + fftN / 2) % fftN;
    out[i] = 10 * Math.log10((pre[j] * pre[j] + pim[j] * pim[j]) / n + 1e-12);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Генераторы превью — зеркало make_waveform() воркера.
// ---------------------------------------------------------------------------

function gaussPair(rand: () => number): [number, number] {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  const r = Math.sqrt(-2 * Math.log(u1));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

function rrcTaps(sps: number, alpha: number, span = 8): Float64Array {
  const m = span * sps + 1;
  const h = new Float64Array(m);
  let energy = 0;
  for (let i = 0; i < m; i++) {
    const t = (i - (m - 1) / 2) / sps;
    let v: number;
    if (Math.abs(t) < 1e-9) {
      v = 1 - alpha + (4 * alpha) / Math.PI;
    } else if (Math.abs(Math.abs(t) - 1 / (4 * alpha)) < 1e-9) {
      v =
        (alpha / Math.sqrt(2)) *
        ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) +
          (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)));
    } else {
      v =
        (Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) /
        (Math.PI * t * (1 - (4 * alpha * t) ** 2));
    }
    h[i] = v;
    energy += v * v;
  }
  const norm = Math.sqrt(energy) || 1;
  for (let i = 0; i < m; i++) h[i] /= norm;
  return h;
}

function pskSymbols(nsym: number, m: number, seed: number): { re: Float64Array; im: Float64Array } {
  const bps = Math.log2(m);
  const rand = mulberry32(seed);
  const re = new Float64Array(nsym);
  const im = new Float64Array(nsym);
  for (let s = 0; s < nsym; s++) {
    let val = 0;
    for (let k = bps - 1; k >= 0; k--) val |= (rand() >= 0.5 ? 1 : 0) << k;
    const gray = val ^ (val >> 1);
    const ph = Math.PI / m + (gray * 2 * Math.PI) / m;
    re[s] = Math.cos(ph);
    im[s] = Math.sin(ph);
  }
  return { re, im };
}

function qam16Symbols(nsym: number, seed: number): { re: Float64Array; im: Float64Array } {
  const rand = mulberry32(seed);
  const re = new Float64Array(nsym);
  const im = new Float64Array(nsym);
  const pam4 = (b0: number, b1: number) => (2 * (b0 * 2 + (b0 ^ b1)) - 3) / Math.sqrt(10);
  for (let s = 0; s < nsym; s++) {
    re[s] = pam4(rand() >= 0.5 ? 1 : 0, rand() >= 0.5 ? 1 : 0);
    im[s] = pam4(rand() >= 0.5 ? 1 : 0, rand() >= 0.5 ? 1 : 0);
  }
  return { re, im };
}

/** Символы → (дифф) → апсэмплинг → циклический RRC → пик = amp. */
function modWave(
  sym: { re: Float64Array; im: Float64Array },
  sps: number,
  alpha: number,
  amp: number,
  diff: boolean,
): { re: Float64Array; im: Float64Array } {
  const nsym = sym.re.length;
  const n = nsym * sps;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let pr = 1;
  let pi = 0;
  for (let s = 0; s < nsym; s++) {
    let sr = sym.re[s];
    let si = sym.im[s];
    if (diff) {
      const tr = pr * sr - pi * si;
      const ti = pr * si + pi * sr;
      pr = tr;
      pi = ti;
      sr = pr;
      si = pi;
    }
    re[s * sps] = sr;
    im[s * sps] = si;
  }
  // Циклическая свёртка через БПФ — как в воркере.
  const h = rrcTaps(sps, alpha);
  const hn = nextPow2(n);
  const hre = new Float64Array(hn);
  const him = new Float64Array(hn);
  hre.set(h);
  const xre = new Float64Array(hn);
  const xim = new Float64Array(hn);
  xre.set(re);
  xim.set(im);
  fftInPlace(hre, him, false);
  fftInPlace(xre, xim, false);
  for (let i = 0; i < hn; i++) {
    const tr = xre[i] * hre[i] - xim[i] * him[i];
    xim[i] = xre[i] * him[i] + xim[i] * hre[i];
    xre[i] = tr;
  }
  fftInPlace(xre, xim, true);
  // Свёртка по mod hn; заворачиваем хвост в mod n — циклическая, как в воркере.
  for (let i = n; i < hn; i++) {
    xre[i - n] += xre[i];
    xim[i - n] += xim[i];
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.hypot(xre[i], xim[i]));
  const g = amp / (peak || 1);
  const ore = new Float64Array(n);
  const oim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ore[i] = xre[i] * g;
    oim[i] = xim[i] * g;
  }
  return { re: ore, im: oim };
}

function mseq31(): Float64Array {
  const r = [0, 0, 0, 0, 1];
  const out = new Float64Array(31);
  for (let i = 0; i < 31; i++) {
    out[i] = r[4] * 2 - 1;
    const fb = r[4] ^ r[2];
    r.pop();
    r.unshift(fb);
  }
  return out;
}

/** Один буфер baseband-сигнала для превью. Ось 0 Гц = центр RF. */
export function previewWaveform(
  kind: WaveKind,
  pr: Record<string, number>,
  n: number = WAVE_PREVIEW_N,
): { re: Float64Array; im: Float64Array } {
  const p = clampParams(kind, pr);
  const amp = p.amp ?? 0.25;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const snap = (fHz: number) => (Math.max(1, Math.round((fHz * n) / WAVE_FS)) * WAVE_FS) / n;

  switch (kind) {
    case "sine":
    case "tone": {
      const fj = Math.round((p.fj ?? 0) * n) / n;
      const theta = kind === "tone" ? Math.random() * 2 * Math.PI : 0;
      for (let i = 0; i < n; i++) {
        const ph = 2 * Math.PI * fj * i + theta;
        re[i] = amp * Math.cos(ph);
        im[i] = amp * Math.sin(ph);
      }
      break;
    }
    case "square": {
      const fb = snap((p.fbKhz ?? 125) * 1e3);
      for (let i = 0; i < n; i++) re[i] = amp * Math.sign(Math.sin((2 * Math.PI * fb * i) / WAVE_FS));
      break;
    }
    case "sawtooth": {
      const fb = snap((p.fbKhz ?? 125) * 1e3);
      for (let i = 0; i < n; i++) re[i] = amp * (2 * (((fb * i) / WAVE_FS) % 1) - 1);
      break;
    }
    case "triangle": {
      const fb = snap((p.fbKhz ?? 125) * 1e3);
      for (let i = 0; i < n; i++)
        re[i] = ((2 * amp) / Math.PI) * Math.asin(Math.sin((2 * Math.PI * fb * i) / WAVE_FS));
      break;
    }
    case "chirp": {
      const span = (p.spanKhz ?? 1000) * 1e3;
      const f0 = -span / 2;
      const k = span / (n / WAVE_FS);
      for (let i = 0; i < n; i++) {
        const t = i / WAVE_FS;
        const ph = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
        re[i] = amp * Math.cos(ph);
        im[i] = amp * Math.sin(ph);
      }
      break;
    }
    case "awgn": {
      const rand = mulberry32(p.seed ?? 1337);
      for (let i = 0; i < n; i++) {
        const [gr, gi] = gaussPair(rand);
        re[i] = (gr / Math.SQRT2) * (amp / 2);
        im[i] = (gi / Math.SQRT2) * (amp / 2);
        const m = Math.hypot(re[i], im[i]);
        if (m > amp) {
          re[i] *= amp / m;
          im[i] *= amp / m;
        }
      }
      break;
    }
    case "bpsk":
    case "qpsk":
    case "qam16": {
      const sps = Math.round(p.sps ?? 4);
      const nsym = Math.floor(n / sps);
      const sym =
        kind === "qam16"
          ? qam16Symbols(nsym, p.seed ?? 1337)
          : pskSymbols(nsym, kind === "bpsk" ? 2 : 4, p.seed ?? 1337);
      return modWave(sym, sps, p.alpha ?? 0.035, amp, kind !== "qam16");
    }
    case "fsk2": {
      const sps = Math.round(p.sps ?? 8);
      const dev = (p.devKhz ?? 250) * 1e3;
      const rand = mulberry32(p.seed ?? 1337);
      let phase = 0;
      let sym = 1;
      for (let i = 0; i < n; i++) {
        if (i % sps === 0) sym = rand() >= 0.5 ? 1 : -1;
        phase += (2 * Math.PI * dev * sym) / WAVE_FS;
        re[i] = amp * Math.cos(phase);
        im[i] = amp * Math.sin(phase);
      }
      break;
    }
    case "dsss": {
      const chips = mseq31();
      const rand = mulberry32(p.seed ?? 1337);
      const spc = 2;
      let bit = 1;
      for (let i = 0; i < n; i++) {
        const chipIdx = Math.floor(i / spc);
        if (chipIdx % 31 === 0) bit = rand() >= 0.5 ? 1 : -1;
        re[i] = amp * bit * chips[chipIdx % 31];
      }
      break;
    }
    case "css": {
      const sf = Math.round(p.sf ?? 6);
      const m = 1 << sf;
      const rand = mulberry32(p.seed ?? 1337);
      for (let s = 0; s * m < n; s++) {
        const sym = Math.floor(rand() * m);
        for (let k = 0; k < m && s * m + k < n; k++) {
          const ph = 2 * Math.PI * ((k * k) / (2 * m) + (sym / m) * k);
          re[s * m + k] = amp * Math.cos(ph);
          im[s * m + k] = amp * Math.sin(ph);
        }
      }
      break;
    }
    case "ofdm": {
      const nfft = 64;
      const cp = 16;
      const rand = mulberry32(p.seed ?? 1337);
      const used: number[] = [];
      for (let k = -26; k <= 26; k++) if (k !== 0) used.push(k);
      let peak = 0;
      for (let s = 0; s * (nfft + cp) < n; s++) {
        const sre = new Float64Array(nfft);
        const sim = new Float64Array(nfft);
        for (const k of used) {
          const ph = Math.PI / 4 + Math.floor(rand() * 4) * (Math.PI / 2);
          sre[(k + nfft) % nfft] = Math.cos(ph);
          sim[(k + nfft) % nfft] = Math.sin(ph);
        }
        fftInPlace(sre, sim, true); // ОБПФ (с нормировкой 1/n) — масштаб поправим пиком
        const base = s * (nfft + cp);
        for (let k = 0; k < nfft + cp && base + k < n; k++) {
          const src = k < cp ? nfft - cp + k : k - cp;
          re[base + k] = sre[src] * Math.sqrt(nfft);
          im[base + k] = sim[src] * Math.sqrt(nfft);
          peak = Math.max(peak, Math.hypot(re[base + k], im[base + k]));
        }
      }
      const g = amp / (peak || 1);
      for (let i = 0; i < n; i++) {
        re[i] *= g;
        im[i] *= g;
      }
      break;
    }
    case "am": {
      const fb = snap((p.fbKhz ?? 125) * 1e3);
      const fm = (p.fmKhz ?? 31.25) * 1e3;
      const m = p.m ?? 0.5;
      for (let i = 0; i < n; i++) {
        const t = i / WAVE_FS;
        const env = (1 + m * Math.sin(2 * Math.PI * fm * t)) / (1 + m);
        re[i] = amp * env * Math.cos(2 * Math.PI * fb * t);
        im[i] = amp * env * Math.sin(2 * Math.PI * fb * t);
      }
      break;
    }
    case "fm": {
      const fb = snap((p.fbKhz ?? 125) * 1e3);
      const fm = (p.fmKhz ?? 31.25) * 1e3;
      const beta = p.beta ?? 5;
      for (let i = 0; i < n; i++) {
        const t = i / WAVE_FS;
        const ph = 2 * Math.PI * fb * t + beta * Math.sin(2 * Math.PI * fm * t);
        re[i] = amp * Math.cos(ph);
        im[i] = amp * Math.sin(ph);
      }
      break;
    }
  }
  return { re, im };
}

/** Идеальное созвездие (до RRC) для модулированных типов; null для остальных. */
export function constellationPoints(
  kind: WaveKind,
  pr: Record<string, number>,
  maxSym = 128,
): { i: number; q: number }[] | null {
  const p = clampParams(kind, pr);
  if (kind === "bpsk" || kind === "qpsk") {
    const s = pskSymbols(maxSym, kind === "bpsk" ? 2 : 4, p.seed ?? 1337);
    return Array.from({ length: maxSym }, (_, k) => ({ i: s.re[k], q: s.im[k] }));
  }
  if (kind === "qam16") {
    const s = qam16Symbols(maxSym, p.seed ?? 1337);
    return Array.from({ length: maxSym }, (_, k) => ({ i: s.re[k], q: s.im[k] }));
  }
  return null;
}
