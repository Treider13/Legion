// Трасса до антенны противника. Нормы P.530-19 и P.526, газ по порядку P.676.
// Сеть не нужна: рельеф — отметки, ровная земля или файл на диске.

import { gas676DbPerKm } from "./gas676";
import { angleOffDeg, azimuthDeg, destination, distanceKm, earthBulgeM } from "./geo";
import { buildingAt, vegetationDb, woodAt } from "./pathCover";
import { patternGainDb } from "./pattern";
import { sampleTiles } from "./srtm";
import { inBounds, sampleDem } from "./terrain";
import type {
  AntennaKind,
  DemGrid,
  MapCell,
  PositionInput,
  PositionResult,
  ProfileSample,
  SearchBox,
  SitePick,
  SquareSearch,
  VerdictKind,
} from "./types";

const SAMPLES = 201;
const RX1_MAX_MHZ = 6000;
const FREQ_MIN = 100;
const FREQ_MAX = 22000;

interface Ends {
  distanceKm: number;
  azimuthDeg: number;
  h1: number;
  h2: number;
  ourGround: number;
  oppGround: number;
}

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function whip(kind: AntennaKind): boolean {
  return kind === "whip";
}

export function fresnelRadiusM(d1Km: number, d2Km: number, freqMhz: number): number {
  const total = d1Km + d2Km;
  if (total <= 0 || freqMhz <= 0) return 0;
  return 17.3 * Math.sqrt((d1Km * d2Km) / ((freqMhz / 1000) * total));
}

export function fsplDb(freqMhz: number, distKm: number): number {
  return 32.44 + 20 * Math.log10(freqMhz) + 20 * Math.log10(distKm);
}

/** Оценка ширины луча по усилению, градусы. Для штыря не используется. */
export function beamwidthDeg(dbi: number): number {
  const linear = 10 ** (dbi / 10);
  return Math.sqrt(31000 / linear);
}

/**
 * Усиление под углом offDeg от оси.
 * До края луча — парабола, на краю ровно −3 дБ.
 * Сразу за лучом патч теряет около 8 дБ, дальше около 13.
 * Тарелка сбоку около 20 дБ, сзади около 34. Волновой канал сбоку около 15.
 */
export function gainTowardDb(kind: AntennaKind, peakDbi: number, offDeg: number): number {
  if (kind === "whip" || !(peakDbi >= 5) || !Number.isFinite(offDeg)) return peakDbi;
  const off = Math.abs(offDeg);
  const half = beamwidthDeg(peakDbi) / 2;
  if (!(half > 0)) return peakDbi;
  if (off <= half) return peakDbi - 3 * (off / half) ** 2;
  if (kind === "dish") return peakDbi - (off <= half * 4 ? 20 : 34);
  if (kind === "yagi") return peakDbi - 15;
  return peakDbi - (off <= half * 2 ? 8 : 13);
}

/** Боковой лепесток: сразу за краем главного луча. */
export function sideGainDb(kind: AntennaKind, peakDbi: number): number {
  const half = beamwidthDeg(peakDbi) / 2;
  return gainTowardDb(kind, peakDbi, half + 0.01);
}

/** Поглощение газа, дБ/км. Ниже 10 ГГц ноль. Пик водяного пара около 22 ГГц — порядка 0,2 дБ/км. */
export function gasDbPerKm(freqMhz: number): number {
  return gas676DbPerKm(freqMhz);
}

// ITU-R P.838-3, горизонтальная поляризация. Дождь в сухой ответ не входит.
const KH = {
  a: [-5.3398, -0.35351, -0.23789, -0.94158],
  b: [-0.10008, 1.2697, 0.86036, 0.64552],
  c: [1.13098, 0.454, 0.15354, 0.16817],
  m: -0.18961,
  c0: 0.71147,
};
const AH = {
  a: [-0.14318, 0.29591, 0.32177, -5.3761, 16.1721],
  b: [1.82442, 0.77564, 0.63773, -0.9623, -3.2998],
  c: [-0.55187, 0.19822, 0.13164, 1.47828, 3.4399],
  m: 0.67849,
  c0: -1.95537,
};

function p838Fit(fGHz: number, row: { a: number[]; b: number[]; c: number[]; m: number; c0: number }): number {
  const logf = Math.log10(fGHz);
  let sum = row.m * logf + row.c0;
  for (let j = 0; j < row.a.length; j++) {
    const t = (logf - row.b[j]) / row.c[j];
    sum += row.a[j] * Math.exp(-(t * t));
  }
  return sum;
}

export function rainDbPerKm(freqMhz: number, mmPerH: number): number {
  const f = freqMhz / 1000;
  if (f < 5 || mmPerH <= 0 || f > 1000) return 0;
  const k = 10 ** p838Fit(f, KH);
  const alpha = p838Fit(f, AH);
  return k * mmPerH ** alpha;
}

/** Потеря одного острого гребня, ITU-R P.526, дБ. hM — высота земли над лучом. */
export function knifeEdgeDb(hM: number, d1M: number, d2M: number, freqMhz: number): number {
  if (hM <= 0 || d1M <= 0 || d2M <= 0 || freqMhz <= 0) return 0;
  const lambda = 300 / freqMhz;
  const v = hM * Math.sqrt((2 / lambda) * (1 / d1M + 1 / d2M));
  return knifeJ(v);
}

