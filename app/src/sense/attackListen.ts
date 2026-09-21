// ============================================================================
// LEGION — слух хост-Атаки. Не hostScanSpanMhz / crop 0.5 / DIO 40.
// Слух: 61.44 MSPS + фильтр 56 (Nuand xA4). ПЕРЕДАТЬ: USB FD ≤40, те же часы.
// FFT 4096/8192. Живой attack_scan — Thomson DPSS×3; эмуляция — спектр эмулятора.
// ============================================================================
import { ATTACK_TX_FS_MIN_HZ, ATTACK_TX_MAX_MHZ, paintTxFsHz, type AttackPaint } from "./attackPaint";

export const ATTACK_LISTEN_FS_HZ = 61_440_000;
export const ATTACK_LISTEN_ANALOG_MHZ = 56;
export const ATTACK_FD_FS_HZ = 40_000_000;
export const ATTACK_FFT_N = 4096;
export const ATTACK_FFT_N_FULL = 8192;
/** Край фильтра, когда полоса = Nyquist (не soapy crop 0.5). */
export const ATTACK_EDGE_CROP = 0.05;

export interface AttackListenPlan {
  fsHz: number;
  filterMhz: number;
  cropFactor: number;
  spanMhz: number;
  fftN: number;
}

export function attackCropFactor(fsHz: number, filterMhz: number): number {
  const span = fsHz / 1e6;
  if (!(span > 0) || !Number.isFinite(filterMhz)) return ATTACK_EDGE_CROP;
  if (filterMhz + 0.05 >= span) return ATTACK_EDGE_CROP;
  return Math.min(0.49, Math.max(0, 1 - filterMhz / span));
}

export function attackListenSpanMhz(fsHz: number, cropFactor: number): number {
  return (fsHz / 1e6) * (1 - cropFactor);
}

export function attackListenPlan(opts: {
  analogMhz: number;
  paintOwnsTx: boolean;
  paint: AttackPaint | null;
}): AttackListenPlan {
  const analog =
    Number.isFinite(opts.analogMhz) && opts.analogMhz > 0 ? opts.analogMhz : ATTACK_LISTEN_ANALOG_MHZ;
  if (opts.paintOwnsTx && opts.paint) {
    const fsHz = paintTxFsHz(opts.paint);
    const filterMhz = Math.min(analog, fsHz / 1e6, ATTACK_TX_MAX_MHZ);
    const cropFactor = attackCropFactor(fsHz, filterMhz);
    return {
      fsHz,
      filterMhz,
      cropFactor,
      spanMhz: attackListenSpanMhz(fsHz, cropFactor),
      fftN: ATTACK_FFT_N_FULL,
    };
  }
  const fsHz =
    analog >= ATTACK_LISTEN_ANALOG_MHZ - 0.5
      ? ATTACK_LISTEN_FS_HZ
      : Math.min(ATTACK_FD_FS_HZ, Math.max(ATTACK_TX_FS_MIN_HZ, analog * 1e6));
  const filterMhz = Math.min(analog, ATTACK_LISTEN_ANALOG_MHZ, fsHz / 1e6);
  const cropFactor = attackCropFactor(fsHz, filterMhz);
  return {
    fsHz,
    filterMhz,
    cropFactor,
    spanMhz: attackListenSpanMhz(fsHz, cropFactor),
    fftN: ATTACK_FFT_N_FULL,
  };
}
