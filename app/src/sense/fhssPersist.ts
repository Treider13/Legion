// ============================================================================
// LEGION — два persist: маска occupancy платы vs слух (треки + семья).
// Расхождение снижает conf затвора. Пустой CH_* вне 2.4 — не штраф (карта NIOS).
// ============================================================================
import { stitchHopFamilies } from "./attackFamily";
import type { AttackLook } from "./attackLook";
import type { AttackTrack } from "./attackTracks";

export const FHSS_PERSIST_RATIO = 0.4;
export const FHSS_PERSIST_DIV_PENALTY = 0.2;

export interface FhssPersistSnap {
  occHops: number;
  listenHops: number;
  occFamily: string;
  listenFamily: string;
  penalty: number;
  diverge: boolean;
  line: string;
}

export function listenPersistHops(
  tracks: readonly AttackTrack[],
  hopsMhz: readonly number[],
  look: AttackLook | null | undefined,
): { n: number; family: string } {
  const fhss = look?.fhss?.hit ? look.fhss : null;
  if (fhss) {
    return {
      n: fhss.unique || fhss.nSlots || fhss.hopSetMhz.length,
      family: fhss.domain?.family ?? "",
    };
  }
  const fams = stitchHopFamilies(tracks, hopsMhz);
  const live = tracks.filter((t) => t.state !== "cooled").map((t) => Math.round(t.freqMhz * 1000) / 1000);
  const n = Math.max(
    new Set(live).size,
    fams.reduce((a, f) => a + f.members.length, 0),
    hopsMhz.length,
  );
  return { n, family: fams[0]?.band ?? "" };
}

export function fhssPersistOf(opts: {
  occHops: number;
  listenHops: number;
  occFamily?: string;
  listenFamily?: string;
}): FhssPersistSnap {
  const occHops = Math.max(0, Math.round(opts.occHops));
  const listenHops = Math.max(0, Math.round(opts.listenHops));
  const occFamily = opts.occFamily ?? "";
  const listenFamily = opts.listenFamily ?? "";
  if (occHops <= 0) {
    return {
      occHops,
      listenHops,
      occFamily,
      listenFamily,
      penalty: 0,
      diverge: false,
      line: `persist occupancy пуст · слух ${listenHops} · AIM по GRID`,
    };
  }
  if (listenHops <= 0) {
    return {
      occHops,
      listenHops,
      occFamily,
      listenFamily,
      penalty: 0,
      diverge: false,
      line: `persist слух пуст · occupancy ${occHops} · AIM по GRID`,
    };
  }
  const ratio = Math.min(occHops, listenHops) / Math.max(occHops, listenHops);
  const diverge = ratio < FHSS_PERSIST_RATIO;
  const penalty = diverge ? FHSS_PERSIST_DIV_PENALTY : 0;
  return {
    occHops,
    listenHops,
    occFamily,
    listenFamily,
    penalty,
    diverge,
    line: diverge
      ? `persist расхождение occupancy ${occHops} vs слух ${listenHops} · conf −${penalty.toFixed(2)}`
      : `persist occupancy ${occHops} · слух ${listenHops}`,
  };
}
