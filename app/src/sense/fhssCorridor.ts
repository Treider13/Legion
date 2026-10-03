// ============================================================================
// LEGION — коридор FPGA из hop-set, не из обзора 2000–3000.
// Подтвердить: F1…F2 = огибающая look, взгляд ≤ analog платы.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import type { AttackLook } from "./attackLook";
import { fhssArmGate, type FhssArmGate } from "./fhssArmGate";
import { FPGA_AIR_BW_MIN_MHZ, clampAirBwMhz } from "./fpgaFastpath";
import type { FhssLook } from "./protocolDb";
import { gridFromMeasuredFhss, type SmartGridCard } from "./smartGrid";

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