const EARTH_M = 6371000;
const AE_M = EARTH_M * 4 / 3;
const AE_KM = AE_M / 1000;

function p526Field(dKm: number, h1: number, h2: number, freqMhz: number, aeKm: number): number {
  const f13 = freqMhz ** (1 / 3);
  const f23 = freqMhz ** (2 / 3);
  const x = 2.188 * f13 * aeKm ** (-2 / 3) * dKm;
  const g = (h: number) => {
    const y = 9.575e-3 * f23 * aeKm ** (-1 / 3) * Math.max(h, 0.5);
    if (y > 2) return 17.6 * Math.sqrt(y - 1.1) - 5 * Math.log10(y - 1.1) - 8;
    return 20 * Math.log10(Math.max(y + 0.1 * y ** 3, 1e-12));
  };
  const f = x >= 1.6
    ? 11 + 10 * Math.log10(Math.max(x, 1e-6)) - 17.6 * x
    : -20 * Math.log10(Math.max(x, 1e-6)) - 5.6488 * x ** 1.425;
  return f + g(h1) + g(h2);
}

/** J(ν) по P.526. Ниже −0,78 формула не применяется, потеря ноль. */
function knifeJ(v: number): number {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Точка наименьшего просвета луча над выпуклостью земли. d1 — от нашей антенны, км. */
function minClearance(distKm: number, h1: number, h2: number): { clearance: number; d1: number } {
  let x = (distKm - (16.989 * (h2 - h1)) / distKm) / 2;
  if (x < 0) x = 0;
  if (x > distKm) x = distKm;
  const f = x / distKm;
  return { clearance: h1 * (1 - f) + h2 * f - earthBulgeM(x, distKm - x), d1: x };
}

/**
 * Гладкая земля, ITU-R P.526 §3.2, уравнение (25).
 * Высоты — над гладкой поверхностью, метры. Ноль потери только при просвете 0,552 первой зоны.
 * Ниже 0,5 м ряд вычетов уходит в бесконечность, поэтому высота не ниже полуметра.
 */
export function smoothEarthDb(distKm: number, h1M: number, h2M: number, freqMhz: number): number {
  if (distKm <= 0 || freqMhz <= 0) return 0;
  const h1 = Math.max(h1M, 0.5);
  const h2 = Math.max(h2M, 0.5);
  const dlos = (Math.sqrt(2 * AE_M * h1) + Math.sqrt(2 * AE_M * h2)) / 1000;
  const spot = minClearance(distKm, h1, h2);
  if (distKm >= dlos || spot.clearance <= 0) return Math.max(0, -p526Field(distKm, h1, h2, freqMhz, AE_KM));
  const need = 0.552 * fresnelRadiusM(spot.d1, distKm - spot.d1, freqMhz);
  if (!(need > 0) || spot.clearance >= need) return 0;
  const aem = AE_KM * (distKm / dlos) ** 2;
  const atFit = Math.max(0, -p526Field(distKm, h1, h2, freqMhz, aem));
  return (1 - spot.clearance / need) * atFit;
}

function bullingtonFromV(v: number): number {
  const luc = knifeJ(v);
  return luc + (1 - Math.exp(-luc / 6));
}

/** Потеря Буллингтона, ITU-R P.526 §4.5.1. heights — земля над уровнем моря, hts/hrs — антенны. */
function bullingtonLb(distKm: number, heights: number[], hts: number, hrs: number, freqMhz: number): number {
  const n = heights.length;
  if (n < 3 || distKm <= 0 || freqMhz <= 0) return 0;
  const lambda = 300 / freqMhz;
  const last = n - 1;
  const vAt = (obstruction: number, d1: number): number => {
    const d2 = distKm - d1;
    if (!(d1 > 0) || !(d2 > 0)) return Number.NEGATIVE_INFINITY;
    return obstruction * Math.sqrt((0.002 * distKm) / (lambda * d1 * d2));
  };
  let stim = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < last; i++) {
    const di = (distKm * i) / last;
    const slope = (heights[i] + earthBulgeM(di, distKm - di) - hts) / di;
    if (slope > stim) stim = slope;
  }
  if (!Number.isFinite(stim)) return 0;
  const str = (hrs - hts) / distKm;
  let v = Number.NEGATIVE_INFINITY;
  if (stim < str) {
    for (let i = 1; i < last; i++) {
      const di = (distKm * i) / last;
      const chord = (hts * (distKm - di) + hrs * di) / distKm;
      const next = vAt(heights[i] + earthBulgeM(di, distKm - di) - chord, di);
      if (next > v) v = next;
    }
  } else {
    let srim = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < last; i++) {
      const di = (distKm * i) / last;
      const slope = (heights[i] + earthBulgeM(di, distKm - di) - hrs) / (distKm - di);
      if (slope > srim) srim = slope;
    }
    const denom = stim + srim;
    const db = denom > 0 ? (hrs - hts + srim * distKm) / denom : Number.NaN;
    if (db > 0 && db < distKm) {
      const chord = (hts * (distKm - db) + hrs * db) / distKm;
      v = vAt(hts + stim * db - chord, db);
    } else {
      for (let i = 1; i < last; i++) {
        const di = (distKm * i) / last;
        const chord = (hts * (distKm - di) + hrs * di) / distKm;
        const next = vAt(heights[i] + earthBulgeM(di, distKm - di) - chord, di);
        if (next > v) v = next;
      }
    }
  }
  if (!Number.isFinite(v)) return 0;
  return bullingtonFromV(v);
}

