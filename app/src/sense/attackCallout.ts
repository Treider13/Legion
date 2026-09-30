// ============================================================================
// LEGION — один совет на главном кадре. Не карусель.
// Sonner, issue #422: повтор с тем же id обновляет существующее сообщение,
// второе не создаётся. Id здесь — класс ситуации. Пока он тот же, карточка
// держит прежний hint, и «Взять» записывает именно его.
// Рамка в помощнике центрируется на выбранном следе (attackAdvisor), поэтому
// частота карточки — след ближе к центру рамки, не самый громкий рядом.
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
  /** Тот hint, который записан в text. «Взять» кладёт в стор его, не более поздний. */
  hint: AttackHint | null;
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
  hint: null,
};

function louder(a: CalloutRow, b: CalloutRow): CalloutRow {
  return b.powerDbm > a.powerDbm ? b : a;
}

function primaryOf(rows: readonly CalloutRow[], frame: { f1Mhz: number; f2Mhz: number } | null): CalloutRow | null {
  const live = rows.filter((row) => row.state === "new" || row.state === "confirmed" || row.state === "held");
  if (live.length === 0) return null;
  if (frame) {
    const inside = live.filter((row) => row.freqMhz >= frame.f1Mhz - 0.2 && row.freqMhz <= frame.f2Mhz + 0.2);
    if (inside.length > 0) {
      const mid = (frame.f1Mhz + frame.f2Mhz) / 2;
      return inside.reduce((best, row) => {
        const closer = Math.abs(row.freqMhz - mid) < Math.abs(best.freqMhz - mid) - 1e-9;
        const tie = Math.abs(Math.abs(row.freqMhz - mid) - Math.abs(best.freqMhz - mid)) <= 1e-9;
        if (closer || (tie && row.powerDbm > best.powerDbm)) return row;
        return best;
      });
    }
  }
  return live.reduce(louder);
}

/** Пока класс тот же — остаётся прежний hint. Новый класс подменяет его целиком. */
export function settleCallout(shown: AttackCallout, next: AttackCallout): AttackCallout {
  return shown.situation === next.situation ? shown : next;
}

/** Полмегагерца: дрожание пика внутри коридора не меняет совет. */
function bucketMhz(mhz: number): string {
  return (Math.round(mhz * 2) / 2).toFixed(1);
}

/** Целый мегагерц ширины рамки. Сотые кадра не меняют класс, смена «узкая / семья» меняет. */
function spanBucket(hint: AttackHint | null): string {
  if (!hint?.paint) return "none";
  return String(Math.round(Math.abs(hint.paint.f2Mhz - hint.paint.f1Mhz)));
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
    hint?.applyLabel ?? "note",
    spanBucket(hint),
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
      hint: null,
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
    hint,
  };
}
