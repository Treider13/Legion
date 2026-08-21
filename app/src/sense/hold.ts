// ============================================================================
// LEGION — после ПЕРЕДАТЬ: сильнее сразу на усилитель. Обход полосы — выбор оператора.
// СБРОСИТЬ — только кнопка оператора, не таймер и не архив засечек.
// Свой CW заполняет тот же бин: «пропала» не видно, пока тон на RF out.
// ============================================================================
import type { Detection } from "../sdr/types";
import { pickStrongest, sameBin } from "./orchestrator";

export const RESENSE_MS = 1000;

export function heldHitAlive(dets: readonly Detection[], heldMhz: number): boolean {
  return dets.some((d) => sameBin(d.freqMhz, heldMhz));
}

/**
 * Цель авто-режима из ТЕКУЩЕГО окна, не из merge-архива.
 * heldPowerDbm == null при уже занятой частоте — не прыгаем вслепую.
 * skipMhz — частота, которую оператор только что сбросил.
 */
export function pickAutoTarget(
  liveWindow: readonly Detection[],
  heldMhz: number | null,
  heldPowerDbm: number | null,
  skipMhz: number | null = null,
): Detection | null {
  const pool =
    skipMhz == null ? liveWindow : liveWindow.filter((d) => !sameBin(d.freqMhz, skipMhz));
  const best = pickStrongest(pool);
  if (!best) return null;
  if (heldMhz == null) return best;
  if (sameBin(best.freqMhz, heldMhz)) return null;
  if (heldPowerDbm == null) return null;
  if (best.powerDbm > heldPowerDbm) return best;
  return null;
}

/** СБРОСИТЬ не выбирает следующую из архива. Ждём живое окно. */
export function nextAfterOperatorReset(_archive: readonly Detection[]): null {
  return null;
}
