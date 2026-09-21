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
  /** Куда смотрит наша антенна. Пустой азимут — повернём её на станцию. Пустой наклон — стоит ровно. */
  ourAimAzDeg: number | null;
  ourAimElDeg: number | null;
  /** Куда смотрит антенна противника. Оба пустые — станция может стоять сбоку, берём боковой лепесток. */
  oppAimAzDeg: number | null;
  oppAimElDeg: number | null;
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
  /** Рельеф Украины ещё читается. Пока его нет, не подменяем ответ фразой «нет земли». */
  terrainPending: boolean;
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
  /** Отдельная строка: станция сбоку и боковой лепесток. */
  side: string | null;
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
