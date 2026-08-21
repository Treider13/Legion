// ============================================================================
// LEGION — после ПЕРЕДАТЬ: каждый новый сигнал сразу на усилитель.
// СБРОСИТЬ — только кнопка оператора, не таймер и не архив засечек.
// Свой CW заполняет тот же бин: «пропала» не видно, пока тон на RF out.
// ============================================================================
import type { Detection } from "../sdr/types";
import { pickStrongest, sameBin } from "./orchestrator";

export const RESENSE_MS = 1000;

export function heldHitAlive(dets: readonly Detection[], heldMhz: number): boolean {
  return dets.some((d) => sameBin(d.freqMhz, heldMhz));
}

export function rememberSeenMhz(seen: readonly number[], mhz: number): number[] {
  if (seen.some((f) => sameBin(f, mhz))) return [...seen];
  return [...seen, mhz];
}

/**
 * Цель авто-режима из ТЕКУЩЕГО окна, не из merge-архива.
 * Новый бин (ещё не уходил на TX в этой сессии) — сразу, даже слабее текущего.
 * Уже виденные не пинг-понгуют каждый тик (свой CW вырезан withoutOwnTx).
 * skipMhz — частота, которую оператор только что сбросил.
 */
export function pickAutoTarget(
  liveWindow: readonly Detection[],
  heldMhz: number | null,
  skipMhz: number | null = null,
  seenMhz: readonly number[] = [],
): Detection | null {
  const pool =
    skipMhz == null ? liveWindow : liveWindow.filter((d) => !sameBin(d.freqMhz, skipMhz));
  if (pool.length === 0) return null;
  const fresh = pool.filter((d) => !seenMhz.some((f) => sameBin(f, d.freqMhz)));
  if (fresh.length > 0) return pickStrongest(fresh);
  if (heldMhz != null) return null;
  return pickStrongest(pool);
}

/** СБРОСИТЬ не выбирает следующую из архива. Ждём живое окно. */
export function nextAfterOperatorReset(_archive: readonly Detection[]): null {
  return null;
}

/** Merge-архив (до 48 бинов) на TX не идёт — только текущее FFT-окно. */
export function pickArmedAutoTarget(opts: {
  liveWindow: readonly Detection[];
  archive: readonly Detection[];
  heldMhz: number | null;
  skipMhz: number | null;
  seenMhz: readonly number[];
}): Detection | null {
  void opts.archive;
  return pickAutoTarget(opts.liveWindow, opts.heldMhz, opts.skipMhz, opts.seenMhz);
}

export function windowCoversMhz(centerMhz: number, windowMhz: number, mhz: number): boolean {
  const half = windowMhz / 2;
  return mhz >= centerMhz - half && mhz <= centerMhz + half;
}

/**
 * СБРОСИТЬ держит частоту, пока она жива в покрывающем окне.
 * Нет бинов (half-duplex пауза) и чужая стойка ≠ «ушла».
 * Бины есть, засечки на этой частоте нет — skip снимаем.
 */
export function refreshSkipMhz(
  skipMhz: number | null,
  liveWindow: readonly Detection[],
  centerMhz: number,
  windowMhz: number,
  hadBins = true,
): number | null {
  if (skipMhz == null) return null;
  if (!hadBins) return skipMhz;
  if (!windowCoversMhz(centerMhz, windowMhz, skipMhz)) return skipMhz;
  return liveWindow.some((d) => sameBin(d.freqMhz, skipMhz)) ? skipMhz : null;
}
