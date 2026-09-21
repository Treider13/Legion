import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computePosition, fresnelRadiusM, gasDbPerKm, knifeEdgeDb, rainDbPerKm, searchSquare, sideGainDb, smoothEarthDb } from "../src/sense/position/compute";
import { azimuthDeg, destination, distanceKm, formatDeg } from "../src/sense/position/geo";
import { modeOf } from "../src/sense/modes";
import { parseDemJson, parseSrtmHgt, sampleDem, swCornerFromHgtName } from "../src/sense/position/terrain";
import type { DemGrid, PositionInput } from "../src/sense/position/types";
import { parseUkraineDemGz } from "../src/sense/position/ukraineDem";

const OPP_LAT = 55 + 45 / 111.32;

function blocked(freqMhz: number, cellM: number | null = null): PositionInput {
  return {
    ourLat: 55,
    ourLon: 37,
    ourGroundM: 235,
    ourAglM: 0,
    oppLat: OPP_LAT,
    oppLon: 37,
    oppGroundM: 202,
    oppAglM: 0,
    freqMhz,
    ourKind: "patch",
    ourDbi: 19,
    oppKind: "patch",
    oppDbi: 21,
    ourAimAzDeg: null,
    ourAimElDeg: null,
    oppAimAzDeg: null,
    oppAimElDeg: null,
    powerW: 1,
    thresholdDbm: -90,
    marks: [
      { km: 18, m: 210 },
      { km: 22.5, m: 220 },
      { km: 27, m: 210 },
    ],
    flatM: null,
    grid: null,
    cellM,
    clutter: false,
    rainMmH: null,
    terrainPending: false,
  };
}

test("вкладка позиции остаётся режимом SDR и не включает передатчик", () => {
  assert.equal(modeOf("position"), "sdr");
});

test("45 км, 2,4 ГГц, гребень 220 м: вся трасса, не только середина", () => {
  const r = computePosition(blocked(2400), false);
  assert.ok(r.distanceKm > 44.5 && r.distanceKm < 45.5, `distance ${r.distanceKm}`);
  assert.equal(r.verdict, "insufficient");
  assert.match(r.action, /ушёл их борт/);
  assert.ok(r.raiseGrazeM > 90 && r.raiseGrazeM < 120, `graze ${r.raiseGrazeM}`);
  assert.ok(r.raiseCleanM > 250 && r.raiseCleanM < 320, `clean ${r.raiseCleanM}`);
  const aimed = computePosition({ ...blocked(2400), oppAimAzDeg: 180, oppAimElDeg: 0 }, false);
  assert.notEqual(aimed.verdict, "insufficient");
  assert.doesNotMatch(aimed.action, /на 1[0-9]{2} м/);
});

test("те же точки на 100 МГц: холм не закрывает фразой «не увидите», запас больше", () => {
  const aim = { oppAimAzDeg: 180, oppAimElDeg: 0, ourAglM: 10, oppAglM: 10 };
  const low = computePosition({ ...blocked(100), ...aim }, false);
  const mid = computePosition({ ...blocked(2400), ...aim }, false);
  assert.notEqual(low.verdict, "closed");
  assert.match(low.action, /Поймаете/);
  assert.doesNotMatch(`${low.phrase} ${low.action}`, /не увидите/);
  assert.ok((low.marginDb ?? 0) > (mid.marginDb ?? 0) + 20, `${low.marginDb} vs ${mid.marginDb}`);
});

test("22 ГГц и клетка 30 м: мало данных, RX1 эту частоту не принимает, газ есть", () => {
  const r = computePosition(blocked(22000, 30), false);
  assert.equal(r.verdict, "insufficient");
  assert.match(r.action, /полосы луча/);
  assert.match(r.rx1 ?? "", /не берёт/);
  assert.ok(r.gasDb > 5, `gas ${r.gasDb}`);
  const midFresnel = fresnelRadiusM(22.5, 22.5, 22000);
  assert.ok(midFresnel < 30);
});

test("узкий луч с высоты смотрит мимо, мачту не предлагает", () => {
  const r = computePosition({
    ...blocked(2400),
    ourLat: 55,
    ourLon: 37,
    ourGroundM: 1000,
    ourAglM: 2,
    oppLat: 55 + 2 / 111.32,
    oppLon: 37,
    oppGroundM: 0,
    oppAglM: 2,
    marks: [],
    flatM: 0,
    ourKind: "dish",
    ourDbi: 19,
    oppAimAzDeg: 180,
    oppAimElDeg: 0,
    terrainPending: false,
  }, false);
  assert.equal(r.verdict, "open");
  assert.match(r.action, /Луч смотрит мимо/);
  assert.doesNotMatch(r.action, /Поднимите/);
});

