import type { DemGrid, TerrainMark } from "./types";

export function inBounds(grid: DemGrid, lat: number, lon: number): boolean {
  if (grid.nlat < 2 || grid.nlon < 2 || grid.dlat === 0 || grid.dlon === 0) return false;
  const x = (lon - grid.lon0) / grid.dlon;
  const y = (lat - grid.lat0) / grid.dlat;
  return x >= 0 && y >= 0 && x <= grid.nlon - 1 && y <= grid.nlat - 1;
}

function heightOk(h: number): boolean {
  return Number.isFinite(h) && h > -1000;
}

export function sampleDem(grid: DemGrid, lat: number, lon: number): number | null {
  if (grid.nlat < 2 || grid.nlon < 2 || grid.dlat === 0 || grid.dlon === 0) return null;
  const x = (lon - grid.lon0) / grid.dlon;
  const y = (lat - grid.lat0) / grid.dlat;
  if (x < 0 || y < 0 || x > grid.nlon - 1 || y > grid.nlat - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, grid.nlon - 1);
  const y1 = Math.min(y0 + 1, grid.nlat - 1);
  const tx = x1 === x0 ? 0 : x - x0;
  const ty = y1 === y0 ? 0 : y - y0;
  const at = (ix: number, iy: number) => grid.heights[iy * grid.nlon + ix];
  const h00 = at(x0, y0);
  const h10 = at(x1, y0);
  const h01 = at(x0, y1);
  const h11 = at(x1, y1);
  if (![h00, h10, h01, h11].every(heightOk)) return null;
  const h0 = h00 * (1 - tx) + h10 * tx;
  const h1 = h01 * (1 - tx) + h11 * tx;
  return h0 * (1 - ty) + h1 * ty;
}

export function cellSizeM(grid: DemGrid): number {
  if (Number.isFinite(grid.cellM) && grid.cellM > 0) return grid.cellM;
  const midLat = grid.lat0 + (grid.nlat * grid.dlat) / 2;
  const latM = Math.abs(grid.dlat) * 111320;
  const lonM = Math.abs(grid.dlon) * 111320 * Math.cos((midLat * Math.PI) / 180);
  return Math.max(latM, lonM);
}

/** SRTM .hgt: 1201 или 3601, big-endian, северная строка первая. Угол — юго-запад тайла. */
export function parseSrtmHgt(buf: ArrayBuffer, swLat: number, swLon: number): DemGrid | null {
  if (!Number.isFinite(swLat) || !Number.isFinite(swLon)) return null;
  const samples = buf.byteLength / 2;
  const n = Math.round(Math.sqrt(samples));
  if ((n !== 1201 && n !== 3601) || n * n * 2 !== buf.byteLength) return null;
  const view = new DataView(buf);
  const heights = new Float64Array(n * n);
  const step = 1 / (n - 1);
  for (let row = 0; row < n; row++) {
    const iy = n - 1 - row;
    for (let col = 0; col < n; col++) {
      const raw = view.getInt16((row * n + col) * 2, false);
      heights[iy * n + col] = raw === -32768 ? Number.NaN : raw;
    }
  }
  return {
    lat0: swLat,
    lon0: swLon,
    nlat: n,
    nlon: n,
    dlat: step,
    dlon: step,
    cellM: step * 111320,
    heights,
  };
}

export function swCornerFromHgtName(name: string): { lat: number; lon: number } | null {
  const m = /([NS])(\d{1,2})([EW])(\d{1,3})/i.exec(name);
  if (!m) return null;
  const lat = Number(m[2]) * (m[1].toUpperCase() === "S" ? -1 : 1);
  const lon = Number(m[4]) * (m[3].toUpperCase() === "W" ? -1 : 1);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

export function parseDemJson(text: string): DemGrid | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const lat0 = Number(o.lat0);
  const lon0 = Number(o.lon0);
  const nlat = Number(o.nlat);
  const nlon = Number(o.nlon);
  const dlat = Number(o.dlat);
  const dlon = Number(o.dlon);
  const heights = o.heights;
  if (![lat0, lon0, nlat, nlon, dlat, dlon].every(Number.isFinite)) return null;
  if (nlat < 2 || nlon < 2 || !Array.isArray(heights) || heights.length !== nlat * nlon) return null;
  const out = new Float64Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    const h = Number(heights[i]);
    out[i] = Number.isFinite(h) ? h : Number.NaN;
  }
  const grid: DemGrid = { lat0, lon0, nlat, nlon, dlat, dlon, cellM: Number(o.cellM), heights: out };
  grid.cellM = cellSizeM(grid);
  return grid;
}

/** Число из поля. Пустая строка — не ноль: Number("") в JS равен 0. */
export function parseTypedNumber(text: string): number {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return Number.NaN;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

export function parsePathMarks(text: string): TerrainMark[] {
  const marks: TerrainMark[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/[\s,;]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const km = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isFinite(km) && Number.isFinite(m)) marks.push({ km, m });
  }
  marks.sort((a, b) => a.km - b.km);
  return marks;
}

export function terrainAtKm(
  km: number,
  distanceKm: number,
  ourGroundM: number,
  oppGroundM: number,
  marks: readonly TerrainMark[],
  flatM: number | null,
): number {
  if (km <= 0) return ourGroundM;
  if (km >= distanceKm) return oppGroundM;
  const inner = marks.filter((p) => p.km > 0 && p.km < distanceKm);
  if (inner.length === 0) return flatM ?? ourGroundM + ((oppGroundM - ourGroundM) * km) / distanceKm;
  let prev = { km: 0, m: ourGroundM };
  let next = { km: distanceKm, m: oppGroundM };
  for (const mark of inner) {
    if (mark.km <= km) prev = mark;
    if (mark.km >= km) {
      next = mark;
      break;
    }
  }
  if (next.km === prev.km) return prev.m;
  const t = (km - prev.km) / (next.km - prev.km);
  return prev.m + (next.m - prev.m) * t;
}
