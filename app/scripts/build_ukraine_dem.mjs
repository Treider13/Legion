// Собирает рельеф всей Украины в один файл.
// Источник: SRTM, тайлы AWS terrain / skadi, по градусу, 1".
// В файл кладётся каждый 12-й отсчёт (12", около 370 м по широте).
// Градусы рамки шире крайних точек страны, чтобы ничего не отрезать:
// север ~52,38°, юг ~44,39° (мыс Сарыч), запад ~22,14°, восток ~40,23°.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const LAT0 = 44;
const LON0 = 22;
const LAT1 = 52.5;
const LON1 = 40.5;
const ARCSEC = 12;
const STEP = ARCSEC / 3600;
const N = 3601;

const nlat = Math.round((LAT1 - LAT0) / STEP) + 1;
const nlon = Math.round((LON1 - LON0) / STEP) + 1;
const heights = new Int16Array(nlat * nlon);
heights.fill(-32768);

function tileName(swLat, swLon) {
  const ns = `${swLat >= 0 ? "N" : "S"}${String(Math.abs(swLat)).padStart(2, "0")}`;
  const ew = `${swLon >= 0 ? "E" : "W"}${String(Math.abs(swLon)).padStart(3, "0")}`;
  return { ns, file: `${ns}${ew}` };
}

async function loadTile(swLat, swLon) {
  const { ns, file } = tileName(swLat, swLon);
  const url = `https://elevation-tiles-prod.s3.amazonaws.com/skadi/${ns}/${file}.hgt.gz`;
  let last = "нет ответа";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(String(res.status));
      const raw = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
      if (raw.length !== N * N * 2) throw new Error(`размер ${raw.length}`);
      return raw;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(`${file}: ${last}`);
}

function writeTile(raw, swLat, swLon) {
  for (let iy = 0; iy < nlat; iy++) {
    const lat = LAT0 + iy * STEP;
    if (lat < swLat || lat >= swLat + 1) continue;
    const row = Math.round((swLat + 1 - lat) * 3600);
    if (row < 0 || row >= N) continue;
    for (let ix = 0; ix < nlon; ix++) {
      const lon = LON0 + ix * STEP;
      if (lon < swLon || lon >= swLon + 1) continue;
      const col = Math.round((lon - swLon) * 3600);
      if (col < 0 || col >= N) continue;
      heights[iy * nlon + ix] = raw.readInt16BE((row * N + col) * 2);
    }
  }
}

const tiles = [];
for (let lat = LAT0; lat < LAT1; lat++) {
  for (let lon = LON0; lon < LON1; lon++) tiles.push([lat, lon]);
}

let done = 0;
async function pool(limit) {
  let cursor = 0;
  async function worker() {
    while (cursor < tiles.length) {
      const index = cursor++;
      const [lat, lon] = tiles[index];
      const raw = await loadTile(lat, lon);
      if (raw) writeTile(raw, lat, lon);
      done++;
      if (done % 15 === 0 || done === tiles.length) console.log(`тайлы ${done}/${tiles.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

await pool(6);

const header = Buffer.alloc(8 + 8 * 4 + 4 * 3);
header.write("UADEM01\0", 0, "ascii");
header.writeDoubleLE(LAT0, 8);
header.writeDoubleLE(LON0, 16);
header.writeDoubleLE(LAT1, 24);
header.writeDoubleLE(LON1, 32);
header.writeUInt32LE(ARCSEC, 40);
header.writeUInt32LE(nlat, 44);
header.writeUInt32LE(nlon, 48);
const payload = Buffer.concat([header, Buffer.from(heights.buffer)]);
const gz = zlib.gzipSync(payload, { level: 9 });
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/sense/position/data/ukraine-dem.bin.gz");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, gz);

function sample(lat, lon) {
  const x = (lon - LON0) / STEP;
  const y = (lat - LAT0) / STEP;
  const ix = Math.round(x);
  const iy = Math.round(y);
  return heights[iy * nlon + ix];
}

let finite = 0;
for (let i = 0; i < heights.length; i++) if (heights[i] > -1000) finite++;
console.log(JSON.stringify({
  nlat,
  nlon,
  gz: gz.length,
  finite,
  hoverla: sample(48.1603, 24.5),
  kyiv: sample(50.4501, 30.5234),
  crimeaSouth: sample(44.4, 33.7),
  east: sample(49.0, 40.0),
  west: sample(48.1, 22.3),
  north: sample(52.2, 33.3),
}));
