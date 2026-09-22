// Дома и лес с векторных тайлов OpenFreeMap (схема OpenMapTiles).
// Высота дома: render_height или height. Нет числа — 3 м и пометка.

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import type { PathBuilding, PathWood } from "./pathCover";

const PLANET = "https://tiles.openfreemap.org/planet";
let tileTemplate: Promise<string | null> | null = null;

function template(): Promise<string | null> {
  if (!tileTemplate) {
    tileTemplate = fetch(PLANET)
      .then((res) => res.json() as Promise<{ tiles?: string[] }>)
      .then((json) => json.tiles?.[0] ?? null)
      .catch(() => null);
  }
  return tileTemplate;
}

function tileRange(lat1: number, lon1: number, lat2: number, lon2: number, z: number): Array<{ x: number; y: number; z: number }> {
  const n = 2 ** z;
  const xOf = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const yOf = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  const pad = 0.01;
  let x0 = xOf(Math.min(lon1, lon2) - pad);
  let x1 = xOf(Math.max(lon1, lon2) + pad);
  let y0 = yOf(Math.max(lat1, lat2) + pad);
  let y1 = yOf(Math.min(lat1, lat2) - pad);
  x0 = Math.max(0, x0);
  x1 = Math.min(n - 1, x1);
  y0 = Math.max(0, y0);
  y1 = Math.min(n - 1, y1);
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      out.push({ x, y, z });
      if (out.length >= 24) return out;
    }
  }
  return out;
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
  const tiles = tileRange(lat1, lon1, lat2, lon2, 14);
  const buildings: PathBuilding[] = [];
  const woods: PathWood[] = [];
  let truncated = tiles.length >= 24;
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
      const limit = Math.min(layer.length, 2500);
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
