// ============================================================================
// LEGION — быстрый путь DETECT → SDR TX → CUE.
// Критический путь живёт в том же процессе, что и бэкенд SDR. React/Zustand
// обновляются после. Не копируем рецепты BlueJammer: только разделение
// «радио-движок vs UI» (ice9 / blue-dragon / libbladeRF full-duplex).
//
// Честный бюджет (не вайбкодинг):
//   detect на bins           — микросекунды CPU
//   SDR TX LO (USB3 host)    — ~200 µs модель; FPGA HDL не реализован
//   ADF4351 SPI+delta        — 7–40 µs записи + settle ФАПЧ 0.15–0.5 мс
//   UART CUE 115200          — миллисекунды RTT, это пол UART, не SDR
//   PA SET I / PA ON / RF ON — только при взведении, не на каждый улов
// ============================================================================
import { cueFreqAllowed, type AllowBand } from "../policy/allowlist";
import type { Detection } from "../sdr/types";
import { decideForward, sameBin } from "./orchestrator";

export interface HandoffInput {
  det: Detection | null;
  bands: readonly AllowBand[];
  loadOk: boolean;
  transmitArmed: boolean;
  autoCue: boolean;
  paMa: number;
  paPrearmed: boolean;
  rfOn: boolean;
  lastCuedMhz: number | null;
  inflight: boolean;
  sdrCanTx: boolean;
}

export interface HandoffPlan {
  skip: boolean;
  reason: string;
  freqMhz: number;
  /** TX LO на том же SDR, сразу, до UART. Только при ПЕРЕДАТЬ. */
  sdrTx: boolean;
  cue: boolean;
  paSetI: boolean;
  paOn: boolean;
  rfOn: boolean;
}

export function planHandoff(i: HandoffInput): HandoffPlan {
  const mhz = i.det?.freqMhz ?? 0;
  const empty = (): HandoffPlan => ({
    skip: true,
    reason: "нет улова",
    freqMhz: mhz,
    sdrTx: false,
    cue: false,
    paSetI: false,
    paOn: false,
    rfOn: false,
  });
  if (!i.det) return empty();
  if (!cueFreqAllowed(i.det.freqMhz, i.bands)) {
    return { ...empty(), reason: "частота вне allowlist", freqMhz: i.det.freqMhz };
  }
  if (i.inflight) {
    return { ...empty(), reason: "предыдущий CUE ещё в UART", freqMhz: i.det.freqMhz };
  }
  if (i.lastCuedMhz !== null && sameBin(i.lastCuedMhz, i.det.freqMhz)) {
    return { ...empty(), reason: "уже на этой частоте", freqMhz: i.det.freqMhz };
  }

  // Авто-наведение без ПЕРЕДАТЬ: только синтезатор, без RF и без SDR TX.
  if (!i.transmitArmed && i.autoCue) {
    return {
      skip: false,
      reason: "CUE только (без RF — нет ПЕРЕДАТЬ)",
      freqMhz: i.det.freqMhz,
      sdrTx: false,
      cue: true,
      paSetI: false,
      paOn: false,
      rfOn: false,
    };
  }

  const d = decideForward(i.det, i.bands, i.loadOk, i.transmitArmed, i.paMa);
  if (!d.ok) {
    return { ...empty(), reason: d.reason, freqMhz: i.det.freqMhz };
  }

  return {
    skip: false,
    reason: "SDR TX сразу + CUE на ADF4351 (PA уже взведён или взводится)",
    freqMhz: i.det.freqMhz,
    sdrTx: i.sdrCanTx,
    cue: true,
    paSetI: !i.paPrearmed,
    paOn: !i.paPrearmed,
    rfOn: !i.rfOn,
  };
}

/** Один слот очереди: если во время UART пришёл другой бин — не теряем. */
export class HandoffGate {
  inflight = false;
  lastCuedMhz: number | null = null;
  queuedMhz: number | null = null;

  reserve(mhz: number): void {
    this.inflight = true;
    this.lastCuedMhz = mhz;
    if (this.queuedMhz !== null && sameBin(this.queuedMhz, mhz)) {
      this.queuedMhz = null;
    }
  }

  queueIfBusy(mhz: number): boolean {
    if (!this.inflight) return false;
    if (this.lastCuedMhz !== null && sameBin(this.lastCuedMhz, mhz)) return true;
    this.queuedMhz = mhz;
    return true;
  }

  release(): number | null {
    this.inflight = false;
    const q = this.queuedMhz;
    this.queuedMhz = null;
    return q;
  }

  reset(): void {
    this.inflight = false;
    this.lastCuedMhz = null;
    this.queuedMhz = null;
  }
}
