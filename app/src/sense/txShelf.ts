// Полка TX: часы выборки и аналоговый фильтр — одно число.
// Фильтр сам горб не расширяет (ошибка CleverJAM: Bandwidth без sample rate).
// Гауссов шум занимает полку целиком. Тон и QPSK — нет.

export const TX_SHELF_DEFAULT_MHZ = 2;
/** AD9361 BW min. x40 ниже 1.5 режет свой фильтр — это потолок платы, не пол. */
export const TX_SHELF_MIN_MHZ = 0.2;
/** Ниже этого fs чип не ставит (Nuand sample-rate min). */
export const TX_SHELF_FS_MIN_HZ = 520834;

export function clampShelfMhz(want: number, analogMaxMhz: number): number {
  const cap = analogMaxMhz > 0 ? analogMaxMhz : 56;
  const w = Number.isFinite(want) && want > 0 ? want : TX_SHELF_DEFAULT_MHZ;
  return Math.round(Math.min(Math.max(w, TX_SHELF_MIN_MHZ), cap) * 1000) / 1000;
}

/** Часы передачи = полка. Потолок — analog платы (micro 56, x40 28). */
export function shelfFsHz(wantMhz: number, analogMaxMhz: number): number {
  const hz = Math.round(clampShelfMhz(wantMhz, analogMaxMhz) * 1e6);
  return Math.max(hz, TX_SHELF_FS_MIN_HZ);
}
