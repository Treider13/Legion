// Собирает рельеф всей Украины в один файл.
// Источник: открытые тайлы Copernicus GLO-30 (публичный бакет AWS).
// В файл кладётся шаг 12" (около 370 м). Полный шаг источника в браузер не лезет.
// Сеть нужна только этой сборке. Расчёт вкладки «Позиция» читает готовый файл.
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
const BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com";

const nlat = Math.round((LAT1 - LAT0) / STEP) + 1;
const nlon = Math.round((LON1 - LON0) / STEP) + 1;
const heights = new Int16Array(nlat * nlon);
heights.fill(-32768);

function tileKey(swLat, swLon) {
  const ns = `${swLat >= 0 ? "N" : "S"}${String(Math.abs(swLat)).padStart(2, "0")}`;
  const ew = `${swLon >= 0 ? "E" : "W"}${String(Math.abs(swLon)).padStart(3, "0")}`;
  return `Copernicus_DSM_COG_10_${ns}_00_${ew}_00_DEM`;
}

function tileUrl(swLat, swLon) {
  const key = tileKey(swLat, swLon);
  return `${BUCKET}/${key}/${key}.tif`;
}

async function fetchRange(url, start, end) {
  let last = "нет ответа";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 404) return null;
      if (res.status !== 206 && res.status !== 200) throw new Error(String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      const want = end - start + 1;
      if (res.status === 200 && buf.length > want) return buf.subarray(start, end + 1);
      if (buf.length < want) throw new Error(`короткий ответ ${buf.length}`);
      return buf.subarray(0, want);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw new Error(last);
}

function typeSize(typ) {
  if (typ === 1 || typ === 2) return 1;
  if (typ === 3) return 2;
  if (typ === 4 || typ === 11) return 4;
  if (typ === 5 || typ === 12) return 8;
  return 0;
}

function readNumbers(buf, field) {
  const sz = typeSize(field.typ) * field.cnt;
  if (sz <= 0) return [];
  let raw;
  if (sz <= 4) {
    raw = Buffer.alloc(4);
    raw.writeUInt32LE(field.val >>> 0, 0);
  } else {
    if (field.val + sz > buf.length) throw new Error("тег за пределами заголовка");
    raw = buf.subarray(field.val, field.val + sz);
  }
  const out = [];
  if (field.typ === 3) {
    for (let i = 0; i < field.cnt; i++) out.push(raw.readUInt16LE(i * 2));
  } else if (field.typ === 4) {
    for (let i = 0; i < field.cnt; i++) out.push(raw.readUInt32LE(i * 4));
  } else if (field.typ === 12) {
    for (let i = 0; i < field.cnt; i++) out.push(raw.readDoubleLE(i * 8));
  }
  return out;
}

function parseImages(buf) {
  if (buf.toString("ascii", 0, 2) !== "II" || buf.readUInt16LE(2) !== 42) throw new Error("не GeoTIFF");
  const images = [];
  const seen = new Set();
  const queue = [buf.readUInt32LE(4)];
  while (queue.length) {
    const off = queue.shift();
    if (!off || seen.has(off)) continue;
    seen.add(off);
    if (off + 2 > buf.length) throw new Error("IFD за пределами заголовка");
    const n = buf.readUInt16LE(off);
    if (off + 2 + n * 12 + 4 > buf.length) throw new Error("IFD обрезан");
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12;
      tags.set(buf.readUInt16LE(p), {
        typ: buf.readUInt16LE(p + 2),
        cnt: buf.readUInt32LE(p + 4),
        val: buf.readUInt32LE(p + 8),
      });
    }
    const next = buf.readUInt32LE(off + 2 + n * 12);
    if (next) queue.push(next);
    const sub = tags.get(330);
    if (sub) {
      for (const s of readNumbers(buf, sub)) queue.push(s);
    }
    images.push(tags);
  }
  return images;
}

function imageInfo(buf, tags) {
  const one = (tag, fallback) => {
    const field = tags.get(tag);
    if (!field) return fallback;
    const nums = readNumbers(buf, field);
    return nums.length === 1 ? nums[0] : nums;
  };
  const width = one(256, 0);
  const height = one(257, 0);
  return {
    width,
    height,
    bits: one(258, 0),
    compression: one(259, 1),
    predictor: one(317, 1),
    tileW: one(322, width),
    tileH: one(323, height),
    offsets: readNumbers(buf, tags.get(324) ?? { typ: 4, cnt: 0, val: 0 }),
    counts: readNumbers(buf, tags.get(325) ?? { typ: 4, cnt: 0, val: 0 }),
    sampleFormat: one(339, 1),
    scale: tags.has(33550) ? readNumbers(buf, tags.get(33550)) : null,
    tie: tags.has(33922) ? readNumbers(buf, tags.get(33922)) : null,
  };
}

