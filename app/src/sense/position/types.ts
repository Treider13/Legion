// Вкладка «Позиция»: трасса до антенны противника. Дрона в модели нет.

import type { AntennaPattern } from "./pattern";
import type { PathBuilding, PathWood } from "./pathCover";

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
  /** Тайлы SRTM 1″ на путь. Нет клетки — берётся grid. */
  tiles?: DemGrid[] | null;
  /** Дома на трассе. В веер вокруг нас не копируются. */
  buildings?: PathBuilding[] | null;
  woods?: PathWood[] | null;
  ourPattern?: AntennaPattern | null;
  oppPattern?: AntennaPattern | null;
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

export interface SearchBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface SitePick {
  lat: number;
  lon: number;
  groundM: number;
  distanceKm: number;
  marginDb: number;
  azimuthDeg: number;
  elevationDeg: number;
  phrase: string;
}

export interface SquareSearch {
  note: string;
  picks: SitePick[];
}

export interface PositionResult {
  verdict: VerdictKind;
  phrase: string;
  action: string;
  /** Куда повернуть нашу антенну. Это не приказ ставить мачту. */
  aim: string;
  /** Отдельная строка: куда смотрит антенна противника. */
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
  /** Лес по P.833. В дифракцию холма не входит. */
  vegetationDb: number;
  buildingsOnPath: number;
  buildingsAssumed: number;
  rainDb: number | null;
  raiseGrazeM: number;
  raiseCleanM: number;
  raiseNormM: number;
  profile: ProfileSample[];
  move: MovePoint | null;
  map: MapCell[] | null;
}
