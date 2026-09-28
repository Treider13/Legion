// ============================================================================
// LEGION — хост-Атака: рамка = коридор слуха, полка = горб TX на засечке.
// xA4 AD9361: один BBPLL (Nuand, robert.ghilduta 2023-03-20) — часы RX=TX
// равны окну слуха, не полке. Полка = analog TX filter + заливка волны.
// USB FD ≤ 40 МГц. Коридор шире окна — слух прыгает внутри рамки.
// ============================================================================
import type { AllowBand } from "../policy/allowlist";
import { rangeInAllowlist } from "../policy/allowlist";
import type { WaveKind } from "../sdr/waveforms";
import {
  ATTACK_TX_FS_MIN_HZ,
  ATTACK_TX_MAX_MHZ,
  ATTACK_TX_MIN_MHZ,
  attackWaveParams,
  normalizePaint,
  paintCenterMhz,
  paintSpanMhz,
  type AttackPaint,
} from "./attackPaint";
import { ATTACK_FD_FS_HZ, attackListenPlan, type AttackListenPlan } from "./attackListen";
import { clampShelfMhz } from "./txShelf";

export function clampCorridorPaint(p: AttackPaint): AttackPaint {
  let { f1Mhz, f2Mhz } = normalizePaint(p.f1Mhz, p.f2Mhz);
  const span = f2Mhz - f1Mhz;
  if (span < ATTACK_TX_MIN_MHZ) {
    const mid = (f1Mhz + f2Mhz) / 2;
    f1Mhz = mid - ATTACK_TX_MIN_MHZ / 2;
    f2Mhz = mid + ATTACK_TX_MIN_MHZ / 2;
  }
  return { f1Mhz, f2Mhz };
}

export function clipCorridorToAllowlist(p: AttackPaint, bands: readonly AllowBand[]): AttackPaint | null {
  const raw = clampCorridorPaint(p);
  if (bands.length === 0) return raw;
  const mid = paintCenterMhz(raw);
  const home =
    bands.find((b) => mid >= b.f1Mhz && mid <= b.f2Mhz) ??
    bands.find((b) => raw.f1Mhz <= b.f2Mhz && raw.f2Mhz >= b.f1Mhz);
  if (!home) return null;
  const f1 = Math.max(raw.f1Mhz, home.f1Mhz);
  const f2 = Math.min(raw.f2Mhz, home.f2Mhz);
  if (f2 - f1 < ATTACK_TX_MIN_MHZ) return null;
  const clipped = clampCorridorPaint({ f1Mhz: f1, f2Mhz: f2 });
  if (!rangeInAllowlist(clipped.f1Mhz, clipped.f2Mhz, [home])) return null;
  return clipped;
}

export function freqInCorridor(mhz: number, paint: AttackPaint, eps = 1e-6): boolean {
  return mhz + eps >= paint.f1Mhz && mhz - eps <= paint.f2Mhz;
}

export function attackListenWindowMhz(corridorSpanMhz: number, analogMhz: number): number {
  const analog = analogMhz > 0 ? analogMhz : 56;
  const span = Number.isFinite(corridorSpanMhz) && corridorSpanMhz > 0 ? corridorSpanMhz : analog;
  return Math.round(Math.min(Math.max(span, ATTACK_TX_MIN_MHZ), analog, ATTACK_TX_MAX_MHZ) * 1000) / 1000;
}

export function corridorFitsOneWindow(paint: AttackPaint, analogMhz: number): boolean {
  return paintSpanMhz(paint) <= attackListenWindowMhz(paintSpanMhz(paint), analogMhz) + 1e-6;
}

export function corridorAsBand(paint: AttackPaint): AllowBand {
  return { f1Mhz: paint.f1Mhz, f2Mhz: paint.f2Mhz };
}

/** Пересечение [f0 ± полка/2] с коридором. Центр сдвигаем, чтобы горб не вылез. */
export function clipShelfToCorridor(
  f0: number,
  shelfMhz: number,
  corridor: AttackPaint,
  analogMhz: number,
): { f1Mhz: number; f2Mhz: number; loMhz: number; occupyMhz: number } | null {
  if (!Number.isFinite(f0) || !freqInCorridor(f0, corridor)) return null;
  const shelf = clampShelfMhz(shelfMhz, analogMhz);
  const half = shelf / 2;
  const f1 = Math.max(f0 - half, corridor.f1Mhz);
  const f2 = Math.min(f0 + half, corridor.f2Mhz);
  const occupy = f2 - f1;
  if (occupy + 1e-9 < ATTACK_TX_MIN_MHZ) return null;
  return { f1Mhz: f1, f2Mhz: f2, loMhz: (f1 + f2) / 2, occupyMhz: occupy };
}

export interface AttackShelfTxPlan {
  /** Частота засечки — для очереди и выреза своего TX. */
  f0Mhz: number;
  /** TX LO (может сдвинуться у края коридора). */
  loMhz: number;
  occupyMhz: number;
  filterMhz: number;
  fsHz: number;
  listen: AttackListenPlan;
  wavePaint: AttackPaint;
  waveParams: Record<string, number>;
}

export function attackShelfTxPlan(opts: {
  f0Mhz: number;
  paint: AttackPaint;
  shelfMhz: number;
  analogMhz: number;
  kind: WaveKind | null;
  params: Record<string, number>;
}): AttackShelfTxPlan | null {
  const clip = clipShelfToCorridor(opts.f0Mhz, opts.shelfMhz, opts.paint, opts.analogMhz);
  if (!clip) return null;
  const listen = attackListenPlan({ analogMhz: opts.analogMhz, paintOwnsTx: true, paint: opts.paint });
  const filterMhz = Math.min(clip.occupyMhz, opts.analogMhz > 0 ? opts.analogMhz : clip.occupyMhz, listen.filterMhz);
  const wavePaint: AttackPaint = { f1Mhz: clip.f1Mhz, f2Mhz: clip.f2Mhz };
  const kind = opts.kind ?? "sine";
  return {
    f0Mhz: opts.f0Mhz,
    loMhz: clip.loMhz,
    occupyMhz: clip.occupyMhz,
    filterMhz,
    fsHz: listen.fsHz,
    listen,
    wavePaint,
    waveParams: attackWaveParams(kind, wavePaint, opts.params),
  };
}

export function ownTxBlankMhz(occupyMhz: number, waveArmed: boolean): number {
  const fromShelf = occupyMhz > 0 ? occupyMhz / 2 + 0.2 : 0;
  const fromWave = waveArmed ? 1.2 : 0.35;
  return Math.max(fromShelf, fromWave);
}

export function attackListenFsHz(paint: AttackPaint | null, analogMhz: number): number {
  const listen = attackListenPlan({ analogMhz, paintOwnsTx: paint != null, paint });
  return Math.max(ATTACK_TX_FS_MIN_HZ, listen.fsHz);
}

export function attackShelfHint(
  kind: WaveKind | null,
  occupyMhz: number,
  corridor: AttackPaint,
): string {
  const span = paintSpanMhz(corridor);
  const title = kind == null ? "CW тон" : kind === "awgn" ? "шум" : kind;
  if (kind == null || kind === "sine" || kind === "tone") {
    return `${title}: палочка в центре полки ${occupyMhz.toFixed(2)} МГц, коридор слуха ${span.toFixed(2)} МГц`;
  }
  return `${title}: горб ≈ ${occupyMhz.toFixed(2)} МГц на засечке (часы слуха ${(attackListenWindowMhz(span, 56)).toFixed(0)} / USB FD ${ATTACK_TX_MAX_MHZ}, не вся рамка)`;
}

export { ATTACK_FD_FS_HZ };
