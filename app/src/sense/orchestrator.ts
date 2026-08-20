// ============================================================================
// LEGION — решения режима SDR (detect → TX на SDR) и утилит списка улова.
// ESP32 CUE/PA — другой режим, сюда не вызывается.
// ============================================================================
import {
  actuatorEnableAllowed,
  cueFreqAllowed,
  type AllowBand,
} from "../policy/allowlist";
import type { Detection } from "../sdr/types";

export const FWD_BIN_MHZ = 0.2;
export const PA_ARM_DEFAULT_MA = 250;

export interface CueDecision {
  ok: boolean;
  reason: string;
  freqMhz: number;
}

export function sameBin(a: number, b: number, tol = FWD_BIN_MHZ): boolean {
  return Math.abs(a - b) <= tol;
}

export function decideCue(
  det: Detection,
  bands: readonly AllowBand[],
  loadOk: boolean,
  autoCue: boolean,
): CueDecision {
  return decideForward(det, bands, loadOk, autoCue, PA_ARM_DEFAULT_MA);
}

export function decideForward(
  det: Detection,
  bands: readonly AllowBand[],
  loadOk: boolean,
  armed: boolean,
  paMa: number,
): CueDecision {
  if (!cueFreqAllowed(det.freqMhz, bands)) {
    return { ok: false, reason: "частота вне allowlist", freqMhz: det.freqMhz };
  }
  if (!actuatorEnableAllowed(loadOk)) {
    return { ok: false, reason: "нет подтверждённой нагрузки 50 Ом", freqMhz: det.freqMhz };
  }
  if (!armed) {
    return {
      ok: false,
      reason: "ожидание кнопки ПЕРЕДАТЬ",
      freqMhz: det.freqMhz,
    };
  }
  if (!(paMa > 0)) {
    return { ok: false, reason: "ток PA не задан (только режим ESP32)", freqMhz: det.freqMhz };
  }
  return {
    ok: true,
    reason: "ESP32: allowlist + заглушка + ток",
    freqMhz: det.freqMhz,
  };
}

/** Режим SDR: ток ESP32 не нужен — усилитель на RF out SDR. */
export function decideSdrTx(
  det: Detection,
  bands: readonly AllowBand[],
  loadOk: boolean,
  armed: boolean,
): CueDecision {
  if (!cueFreqAllowed(det.freqMhz, bands)) {
    return { ok: false, reason: "частота вне allowlist", freqMhz: det.freqMhz };
  }
  if (!actuatorEnableAllowed(loadOk)) {
    return { ok: false, reason: "нет подтверждённой нагрузки 50 Ом", freqMhz: det.freqMhz };
  }
  if (!armed) {
    return { ok: false, reason: "ожидание кнопки ПЕРЕДАТЬ", freqMhz: det.freqMhz };
  }
  return { ok: true, reason: "SDR TX → усилитель", freqMhz: det.freqMhz };
}

export function pickStrongest(dets: readonly Detection[]): Detection | null {
  if (dets.length === 0) return null;
  return dets.reduce((a, b) => (b.powerDbm > a.powerDbm ? b : a));
}

export function mergeDetections(
  prev: readonly Detection[],
  incoming: readonly Detection[],
): Detection[] {
  const out = prev.map((d) => ({ ...d }));
  for (const d of incoming) {
    const i = out.findIndex((x) => sameBin(x.freqMhz, d.freqMhz));
    if (i < 0) {
      out.push({ ...d, forwarded: d.forwarded ?? false });
    } else {
      out[i] = {
        ...out[i],
        powerDbm: d.powerDbm,
        noiseDbm: d.noiseDbm,
        snrDb: d.snrDb,
        ts: d.ts,
      };
    }
  }
  return out.slice(-48);
}

export function markForwarded(list: readonly Detection[], mhz: number): Detection[] {
  return list.map((d) => (sameBin(d.freqMhz, mhz) ? { ...d, forwarded: true } : d));
}
