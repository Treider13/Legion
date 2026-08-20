// ============================================================================
// LEGION — allowlist / CUE / интерлок нагрузки (зеркало policy_math.h).
// Пустой список не ограничивает SET FREQ/RF ON; CUE требует попадание.
// ============================================================================

export interface AllowBand {
  f1Mhz: number;
  f2Mhz: number;
}

export const PA_I_MAX_MA = 1500;
export const SYNTH_FMIN_MHZ = 34.375;
export const SYNTH_FMAX_MHZ = 4400;

export function allowBandValid(f1Mhz: number, f2Mhz: number): boolean {
  return Number.isFinite(f1Mhz) && Number.isFinite(f2Mhz) && f1Mhz > 0 && f2Mhz >= f1Mhz;
}

export function hzInAllowlist(mhz: number, bands: readonly AllowBand[]): boolean {
  if (bands.length === 0) return true;
  return bands.some((b) => mhz >= b.f1Mhz && mhz <= b.f2Mhz);
}

export function rangeInAllowlist(f1Mhz: number, f2Mhz: number, bands: readonly AllowBand[]): boolean {
  if (bands.length === 0) return true;
  if (f2Mhz < f1Mhz) return false;
  return bands.some((b) => f1Mhz >= b.f1Mhz && f2Mhz <= b.f2Mhz);
}

export function cueFreqAllowed(mhz: number, bands: readonly AllowBand[]): boolean {
  if (bands.length === 0) return false;
  return hzInAllowlist(mhz, bands);
}

export function paCurrentInRange(ma: number): boolean {
  return Number.isFinite(ma) && ma >= 0 && ma <= PA_I_MAX_MA;
}

export function actuatorEnableAllowed(loadOk: boolean): boolean {
  return loadOk;
}

export function parseBand(f1: string, f2: string): AllowBand | null {
  const a = parseFloat(f1);
  const b = parseFloat(f2);
  if (!allowBandValid(a, b)) return null;
  if (a < SYNTH_FMIN_MHZ || b > SYNTH_FMAX_MHZ) return null;
  return { f1Mhz: a, f2Mhz: b };
}
