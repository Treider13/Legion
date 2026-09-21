// ============================================================================
// LEGION — советник Атаки. Только текст и предложение. Не пишет в TX.
// Классы волны — факт waveOccupiesPaintMhz: заливка / чирп / узкая / часть.
// ============================================================================
import { atlasForTracks, classifyAttackFamily } from "./attackAtlas";
import { familySpanWithPad, type AttackHopFamily } from "./attackFamily";
import type { AttackLook } from "./attackLook";
import { honestWidthMhz, type AttackWidths } from "./attackMeasure";
import { residualLineRu, type AttackMemStats, type AttackResidual } from "./attackMemory";
import {
  ATTACK_HOLD_DEFAULT_MS,
  ATTACK_HOLD_MAX_MS,
  ATTACK_HOLD_MIN_MS,
  ATTACK_TX_MAX_MHZ,
  clampPaintToCaps,
  clipPaintToAllowlist,
  paintSpanMhz,
  waveOccupiesPaintMhz,
  type AttackPaint,
} from "./attackPaint";
import type { AttackTrack } from "./attackTracks";
import type { AllowBand } from "../policy/allowlist";
import type { WaveKind } from "../sdr/waveforms";

export type AttackHintKind = "paint" | "wave" | "hold";

export interface AttackHint {
  kind: AttackHintKind;
  title: string;
  text: string;
  why: string;
  applyLabel: string | null;
  paint: AttackPaint | null;
  wave: WaveKind | null;
  holdMs: number | null;
}

export interface AttackAdvice {
  scene: string;
  after: string;
  hints: AttackHint[];
  suggestPaint: AttackPaint | null;
}

export type AttackWaveClass = "fill" | "chirp" | "narrow" | "part";

export function waveClassOf(kind: WaveKind | null): AttackWaveClass {
  if (kind == null || kind === "sine" || kind === "tone") return "narrow";
  if (kind === "chirp") return "chirp";
  if (kind === "awgn" || kind === "ofdm" || kind === "otfs" || kind === "afdm" || kind === "ocdm") {
    return "fill";
  }
  if (kind === "scfdma") return "part";
  return "part";
}

export function waveClassRu(c: AttackWaveClass): string {
  if (c === "fill") return "заливка всей рамки (шум / OFDM / OTFS / AFDM / OCDM)";
  if (c === "chirp") return "чирп по ширине рамки";
  if (c === "narrow") return "узкий тон в центре";
  return "часть рамки (~треть) — края не зальёт";
}

function strongest(
  tracks: readonly AttackTrack[],
): AttackTrack | null {
  const live = tracks.filter((t) => t.state === "confirmed" || t.state === "held" || t.state === "new");
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.powerDbm > a.powerDbm ? b : a));
}

function twoFloor(tracks: readonly AttackTrack[], windowMhz: number): boolean {
  return atlasForTracks(tracks, windowMhz).some((t) => t.atlas.id === "two-floor");
}

/** Не предлагать «взять» рамку, которую ПЕРЕДАТЬ отвергнет (вне коридора). */
function allowedPaint(raw: AttackPaint, bands: readonly AllowBand[]): AttackPaint | null {
  return clipPaintToAllowlist(raw, bands);
}