test("штырь не просит доворот", () => {
  const r = computePosition({
    ...blocked(145),
    ourKind: "whip",
    ourDbi: 2,
    oppKind: "whip",
    oppDbi: 2,
    ourGroundM: 200,
    oppGroundM: 200,
    oppLat: 55 + 3 / 111.32,
    marks: [],
    flatM: 180,
  }, false);
  assert.equal(r.verdict, "open");
  assert.match(r.aim, /Крутить не нужно/);
  assert.match(r.action, /Поймаете/);
});

test("без земли по пути ответа нет", () => {
  const r = computePosition({ ...blocked(2400), marks: [], flatM: null }, false);
  assert.equal(r.verdict, "insufficient");
});

test("дифракция и газ на краях диапазона", () => {
  assert.ok(knifeEdgeDb(30, 20000, 25000, 2400) > knifeEdgeDb(30, 20000, 25000, 100));
  assert.equal(gasDbPerKm(2400), 0);
  assert.ok(gasDbPerKm(22000) > 0.15);
  // ITU-R P.838-3, таблица 5, 10 ГГц, горизонтально: k = 0,01217, α = 1,2571.
  const at10 = rainDbPerKm(10000, 25);
  const table = 0.01217 * 25 ** 1.2571;
  assert.ok(Math.abs(at10 - table) / table < 0.02, `rain ${at10} vs ${table}`);
  assert.equal(rainDbPerKm(2400, 25), 0);
});

test("JSON решётки читается офлайн и даёт высоту", () => {
  const grid = parseDemJson(JSON.stringify({
    lat0: 55,
    lon0: 37,
    nlat: 2,
    nlon: 2,
    dlat: 0.01,
    dlon: 0.01,
    heights: [100, 110, 120, 130],
  }));
  assert.ok(grid);
  assert.ok(Math.abs((sampleDem(grid as DemGrid, 55, 37) ?? 0) - 100) < 0.01);
  assert.equal(parseSrtmHgt(new ArrayBuffer(8), 55, 37), null);
  assert.deepEqual(swCornerFromHgtName("N55E037.hgt"), { lat: 55, lon: 37 });
  assert.deepEqual(swCornerFromHgtName("S12W077"), { lat: -12, lon: -77 });
});

test("квадрат предлагает складку, не вершину", () => {
  const nlat = 9;
  const nlon = 9;
  const dlat = 0.03;
  const heights = new Float64Array(nlat * nlon);
  for (let iy = 0; iy < nlat; iy++) {
    for (let ix = 0; ix < nlon; ix++) {
      const ridge = iy >= 3 && iy <= 5;
      heights[iy * nlon + ix] = ridge ? 900 : iy >= 6 ? 250 : 80;
    }
  }
  const grid: DemGrid = { lat0: 0, lon0: 0, nlat, nlon, dlat, dlon: 0.03, cellM: 3000, heights };
  const r = computePosition({
    ourLat: 0.03,
    ourLon: 0.12,
    ourGroundM: 0,
    ourAglM: 2,
    oppLat: 0.21,
    oppLon: 0.12,
    oppGroundM: 0,
    oppAglM: 2,
    freqMhz: 2400,
    ourKind: "patch",
    ourDbi: 19,
    oppKind: "patch",
    oppDbi: 21,
    powerW: 1,
    thresholdDbm: -90,
    marks: [],
    flatM: null,
    grid,
    cellM: null,
    clutter: false,
    rainMmH: null,
    ourAimAzDeg: null,
    ourAimElDeg: null,
    oppAimAzDeg: 0,
    oppAimElDeg: 0,
    terrainPending: false,
  }, false);
  assert.equal(r.verdict, "closed");
  assert.equal(r.move, null);
  const spot = {
    ourLat: 0.03,
    ourLon: 0.12,
    ourGroundM: 80,
    ourAglM: 2,
    oppLat: 0.21,
    oppLon: 0.12,
    oppGroundM: 250,
    oppAglM: 2,
    freqMhz: 2400,
    ourKind: "patch" as const,
    ourDbi: 19,
    oppKind: "patch" as const,
    oppDbi: 21,
    powerW: 1,
    thresholdDbm: -90,
    marks: [],
    flatM: null,
    grid,
    cellM: null,
    clutter: false,
    rainMmH: null,
    ourAimAzDeg: null,
    ourAimElDeg: null,
    oppAimAzDeg: 0,
    oppAimElDeg: 0,
    terrainPending: false,
  };
  const found = searchSquare(spot, { south: 0, north: 0.24, west: 0, east: 0.24 });
  assert.ok(found.picks.length > 0, found.note);
  assert.ok(found.picks.every((p) => p.groundM < 500), `crest ${found.picks.map((p) => p.groundM).join(",")}`);
  const flatHeights = new Float64Array(nlat * nlon).fill(100);
  const flat: DemGrid = { ...grid, heights: flatHeights };
  const plain = searchSquare({ ...spot, ourGroundM: 100, oppGroundM: 100, grid: flat }, { south: 0, north: 0.24, west: 0, east: 0.24 });
  assert.equal(plain.picks.length, 0);
  assert.match(plain.note, /складки нет/);
});