/** Высоты антенн над гладкой поверхностью, подогнанной к профилю. P.526 §4.5.2, (58)–(64). */
function heightsAboveSmooth(distKm: number, heights: number[], hts: number, hrs: number): { h1: number; h2: number } {
  const last = heights.length - 1;
  let v1 = 0;
  let v2 = 0;
  for (let i = 1; i <= last; i++) {
    const di = (distKm * i) / last;
    const prev = (distKm * (i - 1)) / last;
    const hi = heights[i];
    const hp = heights[i - 1];
    const step = di - prev;
    v1 += step * (hi + hp);
    v2 += step * (hi * (2 * di + prev) + hp * (di + 2 * prev));
  }
  const d2 = distKm * distKm;
  let hst = (2 * distKm * v1 - v2) / d2;
  let hsr = (v2 - distKm * v1) / d2;
  let hobs = Number.NEGATIVE_INFINITY;
  let ahead = Number.NEGATIVE_INFINITY;
  let behind = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < last; i++) {
    const di = (distKm * i) / last;
    const rise = heights[i] - (hts * (distKm - di) + hrs * di) / distKm;
    if (rise > hobs) hobs = rise;
    const toTx = rise / di;
    const toRx = rise / (distKm - di);
    if (toTx > ahead) ahead = toTx;
    if (toRx > behind) behind = toRx;
  }
  if (hobs > 0 && ahead + behind > 0) {
    hst -= hobs * (ahead / (ahead + behind));
    hsr -= hobs * (behind / (ahead + behind));
  }
  if (hst > heights[0]) hst = heights[0];
  if (hsr > heights[last]) hsr = heights[last];
  return { h1: Math.max(0, hts - hst), h2: Math.max(0, hrs - hsr) };
}

/**
 * Дифракция всей трассы, ITU-R P.526 §4.5.2, уравнение (66):
 * L = max(Lba + Lsph − Lbs, 0). Ровная земля даёт ровно гладкую сферу.
 * Холм увеличивает Lba и поэтому всю потерю. Долина может её уменьшить.
 */
function pathDiffractionDb(heights: number[], distKm: number, hts: number, hrs: number, freqMhz: number): number {
  const groundTx = heights[0] ?? 0;
  const groundRx = heights[heights.length - 1] ?? 0;
  if (heights.length < 3 || distKm <= 0) return smoothEarthDb(distKm, hts - groundTx, hrs - groundRx, freqMhz);
  const actual = bullingtonLb(distKm, heights, hts, hrs, freqMhz);
  const above = heightsAboveSmooth(distKm, heights, hts, hrs);
  const smooth = bullingtonLb(distKm, heights.map(() => 0), above.h1, above.h2, freqMhz);
  const sphere = smoothEarthDb(distKm, above.h1, above.h2, freqMhz);
  return Math.max(0, actual + sphere - smooth);
}

function normFraction(freqMhz: number, extended: boolean): number {
  if (freqMhz < 2000) return extended ? 0.15 : 0;
  return extended ? 0.3 : 0;
}

function empty(phrase: string, action: string): PositionResult {
  return {
    verdict: "insufficient",
    phrase,
    action,
    side: null,
    rx1: null,
    distanceKm: 0,
    azimuthDeg: 0,
    elevationDeg: 0,
    beamwidthDeg: null,
    marginDb: null,
    fsplDb: 0,
    diffractionDb: 0,
    gasDb: 0,
    vegetationDb: 0,
    buildingsOnPath: 0,
    buildingsAssumed: 0,
    aim: "",
    rainDb: null,
    raiseGrazeM: 0,
    raiseCleanM: 0,
    raiseNormM: 0,
    profile: [],
    move: null,
    map: null,
  };
}

function gridCovers(grid: DemGrid | null, lat: number, lon: number): grid is DemGrid {
  return grid != null && inBounds(grid, lat, lon);
}

function pickedGround(sample: number | null, typed: number): number | null {
  if (sample != null) return sample;
  return finite(typed) ? typed : null;
}

function heightOf(input: PositionInput, grid: DemGrid | null, lat: number, lon: number): number | null {
  const fine = sampleTiles(input.tiles, lat, lon);
  if (fine != null) return fine;
  if (grid && gridCovers(grid, lat, lon)) return sampleDem(grid, lat, lon);
  return null;
}

