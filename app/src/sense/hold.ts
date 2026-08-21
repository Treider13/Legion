// ============================================================================
// LEGION — авто-режим SDR: сильнее сразу на усилитель; СБРОСИТЬ если залипло.
// Свой CW заполняет тот же бин: «пропала» не видно, пока тон на RF out.
// Re-sense коротко гасит TX и смотрит эфир.
// ============================================================================
import type { Detection } from "../sdr/types";
import { pickStrongest, sameBin } from "./orchestrator";

export const RESENSE_MS = 1000;
/** СБРОСИТЬ имеет смысл, если одна частота слишком долго. */
export const STUCK_MS = 8000;

export function heldHitAlive(dets: readonly Detection[], heldMhz: number): boolean {
  return dets.some((d) => sameBin(d.freqMhz, heldMhz));
}

export function lockIsStuck(holdSinceMs: number | null, nowMs: number, limitMs = STUCK_MS): boolean {
  if (holdSinceMs == null) return false;
  return nowMs - holdSinceMs >= limitMs;
}

/** Чуть сильнее другой бин — сразу на усилитель. Тот же бин не трогаем. */
export function pickAutoTarget(
  dets: readonly Detection[],
  heldMhz: number | null,
  heldPowerDbm: number | null,
  skipMhz: number | null = null,
): Detection | null {
  const pool =
    skipMhz == null ? dets : dets.filter((d) => !sameBin(d.freqMhz, skipMhz));
  const best = pickStrongest(pool);
  if (!best) return null;
  if (heldMhz == null) return best;
  if (sameBin(best.freqMhz, heldMhz)) return null;
  if (heldPowerDbm == null || best.powerDbm > heldPowerDbm) return best;
  return null;
}

/** После СБРОСИТЬ — следующая засечка, не та же. */
export function pickOtherHit(
  dets: readonly Detection[],
  skipMhz: number | null,
): Detection | null {
  const pool =
    skipMhz == null ? dets : dets.filter((d) => !sameBin(d.freqMhz, skipMhz));
  return pickStrongest(pool);
}
