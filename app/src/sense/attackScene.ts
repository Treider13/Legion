// ============================================================================
// LEGION — сборка сцены Атаки: ширины, семьи, разбор, совет, память.
// Не пишет в рамку / волну / ПЕРЕДАТЬ.
// ============================================================================
import { atlasForTracks, type AttackAtlasRow } from "./attackAtlas";
import { buildAttackAdvice, type AttackAdvice } from "./attackAdvisor";
import { stitchHopFamilies, type AttackHopFamily } from "./attackFamily";
import { lookFromBins, type AttackLook } from "./attackLook";
import { measureHitWidths, type AttackWidths } from "./attackMeasure";
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
}): AttackSceneView {
  const widths = new Map<number, AttackWidths>();
  const looks = new Map<number, AttackLook>();
  for (const t of input.tracks) {
    const w = input.bins.length ? measureHitWidths(input.bins, t.freqMhz) : {
      width3Mhz: t.widthMhz,
      width26Mhz: t.widthMhz,
      occ99Mhz: t.widthMhz,
    };
    widths.set(t.id, w);
    const remembered = input.memory.looks.get(t.id);
    looks.set(t.id, remembered ?? lookFromBins(input.bins, t.freqMhz, w));
  }
  const families = stitchHopFamilies(input.tracks, input.memory.hopMhz());
  const famOf = new Map<number, string>();
  for (const f of families) {
    for (const id of f.members) famOf.set(id, f.id);
  }
  const atlas = atlasForTracks(input.tracks, input.windowMhz);
  const rows: AttackRow[] = atlas.map((t) => {
    const w = widths.get(t.id) ?? { width3Mhz: t.widthMhz, width26Mhz: t.widthMhz, occ99Mhz: t.widthMhz };
    return {
      ...t,
      width3Mhz: w.width3Mhz,
      width26Mhz: w.width26Mhz,
      occ99Mhz: w.occ99Mhz,
      look: looks.get(t.id),
      familyId: famOf.get(t.id) ?? null,
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
    memoryHopsMhz: input.memory.hopMhz(),
    transmitArmed: input.transmitArmed,
  });
  return {
    rows,
    families,
    advice,
    memoryLine: memoryLineRu(input.memory.stats(), families),
  };
}
