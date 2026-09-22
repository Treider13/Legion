// Кадр карты «Позиция». Камеру крутит MapLibre, здесь только числа кадра.

export type MapViewMode = "2d" | "3d";

export const PITCH_3D = 60;
export const MAX_PITCH = 85;

/** Домашний кадр, пока точки не заданы: вся Украина. */
export const UKRAINE_VIEW = { longitude: 31.2, latitude: 48.6, zoom: 5.4 };

export interface MapPoint {
  lat: number;
  lon: number;
}

export type FrameTarget =
  | { kind: "point"; longitude: number; latitude: number; zoom: number }
  | { kind: "bounds"; west: number; south: number; east: number; north: number };

export function modePitch(mode: MapViewMode): number {
  return mode === "3d" ? PITCH_3D : 0;
}

/** 100% — домашний кадр. Каждый шаг зума MapLibre удваивает масштаб. */
export function scalePercent(zoom: number, homeZoom: number): number {
  if (!Number.isFinite(zoom) || !Number.isFinite(homeZoom)) return 100;
  return Math.max(1, Math.round(100 * 2 ** (zoom - homeZoom)));
}

/**
 * Зум кадра по двум расчётам MapLibre: свободный и более тесный.
 * Объём домов в стиле начинается с 14. Поднимаем кадр только если точки
 * всё ещё влезают в тесный расчёт, иначе оставляем тот зум, где видны оба конца.
 */
export function frameZoom(fitted: number, tight: number | null): number {
  if (!Number.isFinite(fitted)) return 14;
  const capped = Math.min(Math.max(fitted, 0), 16);
  if (capped >= 13.2 && capped < 14 && tight != null && Number.isFinite(tight) && tight >= 14) {
    return Math.min(tight, 15.2);
  }
  return capped;
}

export function motionMs(): number {
  if (typeof matchMedia !== "function") return 700;
  return matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 700;
}

export function frameTarget(points: MapPoint[]): FrameTarget | null {
  const ok = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (ok.length === 0) return null;
  if (ok.length === 1) {
    return { kind: "point", longitude: ok[0].lon, latitude: ok[0].lat, zoom: 14 };
  }
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const p of ok) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lon);
    east = Math.max(east, p.lon);
  }
  const latPad = Math.max((north - south) * 0.25, 0.01);
  const lonPad = Math.max((east - west) * 0.25, 0.01);
  return {
    kind: "bounds",
    west: west - lonPad,
    south: south - latPad,
    east: east + lonPad,
    north: north + latPad,
  };
}
