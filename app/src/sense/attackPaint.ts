// ============================================================================
// LEGION — рамка оператора Атаки: мышь → полоса TX. Не автомат.
// Потолок USB FD xA4 ≈ 40 МГц (Reddit / Nuand). Минимум канала как AD9361.
// Волна — из WAVE_CATALOG, размах чирпа = ширина рамки (не потолок 1 МГц).
// ============================================================================
import { cueFreqAllowed, type AllowBand } from "../policy/allowlist";
import type { WaveKind } from "../sdr/waveforms";
import { defaultParams, waveMeta } from "../sdr/waveforms";

export const ATTACK_TX_MIN_MHZ = 0.2;
export const ATTACK_TX_MAX_MHZ = 40;
export const ATTACK_TX_FS_MIN_HZ = 520_834;
export const ATTACK_HOLD_MIN_MS = 200;
export const ATTACK_HOLD_MAX_MS = 120_000;
export const ATTACK_HOLD_DEFAULT_MS = 3000;
export const ATTACK_COOLDOWN_MS = 250;

export interface AttackPaint {
  f1Mhz: number;
  f2Mhz: number;
}

export function paintSpanMhz(p: AttackPaint): number {
  return Math.max(0, p.f2Mhz - p.f1Mhz);
}

export function paintCenterMhz(p: AttackPaint): number {
  return (p.f1Mhz + p.f2Mhz) / 2;
}

export function normalizePaint(a: number, b: number): AttackPaint {
  const f1 = Math.min(a, b);
  const f2 = Math.max(a, b);
  return { f1Mhz: f1, f2Mhz: f2 };
}

export function clampPaintToCaps(p: AttackPaint): AttackPaint {
  let { f1Mhz, f2Mhz } = normalizePaint(p.f1Mhz, p.f2Mhz);
  let span = f2Mhz - f1Mhz;
  if (span < ATTACK_TX_MIN_MHZ) {
    const mid = (f1Mhz + f2Mhz) / 2;
    f1Mhz = mid - ATTACK_TX_MIN_MHZ / 2;
    f2Mhz = mid + ATTACK_TX_MIN_MHZ / 2;
    span = ATTACK_TX_MIN_MHZ;
  }
  if (span > ATTACK_TX_MAX_MHZ) {
    const mid = (f1Mhz + f2Mhz) / 2;
    f1Mhz = mid - ATTACK_TX_MAX_MHZ / 2;
    f2Mhz = mid + ATTACK_TX_MAX_MHZ / 2;
  }
  return { f1Mhz, f2Mhz };
}

export function clipPaintToAllowlist(p: AttackPaint, bands: readonly AllowBand[]): AttackPaint | null {
  const raw = clampPaintToCaps(p);
  if (bands.length === 0) return raw;
  let f1 = raw.f1Mhz;
  let f2 = raw.f2Mhz;
  const lo = Math.min(...bands.map((b) => b.f1Mhz));
  const hi = Math.max(...bands.map((b) => b.f2Mhz));
  f1 = Math.max(f1, lo);
  f2 = Math.min(f2, hi);
  if (f2 - f1 < ATTACK_TX_MIN_MHZ) return null;
  const mid = (f1 + f2) / 2;
  if (!cueFreqAllowed(mid, bands)) return null;
  return clampPaintToCaps({ f1Mhz: f1, f2Mhz: f2 });
}

export function paintTxFsHz(p: AttackPaint): number {
  const hz = paintSpanMhz(p) * 1e6;
  return Math.max(ATTACK_TX_FS_MIN_HZ, Math.min(ATTACK_TX_MAX_MHZ * 1e6, hz));
}

export function clampAttackHoldMs(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return ATTACK_HOLD_DEFAULT_MS;
  return Math.round(Math.min(ATTACK_HOLD_MAX_MS, Math.max(ATTACK_HOLD_MIN_MS, ms)));
}

/** Сколько рамки реально займёт выбранная волна (честный текст до ПЕРЕДАТЬ). */
export function waveOccupiesPaintMhz(kind: WaveKind | null, paint: AttackPaint, params: Record<string, number>): number {
  const span = paintSpanMhz(paint);
  if (kind == null || kind === "sine" || kind === "tone") return Math.min(span, 0.05);
  if (kind === "awgn" || kind === "ofdm" || kind === "scfdma" || kind === "otfs" || kind === "afdm" || kind === "ocdm") {
    return span;
  }
  if (kind === "chirp") {
    const want = (params.spanKhz ?? span * 1000) / 1000;
    return Math.min(span, Math.max(ATTACK_TX_MIN_MHZ, want));
  }
  return Math.min(span, Math.max(0.2, span * 0.35));
}

export function attackWaveParams(kind: WaveKind, paint: AttackPaint, base: Record<string, number>): Record<string, number> {
  const next = { ...defaultParams(kind), ...base };
  if (kind === "chirp") {
    next.spanKhz = Math.min(paintSpanMhz(paint) * 1000, paintTxFsHz(paint) / 2 / 1e3);
  }
  return next;
}

export function paintRefuseReason(
  paint: AttackPaint | null,
  bands: readonly AllowBand[],
  loadOk: boolean,
): string | null {
  if (!loadOk) return "ПЕРЕДАТЬ: подтвердите нагрузку 50 Ом на выходе усилителя SDR";
  if (!paint) return "ПЕРЕДАТЬ: сначала выделите полосу мышкой на спектре";
  const clipped = clipPaintToAllowlist(paint, bands);
  if (!clipped) return "ПЕРЕДАТЬ: рамка вне allowlist или уже узкого потолка";
  return null;
}

export function paintWaveHint(kind: WaveKind | null, paint: AttackPaint, params: Record<string, number>): string {
  const occ = waveOccupiesPaintMhz(kind, paint, params);
  const span = paintSpanMhz(paint);
  const title = kind ? waveMeta(kind).title : "CW тон";
  if (occ + 0.05 < span) {
    return `${title}: займёт ~${occ.toFixed(2)} МГц в центре рамки ${span.toFixed(2)} МГц, не всю полосу`;
  }
  return `${title}: заливка ≈ ${span.toFixed(2)} МГц (потолок USB FD ${ATTACK_TX_MAX_MHZ} МГц)`;
}
