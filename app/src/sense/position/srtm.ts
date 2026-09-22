// Тайл SRTM 1″ (~30 м), тот же .hgt, что читает SPLAT.
// Берём только клетки на пути. Нет тайла — остаётся файл Украины.

import { cellSizeM, sampleDem } from "./terrain";
import type { DemGrid } from "./types";

const TILE_CAP = 6;

export function srtmTileName(lat: number, lon: number): { name: string; swLat: number; swLon: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const swLat = Math.floor(lat);
  const swLon = Math.floor(lon);
  if (Math.abs(swLat) > 89 || Math.abs(swLon) > 180) return null;
  const ns = swLat >= 0 ? "N" : "S";
  const ew = swLon >= 0 ? "E" : "W";
  const name = `${ns}${String(Math.abs(swLat)).padStart(2, "0")}${ew}${String(Math.abs(swLon)).padStart(3, "0")}`;
  return { name, swLat, swLon };
}

export function srtmTileUrl(name: string): string {
  return `https://elevation-tiles-prod.s3.amazonaws.com/skadi/${name.slice(0, 3)}/${name}.hgt.gz`;
}

export function tilesOnPath(lat1: number, lon1: number, lat2: number, lon2: number): Array<{ name: string; swLat: number; swLon: number }> {
  const out: Array<{ name: string; swLat: number; swLon: number }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const tile = srtmTileName(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t);
    if (!tile || seen.has(tile.name)) continue;
    seen.add(tile.name);
    out.push(tile);
    if (out.length >= TILE_CAP) break;
  }
  return out;
}

async function ungzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(bytes, 0, 2);
  if (!(head[0] === 0x1f && head[1] === 0x8b)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

/** 3601×3601, северная строка в файле первая, в решётке строка 0 — юг. Пустота SRTM −32768. */
export function parseSrtm1(buf: ArrayBuffer, swLat: number, swLon: number): DemGrid | null {
  const n = 3601;
  if (buf.byteLength !== n * n * 2) return null;
  const view = new DataView(buf);
  const heights = new Float32Array(n * n);
  const step = 1 / (n - 1);
  for (let row = 0; row < n; row++) {
    const iy = n - 1 - row;
    for (let col = 0; col < n; col++) {
      const raw = view.getInt16((row * n + col) * 2, false);
      heights[iy * n + col] = raw === -32768 ? Number.NaN : raw;
    }
  }
  const grid: DemGrid = { lat0: swLat, lon0: swLon, nlat: n, nlon: n, dlat: step, dlon: step, cellM: 0, heights };
  grid.cellM = cellSizeM(grid);
  return grid;
}

const cache = new Map<string, Promise<DemGrid | null>>();

function retain(name: string, task: Promise<DemGrid | null>) {
  cache.delete(name);
  cache.set(name, task);
  while (cache.size > TILE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === name) break;
    cache.delete(oldest);
  }
}

export function loadSrtmTile(name: string, swLat: number, swLon: number): Promise<DemGrid | null> {
  const hit = cache.get(name);
  if (hit) {
    retain(name, hit);
    return hit;
  }
  const task = fetch(srtmTileUrl(name))
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.arrayBuffer();
    })
    .then(ungzip)
    .then((raw) => parseSrtm1(raw, swLat, swLon))
    .then((grid) => {
      if (!grid) cache.delete(name);
      return grid;
    })
    .catch(() => {
      cache.delete(name);
      return null;
    });
  retain(name, task);
  return task;
}

export async function loadSrtmPath(lat1: number, lon1: number, lat2: number, lon2: number): Promise<DemGrid[]> {
  const tiles = tilesOnPath(lat1, lon1, lat2, lon2);
  const grids = await Promise.all(tiles.map((tile) => loadSrtmTile(tile.name, tile.swLat, tile.swLon)));
  return grids.filter((grid): grid is DemGrid => grid != null);
}

export function sampleTiles(tiles: readonly DemGrid[] | null | undefined, lat: number, lon: number): number | null {
  if (!tiles) return null;
  for (const tile of tiles) {
    const height = sampleDem(tile, lat, lon);
    if (height != null) return height;
  }
  return null;
}
