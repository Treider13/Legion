// ============================================================================
// LEGION — затвор ARM умной атаки. Только PHY-класс FHSS.
// Нет поля «НСУ» / uplink / downlink. unique < 3 — как FHSS_MIN_HOPS.
// ============================================================================
import type { AttackLook } from "./attackLook";
import type { FhssLook } from "./protocolDb";
import type { SmartGridCard } from "./smartGrid";

export const FHSS_ARM_UNIQUE_MIN = 3;
export const FHSS_ARM_CONF_MIN = 0.45;

export const SMART_ARM_NEED_FHSS_RU = "ARM только по классу FHSS — тон / chirp / OFDM / пусто не проходит";
export const SMART_ARM_NEED_UNIQUE_RU = "ARM: мало уникальных hop (нужно ≥ 3)";
export const SMART_ARM_NEED_CONF_RU = "ARM: уверенность класса ниже порога";
export const SMART_ARM_NEED_CARD_RU = "ARM: нет карточки сетки из look";
export const SMART_ARM_PEAK_CLOSED_RU = "пик без сетки закрыт — нужен FHSS";

export type FhssArmClass = "fhss" | "other";

export interface FhssArmGateInput {
  look?: AttackLook | null;
  fhss?: FhssLook | null;
  card?: SmartGridCard | null;
  persistPenalty?: number;
}

export interface FhssArmGate {
  ok: boolean;
  reason: string;
  classId: FhssArmClass;
  unique: number;
  conf: number;
  fhss: FhssLook | null;
}

export function pickFhssLook(looks: readonly AttackLook[]): AttackLook | null {
  let best: AttackLook | null = null;
  for (const look of looks) {
    if (!look.fhss?.hit) continue;
    const n = look.fhss.unique || look.fhss.hopSetMhz.length;
    const bestN = best?.fhss ? best.fhss.unique || best.fhss.hopSetMhz.length : -1;
    if (!best || n > bestN) best = look;
  }
  return best;
}

/** Hit даёт пол выше AMC-kind: воркер часто ставит tone/unknown на вырез hop. */
export function fhssClassConf(
  look: AttackLook | null | undefined,
  persistPenalty = 0,
  fhss = look?.fhss,
): number {
  if (!fhss?.hit) return 0;
  const base = Math.max(Number(look?.conf) || 0, 0.55);
  const pen = Number.isFinite(persistPenalty) ? Math.max(0, persistPenalty) : 0;
  return Math.max(0, Math.min(1, base - pen));
}

export function fhssArmClass(fhss: FhssLook | null | undefined): FhssArmClass {
  return fhss?.hit === true ? "fhss" : "other";
}

export function fhssArmGate(i: FhssArmGateInput): FhssArmGate {
  const fhss = i.fhss?.hit ? i.fhss : i.look?.fhss?.hit ? i.look.fhss : null;
  const unique = fhss ? (fhss.unique || fhss.nSlots || fhss.hopSetMhz.length) : 0;
  const conf = fhssClassConf(i.look ?? null, i.persistPenalty, fhss);
  const classId = fhssArmClass(fhss);
  const fail = (reason: string): FhssArmGate => ({
    ok: false,
    reason,
    classId,
    unique,
    conf,
    fhss,
  });
  if (classId !== "fhss" || !fhss) return fail(SMART_ARM_NEED_FHSS_RU);
  if (unique < FHSS_ARM_UNIQUE_MIN) return fail(SMART_ARM_NEED_UNIQUE_RU);
  if (conf < FHSS_ARM_CONF_MIN) return fail(SMART_ARM_NEED_CONF_RU);
  const card = i.card;
  if (!card || card.empty || card.analog || !(card.f0Hz > 0) || !(card.stepHz > 0) || !(card.n > 0)) {
    return fail(SMART_ARM_NEED_CARD_RU);
  }
  return { ok: true, reason: "FHSS · затвор открыт", classId, unique, conf, fhss };
}
