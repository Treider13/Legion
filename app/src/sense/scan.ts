// ============================================================================
// LEGION — SCAN RX: обход только allowlist, energy detection.
// Не излучает. Не ходит в ADF4351. Хост + SDR backend.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import { detectFromBins, type SdrBackend } from "../sdr/backend";
import type { Detection } from "../sdr/types";

export interface ScanConfig {
  bands: readonly AllowBand[];
  bwMhz: number;
  bins: number;
  thresholdDb: number;
}

export interface ScanTick {
  centerMhz: number;
  detections: Detection[];
  done: boolean;
}

export class AllowlistScanner {
  private idx = 0;
  private centers: number[] = [];
  private readonly backend: SdrBackend;
  private readonly cfg: ScanConfig;

  constructor(backend: SdrBackend, cfg: ScanConfig) {
    this.backend = backend;
    this.cfg = cfg;
    this.centers = planCenters(cfg.bands, cfg.bwMhz);
  }

  remaining(): number {
    return Math.max(0, this.centers.length - this.idx);
  }

  tick(now = Date.now()): ScanTick {
    if (this.centers.length === 0 || this.idx >= this.centers.length) {
      return { centerMhz: 0, detections: [], done: true };
    }
    const centerMhz = this.centers[this.idx++];
    const bins = this.backend.scanWindow(centerMhz, this.cfg.bwMhz, this.cfg.bins);
    const detections = detectFromBins(bins, this.cfg.thresholdDb).map((d) => ({
      ...d,
      ts: now,
    }));
    return {
      centerMhz,
      detections,
      done: this.idx >= this.centers.length,
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
