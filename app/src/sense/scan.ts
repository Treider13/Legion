// ============================================================================
// LEGION — SCAN RX: обход только allowlist, energy detection.
// Не излучает. Не ходит в ADF4351. Хост + SDR backend.
// ============================================================================
import { cueFreqAllowed, type AllowBand } from "../policy/allowlist";
import { detectFromBins, type SdrBackend } from "../sdr/backend";
import type { Detection, ScanBin } from "../sdr/types";

export interface ScanConfig {
  bands: readonly AllowBand[];
  bwMhz: number;
  bins: number;
  thresholdDb: number;
  /** Непрерывный обход антенны RX (после ПЕРЕДАТЬ / СКАНИРОВАТЬ). */
  loop?: boolean;
}

export interface ScanTick {
  centerMhz: number;
  detections: Detection[];
  bins: ScanBin[];
  done: boolean;
}

export class AllowlistScanner {
  private idx = 0;
  private centers: number[] = [];
  private readonly backend: SdrBackend;
  private readonly cfg: ScanConfig;
  private thresholdDb: number;

  constructor(backend: SdrBackend, cfg: ScanConfig) {
    this.backend = backend;
    this.cfg = cfg;
    this.thresholdDb = cfg.thresholdDb;
    this.centers = planCenters(cfg.bands, cfg.bwMhz);
  }

  setThresholdDb(db: number): void {
    this.thresholdDb = db;
  }

  remaining(): number {
    return Math.max(0, this.centers.length - this.idx);
  }

  rewind(): void {
    this.idx = 0;
  }

  tick(now = Date.now()): ScanTick {
    if (this.centers.length === 0) {
      return { centerMhz: 0, detections: [], bins: [], done: true };
    }
    if (this.idx >= this.centers.length) {
      if (this.cfg.loop) this.idx = 0;
      else return { centerMhz: 0, detections: [], bins: [], done: true };
    }
    const centerMhz = this.centers[this.idx++];
    const bins = this.backend.scanWindow(centerMhz, this.cfg.bwMhz, this.cfg.bins);
    const detections = clipToAllowlist(
      detectFromBins(bins, this.thresholdDb).map((d) => ({
        ...d,
        ts: now,
        forwarded: false,
      })),
      this.cfg.bands,
    );
    const wrapped = this.idx >= this.centers.length;
    if (wrapped && this.cfg.loop) this.idx = 0;
    return {
      centerMhz,
      detections,
      bins,
      done: wrapped && !this.cfg.loop,
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
