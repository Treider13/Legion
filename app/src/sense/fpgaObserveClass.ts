// ============================================================================
// LEGION — класс с observe FPGA. Без retune и без DISARM.
// IQ-гребёнки нет: USB не в круге µs. Полоса + ширина взгляда + энергия.
// ============================================================================
import { ATTACK_SILENT_HINT, classifyAttackFamily, type AttackAtlasRow } from "./attackAtlas";
import type { AttackRow } from "./attackScene";

export interface FpgaObserveClass {
  atlas: AttackAtlasRow;
  freqMhz: number | null;
  detActive: boolean;
  lookMhz: number;
  note: string;
}

export function classifyFpgaObserve(opts: {
  peakMhz: number | null | undefined;
  loMhz: number | null | undefined;
  detActive: boolean;
  lookMhz: number;
}): FpgaObserveClass {
  const look = Number.isFinite(opts.lookMhz) && opts.lookMhz > 0 ? opts.lookMhz : 2;
  const hz =
    opts.peakMhz != null && opts.peakMhz > 0
      ? opts.peakMhz
      : opts.loMhz != null && opts.loMhz > 0
        ? opts.loMhz
        : null;
  if (!opts.detActive) {
    return {
      atlas: { id: "silent", label: "тишина в окне FPGA", hint: ATTACK_SILENT_HINT },
      freqMhz: hz,
      detActive: false,
      lookMhz: look,
      note: "гейт закрыт · класс по IQ только на хост-слухе",
    };
  }
  if (hz == null) {
    return {
      atlas: { id: "energy", label: "энергия в окне", hint: "пик ещё не пришёл с платы" },
      freqMhz: null,
      detActive: true,
      lookMhz: look,
      note: "детекция I²+Q² · частота пика не готова",
    };
  }
  const atlas = classifyAttackFamily(
    { freqMhz: hz, widthMhz: look, duty: 1, streak: 8 },
    look,
    null,
  );
  return {
    atlas: {
      ...atlas,
      hint: `${atlas.hint} · FPGA observe, без FM-гребёнки`,
    },
    freqMhz: hz,
    detActive: true,
    lookMhz: look,
    note: `взгляд ${look.toFixed(1)} МГц · ${hz.toFixed(3)} МГц`,
  };
}

export function fpgaObserveAsRow(cls: FpgaObserveClass): AttackRow | null {
  if (cls.freqMhz == null) return null;
  return {
    id: -1,
    freqMhz: cls.freqMhz,
    fLowMhz: cls.freqMhz - cls.lookMhz / 2,
    fHighMhz: cls.freqMhz + cls.lookMhz / 2,
    widthMhz: cls.lookMhz,
    powerDbm: cls.detActive ? 0 : -200,
    noiseDbm: -200,
    snrDb: 0,
    hits: cls.detActive ? 4 : 0,
    streak: cls.detActive ? 4 : 0,
    maxStreak: cls.detActive ? 4 : 0,
    firstSweep: 0,
    lastSweep: 0,
    gap: 0,
    duty: cls.detActive ? 1 : 0,
    state: cls.detActive ? "confirmed" : "cooled",
    lastSeenTs: Date.now(),
    atlas: cls.atlas,
    width3Mhz: cls.lookMhz,
    width26Mhz: cls.lookMhz,
    occ99Mhz: cls.lookMhz,
    look: undefined,
    familyId: null,
    infoRu: cls.note,
  };
}