function chooseLevel(buf, tagSets) {
  const images = tagSets.map((tags) => imageInfo(buf, tags));
  const base = images.find((im) => im.scale && im.tie && im.bits === 32 && im.sampleFormat === 3);
  if (!base) throw new Error("нет сетки высот");
  let best = null;
  for (const im of images) {
    if (im.bits !== 32 || im.sampleFormat !== 3 || im.width < 2 || im.height < 2) continue;
    const dlon = base.scale[0] * (base.width / im.width);
    const dlat = base.scale[1] * (base.height / im.height);
    if (dlon > STEP * 1.01 || dlat > STEP * 1.01) continue;
    const area = dlon * dlat;
    if (!best || area > best.area) best = { ...im, dlon, dlat, area, tieLon: base.tie[3], tieLat: base.tie[4] };
  }
  if (!best) throw new Error("нет подходящего шага");
  if (best.compression !== 8) throw new Error(`сжатие ${best.compression}`);
  if (best.predictor !== 1 && best.predictor !== 3) throw new Error(`предиктор ${best.predictor}`);
  if (best.offsets.length !== best.counts.length || best.offsets.length === 0) throw new Error("нет блоков");
  return best;
}

function decodeRowFloat(row) {
  const bytesPerSample = 4;
  const stride = 1;
  let index = 0;
  let count = row.length;
  const wc = count / bytesPerSample;
  while (count > stride) {
    for (let i = stride; i > 0; i--) {
      row[index + stride] += row[index];
      index++;
    }
    count -= stride;
  }
  const copy = Uint8Array.prototype.slice.call(row);
  for (let i = 0; i < wc; i++) {
    for (let b = 0; b < bytesPerSample; b++) {
      row[bytesPerSample * i + b] = copy[(bytesPerSample - b - 1) * wc + i];
    }
  }
}

function decodeTile(compressed, tileW, tileH, predictor) {
  const inflated = zlib.inflateSync(compressed);
  const need = tileW * tileH * 4;
  if (inflated.length !== need) throw new Error(`блок ${inflated.length} вместо ${need}`);
  if (predictor === 3) {
    const bytes = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
    const rowBytes = tileW * 4;
    for (let y = 0; y < tileH; y++) decodeRowFloat(bytes.subarray(y * rowBytes, (y + 1) * rowBytes));
  }
  return inflated;
}

function finiteHeight(v) {
  return Number.isFinite(v) && v > -1000 && v < 9000;
}

function bilinear(raster, w, h, col, row) {
  if (col < 0) col = 0;
  if (row < 0) row = 0;
  if (col > w - 1) col = w - 1;
  if (row > h - 1) row = h - 1;
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(c0 + 1, w - 1);
  const r1 = Math.min(r0 + 1, h - 1);
  const tx = col - c0;
  const ty = row - r0;
  const at = (r, c) => {
    const v = raster[r * w + c];
    return finiteHeight(v) ? v : null;
  };
  const parts = [
    [at(r0, c0), (1 - tx) * (1 - ty)],
    [at(r0, c1), tx * (1 - ty)],
    [at(r1, c0), (1 - tx) * ty],
    [at(r1, c1), tx * ty],
  ];
  let acc = 0;
  let wt = 0;
  for (const [v, wgt] of parts) {
    if (v != null && wgt > 0) {
      acc += v * wgt;
      wt += wgt;
    }
  }
  return wt > 0 ? acc / wt : null;
}

async function loadTile(swLat, swLon) {
  const url = tileUrl(swLat, swLon);
  const head = await fetchRange(url, 0, 65535);
  if (!head) return null;
  const level = chooseLevel(head, parseImages(head));
  const tilesX = Math.ceil(level.width / level.tileW);
  const tilesY = Math.ceil(level.height / level.tileH);
  if (tilesX * tilesY !== level.offsets.length) throw new Error("число блоков не сходится");
  const raster = new Float32Array(level.width * level.height);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const idx = ty * tilesX + tx;
      const start = level.offsets[idx];
      const count = level.counts[idx];
      const blob = await fetchRange(url, start, start + count - 1);
      if (!blob) throw new Error("блок пуст");
      const decoded = decodeTile(blob, level.tileW, level.tileH, level.predictor);
      const row0 = ty * level.tileH;
      const col0 = tx * level.tileW;
      for (let r = 0; r < level.tileH && row0 + r < level.height; r++) {
        for (let c = 0; c < level.tileW && col0 + c < level.width; c++) {
          raster[(row0 + r) * level.width + (col0 + c)] = decoded.readFloatLE((r * level.tileW + c) * 4);
        }
      }
    }
  }
  return { raster, level };
}