function grounds(input: PositionInput, grid: DemGrid | null): { our: number; opp: number; missing: string | null; useGrid: boolean } {
  const ourIn = gridCovers(grid, input.ourLat, input.ourLon);
  const oppIn = gridCovers(grid, input.oppLat, input.oppLon);
  const ourSample = heightOf(input, grid, input.ourLat, input.ourLon);
  const oppSample = heightOf(input, grid, input.oppLat, input.oppLon);
  const our = pickedGround(ourSample, input.ourGroundM);
  const opp = pickedGround(oppSample, input.oppGroundM);
  if (our == null || opp == null) {
    const emptyCell = (ourIn && ourSample == null && !finite(input.ourGroundM)) || (oppIn && oppSample == null && !finite(input.oppGroundM));
    const missing = emptyCell
      ? "В этих градусах рельеф пустой."
      : "Нужны отметки земли под нашей антенной и под станцией противника.";
    return { our: 0, opp: 0, missing, useGrid: false };
  }
  // Сетка ведёт весь путь только когда обе земли с неё читаются. Иначе отметки и ровная земля.
  return { our, opp, missing: null, useGrid: ourSample != null && oppSample != null };
}

function hasTerrain(input: PositionInput, grid: DemGrid | null): boolean {
  if (input.tiles && input.tiles.length > 0) return true;
  if (grid) return true;
  if (input.flatM != null && finite(input.flatM)) return true;
  return input.marks.some((m) => m.km > 0);
}

function terrainM(input: PositionInput, grid: DemGrid | null, km: number, dist: number, ourGround: number, oppGround: number, lat: number, lon: number): number | null {
  const fine = sampleTiles(input.tiles, lat, lon);
  if (fine != null) {
    if (km <= 0) return ourGround;
    if (km >= dist) return oppGround;
    return fine;
  }
  if (grid && gridCovers(grid, lat, lon)) {
    if (km <= 0) return ourGround;
    if (km >= dist) return oppGround;
    return sampleDem(grid, lat, lon);
  }
  if (km <= 0) return ourGround;
  if (km >= dist) return oppGround;
  const inner = input.marks.filter((p) => p.km > 0 && p.km < dist);
  if (inner.length > 0) {
    let prev = { km: 0, m: ourGround };
    let next = { km: dist, m: oppGround };
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
  if (input.flatM != null && finite(input.flatM)) return input.flatM;
  return null;
}

function buildProfile(input: PositionInput, grid: DemGrid | null, ends: Ends, extraOurM: number): ProfileSample[] | null {
  const out: ProfileSample[] = [];
  const h1 = ends.h1 + extraOurM;
  for (let i = 0; i < SAMPLES; i++) {
    const f = i / (SAMPLES - 1);
    const km = ends.distanceKm * f;
    const pos = destination(input.ourLat, input.ourLon, ends.azimuthDeg, km);
    const ground = terrainM(input, grid, km, ends.distanceKm, ends.ourGround, ends.oppGround, pos.lat, pos.lon);
    if (ground == null) return null;
    const d1 = km;
    const d2 = ends.distanceKm - km;
    const ray = h1 * (1 - f) + ends.h2 * f - earthBulgeM(d1, d2);
    const fresnel = fresnelRadiusM(d1, d2, input.freqMhz);
    out.push({ km, terrainM: ground, rayM: ray, fresnelM: fresnel, clearanceM: ray - ground });
  }
  return out;
}

function applyCover(input: PositionInput, profile: ProfileSample[], ends: Ends): { vegetationDb: number; buildingsOnPath: number; buildingsAssumed: number } {
  const buildings = input.buildings ?? [];
  const woods = input.woods ?? [];
  const seen = new Set<NonNullable<PositionInput["buildings"]>[number]>();
  let buildingsOnPath = 0;
  let buildingsAssumed = 0;
  let forestM = 0;
  const stepM = (ends.distanceKm * 1000) / Math.max(1, profile.length - 1);
  for (let i = 0; i < profile.length; i++) {
    const sample = profile[i];
    const along = ends.distanceKm <= 0 ? 0 : sample.km / ends.distanceKm;
    const pos = destination(input.ourLat, input.ourLon, ends.azimuthDeg, sample.km);
    if (along > 0.02 && along < 0.98 && buildings.length > 0) {
      const hit = buildingAt(pos.lon, pos.lat, buildings);
      if (hit) {
        sample.terrainM += hit.heightM;
        sample.clearanceM = sample.rayM - sample.terrainM;
        if (!seen.has(hit)) {
          seen.add(hit);
          buildingsOnPath += 1;
          if (hit.assumed) buildingsAssumed += 1;
        }
      }
    }
    if (i > 0 && woods.length > 0 && woodAt(pos.lon, pos.lat, woods)) forestM += stepM;
  }
  return { vegetationDb: vegetationDb(input.freqMhz, forestM), buildingsOnPath, buildingsAssumed };
}

function raiseFor(profile: ProfileSample[], ends: Ends, needM: (s: ProfileSample) => number): number {
  let extra = 0;
  for (const s of profile) {
    const f = ends.distanceKm <= 0 ? 0 : s.km / ends.distanceKm;
    if (f <= 0.05 || f >= 0.95) continue;
    const bulge = ends.h1 * (1 - f) + ends.h2 * f - s.rayM;
    const need = s.terrainM + needM(s);
    const delta = (need - ends.h1 * (1 - f) - ends.h2 * f + bulge) / (1 - f);
    if (delta > extra) extra = delta;
  }
  return Math.max(0, extra);
}

interface Segment {
  from: number;
  to: number;
  extended: boolean;
  intrusionM: number;
  worst: ProfileSample;
}

function segments(profile: ProfileSample[], freqMhz: number, distKm: number): Segment[] {
  const fail: boolean[] = profile.map((s) => {
    const f = distKm <= 0 ? 0 : s.km / distKm;
    if (f <= 0.05 || f >= 0.95) return false;
    return s.clearanceM < 0;
  });
  // Ширина связного куска, где земля выше луча, решает: гребень или склон.
  const found: Segment[] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const slice = profile.slice(start, end + 1);
    const widthKm = profile[end].km - profile[start].km;
    let worst = slice[0];
    for (const s of slice) if (s.terrainM - s.rayM > worst.terrainM - worst.rayM) worst = s;
    found.push({
      from: start,
      to: end,
      extended: widthKm > distKm * 0.15,
      intrusionM: Math.max(0, worst.terrainM - worst.rayM),
      worst,
    });
    start = -1;
  };
  for (let i = 0; i < fail.length; i++) {
    if (fail[i] && start < 0) start = i;
    if (!fail[i] && start >= 0) flush(i - 1);
  }
  if (start >= 0) flush(fail.length - 1);
  // Норма просвета шире, чем просто земля выше луча: длинный склон режется и при положительном просвете.
  if (found.length === 0) {
    const soft = profile.some((s) => {
      const f = distKm <= 0 ? 0 : s.km / distKm;
      if (f <= 0.05 || f >= 0.95) return false;
      return s.clearanceM < normFraction(freqMhz, true) * s.fresnelM;
    });
    if (soft) {
      found.push({
        from: 1,
        to: profile.length - 2,
        extended: true,
        intrusionM: 0,
        worst: profile[Math.floor(profile.length / 2)],
      });
    }
  }
  return found;
}

