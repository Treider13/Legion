// Трасса до антенны противника. Нормы P.530-19 и P.526, газ по порядку P.676.
// Сеть не нужна: рельеф — отметки, ровная земля или файл на диске.

import { angleOffDeg, azimuthDeg, destination, distanceKm, earthBulgeM, formatDeg } from "./geo";
import { inBounds, sampleDem } from "./terrain";
import type {
  AntennaKind,
  DemGrid,
  MapCell,
  MovePoint,
  PositionInput,
  PositionResult,
  ProfileSample,
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
 * Усиление не в пик, а под углом offDeg от оси антенны.
 * До края луча — парабола, на краю ровно −3 дБ.
 * Дальше первый боковой лепесток обычного раскрыва: на 13 дБ ниже пика.
 * Ещё дальше — на 20 дБ ниже пика. Ниже 0 дБи не опускаем.
 */
export function gainTowardDb(kind: AntennaKind, peakDbi: number, offDeg: number): number {
  if (kind === "whip" || !(peakDbi >= 5) || !Number.isFinite(offDeg)) return peakDbi;
  const off = Math.abs(offDeg);
  const half = beamwidthDeg(peakDbi) / 2;
  if (!(half > 0)) return peakDbi;
  if (off <= half) return peakDbi - 3 * (off / half) ** 2;
  if (off <= half * 4) return Math.max(0, peakDbi - 13);
  return Math.max(0, peakDbi - 20);
}

/** Боковой лепесток: сразу за краем главного луча. */
export function sideGainDb(kind: AntennaKind, peakDbi: number): number {
  const half = beamwidthDeg(peakDbi) / 2;
  return gainTowardDb(kind, peakDbi, half + 0.01);
}

/** Поглощение газа, дБ/км. Ниже 10 ГГц ноль. Пик водяного пара около 22 ГГц — порядка 0,2 дБ/км. */
export function gasDbPerKm(freqMhz: number): number {
  const f = freqMhz / 1000;
  if (f < 10) return 0;
  const vapor = 0.16 / (1 + ((f - 22.235) / 2.2) ** 2);
  const tail = 0.012 * (f / 10) ** 2;
  return vapor + tail;
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
  const shifted = v - 0.1;
  return 6.9 + 20 * Math.log10(Math.sqrt(shifted * shifted + 1) + shifted);
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

function grounds(input: PositionInput, grid: DemGrid | null): { our: number; opp: number; missing: string | null; useGrid: boolean } {
  const ourIn = gridCovers(grid, input.ourLat, input.ourLon);
  const oppIn = gridCovers(grid, input.oppLat, input.oppLon);
  const ourSample = ourIn ? sampleDem(grid, input.ourLat, input.ourLon) : null;
  const oppSample = oppIn ? sampleDem(grid, input.oppLat, input.oppLon) : null;
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
  if (grid) return true;
  if (input.flatM != null && finite(input.flatM)) return true;
  return input.marks.some((m) => m.km > 0);
}

function terrainM(input: PositionInput, grid: DemGrid | null, km: number, dist: number, ourGround: number, oppGround: number, lat: number, lon: number): number | null {
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

function aimAction(input: PositionInput, azimuth: number, elevation: number, beam: number | null, ourOff: number): { text: string; miss: boolean } {
  if (whip(input.ourKind) || input.ourDbi < 5 || beam == null) {
    return { text: "Крутить не нужно.", miss: false };
  }
  const aim = `Поверните нашу антенну: азимут ${azimuth.toFixed(1)}°, наклон ${elevation.toFixed(1)}°.`;
  if (ourOff > beam / 2) return { text: `Луч смотрит мимо. ${aim}`, miss: true };
  if (input.ourDbi >= 15 && input.ourAimAzDeg == null) return { text: aim, miss: false };
  if (input.ourDbi >= 15 && input.ourAimAzDeg != null && ourOff > 1) return { text: aim, miss: false };
  return { text: "Крутить не нужно.", miss: false };
}

function rx1Line(freqMhz: number, verdict: VerdictKind, margin: number | null): string | null {
  if (freqMhz > RX1_MAX_MHZ) return "Этот приёмник RX1 такую частоту не берёт.";
  if (verdict !== "open" && verdict !== "ridge") return null;
  if (margin == null) return null;
  if (margin > 0) return "На приёмнике RX1 поймаете.";
  return "На приёмнике RX1 сигнала не хватит.";
}

function marginDb(input: PositionInput, ourDb: number, oppDb: number, fspl: number, diffraction: number, gas: number): number | null {
  if (input.powerW == null || input.thresholdDbm == null) return null;
  if (!(input.powerW > 0) || !finite(input.thresholdDbm)) return null;
  const powerDbm = 10 * Math.log10(input.powerW * 1000);
  return powerDbm + oppDb + ourDb - fspl - diffraction - gas - input.thresholdDbm;
}

function linkGains(input: PositionInput, az: number, el: number): { ourDb: number; oppDb: number; ourOff: number; side: string } {
  const ourAz = input.ourAimAzDeg == null ? az : input.ourAimAzDeg;
  const ourEl = input.ourAimElDeg ?? 0;
  const ourOff = angleOffDeg(ourAz, ourEl, az, el);
  const ourDb = gainTowardDb(input.ourKind, input.ourDbi, ourOff);
  const round = whip(input.oppKind) || input.oppDbi < 5;
  if (input.oppAimAzDeg == null && input.oppAimElDeg == null) {
    return {
      ourDb,
      oppDb: sideGainDb(input.oppKind, input.oppDbi),
      ourOff,
      side: round ? "Антенна противника почти круговая." : "Станция может стоять сбоку. Берём боковой лепесток, не пик из паспорта.",
    };
  }
  const toUsAz = azimuthDeg(input.oppLat, input.oppLon, input.ourLat, input.ourLon);
  const off = angleOffDeg(input.oppAimAzDeg ?? toUsAz, input.oppAimElDeg ?? 0, toUsAz, -el);
  const half = beamwidthDeg(input.oppDbi) / 2;
  const side = round
    ? "Антенна противника почти круговая."
    : off <= half
      ? "Антенна противника смотрит к нам."
      : "Антенна противника смотрит мимо нас. Сбоку сигнал слабее.";
  return { ourDb, oppDb: gainTowardDb(input.oppKind, input.oppDbi, off), ourOff, side };
}

function findMove(input: PositionInput, grid: DemGrid, ends: Ends): MovePoint | null {
  const cos = Math.max(0.2, Math.cos((input.ourLat * Math.PI) / 180));
  const dLat = 45 / 111.32;
  const dLon = 45 / (111.32 * cos);
  const iy0 = Math.max(0, Math.floor(((input.ourLat - dLat) - grid.lat0) / grid.dlat));
  const iy1 = Math.min(grid.nlat - 1, Math.ceil(((input.ourLat + dLat) - grid.lat0) / grid.dlat));
  const ix0 = Math.max(0, Math.floor(((input.ourLon - dLon) - grid.lon0) / grid.dlon));
  const ix1 = Math.min(grid.nlon - 1, Math.ceil(((input.ourLon + dLon) - grid.lon0) / grid.dlon));
  const strideLat = Math.max(1, Math.floor((iy1 - iy0) / 40));
  const strideLon = Math.max(1, Math.floor((ix1 - ix0) / 40));
  let best: MovePoint | null = null;
  for (let iy = iy0; iy <= iy1; iy += strideLat) {
    for (let ix = ix0; ix <= ix1; ix += strideLon) {
      const h = grid.heights[iy * grid.nlon + ix];
      if (!finite(h) || h <= ends.ourGround + 5) continue;
      const lat = grid.lat0 + iy * grid.dlat;
      const lon = grid.lon0 + ix * grid.dlon;
      const hop = distanceKm(input.ourLat, input.ourLon, lat, lon);
      if (hop < 0.2 || hop > 40) continue;
      if (best && hop >= best.distanceKm) continue;
      const trial: PositionInput = {
        ...input,
        ourLat: lat,
        ourLon: lon,
        ourGroundM: h,
        grid,
        marks: [],
        flatM: null,
      };
      const result = computePosition(trial, false);
      if (result.verdict === "open") {
        best = { lat, lon, distanceKm: hop, groundM: h };
      }
    }
  }
  return best;
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

  const cell = base.useGrid && grid ? grid.cellM : input.cellM;
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
      elevationDeg: (Math.atan2(h2 - h1, dist * 1000) * 180) / Math.PI,
      gasDb: gas,
      fsplDb: fsplDb(input.freqMhz, dist),
      profile,
      rx1: "Этот приёмник RX1 такую частоту не берёт.",
    };
  }

  const segs = segments(profile, input.freqMhz, dist);
  const extended = segs.some((s) => s.extended);
  const frac = normFraction(input.freqMhz, extended || segs.length === 0);
  const raiseGrazeM = raiseFor(profile, ends, () => 0);
  const raiseCleanM = raiseFor(profile, ends, (s) => 0.6 * s.fresnelM);
  const raiseNormM = raiseFor(profile, ends, (s) => frac * s.fresnelM);

  let diffraction = 0;
  if (segs.length > 0) {
    const worst = segs.reduce((a, b) => (a.intrusionM >= b.intrusionM ? a : b));
    const d1 = worst.worst.km * 1000;
    const d2 = (dist - worst.worst.km) * 1000;
    diffraction = knifeEdgeDb(worst.intrusionM, d1, d2, input.freqMhz);
  }
  const multi = segs.length >= 2;
  // Несколько холмов закрывают ответ только когда мачта, которая поднимает луч над всеми ними, уже нереальна.
  // Иначе одно действие — поднять антенну. Лес и дома закрывают выше 1 ГГц: их высоты в метрах нет.
  const mastHopeless = input.freqMhz >= 1000 && raiseNormM > 500 && segs.length > 0;
  const clutterBlock = input.freqMhz >= 1000 && input.clutter;

  let verdict: VerdictKind = "open";
  if (clutterBlock || mastHopeless) verdict = "closed";
  else if (segs.length > 0 || raiseNormM > 0.5) verdict = "ridge";

  const fspl = fsplDb(input.freqMhz, dist);
  const gas = gasDbPerKm(input.freqMhz) * dist;
  const rain = input.rainMmH != null && input.rainMmH > 0 ? rainDbPerKm(input.freqMhz, input.rainMmH) * dist : null;
  const elevation = (Math.atan2(h2 - h1, dist * 1000) * 180) / Math.PI;
  const linked = linkGains(input, (az + 360) % 360, elevation);
  const margin = marginDb(input, linked.ourDb, linked.oppDb, fspl, verdict === "closed" ? 0 : diffraction, gas);
  const beam = whip(input.ourKind) ? null : beamwidthDeg(input.ourDbi);
  const aim = aimAction(input, (az + 360) % 360, elevation, beam, linked.ourOff);
  const halfOur = beam == null ? 0 : beam / 2;
  let side = linked.side;
  if (input.ourAimAzDeg != null && beam != null && linked.ourOff > halfOur) {
    side = margin != null && margin > 0
      ? `${side} Сбоку тоже поймаете.`
      : `${side} Сбоку слабо, поверните антенну на станцию.`;
  }

  let phrase = "Доходит.";
  let action = aim.text;
  let move: MovePoint | null = null;
  if (verdict === "closed") {
    phrase = "Не доходит.";
    if (input.clutter && input.freqMhz >= 1000) phrase = "Не доходит. По пути лес или дома.";
    else if (multi) phrase = "Не доходит. Холмов несколько.";
    else phrase = "Не доходит. Мачтой это не поднять.";
    if (withAround && base.useGrid && grid) move = findMove(input, grid, ends);
    action = move
      ? `Встаньте на ${move.groundM.toFixed(0)} м над морем, ${move.distanceKm.toFixed(1)} км отсюда. Широта ${formatDeg(move.lat)}, долгота ${formatDeg(move.lon)}.`
      : base.useGrid
        ? "С этой точки не доходит. Рядом выше по рельефу места нет."
        : "С этой точки не доходит. Чтобы искать другую точку, нужен рельеф вокруг. По Украине он уже в памяти.";
  } else if (verdict === "ridge") {
    phrase = "Мешает земля.";
    if (!aim.miss) {
      action = `Поднимите нашу антенну на ${raiseNormM.toFixed(0)} м. Чтобы коснуться земли — ${raiseGrazeM.toFixed(0)} м. Чтобы земля не лезла в луч — ${raiseCleanM.toFixed(0)} м.`;
    }
  }

  const map = withAround && base.useGrid && grid ? buildMap(input, grid) : null;
  return {
    verdict,
    phrase,
    action,
    side,
    rx1: rx1Line(input.freqMhz, verdict, margin),
    distanceKm: dist,
    azimuthDeg: (az + 360) % 360,
    elevationDeg: elevation,
    beamwidthDeg: beam,
    marginDb: margin,
    fsplDb: fspl,
    diffractionDb: diffraction,
    gasDb: gas,
    rainDb: rain,
    raiseGrazeM,
    raiseCleanM,
    raiseNormM,
    profile,
    move,
    map,
  };
}
