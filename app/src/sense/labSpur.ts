// ============================================================================
// LEGION — шпоры хост-FFT. 1:1 с pavsa SpurFilter.java
// (hackrf-spectrum-analyzer / jspectrumanalyzer.core).
// Дефолты из HackRFSweepSpectrumAnalyzer.java: jitter 6 дБ, порог 4 дБ,
// maxPeakBins 4, validIterations 25.
// Работает по индексу бина hop-окна (DC / образ LO), не по коридору F1…F2.
// Не гейт FPGA. Пока не набрано 25 кадров — кадр без вычитания (калибровка).
// ============================================================================
import type { ScanBin } from "../sdr/types";
import { finiteDbm } from "./labPsd";

export const SPUR_MAX_PEAK_JITTER_DB = 6;
export const SPUR_PEAK_ABOVE_NOISE_DB = 4;
export const SPUR_MAX_PEAK_BINS = 4;
export const SPUR_VALID_ITERATIONS = 25;

function ema(current: number, previous: number, order: number): number {
  const k = 2 / (order + 1);
  return current * k + previous * (1 - k);
}

export class SpurFilter {
  private readonly jitterDb: number;
  private readonly peakAbove: number;
  private readonly maxPeakBins: number;
  private readonly validIterations: number;
  private inputs: number[][] = [];
  private correction: number[] = [];
  private calibrated = false;
  private lastLen = 0;

  constructor(
    maxPeakJitterdB = SPUR_MAX_PEAK_JITTER_DB,
    peakThresholdAboveNoise = SPUR_PEAK_ABOVE_NOISE_DB,
    maxPeakBins = SPUR_MAX_PEAK_BINS,
    validIterations = SPUR_VALID_ITERATIONS,
  ) {
    this.jitterDb = maxPeakJitterdB;
    this.peakAbove = peakThresholdAboveNoise;
    this.maxPeakBins = maxPeakBins;
    this.validIterations = validIterations;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  pendingFrames(): number {
    return this.calibrated ? 0 : Math.max(0, this.validIterations - this.inputs.length);
  }

  recalibrate(): void {
    this.calibrated = false;
    this.inputs = [];
    this.correction = [];
    this.lastLen = 0;
  }

  /**
   * Как filterDataset(): пока не калиброван — копит и возвращает вход как есть.
   * После калибровки вычитает filter[i] (spurAboveNoise) из powerDbm.
   */
  filter(window: readonly ScanBin[]): ScanBin[] {
    const powers = window.map((b) => (finiteDbm(b.powerDbm) ? b.powerDbm : Number.NaN));
    if (powers.length !== this.lastLen) {
      this.recalibrate();
      this.lastLen = powers.length;
    }
    if (!this.calibrated) {
      this.calibrate(powers);
      return window.map((b) => ({ freqMhz: b.freqMhz, powerDbm: b.powerDbm }));
    }
    return window.map((b, i) => ({
      freqMhz: b.freqMhz,
      powerDbm: finiteDbm(b.powerDbm) ? b.powerDbm - (this.correction[i] ?? 0) : b.powerDbm,
    }));
  }

  private calibrate(powers: number[]): void {
    this.inputs.push(powers.slice());
    if (this.inputs.length < this.validIterations) return;
    const n = powers.length;
    const avg = new Array(n).fill(0);
    for (const row of this.inputs) {
      for (let i = 0; i < n; i++) avg[i] += finiteDbm(row[i]) ? row[i] : 0;
    }
    for (let i = 0; i < n; i++) avg[i] /= this.validIterations;

    const noise = new Array(n).fill(0);
    let emaNoise = avg[0];
    const order = Math.max(5, n / 50);
    const end = n - this.maxPeakBins;
    for (let i = 0; i < this.maxPeakBins; i++) noise[i] = emaNoise;
    const spurIdx: number[] = [];
    for (let i = this.maxPeakBins; i < end; i++) {
      const curr = avg[i];
      let left = false;
      let right = false;
      for (let j = i - this.maxPeakBins; j < i && !left; j++) {
        if (curr - emaNoise >= this.peakAbove) left = true;
      }
      for (let j = i + 1; j <= i + this.maxPeakBins && !right; j++) {
        if (curr - emaNoise >= this.peakAbove) right = true;
      }
      if (left && right) spurIdx.push(i);
      else emaNoise = ema(curr, emaNoise, order);
      noise[i] = emaNoise;
    }
    for (let i = end; i < n; i++) noise[i] = emaNoise;

    const stable = spurIdx.filter((idx) => {
      for (const row of this.inputs) {
        if (!finiteDbm(row[idx]) || Math.abs(row[idx] - avg[idx]) > this.jitterDb) return false;
      }
      return true;
    });

    this.correction = new Array(n).fill(0);
    for (const s of stable) this.correction[s] = avg[s] - noise[s];
    this.calibrated = true;
  }
}