function showEl(elevation: number): string {
  return (Math.abs(elevation) < 0.3 ? 0 : elevation).toFixed(1);
}

function pathElevationDeg(h1: number, h2: number, distKm: number): number {
  const geometric = (Math.atan2(h2 - h1, distKm * 1000) * 180) / Math.PI;
  const dip = ((distKm * 1000) / (2 * AE_M)) * (180 / Math.PI);
  return geometric - dip;
}

function aimAction(input: PositionInput, azimuth: number, elevation: number, beam: number | null): { text: string; miss: boolean } {
  if (whip(input.ourKind) || input.ourDbi < 5 || beam == null) {
    return { text: "Крутить не нужно.", miss: false };
  }
  const aim = `Поверните нашу антенну: азимут ${azimuth.toFixed(1)}°, наклон ${showEl(elevation)}°.`;
  const curAz = input.ourAimAzDeg == null ? azimuth : input.ourAimAzDeg;
  const curEl = input.ourAimElDeg ?? 0;
  const off = angleOffDeg(curAz, curEl, azimuth, elevation);
  if (off > beam / 2) return { text: `Луч смотрит мимо. ${aim}`, miss: true };
  if (input.ourDbi >= 15 && input.ourAimAzDeg == null) return { text: aim, miss: false };
  if (input.ourDbi >= 15 && off > 1) return { text: aim, miss: false };
  return { text: "Крутить не нужно.", miss: false };
}

function rx1Line(freqMhz: number, verdict: VerdictKind, margin: number | null): string | null {
  if (freqMhz > RX1_MAX_MHZ) return "Этот приёмник RX1 такую частоту не берёт.";
  if (verdict !== "open" && verdict !== "ridge") return null;
  if (margin == null) return null;
  if (margin > 0) return "На приёмнике RX1 поймаете.";
  return "На приёмнике RX1 сигнала не хватит.";
}

function marginDb(input: PositionInput, ourDb: number, oppDb: number, fspl: number, diffraction: number, gas: number, vegetation: number): number | null {
  if (input.powerW == null || input.thresholdDbm == null) return null;
  if (!(input.powerW > 0) || !finite(input.thresholdDbm)) return null;
  const powerDbm = 10 * Math.log10(input.powerW * 1000);
  return powerDbm + oppDb + ourDb - fspl - diffraction - gas - vegetation - input.thresholdDbm;
}

function oppNeedsAim(input: PositionInput): boolean {
  return !whip(input.oppKind) && input.oppDbi >= 5 && input.oppAimAzDeg == null && input.oppAimElDeg == null;
}

function antennaDb(kind: PositionInput["ourKind"], dbi: number, off: number, pattern: PositionInput["ourPattern"], daz: number, del: number): number {
  const directional = !whip(kind) && dbi >= 5;
  if (directional && pattern && (pattern.az.length > 0 || pattern.el.length > 0)) return patternGainDb(pattern, dbi, daz, del);
  return gainTowardDb(kind, dbi, off);
}

