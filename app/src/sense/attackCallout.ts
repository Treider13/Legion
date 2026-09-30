// ============================================================================
// LEGION — один совет на главном кадре. Не карусель.
// Sonner, issue #422: повтор с тем же id обновляет существующее сообщение,
// второе не создаётся. Id здесь — действие совета (кнопка и передача).
// Пока оно то же и след не ушёл дальше 0.2 МГц, карточка держит прежний hint.
// Рамка в помощнике центрируется на выбранном следе (attackAdvisor), поэтому
// частота карточки — след ближе к центру рамки, не самый громкий рядом.
// ============================================================================
import { buildAttackAdvice, type AttackAdvice, type AttackHint, type AttackHintKind } from "./attackAdvisor";
import type { AttackRow } from "./attackScene";
import { ATTACK_ASSOC_MHZ } from "./attackTracks";
import type { AttackMemStats } from "./attackMemory";
import type { AllowBand } from "../policy/allowlist";
import type { AttackPaint } from "./attackPaint";
import type { WaveKind } from "../sdr/waveforms";

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

function spanMhz(callout: AttackCallout): number | null {
  const paint = callout.hint?.paint;
  if (!paint) return null;
  const span = Math.abs(paint.f2Mhz - paint.f1Mhz);
  return Number.isFinite(span) ? span : null;
}

/**
 * Карточка меняется, когда сменилось действие, ширина рамки ушла минимум
 * на 1 МГц от уже показанной, или след ушёл дальше ворот трекера.
 * Имя класса и корзина полмегагерца сюда не входят: они дёргаются на том же сигнале.
 */
export function settleCallout(shown: AttackCallout, next: AttackCallout): AttackCallout {
  if (shown.situation !== next.situation) return next;
  const shownSpan = spanMhz(shown);
  const nextSpan = spanMhz(next);
  if (shownSpan == null || nextSpan == null) {
    if (shownSpan !== nextSpan) return next;
  } else if (Math.abs(nextSpan - shownSpan) >= 1) {
    return next;
  }
  if (shown.freqMhz == null || next.freqMhz == null) {
    if (shown.freqMhz !== next.freqMhz) return next;
  } else if (Math.abs(next.freqMhz - shown.freqMhz) > ATTACK_ASSOC_MHZ) {
    return next;
  }
  return shown;
}

/** Шаг бина по частотам соседних точек спектра. Это fs/N на текущей сетке. */
export function binStepMhz(freqs: readonly number[]): number {
  let sum = 0;
  let n = 0;
  const take = Math.min(freqs.length - 1, 32);
  for (let i = 1; i <= take; i++) {
    const step = Math.abs(freqs[i]! - freqs[i - 1]!);
    if (step > 0) {
      sum += step;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Подпись частоты. Соседний бин (сдвиг не больше шага) не меняет цифру.
 * Дальше одного бина — меняет. binMhz <= 0 значит сетки ещё нет, берём новое значение.
 */
export function holdPeakMhz(shownMhz: number | null, nextMhz: number | null, binMhz: number): number | null {
  if (nextMhz == null || !Number.isFinite(nextMhz)) return null;
  if (shownMhz == null || !Number.isFinite(shownMhz) || !(binMhz > 0)) return nextMhz;
  if (Math.abs(nextMhz - shownMhz) > binMhz + 1e-9) return nextMhz;
  return shownMhz;
}

/** Частота строки «Сигнал»: пик того же следа, что на карточке, с удержанием соседнего бина. */
const EMPTY_MEMORY: AttackMemStats = {
  hopRemembered: 0,
  scenes: 0,
  residuals: 0,
  workerSamples: 0,
  workerCap: 0,
  workerMs: 0,
};

/** Совет только по одному следу. Чужие, даже более громкие, в расчёт не входят. */
export function calloutForMarker(
  row: AttackRow,
  opts: {
    windowMhz: number;
    paint: AttackPaint | null;
    wave: WaveKind | null;
    holdMs: number;
    bands: readonly AllowBand[];
    transmitArmed: boolean;
  },
): AttackCallout {
  const widths = new Map([
    [row.id, { width3Mhz: row.width3Mhz, width26Mhz: row.width26Mhz, occ99Mhz: row.occ99Mhz }],
  ]);
  const looks = new Map(row.look ? [[row.id, row.look] as const] : []);
  const advice = buildAttackAdvice({
    tracks: [row],
    families: [],
    widths,
    looks,
    windowMhz: opts.windowMhz > 0 ? opts.windowMhz : 56,
    paint: opts.paint,
    wave: opts.wave,
    holdMs: opts.holdMs,
    bands: opts.bands,
    residual: null,
    memory: EMPTY_MEMORY,
    transmitArmed: opts.transmitArmed,
    sweep: row.lastSweep,
  });
  const card = buildAttackCallout([rowToCallout(row)], advice);
  return { ...card, freqMhz: row.freqMhz, typeLabel: row.look?.label ?? row.atlas.label };
}

function rowToCallout(row: AttackRow): CalloutRow {
  return {
    freqMhz: row.freqMhz,
    powerDbm: row.powerDbm,
    state: row.state,
    atlasId: row.atlas.id,
    typeLabel: row.look?.label ?? row.atlas.label,
  };
}

export function signalReadoutMhz(
  cardMhz: number | null,
  liveMhz: number | null,
  printedMhz: number | null,
  binMhz: number,
): number | null {
  const same =
    cardMhz != null && liveMhz != null && Math.abs(liveMhz - cardMhz) <= ATTACK_ASSOC_MHZ;
  const candidate = same ? liveMhz : (cardMhz ?? liveMhz);
  return holdPeakMhz(printedMhz, candidate, binMhz);
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