test("градусы WGS84 сходятся с известной геодезической задачей", () => {
  const lat1 = -(37 + 57 / 60 + 3.7203 / 3600);
  const lon1 = 144 + 25 / 60 + 29.5244 / 3600;
  const lat2 = -(37 + 39 / 60 + 10.1561 / 3600);
  const lon2 = 143 + 55 / 60 + 35.3839 / 3600;
  const dist = distanceKm(lat1, lon1, lat2, lon2);
  assert.ok(Math.abs(dist - 54.972271) < 0.000002, `distance ${dist}`);
  const az = (azimuthDeg(lat1, lon1, lat2, lon2) + 360) % 360;
  assert.ok(Math.abs(az - 306.868158) < 1e-5, `azimuth ${az}`);
  const back = destination(50.45, 30.5234, 90, 10);
  assert.ok(Math.abs(distanceKm(50.45, 30.5234, back.lat, back.lon) - 10) < 0.001);
  assert.equal(formatDeg(50.45), "50.450000°");
});

test("патч сразу за лучом теряет около 8 дБ, пустая сторона борта не берёт пик", () => {
  const side = sideGainDb("patch", 21);
  assert.ok(Math.abs(side - 13) < 0.2, `side ${side}`);
  assert.equal(sideGainDb("whip", 2), 2);
  assert.ok(Math.abs(sideGainDb("dish", 30) - 10) < 0.5, `dish ${sideGainDb("dish", 30)}`);
  const blind = computePosition(blocked(2400), false);
  assert.match(blind.action, /ушёл их борт/);
  assert.equal(blind.marginDb, null);
});