function linkGains(input: PositionInput, el: number, azimuth: number, ourOff: number): { ourDb: number; oppDb: number; side: string | null; aimed: boolean } {
  const ourAz = input.ourAimAzDeg ?? azimuth;
  const ourEl = input.ourAimElDeg ?? 0;
  const ourDb = antennaDb(input.ourKind, input.ourDbi, ourOff, input.ourPattern, azimuth - ourAz, el - ourEl);
  const round = whip(input.oppKind) || input.oppDbi < 5;
  if (round) {
    return { ourDb, oppDb: input.oppDbi, side: "Антенна противника почти круговая.", aimed: true };
  }
  if (oppNeedsAim(input)) {
    return { ourDb, oppDb: 0, side: null, aimed: false };
  }
  const toUsAz = (azimuthDeg(input.oppLat, input.oppLon, input.ourLat, input.ourLon) + 360) % 360;
  const oppAz = input.oppAimAzDeg ?? toUsAz;
  const oppEl = input.oppAimElDeg ?? 0;
  const off = angleOffDeg(oppAz, oppEl, toUsAz, -el);
  const half = beamwidthDeg(input.oppDbi) / 2;
  const oppDb = antennaDb(input.oppKind, input.oppDbi, off, input.oppPattern, toUsAz - oppAz, -el - oppEl);
  const toward = input.oppPattern ? oppDb >= input.oppDbi - 3 : off <= half;
  const side = toward
    ? "Антенна противника смотрит к нам."
    : "Антенна противника смотрит мимо нас. Сбоку сигнал слабее.";
  return { ourDb, oppDb, side, aimed: true };
}

function buildMap(input: PositionInput, grid: DemGrid): MapCell[] {
  const cells: MapCell[] = [];
  const bearings = 12;
  const stepKm = 5;
  const maxKm = 40;
  for (let b = 0; b < bearings; b++) {
    const az = (360 / bearings) * b;
    for (let km = stepKm; km <= maxKm; km += stepKm) {
      const pos = destination(input.ourLat, input.ourLon, az, km);
      const ground = sampleDem(grid, pos.lat, pos.lon);
      if (ground == null) continue;
      const trial: PositionInput = {
        ...input,
        oppLat: pos.lat,
        oppLon: pos.lon,
        oppGroundM: ground,
        grid,
        marks: [],
        flatM: null,
        buildings: null,
        woods: null,
      };
      const result = computePosition(trial, false);
      cells.push({ lat: pos.lat, lon: pos.lon, km, azimuthDeg: az, verdict: result.verdict });
    }
  }
  return cells;
}

