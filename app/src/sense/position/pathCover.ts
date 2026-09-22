// Лес — ITU-R P.833-10, уравнение (1) и таблица 1.
// Дом — отдельное препятствие над землёй файла, как пользовательская точка SPLAT.
// Нет высоты в карте — 3 м, нижняя оценка CloudRF, и это помечается.

export interface PathBuilding {
  rings: number[][][];
  heightM: number;
  assumed: boolean;
}

export interface PathWood {
  rings: number[][][];
}

interface VegRow {
  mhz: number;
  gamma: number;
  am: number;
}

// Таблица 1 P.833-10. Выше последней строки коэффициенты не выдумываем: держим край таблицы.
const VEG: VegRow[] = [
  { mhz: 105.9, gamma: 0.04, am: 9.4 },
  { mhz: 466.475, gamma: 0.12, am: 18 },
  { mhz: 949, gamma: 0.17, am: 26.5 },
  { mhz: 1852.2, gamma: 0.3, am: 29 },
  { mhz: 2117.5, gamma: 0.34, am: 34.1 },
];

function lerpRow(freqMhz: number): VegRow {
  if (freqMhz <= VEG[0].mhz) return VEG[0];
  const last = VEG[VEG.length - 1];
  if (freqMhz >= last.mhz) return last;
  let hi = 1;
  while (VEG[hi].mhz < freqMhz) hi += 1;
  const a = VEG[hi - 1];
  const b = VEG[hi];
  const t = Math.log(freqMhz / a.mhz) / Math.log(b.mhz / a.mhz);
  return {
    mhz: freqMhz,
    gamma: a.gamma + (b.gamma - a.gamma) * t,
    am: a.am + (b.am - a.am) * t,
  };
}

/** Лишние децибелы леса. d — метры пути внутри леса. Выше 2117,5 МГц берётся край таблицы 1. */
export function vegetationDb(freqMhz: number, lengthM: number): number {
  if (!(lengthM > 0) || !(freqMhz > 0)) return 0;
  const row = lerpRow(freqMhz);
  if (!(row.am > 0)) return 0;
  return row.am * (1 - Math.exp((-lengthM * row.gamma) / row.am));
}

export function vegetationClamped(freqMhz: number): boolean {
  return freqMhz > VEG[VEG.length - 1].mhz;
}

function ringHas(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const cross = (yi > lat) !== (yj > lat);
    if (cross && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonHas(lon: number, lat: number, rings: number[][][]): boolean {
  if (rings.length === 0 || !ringHas(lon, lat, rings[0])) return false;
  for (let hole = 1; hole < rings.length; hole++) {
    if (ringHas(lon, lat, rings[hole])) return false;
  }
  return true;
}

export function buildingAt(lon: number, lat: number, buildings: readonly PathBuilding[]): PathBuilding | null {
  let best: PathBuilding | null = null;
  for (const building of buildings) {
    if (!polygonHas(lon, lat, building.rings)) continue;
    if (!best || building.heightM > best.heightM) best = building;
  }
  return best;
}

export function woodAt(lon: number, lat: number, woods: readonly PathWood[]): boolean {
  for (const wood of woods) {
    if (polygonHas(lon, lat, wood.rings)) return true;
  }
  return false;
}