function paintTile(swLat, swLon, raster, level) {
  const originLat = LAT0 * 3600;
  const originLon = LON0 * 3600;
  const iy0 = Math.max(0, Math.ceil((swLat * 3600 - originLat) / ARCSEC));
  const iy1 = Math.min(nlat - 1, Math.floor(((swLat + 1) * 3600 - 1 - originLat) / ARCSEC));
  const ix0 = Math.max(0, Math.ceil((swLon * 3600 - originLon) / ARCSEC));
  const ix1 = Math.min(nlon - 1, Math.floor(((swLon + 1) * 3600 - 1 - originLon) / ARCSEC));
  for (let iy = iy0; iy <= iy1; iy++) {
    const lat = (originLat + iy * ARCSEC) / 3600;
    const row = (level.tieLat - lat) / level.dlat - 0.5;
    for (let ix = ix0; ix <= ix1; ix++) {
      const lon = (originLon + ix * ARCSEC) / 3600;
      const col = (lon - level.tieLon) / level.dlon - 0.5;
      const h = bilinear(raster, level.width, level.height, col, row);
      heights[iy * nlon + ix] = h == null ? -32768 : Math.round(h);
    }
  }
}

const tiles = [];
for (let lat = LAT0; lat < LAT1; lat++) {
  for (let lon = LON0; lon < LON1; lon++) tiles.push([lat, lon]);
}

let done = 0;
let missing = 0;
async function pool(limit) {
  let cursor = 0;
  async function worker() {
    while (cursor < tiles.length) {
      const index = cursor++;
      const [lat, lon] = tiles[index];
      const loaded = await loadTile(lat, lon);
      if (!loaded) missing++;
      else paintTile(lat, lon, loaded.raster, loaded.level);
      done++;
      if (done % 15 === 0 || done === tiles.length) console.log(`тайлы ${done}/${tiles.length}`);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
}

await pool(6);

function sample(lat, lon) {
  const ix = Math.round(((lon - LON0) / STEP));
  const iy = Math.round(((lat - LAT0) / STEP));
  if (iy < 0 || ix < 0 || iy >= nlat || ix >= nlon) return null;
  const h = heights[iy * nlon + ix];
  return h <= -1000 ? null : h;
}

let finite = 0;
for (let i = 0; i < heights.length; i++) if (heights[i] > -1000) finite++;
const hoverla = sample(48.1603, 24.5);
const kyiv = sample(50.4501, 30.5234);
if (finite < heights.length * 0.5) {
  console.error("слишком много пустых клеток, файл не перезаписан");
  process.exit(1);
}
if (!(hoverla > 1400) || !(kyiv > 80 && kyiv < 250)) {
  console.error(`контрольные высоты не сходятся: Говерла ${hoverla}, Киев ${kyiv}`);
  process.exit(1);
}

const header = Buffer.alloc(8 + 8 * 4 + 4 * 3);
header.write("UADEM01\0", 0, "ascii");
header.writeDoubleLE(LAT0, 8);
header.writeDoubleLE(LON0, 16);
header.writeDoubleLE(LAT1, 24);
header.writeDoubleLE(LON1, 32);
header.writeUInt32LE(ARCSEC, 40);
header.writeUInt32LE(nlat, 44);
header.writeUInt32LE(nlon, 48);
const payload = Buffer.concat([header, Buffer.from(heights.buffer, heights.byteOffset, heights.byteLength)]);
const gz = zlib.gzipSync(payload, { level: 9 });
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/sense/position/data/ukraine-dem.bin.gz");
const tmp = `${out}.tmp`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(tmp, gz);
fs.renameSync(tmp, out);

console.log(JSON.stringify({
  nlat,
  nlon,
  gz: gz.length,
  finite,
  missing,
  hoverla,
  kyiv,
  crimeaSouth: sample(44.4, 33.7),
  east: sample(49.0, 40.0),
  west: sample(48.1, 22.3),
  north: sample(52.2, 33.3),
}));
