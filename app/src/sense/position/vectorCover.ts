// Дома и лес с векторных тайлов OpenFreeMap (схема OpenMapTiles).
// Высота дома: render_height или height. Нет числа — 3 м и пометка.

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { azimuthDeg, destination, distanceKm } from "./geo";
import type { PathBuilding, PathWood } from "./pathCover";

const PLANET = "https://tiles.openfreemap.org/planet";
let tileTemplate: Promise<string | null> | null = null;

function template(): Promise<string | null> {
  if (!tileTemplate) {
    const task = fetch(PLANET)
      .then((res) => res.json() as Promise<{ tiles?: string[] }>)
      .then((json) => json.tiles?.[0] ?? null)
      .catch(() => null);
    tileTemplate = task;
    void task.then((url) => {
      if (!url) tileTemplate = null;
    });
  }
  return tileTemplate;
}

export interface CoverTile {
  x: number;
  y: number;
  z: number;
}

const COVER_Z = 14;
const TILE_CAP = 128;
const STEP_KM = 0.2;

function tileXY(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const latC = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (latC * Math.PI) / 180;
  const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

/** Клетки векторной карты по геодезической луча. Оба конца входят. Шаг короче клетки. */
export function coverTilesOnPath(lat1: number, lon1: number, lat2: number, lon2: number, z = COVER_Z): { tiles: CoverTile[]; truncated: boolean } {
  const dist = distanceKm(lat1, lon1, lat2, lon2);
  const az = azimuthDeg(lat1, lon1, lat2, lon2);
  const steps = Math.max(1, Math.ceil(dist / STEP_KM));
  const tiles: CoverTile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const atEnd = i === steps;
    const pos = atEnd ? { lat: lat2, lon: lon2 } : destination(lat1, lon1, az, (dist * i) / steps);
    const cell = tileXY(pos.lat, pos.lon, z);
    const key = `${cell.x},${cell.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tiles.push({ x: cell.x, y: cell.y, z });
  }
  if (tiles.length <= TILE_CAP) return { tiles, truncated: false };
  return { tiles: tiles.slice(0, TILE_CAP), truncated: true };
}

function ringsOf(geometry: { type: string; coordinates: number[][][] | number[][][][] }): number[][][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  return [];
}

function heightOf(props: Record<string, number | string | boolean>): { heightM: number; assumed: boolean } {
  const raw = props.render_height ?? props.height;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(value) && value > 0) return { heightM: value, assumed: false };
  return { heightM: 3, assumed: true };
}

function isWood(layer: string, props: Record<string, number | string | boolean>): boolean {
  const kind = String(props.class ?? "");
  if (layer === "landcover" && (kind === "wood" || kind === "forest")) return true;
  if (layer === "landuse" && (kind === "wood" || kind === "forest")) return true;
  return false;
}

export interface PathCover {
  buildings: PathBuilding[];
  woods: PathWood[];
  truncated: boolean;
}

export async function loadPathCover(lat1: number, lon1: number, lat2: number, lon2: number, signal?: AbortSignal): Promise<PathCover> {
  const pattern = await template();
  if (!pattern) return { buildings: [], woods: [], truncated: false };
  const line = coverTilesOnPath(lat1, lon1, lat2, lon2);
  const tiles = line.tiles;
  const buildings: PathBuilding[] = [];
  const woods: PathWood[] = [];
  let truncated = line.truncated;
  await Promise.all(tiles.map(async (tile) => {
    if (signal?.aborted) return;
    const url = pattern.replace("{z}", String(tile.z)).replace("{x}", String(tile.x)).replace("{y}", String(tile.y));
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch {
      return;
    }
    if (!res.ok) return;
    const vector = new VectorTile(new PbfReader(await res.arrayBuffer()));
    for (const name of ["building", "landuse", "landcover"]) {
      const layer = vector.layers[name];
      if (!layer) continue;
      const limit = Math.min(layer.length, 8000);
      if (layer.length > limit) truncated = true;
      for (let i = 0; i < limit; i++) {
        const feature = layer.feature(i);
        if (feature.type !== 3) continue;
        const geo = feature.toGeoJSON(tile.x, tile.y, tile.z);
        if (geo.geometry.type !== "Polygon" && geo.geometry.type !== "MultiPolygon") continue;
        for (const rings of ringsOf(geo.geometry)) {
          if (name === "building") {
            const height = heightOf(feature.properties);
            buildings.push({ rings, ...height });
          } else if (isWood(name, feature.properties)) {
            woods.push({ rings });
          }
        }
      }
    }
  }));
  return { buildings, woods, truncated };
}
