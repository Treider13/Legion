// Плитки высот для 3D-карты. Числа те же, что в счёте трассы: метры над морем.
// Картинка растягивает их, чтобы хребет было видно глазом. Счёт это не трогает.

import { sampleDem } from "../../sense/position/terrain";
import type { DemGrid } from "../../sense/position/types";

export const TERRAIN_TILE_PX = 256;
export const TERRAIN_MAX_ZOOM = 11;
export const TERRAIN_EXAGGERATION = 1.5;

export function terrainTileKey(grid: DemGrid): string {
  return `${grid.lat0.toFixed(5)}_${grid.lon0.toFixed(5)}_${grid.nlat}_${grid.nlon}`;
}

export function terrariumOf(heightM: number): [number, number, number] {
  const shifted = Math.min(65535, Math.max(0, heightM + 32768));
  const whole = Math.floor(shifted);
  const frac = Math.round((shifted - whole) * 256);
  return [(whole >> 8) & 255, whole & 255, frac & 255];
}

export function heightOfTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export function webMercatorLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function webMercatorLat(y: number, z: number): number {
  const merc = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
}

function heightAt(grid: DemGrid, lat: number, lon: number): number {
  const lat1 = grid.lat0 + (grid.nlat - 1) * grid.dlat;
  const lon1 = grid.lon0 + (grid.nlon - 1) * grid.dlon;
  const latC = Math.min(Math.max(lat, Math.min(grid.lat0, lat1)), Math.max(grid.lat0, lat1));
  const lonC = Math.min(Math.max(lon, Math.min(grid.lon0, lon1)), Math.max(grid.lon0, lon1));
  return sampleDem(grid, latC, lonC) ?? 0;
}

/** RGB плитки: север сверху, как у карты. За рамкой файла — высота кромки, без обрыва в ноль. */
export function fillTerrariumRgb(grid: DemGrid, z: number, x: number, y: number, size = TERRAIN_TILE_PX): Uint8Array {
  const rgb = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    const lat = webMercatorLat(y + (py + 0.5) / size, z);
    for (let px = 0; px < size; px++) {
      const lon = webMercatorLon(x + (px + 0.5) / size, z);
      const [r, g, b] = terrariumOf(heightAt(grid, lat, lon));
      const i = (py * size + px) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return rgb;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const body = new Uint8Array(bytes);
  const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeRgbPng(rgb: Uint8Array, width: number, height: number): Promise<ArrayBuffer> {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    raw.set(rgb.subarray(y * stride, y * stride + stride), at + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array())];
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png.buffer;
}

export function parseTerrainTileUrl(url: string): { z: number; x: number; y: number } | null {
  const match = /\/(\d+)\/(\d+)\/(\d+)\.png(?:\?.*)?$/.exec(url);
  if (!match) return null;
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}
