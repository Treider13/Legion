// ============================================================================
// LEGION — строгость засечки. Не RF jargon «sensitivity».
// Низкая = слабые тоже (низкий порог СНР). Высокая = только сильные.
// ============================================================================

export const SENS_THR_MIN_DB = 3;
export const SENS_THR_MAX_DB = 24;

/** 0 = все подряд, 100 = только сильные. */
export function sensitivityToThresholdDb(sens: number): number {
  const s = Math.min(100, Math.max(0, Number.isFinite(sens) ? sens : 0));
  return SENS_THR_MIN_DB + (s / 100) * (SENS_THR_MAX_DB - SENS_THR_MIN_DB);
}

export function thresholdToSensitivity(db: number): number {
  const span = SENS_THR_MAX_DB - SENS_THR_MIN_DB;
  const t = Math.min(SENS_THR_MAX_DB, Math.max(SENS_THR_MIN_DB, db));
  return Math.round(((t - SENS_THR_MIN_DB) / span) * 100);
}
