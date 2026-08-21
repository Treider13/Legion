// ============================================================================
// LEGION — мост состояние→3D: мутируемый объект без React-ре-рендеров
// (паттерн 2026: scroll/uniforms через shared mutable store).
// zustand подписка пишет сюда; useFrame читает отсюда.
// ============================================================================

export interface RfVisualState {
  /** Текущая частота, МГц */
  freqMhz: number;
  /** LOCK */
  lock: boolean;
  /** Коридор активен */
  corridorActive: boolean;
  /** Коридор: границы, МГц */
  corrF1: number;
  corrF2: number;
  /** Телеметрия коридора: текущая частота, МГц (null вне коридора) */
  telemFreqMhz: number | null;
  /** Режим SDR: TX на усилитель */
  sdrTransmit: boolean;
  sdrHitMhz: number | null;
  sdrTxMhz: number | null;
}

export const rfVisual: RfVisualState = {
  freqMhz: 2475.0,
  lock: false,
  corridorActive: false,
  corrF1: 2400,
  corrF2: 2500,
  telemFreqMhz: null,
  sdrTransmit: false,
  sdrHitMhz: null,
  sdrTxMhz: null,
};

// Диапазон спектрального кольца (фиксированный «экран прибора»)
export const RING_MIN_MHZ = 2350;
export const RING_MAX_MHZ = 2550;

export function freqTo01(mhz: number): number {
  return Math.min(1, Math.max(0, (mhz - RING_MIN_MHZ) / (RING_MAX_MHZ - RING_MIN_MHZ)));
}