export function computePosition(input: PositionInput, withAround = true): PositionResult {
  if (!finite(input.freqMhz) || input.freqMhz < FREQ_MIN || input.freqMhz > FREQ_MAX) {
    return empty("Мало данных.", "Частота нужна от 100 до 22000 МГц.");
  }
  if (![input.ourLat, input.ourLon, input.oppLat, input.oppLon, input.ourAglM, input.oppAglM, input.ourDbi, input.oppDbi].every(finite)) {
    return empty("Мало данных.", "Нужны обе точки, высоты антенн над землёй и оба усиления.");
  }
  if (input.ourAglM < 0 || input.oppAglM < 0) {
    return empty("Мало данных.", "Высота антенны над землёй не бывает ниже нуля.");
  }
  if (input.terrainPending && !input.grid && !hasTerrain(input, null)) {
    return empty("Мало данных.", "Рельеф Украины ещё читается.");
  }
  const grid = input.grid;
  const base = grounds(input, grid);
  if (base.missing) return empty("Мало данных.", base.missing);
  if (!base.useGrid && !hasTerrain(input, null)) {
    return empty("Мало данных.", "Нужна земля по пути: отметки, ровная земля или точка на карте Украины.");
  }
  const dist = distanceKm(input.ourLat, input.ourLon, input.oppLat, input.oppLon);
  if (dist < 0.05) return empty("Мало данных.", "Точки слишком близко.");
  const az = azimuthDeg(input.ourLat, input.ourLon, input.oppLat, input.oppLon);
  const h1 = base.our + input.ourAglM;
  const h2 = base.opp + input.oppAglM;
  const ends: Ends = { distanceKm: dist, azimuthDeg: az, h1, h2, ourGround: base.our, oppGround: base.opp };
  const profile = buildProfile(input, base.useGrid ? grid : null, ends, 0);
  if (!profile) return empty("Мало данных.", "Рельеф по пути не читается.");

  const fineCell = sampleTiles(input.tiles, input.ourLat, input.ourLon) != null && sampleTiles(input.tiles, input.oppLat, input.oppLon) != null
    ? input.tiles?.find((tile) => sampleDem(tile, input.ourLat, input.ourLon) != null)?.cellM ?? null
    : null;
  const cell = fineCell ?? (base.useGrid && grid ? grid.cellM : input.cellM);
  const minFresnel = profile.reduce((m, s) => {
    const f = s.km / dist;
    if (f <= 0.05 || f >= 0.95) return m;
    return Math.min(m, s.fresnelM);
  }, Number.POSITIVE_INFINITY);
  if (input.freqMhz > 13000 && cell != null && cell > minFresnel) {
    const gas = gasDbPerKm(input.freqMhz) * dist;
    return {
      ...empty("Мало данных.", "Шаг рельефа крупнее полосы луча. Ответ по земле ненадёжен."),
      distanceKm: dist,
      azimuthDeg: (az + 360) % 360,
      elevationDeg: pathElevationDeg(h1, h2, dist),
      aim: "",
      gasDb: gas,
      fsplDb: fsplDb(input.freqMhz, dist),
      profile,
      rx1: "Этот приёмник RX1 такую частоту не берёт.",
    };
  }

  const cover = applyCover(input, profile, ends);
  const segs = segments(profile, input.freqMhz, dist);
  const extended = segs.some((s) => s.extended);
  const frac = normFraction(input.freqMhz, extended || segs.length === 0);
  const raiseGrazeM = raiseFor(profile, ends, () => 0);
  const raiseCleanM = raiseFor(profile, ends, (s) => 0.6 * s.fresnelM);
  const raiseNormM = raiseFor(profile, ends, (s) => frac * s.fresnelM);
  const multi = segs.filter((s) => s.intrusionM > 0).length >= 2;
  const terrain = profile.map((s) => s.terrainM);

  const fspl = fsplDb(input.freqMhz, dist);
  const gas = gasDbPerKm(input.freqMhz) * dist;
  const rain = input.rainMmH != null && input.rainMmH > 0 ? rainDbPerKm(input.freqMhz, input.rainMmH) * dist : null;
  const elevation = pathElevationDeg(h1, h2, dist);
  const azimuth = (az + 360) % 360;
  const beam = whip(input.ourKind) ? null : beamwidthDeg(input.ourDbi);
  const aim = aimAction(input, azimuth, elevation, beam);
  const linked = linkGains(input, elevation, azimuth, aim.miss ? 0 : angleOffDeg(
    input.ourAimAzDeg ?? azimuth,
    input.ourAimElDeg ?? 0,
    azimuth,
    elevation,
  ));

  const lossAt = (extraM: number): number => {
    if (input.freqMhz >= 1000 && input.clutter) return 0;
    return pathDiffractionDb(terrain, dist, ends.h1 + extraM, ends.h2, input.freqMhz);
  };

  const diffraction = lossAt(0);
  const margin = linked.aimed ? marginDb(input, linked.ourDb, linked.oppDb, fspl, diffraction, gas, cover.vegetationDb) : null;
  const marginAt = (extraM: number): number | null => {
    if (!linked.aimed) return null;
    return marginDb(input, linked.ourDb, linked.oppDb, fspl, lossAt(extraM), gas, cover.vegetationDb);
  };

  let hearingExtra = 0;
  if (margin != null && margin <= 0 && !(input.freqMhz >= 1000 && input.clutter)) {
    let lo = 0;
    let hi = 30;
    if ((marginAt(30) ?? -999) >= 6) {
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if ((marginAt(mid) ?? -999) >= 6) hi = mid;
        else lo = mid;
      }
      hearingExtra = Math.ceil(hi * 2) / 2;
    } else {
      hearingExtra = 31;
    }
  }

  const clutterBlock = input.freqMhz >= 1000 && input.clutter;
  let verdict: VerdictKind = "open";
  let phrase = "Доходит.";
  let action = "Поймаете. Мачта для слышимости не нужна.";
  if (!linked.aimed) {
    verdict = "insufficient";
    phrase = "Мало данных.";
    action = "Укажите, в какую сторону ушёл их борт.";
  } else if (margin == null) {
    verdict = "insufficient";
    phrase = "Мало данных.";
    action = "Нужны мощность противника и порог приёмника.";
  } else if (clutterBlock) {
    verdict = "closed";
    phrase = "Не доходит. По пути лес или дома.";
    action = "С этой точки не доходит.";
  } else if (aim.miss) {
    verdict = margin > 0 ? "open" : hearingExtra > 30 ? "closed" : "ridge";
    phrase = verdict === "closed" ? "Не доходит." : verdict === "ridge" ? "Мешает земля." : "Доходит.";
    action = aim.text;
  } else if (margin > 0) {
    verdict = "open";
    phrase = "Доходит.";
    action = "Поймаете. Мачта для слышимости не нужна.";
  } else if (hearingExtra <= 30) {
    verdict = "ridge";
    phrase = "Мешает земля.";
    action = `Поднимите нашу антенну ещё на ${formatMast(hearingExtra)} м, до ${formatMast(input.ourAglM + hearingExtra)} м.`;
  } else {
    verdict = "closed";
    phrase = multi ? "Не доходит. Холмов несколько." : "Не доходит. Мачтой это не поднять.";
    action = "С этой точки не доходит. Выделите квадрат и ищите место, откуда до них доходит.";
  }

  const map = withAround && linked.aimed && base.useGrid && grid ? buildMap(input, grid) : null;
  return {
    verdict,
    phrase,
    action,
    aim: aim.text,
    side: linked.side,
    rx1: rx1Line(input.freqMhz, verdict, margin),
    distanceKm: dist,
    azimuthDeg: azimuth,
    elevationDeg: elevation,
    beamwidthDeg: beam,
    marginDb: margin,
    fsplDb: fspl,
    diffractionDb: diffraction,
    gasDb: gas,
    vegetationDb: cover.vegetationDb,
    buildingsOnPath: cover.buildingsOnPath,
    buildingsAssumed: cover.buildingsAssumed,
    rainDb: rain,
    raiseGrazeM,
    raiseCleanM,
    raiseNormM,
    profile,
    move: null,
    map,
  };
}

