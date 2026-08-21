// ============================================================================
// LEGION — режим SDR: DETECT → TX LO на том же SDR → RF out на усилитель.
// ESP32 / CUE / PA SET I / RF ON сюда не входят (это другой режим).
// ============================================================================
import { cueFreqAllowed, type AllowBand } from "../policy/allowlist";
import type { Detection } from "../sdr/types";
import { sameBin } from "./orchestrator";

export interface HandoffInput {
  det: Detection | null;
  bands: readonly AllowBand[];
  loadOk: boolean;
  transmitArmed: boolean;
  lastCuedMhz: number | null;
  inflight: boolean;
  sdrCanTx: boolean;
  /** Держим текущую засечку, не прыгаем на более сильную. */
  holdLock?: boolean;
  /** СБРОСИТЬ: разрешить другую частоту. */
  forceRetarget?: boolean;
}

export interface HandoffPlan {
  skip: boolean;
  reason: string;
  freqMhz: number;
  sdrTx: boolean;
}

export function planHandoff(i: HandoffInput): HandoffPlan {
  const mhz = i.det?.freqMhz ?? 0;
  const empty = (reason: string, freq = mhz): HandoffPlan => ({
    skip: true,
    reason,
    freqMhz: freq,
    sdrTx: false,
  });
  if (!i.det) return empty("нет улова");
  if (!i.transmitArmed) return empty("ожидание ПЕРЕДАТЬ (режим SDR)", i.det.freqMhz);
  if (!cueFreqAllowed(i.det.freqMhz, i.bands)) {
    return empty("частота вне allowlist", i.det.freqMhz);
  }
  if (!i.loadOk) return empty("нет подтверждённой нагрузки 50 Ом", i.det.freqMhz);
  if (!i.sdrCanTx) return empty("у этого SDR нет TX — усилитель не к чему подключить", i.det.freqMhz);
  if (i.inflight) return empty("предыдущий SDR TX ещё идёт", i.det.freqMhz);
  if (i.lastCuedMhz !== null && sameBin(i.lastCuedMhz, i.det.freqMhz)) {
    return empty("уже на этой частоте", i.det.freqMhz);
  }
  if (i.holdLock && !i.forceRetarget && i.lastCuedMhz !== null) {
    return empty("держим засечку — СБРОСИТЬ чтобы сменить", i.det.freqMhz);
  }
  return {
    skip: false,
    reason: "SDR TX LO → RF out → усилитель (ESP32 не участвует)",
    freqMhz: i.det.freqMhz,
    sdrTx: true,
  };
}

export class HandoffGate {
  inflight = false;
  lastCuedMhz: number | null = null;
  queuedMhz: number | null = null;
  /** Частота, которую сейчас пытаемся поставить. Не успех, пока нет commit. */
  pendingMhz: number | null = null;

  reserve(mhz: number): void {
    this.inflight = true;
    this.pendingMhz = mhz;
    if (this.queuedMhz !== null && sameBin(this.queuedMhz, mhz)) {
      this.queuedMhz = null;
    }
  }

  commit(mhz: number): void {
    this.lastCuedMhz = mhz;
    this.pendingMhz = null;
  }

  abort(): void {
    this.pendingMhz = null;
  }

  /** Пока TX ставится — более сильную другую частоту кладём в очередь. */
  queueIfBusy(mhz: number): boolean {
    if (!this.inflight) return false;
    if (this.lastCuedMhz !== null && sameBin(this.lastCuedMhz, mhz)) return true;
    if (this.pendingMhz !== null && sameBin(this.pendingMhz, mhz)) return true;
    this.queuedMhz = mhz;
    return true;
  }

  dropHold(): number | null {
    const was = this.lastCuedMhz;
    this.lastCuedMhz = null;
    this.queuedMhz = null;
    this.pendingMhz = null;
    return was;
  }

  release(): number | null {
    this.inflight = false;
    this.pendingMhz = null;
    const q = this.queuedMhz;
    this.queuedMhz = null;
    return q;
  }

  reset(): void {
    this.inflight = false;
    this.lastCuedMhz = null;
    this.queuedMhz = null;
    this.pendingMhz = null;
  }
}
