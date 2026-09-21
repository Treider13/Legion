// ============================================================================
// LEGION — сборка сцены Атаки: ширины, семьи, разбор, помощник, память.
// Не пишет в рамку / волну / ПЕРЕДАТЬ.
// ============================================================================
import { atlasForTracks, type AttackAtlasRow } from "./attackAtlas";
import { buildAttackAdvice, type AttackAdvice } from "./attackAdvisor";
import { readAttackInfo } from "./attackInfo";
import { stitchHopFamilies, type AttackHopFamily } from "./attackFamily";
import { lookFromBins, type AttackLook } from "./attackLook";
import { measureHitWidths, spectrumCoversMhz, type AttackWidths } from "./attackMeasure";
import { memoryLineRu, type AttackSessionMemory } from "./attackMemory";
import type { AttackPaint } from "./attackPaint";
import type { AttackTrack } from "./attackTracks";
import type { AllowBand } from "../policy/allowlist";
import type { ScanBin } from "../sdr/types";
import type { WaveKind } from "../sdr/waveforms";

export interface AttackRow extends AttackTrack {
  atlas: AttackAtlasRow;
  width3Mhz: number;
  width26Mhz: number;
  occ99Mhz: number;
  look: AttackLook | undefined;
  familyId: string | null;
  /** Роль для оператора: фон / борт / пульт / ретранслятор. Пусто, если роли нет. */
  infoRu: string;
}

export interface AttackSceneView {
  rows: AttackRow[];
  families: AttackHopFamily[];
  advice: AttackAdvice;
  memoryLine: string;
}

export function buildAttackScene(input: {
  tracks: readonly AttackTrack[];
  bins: readonly ScanBin[];
  windowMhz: number;
  memory: AttackSessionMemory;
  paint: AttackPaint | null;
  wave: WaveKind | null;
  holdMs: number;
  bands: readonly AllowBand[];
  transmitArmed: boolean;
  /** Номер обхода трекера. Карточка его не выдумывает из lastSweep. */
  sweep?: number;
}): AttackSceneView {
  const widths = new Map<number, AttackWidths>();
  const looks = new Map<number, AttackLook>();
  for (const t of input.tracks) {
    // Спектр этого обхода чужую частоту не содержит. Ширина хита — та,
    // что трекер записал, когда частота была в окне. Разбор чужого окна
    // к этому следу не приписываем.
    const seenHere = spectrumCoversMhz(input.bins, t.freqMhz);
    const w: AttackWidths = seenHere
      ? measureHitWidths(input.bins, t.freqMhz)
      : { width3Mhz: t.widthMhz, width26Mhz: t.widthMhz, occ99Mhz: t.widthMhz };
    widths.set(t.id, w);
    const remembered = input.memory.looks.get(t.id);
    if (remembered) looks.set(t.id, remembered);
    else if (seenHere) looks.set(t.id, lookFromBins(input.bins, t.freqMhz, w));
  }
  const families = stitchHopFamilies(input.tracks, input.memory.hopMhz());
  const famOf = new Map<number, string>();
  for (const f of families) {
    for (const id of f.members) famOf.set(id, f.id);
  }
  const atlas = atlasForTracks(input.tracks, input.windowMhz);
  const info = readAttackInfo({
    tracks: input.tracks,
    snaps: input.memory.powerSnaps(),
    sweep: input.sweep,
  });
  const roleOf = new Map(info.roles.map((r) => [r.trackId, r.roleRu]));
  const rows: AttackRow[] = atlas.map((t) => {
    const w = widths.get(t.id) ?? { width3Mhz: t.widthMhz, width26Mhz: t.widthMhz, occ99Mhz: t.widthMhz };
    return {
      ...t,
      width3Mhz: w.width3Mhz,
      width26Mhz: w.width26Mhz,
      occ99Mhz: w.occ99Mhz,
      look: looks.get(t.id),
      familyId: famOf.get(t.id) ?? null,
      infoRu: roleOf.get(t.id) ?? "",
    };
  });
  const advice = buildAttackAdvice({
    tracks: input.tracks,
    families,
    widths,
    looks,
    windowMhz: input.windowMhz,
    paint: input.paint,
    wave: input.wave,
    holdMs: input.holdMs,
    bands: input.bands,
    residual: input.memory.lastResidual(),
    memory: input.memory.stats(),
    transmitArmed: input.transmitArmed,
    snaps: input.memory.powerSnaps(),
    info,
    sweep: input.sweep,
  });
  return {
    rows,
    families,
    advice,
    memoryLine: memoryLineRu(input.memory.stats(), families),
  };
}
