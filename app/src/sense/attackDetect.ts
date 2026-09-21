// ============================================================================
// LEGION — глаза хост-Атаки. Только scanPattern="auto".
// CA-CFAR 1D: порт esm-wideband-cfar/src/cfar/cfar1d.py (prefix-sum, края
// не считаются). Склейка — непрерывный run бинов, не клей 0.25 МГц.
// detectFromBins / estimateNoiseFloor не трогаем.
// ============================================================================
import type { Detection, ScanBin } from "../sdr/types";

export const ATTACK_CFAR_TRAIN = 16;
export const ATTACK_CFAR_GUARD = 4;
export const ATTACK_CFAR_PFA = 1e-3;
export const ATTACK_MIN_BW_MHZ = 0.2;
export const ATTACK_MAX_BW_MHZ = 22;
export const ATTACK_VIDEO_BW_MHZ = 6;

export interface AttackHit {
  freqMhz: number;
  powerDbm: number;
  noiseDbm: number;
  snrDb: number;
  fLowMhz: number;
  fHighMhz: number;
  widthMhz: number;
}

function dbmToLin(dbm: number): number {
  return Math.pow(10, dbm / 10);
}

function linToDbm(lin: number): number {
  if (!(lin > 0)) return -200;
  return 10 * Math.log10(lin);
}

/** CA-CFAR 1D по линейной мощности. Края half_window — false / NaN. */
export function caCfar1d(
  powerLin: readonly number[],
  numTrain = ATTACK_CFAR_TRAIN,
  numGuard = ATTACK_CFAR_GUARD,
  pfa = ATTACK_CFAR_PFA,
): { det: boolean[]; thr: number[] } {
  const n = powerLin.length;
  const det = Array<boolean>(n).fill(false);
  const thr = Array<number>(n).fill(Number.NaN);
  const half = numTrain + numGuard;
  if (n < 2 * half + 1) return { det, thr };
  const trainCells = 2 * numTrain;
  const alpha = trainCells * (Math.pow(pfa, -1 / trainCells) - 1);
  const csum = new Array<number>(n + 1);
  csum[0] = 0;
  for (let i = 0; i < n; i++) csum[i + 1] = csum[i] + Math.max(0, powerLin[i]);
  for (let i = half; i < n - half; i++) {
    const full = csum[i + half + 1] - csum[i - half];
    const guard = csum[i + numGuard + 1] - csum[i - numGuard];
    const noise = (full - guard) / trainCells;
    const t = alpha * noise;
    thr[i] = t;
    det[i] = powerLin[i] > t;
  }
  return { det, thr };
}

function binStepMhz(bins: readonly ScanBin[]): number {
  if (bins.length < 2) return ATTACK_MIN_BW_MHZ;
  let s = 0;
  for (let i = 1; i < bins.length; i++) s += Math.abs(bins[i].freqMhz - bins[i - 1].freqMhz);
  return s / (bins.length - 1);
}

function globalFloorDbm(bins: readonly ScanBin[]): number {
  if (bins.length === 0) return 0;
  const sorted = bins.map((b) => b.powerDbm).sort((a, b) => a - b);
  const n = Math.max(1, Math.floor(sorted.length * 0.6));
  const lower = sorted.slice(0, n);
  const mid = Math.floor(lower.length / 2);
  return lower.length % 2 === 0 ? (lower[mid - 1] + lower[mid]) / 2 : lower[mid];
}

function groupRuns(
  bins: readonly ScanBin[],
  mask: readonly boolean[],
  noiseDbm: readonly number[],
): AttackHit[] {
  const out: AttackHit[] = [];
  let i = 0;
  while (i < bins.length) {
    if (!mask[i]) {
      i += 1;
      continue;
    }
    let j = i;
    let peakI = i;
    while (j + 1 < bins.length && mask[j + 1]) {
      j += 1;
      if (bins[j].powerDbm > bins[peakI].powerDbm) peakI = j;
    }
    const peak = bins[peakI];
    let fLow = bins[i].freqMhz;
    let fHigh = bins[j].freqMhz;
    if (fHigh < fLow) {
      const t = fLow;
      fLow = fHigh;
      fHigh = t;
    }
    let width = Math.max(fHigh - fLow, binStepMhz(bins));
    if (width < ATTACK_MIN_BW_MHZ) {
      i = j + 1;
      continue;
    }
    if (width > ATTACK_MAX_BW_MHZ) {
      const half = ATTACK_MAX_BW_MHZ / 2;
      fLow = peak.freqMhz - half;
      fHigh = peak.freqMhz + half;
      width = ATTACK_MAX_BW_MHZ;
    }
    const noise = noiseDbm[peakI] ?? globalFloorDbm(bins);
    out.push({
      freqMhz: peak.freqMhz,
      powerDbm: peak.powerDbm,
      noiseDbm: noise,
      snrDb: peak.powerDbm - noise,
      fLowMhz: fLow,
      fHighMhz: fHigh,
      widthMhz: width,
    });
    i = j + 1;
  }
  return out;
}

/** Порог Атаки: CFAR если окно достаточно длинное, иначе глобальный пол + thresholdDb. */
export function detectAttackHits(bins: readonly ScanBin[], thresholdDb: number): AttackHit[] {
  if (bins.length === 0) return [];
  const floor = globalFloorDbm(bins);
  const lin = bins.map((b) => dbmToLin(b.powerDbm));
  const half = ATTACK_CFAR_TRAIN + ATTACK_CFAR_GUARD;
  const mask = Array<boolean>(bins.length).fill(false);
  const noiseAt = bins.map(() => floor);
  if (bins.length >= 2 * half + 1) {
    const { det, thr } = caCfar1d(lin);
    for (let i = 0; i < bins.length; i++) {
      const localFloor = Number.isFinite(thr[i]) ? linToDbm(thr[i]) : floor;
      noiseAt[i] = localFloor;
      const snr = bins[i].powerDbm - localFloor;
      mask[i] = det[i] || snr >= thresholdDb;
    }
  } else {
    for (let i = 0; i < bins.length; i++) {
      mask[i] = bins[i].powerDbm - floor >= thresholdDb;
    }
  }
  return groupRuns(bins, mask, noiseAt);
}

export function attackHitsToDetections(hits: readonly AttackHit[], ts: number): Detection[] {
  return hits.map((h) => ({
    freqMhz: h.freqMhz,
    powerDbm: h.powerDbm,
    noiseDbm: h.noiseDbm,
    snrDb: h.snrDb,
    ts,
    forwarded: false,
  }));
}
