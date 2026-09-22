// MapLibre спрашивает плитки сам. Отдаём ему высоты из файла, без сети.

import { addProtocol, type AddProtocolAction } from "maplibre-gl";
import type { DemGrid } from "../../sense/position/types";
import { encodeRgbPng, fillTerrariumRgb, parseTerrainTileUrl, TERRAIN_TILE_PX } from "./terrariumTile";

let grid: DemGrid | null = null;
let hooked = false;

const loadTile: AddProtocolAction = async (params, abort) => {
  if (abort.signal.aborted) throw new Error("плитка отменена");
  const tile = parseTerrainTileUrl(params.url);
  const active = grid;
  if (!tile || !active) throw new Error("рельеф ещё не прочитан");
  const rgb = fillTerrariumRgb(active, tile.z, tile.x, tile.y, TERRAIN_TILE_PX);
  return { data: await encodeRgbPng(rgb, TERRAIN_TILE_PX, TERRAIN_TILE_PX) };
};

export function bindTerrainGrid(next: DemGrid | null) {
  grid = next;
  if (hooked) return;
  hooked = true;
  addProtocol("uadem", loadTile);
}
