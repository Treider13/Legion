// Вкладка «Позиция»: трасса до антенны противника. Дрона в модели нет.

export type AntennaKind = "whip" | "patch" | "dish" | "yagi";

export type VerdictKind = "open" | "ridge" | "closed" | "insufficient";

export interface TerrainMark {
  km: number;
  m: number;
}

/** Решётка высот. Строка 0 — южная кромка lat0, столбец 0 — западная кромка lon0. */
export interface DemGrid {
  lat0: number;
  lon0: number;
  nlat: number;
  nlon: number;
  dlat: number;
  dlon: number;
  cellM: number;
  heights: ArrayLike<number>;
}

export interface PositionInput {
  ourLat: number;
  ourLon: number;
  ourGroundM: number;
  ourAglM: number;
  oppLat: number;
  oppLon: number;
  oppGroundM: number;
  oppAglM: number;
  freqMhz: number;
  ourKind: AntennaKind;
  ourDbi: number;
  oppKind: AntennaKind;
  oppDbi: number;
  powerW: number | null;
  thresholdDbm: number | null;
  /** Отметки земли между концами, км от нас. Концы берутся из точек. */
  marks: TerrainMark[];
  /** Явная ровная земля, м над морем. Без отметок и без файла. */
  flatM: number | null;
  grid: DemGrid | null;
  /** Шаг карты, м. Для файла берётся из решётки, если поле пустое. */
  cellM: number | null;
  clutter: boolean;
  rainMmH: number | null;
}

export interface ProfileSample {
  km: number;
  terrainM: number;
  rayM: number;
  fresnelM: number;
  clearanceM: number;
}

export interface MovePoint {
  lat: number;
  lon: number;
  distanceKm: number;
  groundM: number;
}

export interface MapCell {
  lat: number;
  lon: number;
  km: number;
  azimuthDeg: number;
  verdict: VerdictKind;
}

export interface PositionResult {
  verdict: VerdictKind;
  phrase: string;
  action: string;
  rx1: string | null;
  distanceKm: number;
  azimuthDeg: number;
  elevationDeg: number;
  beamwidthDeg: number | null;
  marginDb: number | null;
  fsplDb: number;
  diffractionDb: number;
  gasDb: number;
  rainDb: number | null;
  raiseGrazeM: number;
  raiseCleanM: number;
  raiseNormM: number;
  profile: ProfileSample[];
  move: MovePoint | null;
  map: MapCell[] | null;
}
