// ============================================================================
// LEGION — коридор FPGA из hop-set, не из обзора 2000–3000.
// Подтвердить: F1…F2 = огибающая look, взгляд ≤ analog платы.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import type { AttackLook } from "./attackLook";
import { fhssArmGate, type FhssArmGate } from "./fhssArmGate";
import { FPGA_AIR_BW_MIN_MHZ, clampAirBwMhz } from "./fpgaFastpath";
import { fhssHopSpacingMhz, fhssResidualF0, type FhssLook } from "./protocolDb";
import { gridFromMeasuredFhss, type SmartGridCard } from "./smartGrid";

/** Индекс HOP_LUT 8 бит. Это потолок таблицы, не число каналов пульта. */
export const HOP_TAPE_CAP = 256;
/** Тот же допуск, что ассоциация следов: дрожание бина — один канал. */
const HOP_CLUSTER_MHZ = 0.2;

export interface FhssCorridor {
  f1Mhz: number;
  f2Mhz: number;
  lookMhz: number;
  windowLimited: boolean;
}

function hopsOf(fhss: FhssLook | null | undefined, hopsMhz: readonly number[]): number[] {
  const fromLook = (fhss?.hopSetMhz ?? []).filter((h) => Number.isFinite(h) && h > 0);
  if (fromLook.length >= 2) return [...new Set(fromLook.map((h) => Math.round(h * 1000) / 1000))].sort((a, b) => a - b);
  return [...new Set(hopsMhz.filter((h) => Number.isFinite(h) && h > 0).map((h) => Math.round(h * 1000) / 1000))].sort(
    (a, b) => a - b,
  );
}

/** Огибающая hop-set. Шире analog — один взгляд вокруг середины, не весь обзор. */
export function fhssCorridorFromLook(
  fhss: FhssLook | null | undefined,
  hopsMhz: readonly number[],
  analogMhz: number,
): FhssCorridor | null {
  const hops = hopsOf(fhss, hopsMhz);
  if (hops.length < 2) return null;
  const pad = fhss && fhss.spacingMhz > 0 ? fhss.spacingMhz * 0.5 : 0.5;
  let f1 = (fhss?.fLowMhz && fhss.fLowMhz > 0 ? fhss.fLowMhz : hops[0]!) - pad;
  let f2 = (fhss?.fHighMhz && fhss.fHighMhz > 0 ? fhss.fHighMhz : hops[hops.length - 1]!) + pad;
  if (!(f2 > f1)) return null;
  const analog = analogMhz > 0 ? analogMhz : 56;
  const span = f2 - f1;
  let windowLimited = fhss?.windowLimited === true || span > analog + 0.5;
  if (span > analog + 0.5) {
    const mid = (f1 + f2) / 2;
    f1 = mid - analog / 2;
    f2 = mid + analog / 2;
    windowLimited = true;
  }
  const lookMhz = clampAirBwMhz(Math.max(f2 - f1, FPGA_AIR_BW_MIN_MHZ), analog);
  return { f1Mhz: f1, f2Mhz: f2, lookMhz, windowLimited };
}

export function fhssCorridorBand(c: FhssCorridor): AllowBand {
  return { f1Mhz: c.f1Mhz, f2Mhz: c.f2Mhz };
}

function medianGapMhz(sorted: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!;
    if (gap > 0.05) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * Лента «каждая вспышка — новая частота» схлопывается в каналы.
 * Повтор канала и юбка окна (2499 при сетке до 2479) сюда не входят:
 * канал — это центр, куда попали несколько раз, а участок — самая длинная
 * цепочка с шагом сетки. 256 остаётся только потолком LUT.
 */
export function collapseHopTape(raw: readonly number[]): number[] {
  type Cluster = { mhz: number; n: number; first: number };
  const clusters: Cluster[] = [];
  let event = 0;
  for (const rawMhz of raw) {
    if (!Number.isFinite(rawMhz) || rawMhz <= 0) continue;
    const mhz = Math.round(rawMhz * 1000) / 1000;
    let best = -1;
    let bestD = HOP_CLUSTER_MHZ;
    for (let i = 0; i < clusters.length; i++) {
      const d = Math.abs(clusters[i]!.mhz - mhz);
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best < 0) clusters.push({ mhz, n: 1, first: event });
    else {
      const cluster = clusters[best]!;
      cluster.mhz = (cluster.mhz * cluster.n + mhz) / (cluster.n + 1);
      cluster.n += 1;
    }
    event += 1;
  }
  if (clusters.length === 0) return [];
  const repeated = clusters.filter((c) => c.n >= 2);
  const pool = repeated.length >= 2 ? repeated : clusters;
  const sorted = [...pool].sort((a, b) => a.mhz - b.mhz);
  const spacing = medianGapMhz(sorted.map((c) => c.mhz));
  const bridge = spacing > 0 ? Math.max(spacing * 3, 1.5) : 3;
  const runs: Cluster[][] = [];
  let run: Cluster[] = [];
  for (const cluster of sorted) {
    const prev = run[run.length - 1];
    if (!prev || cluster.mhz - prev.mhz <= bridge) run.push(cluster);
    else {
      runs.push(run);
      run = [cluster];
    }
  }
  if (run.length > 0) runs.push(run);
  runs.sort((a, b) => b.length - a.length || b.reduce((s, c) => s + c.n, 0) - a.reduce((s, c) => s + c.n, 0));
  const best = runs[0] ?? [];
  const centers = best.map((c) => c.mhz);
  const step = spacing > 0 ? spacing : fhssHopSpacingMhz(centers);
  let snapped = best.map((c) => ({ mhz: Math.round(c.mhz * 1000) / 1000, first: c.first }));
  if (step >= 0.15 && centers.length >= 2) {
    const { residualMhz, fRefMhz } = fhssResidualF0(centers, step);
    const origin = fRefMhz + residualMhz;
    const seen = new Set<number>();
    snapped = [];
    for (const cluster of [...best].sort((a, b) => a.first - b.first)) {
      const k = Math.round((cluster.mhz - origin) / step);
      const grid = Math.round((origin + k * step) * 1000) / 1000;
      if (Math.abs(grid - cluster.mhz) > step * 0.35) continue;
      const key = Math.round(grid * 1000);
      if (seen.has(key)) continue;
      seen.add(key);
      snapped.push({ mhz: grid, first: cluster.first });
    }
    if (snapped.length === 0) {
      snapped = best.map((c) => ({ mhz: Math.round(c.mhz * 1000) / 1000, first: c.first }));
    }
  }
  snapped.sort((a, b) => a.first - b.first);
  return snapped.slice(0, HOP_TAPE_CAP).map((c) => c.mhz);
}

export function evalFhssConfirm(i: {
  look?: AttackLook | null;
  hopsMhz: readonly number[];
  card?: SmartGridCard | null;
  analogMhz: number;
  persistPenalty?: number;
}): {
  ready: boolean;
  gate: FhssArmGate;
  corridor: FhssCorridor | null;
  card: SmartGridCard | null;
} {
  const fhss = i.look?.fhss?.hit ? i.look.fhss : null;
  const corridor = fhssCorridorFromLook(fhss, i.hopsMhz, i.analogMhz);
  /* ARM только из look. Каталог hopMatch (n=80 / F0=2400.4) — для UI, не в GRID. */
  const measured = gridFromMeasuredFhss(fhss, i.hopsMhz, corridor?.windowLimited === true);
  const gate = fhssArmGate({
    look: i.look,
    fhss,
    card: measured,
    persistPenalty: i.persistPenalty,
  });
  return { ready: gate.ok && corridor != null && measured != null, gate, corridor, card: measured };
}
