// ============================================================================
// LEGION — стратегия живого DRFM после матчера сетки.
// Хост выбирает отводы/FTW. NIOS не switch(kind). aim NCO не трогаем.
//
// ELRS 2.4: ExpressLRS common.cpp — 500/333 Hz = LoRa SF5 @ BW_0800 (~812.5 кГц),
// символ 39.4 мкс (LBT.cpp). 1/B ≈ 1.23 мкс ≈ 64 отсчёта @ 56 MSPS (two-ray).
// FLRC F1000/F500 матчер не отличает — тот же two-ray.
//
// ZC: proto17/dji_droneid + Schiller 2023 — SCS 15 кГц, root 600/147.
// CFO ≈ 1 SCS ломает пик корреляции ZC (LTE PSS / Hua). Пишем LB_FTW0, не aim.
// OFDM без флага ZC (ISM8 / C58 видео) — не «OcuSync»: CP не опубликован.
//
// Mux уже ×0.9 (LEGION_LB_AMP_Q15=29491). Tap amp 0.5+0.5, не 0.9 на отводе.
// walk_step=0: HDL «STEP=0 — застыть». Иначе lab walk съест 64.
// ============================================================================
import {
  GRID_FLAG_ZC,
  type SmartGridCard,
} from "./smartGrid";

/** Застывший two-ray: 64 @ 56 MSPS ≈ 1.14 мкс ≈ 1/B ELRS LoRa BW_0800.
 *  На другом fs — round(64·fs/56e6), не «всегда 64». 2 MSPS → 2. */
export const DRFM_TAP0 = 0;
export const DRFM_TAP1_TWORY = 64;
export const DRFM_TWORY_FS_HZ = 56e6;
/** Q15 0.5. Mux потом ещё ×0.9 — не ставить 29491 на отвод. */
export const DRFM_AMP_HALF = 16384;
/** 1 SCS DroneID / OcuSync PHY (Schiller 2023, proto17). */
export const DRFM_ZC_SHIFT_HZ = 15_000;
/** Запас 20 кГц. В v1 не включаем. */
export const DRFM_ZC_SHIFT_ALT_HZ = 20_000;

export const DRFM_TWORY_RU = "drfm · two-ray 0/64";
export const DRFM_ZC_RU = "drfm · ZC CFO 15 кГц";

export function drfmTworyDelay1(fsHz: number): number {
  const fs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : DRFM_TWORY_FS_HZ;
  return Math.max(1, Math.min(4095, Math.round((DRFM_TAP1_TWORY * fs) / DRFM_TWORY_FS_HZ)));
}

export function drfmTworyRu(delay1: number): string {
  return `drfm · two-ray 0/${delay1}`;
}

export type DrfmWire = "none" | "shift" | "ftw";

export interface DrfmStrategy {
  id: "tworay" | "zc-cfo";
  delay0: number;
  delay1: number;
  amp0: number;
  amp1: number;
  shiftHz: number;
  ftw: number;
  walkStep: number;
  walkEn: boolean;
  wire: DrfmWire;
  reason: string;
}

export interface DrfmOverride {
  /** >0 — оператор задал tap0. 0 / пусто — таблица. */
  delay0?: number;
  /** Если передано (в т.ч. 0) — бьёт tap1. */
  delay1?: number;
  /** |Hz|≥0.5 — бьёт таблицу (панель «DRFM СДВИГ»). */
  shiftHz?: number;
  /** Готовый FTW бьёт сдвиг. */
  ftw?: number;
  amp0?: number;
  amp1?: number;
  walkStep?: number;
}

export function drfmFtwFromHz(hz: number, fsHz: number): number {
  if (!Number.isFinite(hz) || !Number.isFinite(fsHz) || fsHz <= 0 || Math.abs(hz) < 0.5) {
    return 0;
  }
  /* 15e3/56e6·2³² = 1_150_438, не 1150 (~15 Гц). Шлюз: hz/fs*(1<<32). */
  return (Math.round((hz / fsHz) * 2 ** 32) >>> 0);
}

export function wantsZcDrfm(card: SmartGridCard | null | undefined): boolean {
  if (!card) return false;
  return (card.flags & GRID_FLAG_ZC) !== 0;
}

function twoRay(fsHz: number): DrfmStrategy {
  const delay1 = drfmTworyDelay1(fsHz);
  return {
    id: "tworay",
    delay0: DRFM_TAP0,
    delay1,
    amp0: DRFM_AMP_HALF,
    amp1: DRFM_AMP_HALF,
    shiftHz: 0,
    ftw: 0,
    walkStep: 0,
    walkEn: true,
    wire: "none",
    reason: drfmTworyRu(delay1),
  };
}

function zcCfo(fsHz: number): DrfmStrategy {
  const shiftHz = DRFM_ZC_SHIFT_HZ;
  return {
    id: "zc-cfo",
    delay0: DRFM_TAP0,
    delay1: 0,
    amp0: DRFM_AMP_HALF,
    amp1: 0,
    shiftHz,
    ftw: drfmFtwFromHz(shiftHz, fsHz),
    walkStep: 0,
    walkEn: true,
    wire: "shift",
    reason: DRFM_ZC_RU,
  };
}

function clampDelay(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(4095, Math.round(n));
}

/**
 * Таблица решений. ZC CFO — только подтверждённый GRID_FLAG_ZC (zc_hit).
 * kind=ZC без флага = пресет O4VID3 / LUT, не DroneID (Schiller / proto17).
 * ISM8 / OFDM без флага / analog / пустая сетка — застывший two-ray.
 */
export function planDrfmStrategy(
  card: SmartGridCard | null | undefined,
  fsHz: number,
  override?: DrfmOverride | null,
): DrfmStrategy {
  const fs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : DRFM_TWORY_FS_HZ;
  const s = wantsZcDrfm(card) ? zcCfo(fs) : twoRay(fs);
  const o = override ?? {};

  if (o.delay0 !== undefined && Number.isFinite(o.delay0) && o.delay0 > 0) {
    s.delay0 = clampDelay(o.delay0);
  }
  if (o.delay1 !== undefined && Number.isFinite(o.delay1) && o.delay1 >= 0) {
    s.delay1 = clampDelay(o.delay1);
  }
  if (o.amp0 !== undefined && Number.isFinite(o.amp0)) {
    s.amp0 = Math.max(0, Math.min(32767, Math.round(o.amp0)));
  }
  if (o.amp1 !== undefined && Number.isFinite(o.amp1)) {
    s.amp1 = Math.max(0, Math.min(32767, Math.round(o.amp1)));
  }
  if (o.walkStep !== undefined && Number.isFinite(o.walkStep) && o.walkStep >= 0) {
    s.walkStep = Math.round(o.walkStep);
  }

  if (o.ftw !== undefined && Number.isFinite(o.ftw)) {
    s.ftw = Math.round(o.ftw) >>> 0;
    s.shiftHz = 0;
    s.wire = s.ftw === 0 ? "none" : "ftw";
  } else if (o.shiftHz !== undefined && Number.isFinite(o.shiftHz) && Math.abs(o.shiftHz) >= 0.5) {
    s.shiftHz = o.shiftHz;
    s.ftw = drfmFtwFromHz(o.shiftHz, fs);
    s.wire = "shift";
  }
  return s;
}