function formatMast(m: number): string {
  const rounded = Math.round(m * 2) / 2;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

function boxSidesKm(box: SearchBox): { ns: number; ew: number } | null {
  const south = Math.min(box.south, box.north);
  const north = Math.max(box.south, box.north);
  const west = Math.min(box.west, box.east);
  const east = Math.max(box.west, box.east);
  if (![south, north, west, east].every(finite)) return null;
  return {
    ns: distanceKm(south, west, north, west),
    ew: distanceKm(south, west, south, east),
  };
}

/** Поиск нашей точки внутри квадрата. Их точка остаётся. Вершину и ровное поле не предлагает. */
export function searchSquare(input: PositionInput, box: SearchBox): SquareSearch {
  const cover = "Лес на снимке не вижу, укрытие по складке рельефа.";
  const grid = input.grid;
  if (!grid) return { note: "В этом квадрате рельеф не читается.", picks: [] };
  if (oppNeedsAim(input)) return { note: "Укажите, в какую сторону ушёл их борт.", picks: [] };
  const sides = boxSidesKm(box);
  if (!sides) return { note: "Квадрат не задан.", picks: [] };
  if (sides.ns < 1 || sides.ew < 1) return { note: "Квадрат слишком мал.", picks: [] };
  if (sides.ns > 40 || sides.ew > 40) return { note: "Выделите участок до 40 км.", picks: [] };

  const south = Math.min(box.south, box.north);
  const north = Math.max(box.south, box.north);
  const west = Math.min(box.west, box.east);
  const east = Math.max(box.west, box.east);
  const iy0 = Math.max(0, Math.ceil((south - grid.lat0) / grid.dlat));
  const iy1 = Math.min(grid.nlat - 1, Math.floor((north - grid.lat0) / grid.dlat));
  const ix0 = Math.max(0, Math.ceil((west - grid.lon0) / grid.dlon));
  const ix1 = Math.min(grid.nlon - 1, Math.floor((east - grid.lon0) / grid.dlon));
  if (iy1 < iy0 || ix1 < ix0) return { note: "В этом квадрате рельеф не читается.", picks: [] };
  const strideLat = Math.max(1, Math.ceil((iy1 - iy0 + 1) / 40));
  const strideLon = Math.max(1, Math.ceil((ix1 - ix0 + 1) / 40));
  const radius = Math.max(1, Math.round(1000 / Math.max(grid.cellM, 1)));

  const folded: Array<{ lat: number; lon: number; h: number }> = [];
  let sawRelief = false;
  for (let iy = iy0; iy <= iy1; iy += strideLat) {
    for (let ix = ix0; ix <= ix1; ix += strideLon) {
      const h = grid.heights[iy * grid.nlon + ix];
      if (!finite(h)) continue;
      let minH = h;
      let maxH = h;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const y = iy + dy;
          const x = ix + dx;
          if (y < 0 || x < 0 || y >= grid.nlat || x >= grid.nlon) continue;
          const n = grid.heights[y * grid.nlon + x];
          if (!finite(n)) continue;
          minH = Math.min(minH, n);
          maxH = Math.max(maxH, n);
        }
      }
      if (maxH - minH >= 8) sawRelief = true;
      if (h >= maxH - 3) continue;
      const lat = grid.lat0 + iy * grid.dlat;
      const lon = grid.lon0 + ix * grid.dlon;
      const az = azimuthDeg(lat, lon, input.oppLat, input.oppLon);
      const back = destination(lat, lon, az + 180, 1);
      const behind = sampleDem(grid, back.lat, back.lon);
      if (behind == null || behind < h + 5) continue;
      const aheadPos = destination(lat, lon, az, 1);
      const ahead = sampleDem(grid, aheadPos.lat, aheadPos.lon);
      if (ahead != null && ahead > h + input.ourAglM + 15) continue;
      folded.push({ lat, lon, h });
    }
  }
  if (folded.length === 0) {
    return {
      note: sawRelief
        ? "В этом квадрате складки нет. Берите край ближе к ним."
        : "В этом квадрате складки нет. Берите край ближе к ним.",
      picks: [],
    };
  }

  const picks: SitePick[] = [];
  for (const spot of folded) {
    const trial: PositionInput = {
      ...input,
      ourLat: spot.lat,
      ourLon: spot.lon,
      ourGroundM: spot.h,
      marks: [],
      flatM: null,
    };
    const result = computePosition(trial, false);
    if (result.verdict !== "open" && result.verdict !== "ridge") continue;
    if (result.marginDb == null) continue;
    picks.push({
      lat: spot.lat,
      lon: spot.lon,
      groundM: spot.h,
      distanceKm: result.distanceKm,
      marginDb: result.marginDb,
      azimuthDeg: result.azimuthDeg,
      elevationDeg: result.elevationDeg,
      phrase: `Встаньте здесь. ${result.phrase} За спиной складка. Азимут ${result.azimuthDeg.toFixed(1)}°, наклон ${showEl(result.elevationDeg)}°.`,
    });
  }
  picks.sort((a, b) => b.marginDb - a.marginDb);
  const top = picks.slice(0, 3);
  if (top.length === 0) return { note: "В этом квадрате до них не доходит.", picks: [] };
  return { note: cover, picks: top };
}
