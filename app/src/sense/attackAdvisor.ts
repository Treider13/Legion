// ============================================================================
// LEGION — помощник Атаки. Только текст и предложение. Не пишет в TX.
// Классы волны — факт waveOccupiesPaintMhz: заливка / чирп / узкая / часть.
// Информация (роли и тень) только выбирает уже видимую рамку.
// ============================================================================
import { atlasForTracks, bandBucket, classifyAttackFamily } from "./attackAtlas";
import { chunkInsideEnvelope, familySpanWithPad, type AttackHopFamily } from "./attackFamily";
import { attackLiveTracks, readAttackInfo, type AttackInfo, type AttackInfoSnap } from "./attackInfo";
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

function familyFocusMhz(tracks: readonly AttackTrack[], fam: AttackHopFamily): number {
  let best: AttackTrack | null = null;
  for (const t of tracks) {
    if (t.state === "cooled" || !fam.members.includes(t.id)) continue;
    if (!best || t.powerDbm > best.powerDbm) best = t;
  }
  return best ? best.freqMhz : (fam.fLowMhz + fam.fHighMhz) / 2;
}

function inCorridor(mhz: number, bands: readonly AllowBand[]): boolean {
  if (bands.length === 0) return true;
  return bands.some((b) => mhz >= b.f1Mhz && mhz <= b.f2Mhz);
}

/** Самая сильная вспышка семьи, которую коридор вообще пускает в рамку. */
function paintableFocusMhz(
  tracks: readonly AttackTrack[],
  fam: AttackHopFamily,
  bands: readonly AllowBand[],
): number | null {
  let best: AttackTrack | null = null;
  for (const t of tracks) {
    if (t.state === "cooled" || !fam.members.includes(t.id)) continue;
    if (!inCorridor(t.freqMhz, bands)) continue;
    if (!best || t.powerDbm > best.powerDbm) best = t;
  }
  return best ? best.freqMhz : null;
}

/**
 * Частота, вокруг которой режется огибающая.
 * Сначала та, которую обводим, если коридор её пускает.
 * Если она снаружи, а в семье есть вспышка внутри коридора — берём её,
 * а не обрезанный край, который вспышку снаружи не накрывает.
 */
function familyPaintFocusMhz(
  tracks: readonly AttackTrack[],
  fam: AttackHopFamily,
  bands: readonly AllowBand[],
  preferMhz: number,
): number | null {
  const preferred = tracks.find(
    (t) =>
      t.state !== "cooled" &&
      fam.members.includes(t.id) &&
      Math.abs(t.freqMhz - preferMhz) <= 1e-3 &&
      inCorridor(t.freqMhz, bands),
  );
  if (preferred) return preferred.freqMhz;
  return paintableFocusMhz(tracks, fam, bands);
}

