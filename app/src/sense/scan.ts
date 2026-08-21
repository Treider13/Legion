// ============================================================================
// LEGION — SCAN RX: обход только allowlist, energy detection.
// Не излучает. Не ходит в ADF4351. Хост + SDR backend.
// ============================================================================
import { cueFreqAllowed, type AllowBand } from "../policy/allowlist";
import { detectFromBins, type SdrBackend } from "../sdr/backend";
import type { Detection, ScanBin } from "../sdr/types";

export type ScanPattern = "sweep" | "band" | "hop";

export interface ScanConfig {
  bands: readonly AllowBand[];
  bwMhz: number;
  bins: number;
  thresholdDb: number;
  /** Непрерывный обход антенны RX (СКАНИРОВАТЬ или ПЕРЕДАТЬ). */
  loop?: boolean;
  pattern?: ScanPattern;
  dwellMs?: number;
  seed?: number;
}

export interface ScanTick {
  centerMhz: number;
  detections: Detection[];
  bins: ScanBin[];
  done: boolean;
}

export interface ScanStep {
  centerMhz: number;
  windowMhz: number;
}

export function clampWindowMhz(wantMhz: number, analogBwMhz: number): number {
  const cap = analogBwMhz > 0 ? analogBwMhz : 20;
  const w = Number.isFinite(wantMhz) && wantMhz > 0 ? wantMhz : cap;
  return Math.round(Math.min(Math.max(w, 0.2), cap) * 1000) / 1000;
}

export function clampDwellMs(ms: number, fallback = 40): number {
  const n = Number.isFinite(ms) && ms > 0 ? ms : fallback;
  return Math.round(Math.min(Math.max(n, 16), 5000));
}

/** Детерминированный RNG для случайной полосы (тесты и повтор). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hopCenterInBand(
  bands: readonly AllowBand[],
  windowMhz: number,
  rng: () => number,
): number {
  const usable = bands.filter((b) => b.f2Mhz >= b.f1Mhz);
  if (usable.length === 0) return 0;
  const b = usable[Math.min(usable.length - 1, Math.floor(rng() * usable.length))];
  const half = windowMhz / 2;
  const wide = b.f2Mhz - b.f1Mhz > windowMhz;
  const lo = wide ? b.f1Mhz + half : b.f1Mhz;
  const hi = wide ? b.f2Mhz - half : b.f2Mhz;
  if (hi <= lo) return (b.f1Mhz + b.f2Mhz) / 2;
  return lo + rng() * (hi - lo);
}

export class ScanWalker {
  readonly pattern: ScanPattern;
  readonly windowMhz: number;
  readonly tickMs: number;
  readonly centers: number[];
  private idx = 0;
  private dir = 1;
  private steps = 0;
  private readonly bands: readonly AllowBand[];
  private readonly rng: () => number;

  constructor(opts: {
    bands: readonly AllowBand[];
    pattern: ScanPattern;
    windowMhz: number;
    analogBwMhz: number;
    dwellMs?: number;
    seed?: number;
  }) {
    this.pattern = opts.pattern;
    this.windowMhz = clampWindowMhz(opts.windowMhz, opts.analogBwMhz);
    this.bands = opts.bands;
    this.centers = planCenters(opts.bands, this.windowMhz);
    const parked = this.centers.length <= 1 && opts.pattern !== "hop";
    this.tickMs = clampDwellMs(opts.dwellMs ?? (parked ? 16 : 40), parked ? 16 : 40);
    this.rng = mulberry32(opts.seed ?? 1337);
  }

  next(): ScanStep {
    this.steps += 1;
    if (this.pattern === "hop") {
      return {
        centerMhz: hopCenterInBand(this.bands, this.windowMhz, this.rng),
        windowMhz: this.windowMhz,
      };
    }
    if (this.centers.length === 0) {
      return { centerMhz: 0, windowMhz: this.windowMhz };
    }
    if (this.pattern === "sweep" && this.centers.length > 1) {
      const centerMhz = this.centers[this.idx];
      const nxt = this.idx + this.dir;
      if (nxt >= this.centers.length || nxt < 0) this.dir *= -1;
      this.idx = Math.min(Math.max(this.idx + this.dir, 0), this.centers.length - 1);
      return { centerMhz, windowMhz: this.windowMhz };
    }
    const centerMhz = this.centers[this.idx % this.centers.length];
    this.idx += 1;
    return { centerMhz, windowMhz: this.windowMhz };
  }

  finished(loop: boolean): boolean {
    if (loop || this.pattern === "hop") return false;
    return this.steps >= Math.max(this.centers.length, 1);
  }
}

export class AllowlistScanner {
  private readonly backend: SdrBackend;
  private readonly cfg: ScanConfig;
  private readonly walker: ScanWalker;
  private thresholdDb: number;

  constructor(backend: SdrBackend, cfg: ScanConfig) {
    this.backend = backend;
    this.cfg = cfg;
    this.thresholdDb = cfg.thresholdDb;
    this.walker = new ScanWalker({
      bands: cfg.bands,
      pattern: cfg.pattern ?? "band",
      windowMhz: cfg.bwMhz,
      analogBwMhz: cfg.bwMhz,
      dwellMs: cfg.dwellMs,
      seed: cfg.seed,
    });
  }

  setThresholdDb(db: number): void {
    this.thresholdDb = db;
  }

  tick(now = Date.now()): ScanTick {
    const step = this.walker.next();
    if (!step.centerMhz) {
      return { centerMhz: 0, detections: [], bins: [], done: true };
    }
    const bins = this.backend.scanWindow(step.centerMhz, step.windowMhz, this.cfg.bins);
    const detections = clipToAllowlist(
      detectFromBins(bins, this.thresholdDb).map((d) => ({
        ...d,
        ts: now,
        forwarded: false,
      })),
      this.cfg.bands,
    );
    return {
      centerMhz: step.centerMhz,
      detections,
      bins,
      done: this.walker.finished(!!this.cfg.loop),
    };
  }
}

export function planCenters(bands: readonly AllowBand[], bwMhz: number): number[] {
  const bw = bwMhz > 0 ? bwMhz : 20;
  const out: number[] = [];
  for (const b of bands) {
    if (b.f2Mhz < b.f1Mhz) continue;
    const span = b.f2Mhz - b.f1Mhz;
    if (span <= bw) {
      out.push((b.f1Mhz + b.f2Mhz) / 2);
      continue;
    }
    const n = Math.ceil(span / bw);
    for (let i = 0; i < n; i++) {
      const c = b.f1Mhz + bw / 2 + i * bw;
      out.push(Math.min(c, b.f2Mhz));
    }
  }
  return out;
}

/** Край окна FFT может вылезти за полосу — в UI и на TX SDR такие бины не идут. */
export function clipToAllowlist(
  dets: readonly Detection[],
  bands: readonly AllowBand[],
): Detection[] {
  return dets.filter((d) => cueFreqAllowed(d.freqMhz, bands));
}

/** Hop = аналоговая BW устройства, не захардкоженные 20 МГц. */
export function scanHopMhz(analogBwMhz: number): number {
  if (!Number.isFinite(analogBwMhz) || analogBwMhz <= 0) return 20;
  return analogBwMhz;
}

/** Parked (одна стоянка) — чаще; hop — реже, чтобы не молотить USB LO. */
export function scanTickMs(centerCount: number): number {
  return centerCount <= 1 ? 16 : 40;
}
