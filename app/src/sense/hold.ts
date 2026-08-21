// ============================================================================
// LEGION — после ПЕРЕДАТЬ: приоритет (сильнее) или обычный (очередь + выдержка).
// СБРОСИТЬ — только кнопка оператора, не таймер и не архив засечек.
// Свой CW заполняет тот же бин: «пропала» не видно, пока тон на RF out.
// ============================================================================
import type { Detection } from "../sdr/types";
import { pickStrongest, sameBin } from "./orchestrator";

export const RESENSE_MS = 1000;

export type AutoDispatch = "priority" | "turn";

export function heldHitAlive(dets: readonly Detection[], heldMhz: number): boolean {
  return dets.some((d) => sameBin(d.freqMhz, heldMhz));
}

export function uniqueBins(dets: readonly Detection[]): Detection[] {
  const out: Detection[] = [];
  for (const d of dets) {
    const i = out.findIndex((x) => sameBin(x.freqMhz, d.freqMhz));
    if (i < 0) out.push({ ...d });
    else if (d.powerDbm > out[i].powerDbm) out[i] = { ...d };
  }
  return out;
}

/** ПРИОРИТЕТ: на усилитель только сильнейшая. Слабее текущую не сбивает. */
export function pickPriorityTarget(
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

/**
 * ОБЫЧНЫЙ: живые по кругу. Выдержка = сколько держим текущую, потом следующая.
 * held нет в withoutOwnTx — подставляем слот, иначе третья частота выпадает.
 */
export function pickTurnTarget(
  liveWindow: readonly Detection[],
  skipMhz: number | null,
  heldMhz: number | null,
  heldPowerDbm: number | null = null,
): Detection | null {
  let pool = uniqueBins(
    skipMhz == null ? liveWindow : liveWindow.filter((d) => !sameBin(d.freqMhz, skipMhz)),
  );
  if (heldMhz != null && !pool.some((d) => sameBin(d.freqMhz, heldMhz))) {
    pool.push({
      freqMhz: heldMhz,
      powerDbm: heldPowerDbm ?? 0,
      noiseDbm: 0,
      snrDb: 0,
      ts: 0,
      forwarded: true,
    });
  }
  pool = uniqueBins(pool).sort((a, b) => a.freqMhz - b.freqMhz);
  if (pool.length === 0) return null;
  if (heldMhz == null) return pickStrongest(pool);
  const idx = pool.findIndex((d) => sameBin(d.freqMhz, heldMhz));
  if (idx < 0) return pool[0];
  return pool[(idx + 1) % pool.length];
}

/** СБРОСИТЬ не выбирает следующую из архива. Ждём живое окно. */
export function nextAfterOperatorReset(_archive: readonly Detection[]): null {
  return null;
}

/** Merge-архив на TX не идёт — только текущее FFT-окно. */
export function pickArmedAutoTarget(opts: {
  liveWindow: readonly Detection[];
  archive: readonly Detection[];
  heldMhz: number | null;
  heldPowerDbm: number | null;
  skipMhz: number | null;
  dispatch: AutoDispatch;
}): Detection | null {
  void opts.archive;
  if (opts.dispatch === "turn") {
    return pickTurnTarget(opts.liveWindow, opts.skipMhz, opts.heldMhz, opts.heldPowerDbm);
  }
  return pickPriorityTarget(opts.liveWindow, opts.heldMhz, opts.heldPowerDbm, opts.skipMhz);
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