export function buildAttackAdvice(input: {
  tracks: readonly AttackTrack[];
  families: readonly AttackHopFamily[];
  widths: ReadonlyMap<number, AttackWidths>;
  looks: ReadonlyMap<number, AttackLook>;
  windowMhz: number;
  paint: AttackPaint | null;
  wave: WaveKind | null;
  holdMs: number;
  bands: readonly AllowBand[];
  residual: AttackResidual | null;
  memory: AttackMemStats;
  transmitArmed: boolean;
}): AttackAdvice {
  const live = input.tracks.filter((t) => t.state !== "cooled");
  const hints: AttackHint[] = [];
  let suggestPaint: AttackPaint | null = null;

  if (live.length === 0) {
    return {
      scene: "Эфир тихий этим режимом: волокно, автономия и чужая сотовая отсюда не видны.",
      after: input.residual
        ? residualLineRu(input.residual)
        : "После передачи здесь появится, что осталось в рамке.",
      hints: [
        {
          kind: "paint",
          title: "Рамка",
          text: "Пока нечего обводить — подождите вспышку или смените коридор.",
          why: "нет подтверждённых треков",
          applyLabel: null,
          paint: null,
          wave: null,
          holdMs: null,
        },
      ],
      suggestPaint: null,
    };
  }

  const top = strongest(live);
  const fam = input.families[0] ?? null;
  const floors = twoFloor(live, input.windowMhz);
  const atlas = top ? classifyAttackFamily(top, input.windowMhz) : null;
  const w = top ? input.widths.get(top.id) : undefined;
  const honest = top && w ? honestWidthMhz(w, top.widthMhz) : top?.widthMhz ?? 0;
  const windowFill = atlas?.id === "window-fill" || (top != null && input.windowMhz > 0 && top.widthMhz >= 0.85 * input.windowMhz);

  let scene = `${live.length} след(ов) в кадре.`;
  if (floors) scene += " Два этажа: широкое липкое и hop рядом — это не один сигнал.";
  if (fam) {
    scene += ` Семья hop: ${fam.fLowMhz.toFixed(2)}…${fam.fHighMhz.toFixed(2)} МГц`;
    if (fam.gridMhz > 0) scene += `, шаг сетки ≈ ${fam.gridMhz.toFixed(2)} МГц`;
    scene += " (уже виденные вспышки, не будущий канал).";
  }
  if (windowFill) {
    scene += ` Окно слуха ≈ ${input.windowMhz.toFixed(0)} МГц забито — канал может быть 60/80, рука платы 40 МГц туда не достанет.`;
  }
  if (input.memory.hopRemembered > 4) {
    scene += ` Память видела уже ${input.memory.hopRemembered} hop-вспышек за сессию.`;
  }

  if (floors && top) {
    const video = live.filter((t) => t.duty >= 0.7 && t.widthMhz >= 6);
    const hop = live.filter((t) => t.duty < 0.45 && t.widthMhz <= 2);
    const v = video[0];
    if (v) {
      const vw = input.widths.get(v.id);
      const span = vw ? honestWidthMhz(vw, v.widthMhz) : v.widthMhz;
      const raw = clampPaintToCaps({ f1Mhz: v.freqMhz - span / 2, f2Mhz: v.freqMhz + span / 2 });
      const clipped = allowedPaint(raw, input.bands);
      suggestPaint = clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: clipped
          ? `Сначала широкое: ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц. Hop — второй раз, другой рамкой.`
          : `Широкое ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`,
        why: "два этажа в одной корзине",
        applyLabel: clipped ? "Взять широкую рамку" : null,
        paint: clipped,
        wave: null,
        holdMs: null,
      });
    } else if (hop[0] && fam) {
      const span = familySpanWithPad(fam);
      const raw = clampPaintToCaps(span);
      const clipped = allowedPaint(raw, input.bands);
      suggestPaint = clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: clipped
          ? `Hop-семья ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц. Не одна вспышка.`
          : `Hop-семья ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`,
        why: "огибающая уже виденных вспышек",
        applyLabel: clipped ? "Взять рамку семьи" : null,
        paint: clipped,
        wave: null,
        holdMs: null,
      });
    }
  } else if (fam) {
    const span = familySpanWithPad(fam);
    let raw = clampPaintToCaps(span);
    const want = paintSpanMhz(span);
    if (want > ATTACK_TX_MAX_MHZ) {
      raw = clampPaintToCaps({
        f1Mhz: fam.fLowMhz,
        f2Mhz: fam.fLowMhz + ATTACK_TX_MAX_MHZ,
      });
    }
    const clipped = allowedPaint(raw, input.bands);
    suggestPaint = clipped;
    const extra =
      want > ATTACK_TX_MAX_MHZ
        ? ` Сетка шире руки: видно ≈ ${want.toFixed(1)} МГц, залить можно ${ATTACK_TX_MAX_MHZ}.`
        : "";
    hints.push({
      kind: "paint",
      title: "Рамка",
      text: clipped
        ? `Обведите семью hop ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц, не одну вспышку.${extra}`
        : `Семья hop ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`,
      why: fam.gridMhz > 0 ? `шаг ≈ ${fam.gridMhz.toFixed(2)} МГц` : "несколько вспышек в одной корзине",
      applyLabel: clipped ? "Взять рамку семьи" : null,
      paint: clipped,
      wave: null,
      holdMs: null,
    });
  } else if (top) {
    const span = Math.min(Math.max(honest, 0.2), ATTACK_TX_MAX_MHZ);
    const raw = clampPaintToCaps({ f1Mhz: top.freqMhz - span / 2, f2Mhz: top.freqMhz + span / 2 });
    const clipped = allowedPaint(raw, input.bands);
    suggestPaint = clipped;
    hints.push({
      kind: "paint",
      title: "Рамка",
      text: !clipped
        ? `Полоса ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`
        : windowFill
          ? `Слышим край фильтра. Рука 40 МГц: ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)}. Остальное этой заливкой не взять.`
          : `По честной ширине: ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц (−26 / 99% / −3, не юбка CFAR).`,
      why: `ширина ≈ ${span.toFixed(2)} МГц`,
      applyLabel: clipped ? "Взять эту рамку" : null,
      paint: clipped,
      wave: null,
      holdMs: null,
    });
  }

  const look = top ? input.looks.get(top.id) : undefined;
  const wantClass: AttackWaveClass = (() => {
    if (look?.kind === "tone" || (honest > 0 && honest <= 2 && (top?.duty ?? 1) < 0.5)) return "narrow";
    if (look?.kind === "ofdm" || look?.kind === "noise" || (top && top.duty >= 0.7 && honest >= 6)) return "fill";
    if (fam && honest <= 2) return "narrow";
    return "fill";
  })();
  const haveClass = waveClassOf(input.wave);
  const wavePick: WaveKind | null = wantClass === "fill" ? "awgn" : wantClass === "chirp" ? "chirp" : wantClass === "narrow" ? "sine" : null;
  let waveText = `По картине ближе класс «${waveClassRu(wantClass)}».`;
  if (haveClass !== wantClass) {
    const occ = input.paint ? waveOccupiesPaintMhz(input.wave, input.paint, {}) : 0;
    const span = input.paint ? paintSpanMhz(input.paint) : 0;
    if (haveClass === "narrow" && wantClass === "fill" && span > 1) {
      waveText += ` Сейчас выбран тон — он займёт около 0.05 МГц из ${span.toFixed(1)}, края останутся живыми.`;
    } else if (haveClass === "fill" && wantClass === "narrow") {
      waveText += " Сейчас выбрана широкая заливка на узкую вспышку: накроете клетку и соседей, не всю сетку.";
    } else if (haveClass === "part" && input.paint && occ + 0.2 < span) {
      waveText += ` Выбранная волна займёт ≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц.`;
    }
  } else {
    waveText += " Выбранный тип этому классу не противоречит.";
  }
  hints.push({
    kind: "wave",
    title: "Волна",
    text: waveText,
    why: look ? look.label : atlas?.label ?? "по ширине и duty",
    applyLabel: wavePick && haveClass !== wantClass ? `Поставить «${wavePick === "awgn" ? "гауссов шум" : wavePick === "sine" ? "синус" : "чирп"}»` : null,
    paint: null,
    wave: wavePick && haveClass !== wantClass ? wavePick : null,
    holdMs: null,
  });

  const hopish = Boolean(fam) || (top != null && top.duty < 0.45);
  const holdWant = hopish
    ? Math.min(ATTACK_HOLD_MAX_MS, Math.max(input.holdMs, 5000))
    : Math.min(ATTACK_HOLD_MAX_MS, Math.max(ATTACK_HOLD_MIN_MS, input.holdMs || ATTACK_HOLD_DEFAULT_MS));
  hints.push({
    kind: "hold",
    title: "Время",
    text: hopish
      ? `Между вспышками тишина. Короткая выдержка может попасть в паузу. Лучше не короче ${holdWant} мс — больше шанс задеть несколько пакетов в нарисованной полосе. Канал не угадываем.`
      : `Сигнал держится. Выдержки ${input.holdMs} мс обычно хватает, чтобы увидеть остаток после передачи.`,
    why: hopish ? "низкий duty" : "липкий след",
    applyLabel: hopish && input.holdMs < holdWant ? `Поставить ${holdWant} мс` : null,
    paint: null,
    wave: null,
    holdMs: hopish && input.holdMs < holdWant ? holdWant : null,
  });

  let after = "Пока не передавали — остатка нет. После ПЕРЕДАТЬ здесь будет, накрыли ли края.";
  if (input.residual) after = residualLineRu(input.residual);
  if (input.transmitArmed && !input.residual) {
    after = "Идёт передача. Остаток появится, когда память IQ вычтет свою волну. Если усилитель в клипе — вычет мёртв.";
  }

  return { scene, after, hints: hints.slice(0, 3), suggestPaint };
}
