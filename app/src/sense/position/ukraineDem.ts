// Рельеф всей Украины в памяти. Файл собран заранее, сеть при счёте не нужна.
// Рамка 44–52,5° с.ш. и 22–40,5° в.д. шире крайних точек страны.

import { cellSizeM } from "./terrain";
import type { DemGrid } from "./types";

const MAGIC = "UADEM01";

async function ungzip(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(bytes, 0, 2);
  // Сервер часто отдаёт .gz уже распакованным. Тогда в начале сразу заголовок.
  if (!(head[0] === 0x1f && head[1] === 0x8b)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

export async function parseUkraineDemGz(bytes: ArrayBuffer): Promise<DemGrid> {
  const raw = await ungzip(bytes);
  const view = new DataView(raw);
  const magic = String.fromCharCode(...new Uint8Array(raw, 0, MAGIC.length));
  if (magic !== MAGIC) throw new Error("чужой файл рельефа");
  const lat0 = view.getFloat64(8, true);
  const lon0 = view.getFloat64(16, true);
  const lat1 = view.getFloat64(24, true);
  const lon1 = view.getFloat64(32, true);
  const arcsec = view.getUint32(40, true);
  const nlat = view.getUint32(44, true);
  const nlon = view.getUint32(48, true);
  if (arcsec <= 0 || nlat < 2 || nlon < 2) throw new Error("пустой рельеф");
  if (52 + nlat * nlon * 2 !== raw.byteLength) throw new Error("рельеф обрезан");
  const step = arcsec / 3600;
  const endLat = lat0 + (nlat - 1) * step;
  const endLon = lon0 + (nlon - 1) * step;
  if (Math.abs(endLat - lat1) > 1e-6 || Math.abs(endLon - lon1) > 1e-6) throw new Error("градусы рельефа не сходятся");
  const grid: DemGrid = {
    lat0,
    lon0,
    nlat,
    nlon,
    dlat: step,
    dlon: step,
    cellM: 0,
    heights: new Int16Array(raw, 52, nlat * nlon),
  };
  grid.cellM = cellSizeM(grid);
  return grid;
}

let pending: Promise<DemGrid> | null = null;

/** Один запрос на всех. Повторный вызов не читает файл второй раз. */
export function loadUkraineDem(): Promise<DemGrid> {
  if (!pending) {
    pending = fetch(new URL("./data/ukraine-dem.bin.gz", import.meta.url))
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.arrayBuffer();
      })
      .then(parseUkraineDemGz)
      .catch((err: unknown) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