test("рельеф Украины в файле и покрывает крайние точки", async () => {
  const buf = readFileSync(new URL("../src/sense/position/data/ukraine-dem.bin.gz", import.meta.url));
  const grid = await parseUkraineDemGz(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert.equal(grid.lat0, 44);
  assert.equal(grid.lon0, 22);
  const lat1 = grid.lat0 + (grid.nlat - 1) * grid.dlat;
  const lon1 = grid.lon0 + (grid.nlon - 1) * grid.dlon;
  assert.ok(Math.abs(lat1 - 52.5) < 1e-6, `lat1 ${lat1}`);
  assert.ok(Math.abs(lon1 - 40.5) < 1e-6, `lon1 ${lon1}`);
  const hoverla = sampleDem(grid, 48.1603, 24.5) ?? -1;
  const kyiv = sampleDem(grid, 50.4501, 30.5234) ?? -1;
  const south = sampleDem(grid, 44.4, 33.7) ?? -1;
  const east = sampleDem(grid, 49, 40) ?? -1;
  const west = sampleDem(grid, 48.1, 22.3) ?? -1;
  const north = sampleDem(grid, 52.2, 33.3) ?? -1;
  assert.ok(hoverla > 1400, `hoverla ${hoverla}`);
  assert.ok(kyiv > 80 && kyiv < 250, `kyiv ${kyiv}`);
  assert.ok(south > -200 && south < 400, `south ${south}`);
  assert.ok(east > 0, `east ${east}`);
  assert.ok(west > 0, `west ${west}`);
  assert.ok(north > 0, `north ${north}`);
  assert.equal(sampleDem(grid, 55, 37), null);
  const path = computePosition({
    ...blocked(145),
    ourLat: 50.4501,
    ourLon: 30.5234,
    oppLat: 50.5,
    oppLon: 30.5234,
    marks: [],
    flatM: null,
    grid,
    ourKind: "whip",
    ourDbi: 2,
    oppKind: "whip",
    oppDbi: 2,
  }, false);
  assert.notEqual(path.verdict, "insufficient");
  assert.ok(path.profile.length > 100);
  assert.ok(path.profile[0].terrainM > 80 && path.profile[0].terrainM < 250);

  const outside = computePosition({
    ...blocked(145),
    ourLat: 50.4501,
    ourLon: 30.5234,
    ourGroundM: Number.NaN,
    oppLat: 55,
    oppLon: 37,
    oppAimAzDeg: 180,
    oppAimElDeg: 0,
    oppGroundM: 140,
    marks: [],
    flatM: 150,
    grid,
  }, false);
  assert.notEqual(outside.verdict, "insufficient", outside.action);
  assert.ok(Math.abs(outside.profile[0].terrainM - kyiv) < 0.01, `our ${outside.profile[0].terrainM}`);
  assert.equal(outside.profile.at(-1)?.terrainM, 140);
});

test("два холма, которые берёт мачта, не называются непроходимыми", () => {
  const two = computePosition({
    ...blocked(2400),
    oppAimAzDeg: 180,
    oppAimElDeg: 0,
    marks: [
      { km: 12, m: 260 },
      { km: 15, m: 280 },
      { km: 18, m: 80 },
      { km: 27, m: 80 },
      { km: 30, m: 280 },
      { km: 33, m: 260 },
    ],
  }, false);
  assert.notEqual(two.verdict, "closed", `${two.phrase} ${two.action}`);
  assert.match(two.action, /Поймаете/);
  assert.ok(two.raiseNormM > 0, `norm ${two.raiseNormM}`);
  const hopeless = computePosition({
    ...blocked(2400),
    oppAimAzDeg: 180,
    oppAimElDeg: 0,
    marks: [
      { km: 15, m: 900 },
      { km: 22, m: 80 },
      { km: 30, m: 900 },
    ],
  }, false);
  assert.equal(hopeless.verdict, "closed");
  assert.match(hopeless.phrase, /Холмов несколько/);
});

test("пустая клетка не отменяет вписанную отметку", () => {
  const grid: DemGrid = {
    lat0: 50,
    lon0: 30,
    nlat: 2,
    nlon: 2,
    dlat: 0.5,
    dlon: 0.5,
    cellM: 1000,
    heights: new Float64Array([Number.NaN, 100, 100, 100]),
  };
  const refused = computePosition({
    ...blocked(145),
    ourLat: 50,
    ourLon: 30,
    ourGroundM: Number.NaN,
    oppLat: 50,
    oppLon: 30.5,
    oppGroundM: 100,
    marks: [],
    flatM: 90,
    grid,
  }, false);
  assert.match(refused.action, /пустой/);
  const typed = computePosition({
    ...blocked(145),
    ourLat: 50,
    ourLon: 30,
    oppAimAzDeg: 270,
    oppAimElDeg: 0,
    ourGroundM: 80,
    oppLat: 50,
    oppLon: 30.5,
    oppGroundM: 999,
    marks: [],
    flatM: 90,
    grid,
  }, false);
  assert.notEqual(typed.verdict, "insufficient", typed.action);
  assert.equal(typed.profile[0].terrainM, 80);
  assert.equal(typed.profile.at(-1)?.terrainM, 100);
});

test("30 км в лоб слышно без мачты, на 45 км подъём около 14 м", () => {
  const opp = destination(50, 30, 0, 30);
  const face = {
    ...blocked(2400),
    ourLat: 50,
    ourLon: 30,
    ourGroundM: 200,
    ourAglM: 10,
    oppLat: opp.lat,
    oppLon: opp.lon,
    oppGroundM: 200,
    oppAglM: 10,
    ourKind: "patch" as const,
    ourDbi: 19,
    oppKind: "patch" as const,
    oppDbi: 22,
    oppAimAzDeg: 180,
    oppAimElDeg: 0,
    powerW: 10,
    thresholdDbm: -90,
    marks: [],
    flatM: 200,
  };
  const near = computePosition(face, false);
  assert.equal(near.verdict, "open", `${near.phrase} ${near.action} ${near.marginDb}`);
  assert.match(near.action, /Поймаете/);
  assert.doesNotMatch(near.action, /Поднимите/);
  assert.ok((near.marginDb ?? 0) > 14 && (near.marginDb ?? 0) < 20, `margin ${near.marginDb}`);
  assert.match(near.aim, /наклон 0\.0/);
  const farOpp = destination(50, 30, 0, 45);
  const far = computePosition({ ...face, oppLat: farOpp.lat, oppLon: farOpp.lon }, false);
  assert.equal(far.verdict, "ridge", `${far.phrase} ${far.action} ${far.marginDb}`);
  assert.match(far.action, /ещё на 1[2-6]/);
  const loss = smoothEarthDb(40, 10, 10, 2400);
  assert.ok(loss > 30 && loss < 45, `smooth ${loss}`);
  assert.ok(smoothEarthDb(10, 10, 10, 2400) < 6);
});
