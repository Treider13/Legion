import { ScanWalker } from "../sense/scan";
import { sweepNextMhz } from "../sl22/map";
import type { SdrWalkPattern } from "../sense/modes";

/**
 * Коридор снимка — 8 МГц. Боевое окно хост-TX по умолчанию 20 МГц
 * на таком коридоре даёт одну стоянку, и качание на экране не видно.
 * 2 МГц — ширина взгляда эфира по умолчанию: на этом коридоре несколько стоянок.
 */
export const DEMO_LOOK_MHZ = 2;

/** Прошивка держит шаг 10 мс. На коридоре 8 МГц при шаге 1 МГц цифра не читается. */
export const DEMO_ESP_STEP_MHZ = 1;
export const DEMO_ESP_DRAW_MS = 200;

export type OpenLoopPattern = Extract<SdrWalkPattern, "sweep" | "band" | "hop">;

export function isOpenLoop(pattern: SdrWalkPattern): pattern is OpenLoopPattern {
  return pattern === "sweep" || pattern === "band" || pattern === "hop";
}

/** Тот же ScanWalker, что боевой открытый TX. seed фиксирован, чтобы повтор демо совпадал. */
export function hostTxWalker(
  pattern: OpenLoopPattern,
  f1Mhz: number,
  f2Mhz: number,
  windowMhz: number,
  analogBwMhz: number,
): ScanWalker {
  return new ScanWalker({
    bands: [{ f1Mhz, f2Mhz }],
    pattern,
    windowMhz,
    analogBwMhz,
    dwellMs: 40,
    seed: 1,
  });
}

/** Тот же шаг, что engine_sweep_next: cur += step, выше F2 — снова F1. */
export function espSweepNext(curMhz: number, f1Mhz: number, f2Mhz: number): number {
  return sweepNextMhz(curMhz, f1Mhz, f2Mhz, DEMO_ESP_STEP_MHZ);
}
