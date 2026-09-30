// ============================================================================
// LEGION — один совет на главном кадре. Не карусель.
// Sonner (issue #422, ответ мейнтейнера): то же id обновляет текст, а не
// заводит второе сообщение. Карточка показывает текущий hint — тот же,
// который запишет «Взять». Класс ситуации не меняется от дрожания пика
// внутри полмегагерца. Частота карточки — след внутри предложенной рамки,
// не самый громкий в эфире: помощник может обводить тихую полку.
// ============================================================================
import type { AttackAdvice, AttackHint, AttackHintKind } from "./attackAdvisor";

export interface CalloutRow {
  freqMhz: number;
  powerDbm: number;
  state: "new" | "confirmed" | "held" | "cooled";
  atlasId: string;
  typeLabel: string;
}

export interface AttackCallout {
  /** Меняется, когда сменился класс совета, не когда дрогнул мегагерц. */
  situation: string;
  kicker: string;
  title: string;
  text: string;
  why: string;
  freqMhz: number | null;
  typeLabel: string | null;
  applyKind: AttackHintKind | null;
  applyLabel: string | null;
}

const WAIT: AttackCallout = {
  situation: "wait",
  kicker: "ожидание",
  title: "Ждёт сигнал",
  text: "Когда в эфире появится след, здесь останется один совет. Текст сам не листается.",
  why: "",
  freqMhz: null,
  typeLabel: null,
  applyKind: null,
  applyLabel: null,
};

function louder(a: CalloutRow, b: CalloutRow): CalloutRow {
  return b.powerDbm > a.powerDbm ? b : a;
}

function primaryOf(rows: readonly CalloutRow[], frame: { f1Mhz: number; f2Mhz: number } | null): CalloutRow | null {
  const live = rows.filter((row) => row.state === "new" || row.state === "confirmed" || row.state === "held");
  if (live.length === 0) return null;
  if (frame) {
    const inside = live.filter((row) => row.freqMhz >= frame.f1Mhz - 0.2 && row.freqMhz <= frame.f2Mhz + 0.2);
    if (inside.length > 0) return inside.reduce(louder);
  }
  return live.reduce(louder);
}

/** Полмегагерца: дрожание пика внутри коридора не меняет совет. */
function bucketMhz(mhz: number): string {
  return (Math.round(mhz * 2) / 2).toFixed(1);
}

function pickHint(advice: AttackAdvice): AttackHint | null {
  return advice.hints.find((hint) => hint.kind === "paint")
    ?? advice.hints.find((hint) => hint.applyLabel)
    ?? advice.hints[0]
    ?? null;
}

export function buildAttackCallout(rows: readonly CalloutRow[], advice: AttackAdvice): AttackCallout {
  const hint = pickHint(advice);
  const frame = hint?.paint ?? advice.suggestPaint;
  const primary = primaryOf(rows, frame);
  if (!hint && !advice.scene) return WAIT;
  const tx = advice.scene.includes("Идёт передача");
  const situation = [
    hint?.kind ?? "scene",
    hint?.applyLabel ? "act" : "note",
    primary?.atlasId ?? "none",
    primary ? bucketMhz(primary.freqMhz) : "none",
    tx ? "tx" : "rx",
  ].join("|");
  if (!hint) {
    return {
      situation,
      kicker: primary ? primary.typeLabel : "Эфир",
      title: "Эфир",
      text: advice.scene,
      why: "",
      freqMhz: primary?.freqMhz ?? null,
      typeLabel: primary?.typeLabel ?? null,
      applyKind: null,
      applyLabel: null,
    };
  }
  return {
    situation,
    kicker: primary ? primary.typeLabel : "Совет",
    title: hint.title,
    text: hint.text,
    why: hint.why,
    freqMhz: primary?.freqMhz ?? null,
    typeLabel: primary?.typeLabel ?? null,
    applyKind: hint.applyLabel ? hint.kind : null,
    applyLabel: hint.applyLabel,
  };
}
