export const DIGITAL_PROFILE_MHZ = 7;
export const DIGITAL_MAX_CORRIDOR_MHZ = 56;
export const DIGITAL_HW_SLOTS = 8;
export const DIGITAL_HW_SWITCH_US = 20;
export const DIGITAL_NIOS_SWITCH_US = 100;
export const DIGITAL_TUNE_MARGIN = 4;
export const DIGITAL_PROFILE_WIDTHS_MHZ = [7, 3.5, 1.75] as const;

export type DigitalWalk = "sequential" | "random" | "static";
export type DigitalWave = "saw" | "chirp" | "noise" | "tone" | "fm";
export type DigitalChirpDir = "up" | "down";
export type DigitalPresetId =
  | "elrs_500"
  | "elrs_250"
  | "elrs_150"
  | "elrs_50"
  | "crossfire_868_150"
  | "crossfire_868_50"
  | "custom";

export interface DigitalCorridor {
  startMhz: number;
  endMhz: number;
  priority: number;
}

export interface DigitalPreset {
  id: DigitalPresetId;
  label: string;
  dwellMs: number;
  profileMhz: number;
  src: string;
}

/** dwell = 1/rate. Сетка ELRS 2.4 в дереве — 1 МГц. Crossfire 868 — из fpga_control. */
export const DIGITAL_PRESETS: Record<DigitalPresetId, DigitalPreset> = {
  elrs_500: { id: "elrs_500", label: "ELRS 500 Гц", dwellMs: 2, profileMhz: 7, src: "спека: dwell 2 мс" },
  elrs_250: { id: "elrs_250", label: "ELRS 250 Гц", dwellMs: 4, profileMhz: 7, src: "спека: dwell 4 мс" },
  elrs_150: { id: "elrs_150", label: "ELRS 150 Гц", dwellMs: 1000 / 150, profileMhz: 7, src: "период 1/150 с" },
  elrs_50: { id: "elrs_50", label: "ELRS 50 Гц", dwellMs: 20, profileMhz: 3.5, src: "период 20 мс; 3.5 МГц если бюджет позволяет" },
  crossfire_868_150: { id: "crossfire_868_150", label: "Crossfire 868 150 Гц", dwellMs: 1000 / 150, profileMhz: 7, src: "fpga_control 1/150" },
  crossfire_868_50: { id: "crossfire_868_50", label: "Crossfire 868 50 Гц", dwellMs: 20, profileMhz: 7, src: "fpga_control 1/50" },
  custom: { id: "custom", label: "Пользовательский", dwellMs: 4, profileMhz: 7, src: "dwell и ширину задаёт оператор" },
};

export const DIGITAL_PRESET_IDS = Object.keys(DIGITAL_PRESETS) as DigitalPresetId[];

export function defaultDigitalCorridors(f1Mhz: number, f2Mhz: number): DigitalCorridor[] {
  const start = Number.isFinite(f1Mhz) ? f1Mhz : 2400;
  let end = Number.isFinite(f2Mhz) ? f2Mhz : start + DIGITAL_MAX_CORRIDOR_MHZ;
  if (end <= start) end = start + DIGITAL_MAX_CORRIDOR_MHZ;
  if (end - start > DIGITAL_MAX_CORRIDOR_MHZ) end = start + DIGITAL_MAX_CORRIDOR_MHZ;
  return [{ startMhz: start, endMhz: end, priority: 1 }];
}

export function corridorProfileCount(startMhz: number, endMhz: number, profileMhz = DIGITAL_PROFILE_MHZ): number {
  const span = endMhz - startMhz;
  const step = profileMhz > 0 ? profileMhz : DIGITAL_PROFILE_MHZ;
  if (!(span > 0) || span > DIGITAL_MAX_CORRIDOR_MHZ + 1e-9) return 0;
  return Math.ceil(span / step);
}

export function corridorCentersMhz(startMhz: number, endMhz: number, profileMhz = DIGITAL_PROFILE_MHZ): number[] {
  const step = profileMhz > 0 ? profileMhz : DIGITAL_PROFILE_MHZ;
  const n = corridorProfileCount(startMhz, endMhz, step);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(startMhz + step / 2 + i * step);
  }
  return out;
}

export function digitalPoolCount(
  corridors: DigitalCorridor[],
  profileMhz = DIGITAL_PROFILE_MHZ,
  collapse = true,
): number {
  if (!collapse) {
    return corridors.reduce((n, c) => n + corridorProfileCount(c.startMhz, c.endMhz, profileMhz), 0);
  }
  const best = new Map<number, number>();
  for (const c of corridors) {
    for (const mhz of corridorCentersMhz(c.startMhz, c.endMhz, profileMhz)) {
      const key = Math.round(mhz * 1e6);
      const prev = best.get(key);
      if (prev == null || c.priority > prev) best.set(key, c.priority);
    }
  }
  return best.size;
}

export function digitalWalkUs(n: number): number {
  const hw = Math.min(Math.max(0, n), DIGITAL_HW_SLOTS) * DIGITAL_HW_SWITCH_US;
  const nios = Math.max(0, n - DIGITAL_HW_SLOTS) * DIGITAL_NIOS_SWITCH_US;
  return hw + nios;
}

export interface DigitalTune {
  profileMhz: number;
  n: number;
  walkUs: number;
  dwellMs: number;
  budgetUs: number;
  fits: boolean;
  circles: number;
}

export function autoTuneDigital(
  corridors: DigitalCorridor[],
  dwellMs: number,
  profileMhz: number,
): DigitalTune {
  const n = digitalPoolCount(corridors, profileMhz);
  const walkUs = digitalWalkUs(n);
  const dwellUs = Math.max(1, Math.round(dwellMs * 1000));
  const budgetUs = Math.max(1, Math.floor(dwellUs / DIGITAL_TUNE_MARGIN));
  return {
    profileMhz,
    n,
    walkUs,
    dwellMs,
    budgetUs,
    fits: walkUs <= budgetUs,
    circles: walkUs ? Math.floor(dwellUs / walkUs) : 0,
  };
}

export function digitalBeatLine(n: number, dwellMs = 4, profileMhz = DIGITAL_PROFILE_MHZ): string {
  const us = digitalWalkUs(n);
  const dwellUs = Math.max(1, Math.round(dwellMs * 1000));
  const budgetUs = Math.max(1, Math.floor(dwellUs / DIGITAL_TUNE_MARGIN));
  const circles = us ? Math.floor(dwellUs / us) : 0;
  return (
    `${n} окон · ${profileMhz} МГц · круг ${us} мкс · бюджет ${budgetUs} мкс ` +
    `${us <= budgetUs ? "влезает" : "не влезает"} · кругов за dwell ${circles} (расчёт, не эфир)`
  );
}

export function digitalTuneLine(tune: DigitalTune): string {
  return (
    `${tune.n} окон · ${tune.profileMhz} МГц · круг ${tune.walkUs} мкс · ` +
    `бюджет ${tune.budgetUs} мкс ${tune.fits ? "влезает" : "не влезает"} · ` +
    `кругов за dwell ${tune.circles} (расчёт, не эфир)`
  );
}

export function waveLabelRu(wave: DigitalWave): string {
  switch (wave) {
    case "saw":
      return "Пила";
    case "chirp":
      return "Чирп";
    case "noise":
      return "Гауссов шум";
    case "tone":
      return "Тон";
    case "fm":
      return "FM + фаза";
  }
}

export function walkLabelRu(walk: DigitalWalk): string {
  if (walk === "random") return "Случайный";
  if (walk === "static") return "Статичный";
  return "Последовательный";
}
