// ============================================================================
// LEGION — оркестратор: DETECT → решение CUE.
// CUE ставит частоту синтезатора. RF ON и PA ON — отдельные команды.
// Авто-наведение только при loadOk + allowlist + явный флаг.
// ============================================================================
import {
  actuatorEnableAllowed,
  cueFreqAllowed,
  type AllowBand,
} from "../policy/allowlist";
import type { Detection } from "../sdr/types";

export interface CueDecision {
  ok: boolean;
  reason: string;
  freqMhz: number;
}

export function decideCue(
  det: Detection,
  bands: readonly AllowBand[],
  loadOk: boolean,
  autoCue: boolean,
): CueDecision {
  if (!cueFreqAllowed(det.freqMhz, bands)) {
    return { ok: false, reason: "частота вне allowlist", freqMhz: det.freqMhz };
  }
  if (!actuatorEnableAllowed(loadOk)) {
    return { ok: false, reason: "нет подтверждённой нагрузки 50 Ом", freqMhz: det.freqMhz };
  }
  if (!autoCue) {
    return {
      ok: false,
      reason: "авто-наведение выключено — нажмите НАВЕСТИ",
      freqMhz: det.freqMhz,
    };
  }
  return { ok: true, reason: "CUE разрешён (нагрузка + allowlist)", freqMhz: det.freqMhz };
}

export function pickStrongest(dets: readonly Detection[]): Detection | null {
  if (dets.length === 0) return null;
  return dets.reduce((a, b) => (b.powerDbm > a.powerDbm ? b : a));
}
