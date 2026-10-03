// ============================================================================
// LEGION — маска своего TX на occupancy платы. Не кормить persist/conf.
// CH_HITS_0..7 — 8 слотов 10 МГц (2400+i×10). CH_ACTIVE_1..3 — 80 бит ELRS
// 2400.4+i (карта NIOS, не измеренный GRID).
// ============================================================================
import type { Detection } from "../sdr/types";
import { withoutOwnTx } from "./orchestrator";
import { ownTxBlankMhz } from "./attackShelfTx";

export const CH_SLOT_N = 8;
export const CH_SLOT_F0_MHZ = 2400;
export const CH_SLOT_BW_MHZ = 10;
export const CH_ELRS_N = 80;
export const CH_ELRS_F0_MHZ = 2400.4;
export const CH_ELRS_STEP_MHZ = 1;

export interface ChOccupancy {
  chHits: number[];
  chActive: number[];
}

export interface MaskedChOccupancy extends ChOccupancy {
  maskedSlots: number[];
  maskedElrs: number[];
}

function slotMhz(i: number): { lo: number; hi: number; mid: number } {
  const lo = CH_SLOT_F0_MHZ + i * CH_SLOT_BW_MHZ;
  return { lo, hi: lo + CH_SLOT_BW_MHZ, mid: lo + CH_SLOT_BW_MHZ / 2 };
}

function asDet(mhz: number): Detection {
  return { freqMhz: mhz, powerDbm: 0, noiseDbm: 0, snrDb: 0, ts: 0, forwarded: false };
}

/** Слоты/биты в интервале своего TX вырезаются целиком. Карта — NIOS 2.4. */
export function maskOwnTxOccupancy(
  raw: ChOccupancy | null | undefined,
  opts: {
    txMhz: number | null;
    occupyMhz?: number;
    waveArmed?: boolean;
  },
): MaskedChOccupancy {
  const hits = [...(raw?.chHits ?? Array.from({ length: CH_SLOT_N }, () => 0))].slice(0, CH_SLOT_N);
  while (hits.length < CH_SLOT_N) hits.push(0);
  const active = [...(raw?.chActive ?? [0, 0, 0, 0])].slice(0, 4);
  while (active.length < 4) active.push(0);
  const guard = ownTxBlankMhz(opts.occupyMhz ?? 0, opts.waveArmed === true);
  const tx = opts.txMhz;
  const maskedSlots: number[] = [];
  const maskedElrs: number[] = [];
  if (tx == null || !Number.isFinite(tx)) {
    return { chHits: hits, chActive: active, maskedSlots, maskedElrs };
  }
  const slotDets = Array.from({ length: CH_SLOT_N }, (_, i) => asDet(slotMhz(i).mid));
  const keptSlots = new Set(withoutOwnTx(slotDets, tx, guard).map((d) => d.freqMhz));
  for (let i = 0; i < CH_SLOT_N; i++) {
    if (keptSlots.has(slotMhz(i).mid)) continue;
    hits[i] = 0;
    active[0] = (active[0] ?? 0) & ~(1 << i);
    maskedSlots.push(i);
  }
  const elrsDets = Array.from({ length: CH_ELRS_N }, (_, i) => asDet(CH_ELRS_F0_MHZ + i * CH_ELRS_STEP_MHZ));
  const keptElrs = new Set(withoutOwnTx(elrsDets, tx, guard).map((d) => d.freqMhz));
  for (let i = 0; i < CH_ELRS_N; i++) {
    const mhz = CH_ELRS_F0_MHZ + i * CH_ELRS_STEP_MHZ;
    if (keptElrs.has(mhz)) continue;
    const word = 1 + Math.floor(i / 32);
    const bit = i % 32;
    if (word >= 1 && word <= 3) active[word] = (active[word] ?? 0) & ~(1 << bit);
    maskedElrs.push(i);
  }
  return { chHits: hits, chActive: active, maskedSlots, maskedElrs };
}

export function occupancyHopCount(occ: MaskedChOccupancy): number {
  let n = 0;
  for (let w = 1; w <= 3; w++) {
    let bits = occ.chActive[w] ?? 0;
    while (bits) {
      n += bits & 1;
      bits >>>= 1;
    }
  }
  if (n > 0) return n;
  return occ.chHits.filter((h) => h > 0).length;
}