/** Огибающая семьи. Шире 40 МГц — кусок вокруг уже виденной вспышки, не нижний край и не следующий канал. */
function proposeFamilyPaint(
  fam: AttackHopFamily,
  tracks: readonly AttackTrack[],
  bands: readonly AllowBand[],
  memoryHopsMhz: readonly number[],
  preferMhz: number,
): { clipped: AttackPaint | null; text: string; why: string } {
  const span = familySpanWithPad(fam);
  const seen = paintSpanMhz(span);
  const neighbors = memoryHopsMhz.filter((f) => bandBucket(f) === fam.band).length >= 2;
  const where = neighbors ? "по соседним окнам" : "в кадре";
  const why = fam.gridMhz > 0 ? `шаг ≈ ${fam.gridMhz.toFixed(2)} МГц` : "несколько вспышек в одной корзине";
  const outside = ` Огибающая ${where} ≈ ${seen.toFixed(0)} МГц. Канал не угадываем.`;
  const focus = familyPaintFocusMhz(tracks, fam, bands, preferMhz);
  if (focus == null) {
    const seenAt = familyFocusMhz(tracks, fam);
    return {
      clipped: null,
      why,
      text: `Живая вспышка ${seenAt.toFixed(2)} МГц вне коридора — этот мазок её не накроет.${outside}`,
    };
  }
  const chunk = seen > ATTACK_TX_MAX_MHZ ? chunkInsideEnvelope(span, focus, ATTACK_TX_MAX_MHZ) : span;
  const raw = clampPaintToCaps(chunk);
  const clipped = allowedPaint(raw, bands);
  const covers = clipped != null && focus >= clipped.f1Mhz - 1e-6 && focus <= clipped.f2Mhz + 1e-6;
  if (!clipped || !covers) {
    return {
      clipped: null,
      why,
      text: `Живая вспышка ${focus.toFixed(2)} МГц вне коридора — этот мазок её не накроет.${outside}`,
    };
  }
  if (seen > ATTACK_TX_MAX_MHZ) {
    return {
      clipped,
      why,
      text:
        `Огибающая ${where} ≈ ${seen.toFixed(0)} МГц. Этим мазком ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц` +
        ` (не шире ${ATTACK_TX_MAX_MHZ}, вокруг живой вспышки ${focus.toFixed(2)} МГц).` +
        ` Остальное — следующим мазком, канал не угадываем.`,
    };
  }
  return {
    clipped,
    why,
    text: `Обведите семью hop ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц, не одну вспышку. Зона влезает в ${ATTACK_TX_MAX_MHZ} МГц.`,
  };
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
  memoryHopsMhz?: readonly number[];
  transmitArmed: boolean;
  snaps?: readonly AttackInfoSnap[];
  info?: AttackInfo;
  /** Номер обхода трекера. Без него берётся последний lastSweep на следах. */
  sweep?: number;
}): AttackAdvice {
  const live = attackLiveTracks(input.tracks, input.sweep);
  const hints: AttackHint[] = [];
  let suggestPaint: AttackPaint | null = null;
  const memoryHops = input.memoryHopsMhz ?? [];

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

  let top = strongest(live);
  const floors = twoFloor(live, input.windowMhz);
  const info =
    input.info ??
    readAttackInfo({
      tracks: input.tracks,
      snaps: input.snaps,
      sweep: input.sweep,
    });
  // Тень может держать канал hop, который в «живые» не попал: один удар на частоте,
  // окно уже на 5.8. Он не остыл — это увиденный пульт, не предсказанный канал.
  const known = input.tracks.filter((t) => t.state !== "cooled");
  const veto = info.redirectId != null ? known.find((t) => t.id === info.redirectId) ?? null : null;
  const prefer =
    veto == null && !floors && info.preferWideId != null
      ? live.find((t) => t.id === info.preferWideId) ?? null
      : null;
  const framed = veto ?? prefer;
  // Семья той частоты, которую обводим. families[0] — другая полоса:
  // пульт 915 МГц отдавал кнопку семье на 2416, а громкие 2440 — тихой семье на 868.
  const focusId = top?.id ?? null;
  let fam: AttackHopFamily | null =
    focusId == null ? null : (input.families.find((f) => f.members.includes(focusId)) ?? null);
  let honest = 0;
  if (top) {
    const w = input.widths.get(top.id);
    honest = w ? honestWidthMhz(w, top.widthMhz) : top.widthMhz;
  }
  if (framed) {
    top = framed;
    fam =
      framed.duty >= 0.7 && framed.widthMhz >= 6
        ? null
        : input.families.find((f) => f.members.includes(framed.id)) ?? null;
    const fw = input.widths.get(top.id);
    honest = fw ? honestWidthMhz(fw, top.widthMhz) : top.widthMhz;
  }
  const atlas = top ? classifyAttackFamily(top, input.windowMhz) : null;
  const topAtlas = top
    ? atlasForTracks(live, input.windowMhz).find((t) => t.id === top.id)?.atlas ?? atlas
    : null;
  const windowFill =
    topAtlas?.id === "window-fill" ||
    atlas?.id === "window-fill" ||
    (top != null && input.windowMhz > 0 && top.widthMhz >= 0.85 * input.windowMhz);

  let scene = `${live.length} след(ов) в кадре.`;
  if (topAtlas) scene += ` Класс энергии: ${topAtlas.label}. ${topAtlas.hint}.`;
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
  if (info.line) scene += ` ${info.line}`;
  scene += " Слушатель не читает имена бортов и текст модема: MAVLink — байты внутри пакета, не форма спектра.";
  scene += " Предложение не команда: ширину и тип волны можно указать другими, затем ПЕРЕДАТЬ. «Взять» не передаёт.";
  if (input.transmitArmed) scene += " Идёт передача: кнопки «Взять» выключены.";

  if (framed && top) {
    const wide = top.duty >= 0.7 && top.widthMhz >= 6;
    if (wide) {
      const vw = input.widths.get(top.id);
      const span = vw ? honestWidthMhz(vw, top.widthMhz) : top.widthMhz;
      const raw = clampPaintToCaps({ f1Mhz: top.freqMhz - span / 2, f2Mhz: top.freqMhz + span / 2 });
      const clipped = allowedPaint(raw, input.bands);
      suggestPaint = clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: clipped
          ? `Широкая полка сейчас: ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц.`
          : `Широкая полка ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`,
        why: "информация: широкая полка",
        applyLabel: clipped ? "Взять широкую рамку" : null,
        paint: clipped,
        wave: null,
        holdMs: null,
      });
    } else if (fam) {
      const proposed = proposeFamilyPaint(fam, known, input.bands, memoryHops, top.freqMhz);
      suggestPaint = proposed.clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: proposed.text,
        why: proposed.why,
        applyLabel: proposed.clipped ? "Взять рамку семьи" : null,
        paint: proposed.clipped,
        wave: null,
        holdMs: null,
      });
    } else {
      const span = Math.min(Math.max(honest, 0.2), ATTACK_TX_MAX_MHZ);
      const raw = clampPaintToCaps({ f1Mhz: top.freqMhz - span / 2, f2Mhz: top.freqMhz + span / 2 });
      const clipped = allowedPaint(raw, input.bands);
      suggestPaint = clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: clipped
          ? `Текущая частота: ${clipped.f1Mhz.toFixed(2)}…${clipped.f2Mhz.toFixed(2)} МГц.`
          : `Полоса ${raw.f1Mhz.toFixed(2)}…${raw.f2Mhz.toFixed(2)} МГц вне коридора — взять нельзя.`,
        why: "информация: текущая частота",
        applyLabel: clipped ? "Взять эту рамку" : null,
        paint: clipped,
        wave: null,
        holdMs: null,
      });
    }
  } else if (floors && top) {
    const video = live.filter((t) => t.duty >= 0.7 && t.widthMhz >= 6);
    const hop = live.filter((t) => t.duty < 0.45 && t.widthMhz <= 2);
    const v = strongest(video);
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
      const proposed = proposeFamilyPaint(fam, known, input.bands, memoryHops, hop[0].freqMhz);
      suggestPaint = proposed.clipped;
      hints.push({
        kind: "paint",
        title: "Рамка",
        text: proposed.text,
        why: proposed.why,
        applyLabel: proposed.clipped ? "Взять рамку семьи" : null,
        paint: proposed.clipped,
        wave: null,
        holdMs: null,
      });
    }
  } else if (fam && top) {
    const proposed = proposeFamilyPaint(fam, known, input.bands, memoryHops, top.freqMhz);
    suggestPaint = proposed.clipped;
    hints.push({
      kind: "paint",
      title: "Рамка",
      text: proposed.text,
      why: proposed.why,
      applyLabel: proposed.clipped ? "Взять рамку семьи" : null,
      paint: proposed.clipped,
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
  const wavePick: WaveKind | null = wantClass === "fill" ? "awgn" : wantClass === "narrow" ? "sine" : null;
  const occ = input.paint ? waveOccupiesPaintMhz(input.wave, input.paint, {}) : 0;
  const span = input.paint ? paintSpanMhz(input.paint) : 0;
  let waveText = `По картине ближе класс «${waveClassRu(wantClass)}».`;
  if (haveClass !== wantClass) {
    if (haveClass === "narrow" && wantClass === "fill" && span > 1) {
      waveText += ` Сейчас выбран тон — он займёт около 0.05 МГц из ${span.toFixed(1)}, края останутся живыми.`;
    } else if (haveClass === "fill" && wantClass === "narrow") {
      waveText += " Сейчас выбрана широкая заливка на узкую вспышку: накроете клетку и соседей, не всю сетку.";
    } else if (input.paint && occ + 0.35 < span) {
      waveText += ` Выбранная волна не зальёт края: ≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц.`;
    }
  } else {
    waveText += " Выбранный тип этому классу не противоречит.";
    if (input.paint && haveClass === "fill") {
      waveText += ` Края рамки эта волна зальёт (≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц).`;
    } else if (input.paint && occ + 0.35 < span) {
      waveText += ` Края рамки она не зальёт: ≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц.`;
    }
  }
  if (input.paint && span > 0 && !waveText.includes("кра")) {
    waveText +=
      occ + 0.35 >= span
        ? ` Выбранная волна зальёт края рамки (≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц).`
        : ` Выбранная волна не зальёт края: ≈ ${occ.toFixed(2)} из ${span.toFixed(2)} МГц.`;
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
      ? input.holdMs < holdWant
        ? `Выдержка ${input.holdMs} мс коротковата для hop: между вспышками тишина. Лучше не короче ${holdWant} мс, чтобы задеть несколько пакетов в нарисованной полосе. Канал не угадываем.`
        : `Выдержки ${input.holdMs} мс для hop хватает, чтобы задеть несколько пакетов в нарисованной полосе. Канал не угадываем.`
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
