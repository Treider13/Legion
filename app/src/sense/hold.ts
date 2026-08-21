// ============================================================================
// LEGION — замок на засечку: держим TX, пока эфир жив; СБРОСИТЬ — на другую.
// Свой CW заполняет тот же бин: пока тон на RF out, «пропала» не видно.
// Поэтому re-sense коротко гасит TX, смотрит RX, и либо возвращает тон, либо нет.
// ============================================================================
import type { Detection } from "../sdr/types";
import { pickStrongest, sameBin } from "./orchestrator";

/** Пауза между проверками «засечка ещё в эфире». */
export const RESENSE_MS = 1000;

export function heldHitAlive(dets: readonly Detection[], heldMhz: number): boolean {
  return dets.some((d) => sameBin(d.freqMhz, heldMhz));
}

/** После СБРОСИТЬ / пропажи — следующая засечка, не та же. */
export function pickOtherHit(
  dets: readonly Detection[],
  skipMhz: number | null,
): Detection | null {
  const pool =
    skipMhz == null ? dets : dets.filter((d) => !sameBin(d.freqMhz, skipMhz));
  return pickStrongest(pool);
}
