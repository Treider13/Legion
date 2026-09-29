// Спектр для платы: тот же контракт слова, что HDL peak_word.
// Считается по бинам, которые компьютер уже получил с приёмника.

import type { ScanBin } from "../sdr/types";

/** [31] valid, [30:24] frame, [23:8] mag16, [7:0] bin. */
export function hostPeakWord(
  bins: ScanBin[],
  centerMhz: number,
  fsHz: number,
  frame = 1,
  dcNotch = true,
): number | null {
  const finite = bins.filter((b) => Number.isFinite(b.freqMhz) && Number.isFinite(b.powerDbm));
  if (finite.length < 8 || !(fsHz > 0)) return null;
  const powers = finite.map((b) => b.powerDbm).sort((a, b) => a - b);
  const median = powers[powers.length >> 1];
  const ranked = [...finite].sort((a, b) => b.powerDbm - a.powerDbm);
  let best = ranked[0];
  const binOf = (freqMhz: number) => {
    let k = Math.round(((freqMhz - centerMhz) * 1e6 * 256) / fsHz);
    k %= 256;
    if (k < 0) k += 256;
    return k;
  };
  if (dcNotch) {
    const next = ranked.find((b) => binOf(b.freqMhz) !== 0);
    if (next) best = next;
  }
  const bin = binOf(best.freqMhz);
  const db = Math.max(0, best.powerDbm - median);
  const mag16 = Math.max(0, Math.min(0xffff, Math.round(db * 256)));
  if (mag16 <= 0) return null;
  return (((1 << 31) | ((frame & 0x7f) << 24) | (mag16 << 8) | (bin & 0xff)) >>> 0);
}
