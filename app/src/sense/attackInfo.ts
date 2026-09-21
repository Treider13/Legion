// ============================================================================
// LEGION — информация Атаки. Только сцена режима Атака.
// Смотрит роли и физику тени / горизонта и говорит помощнику, какую
// УЖЕ ВИДНУЮ частоту обвести. Не пишет в TX, не включает излучение,
// не предсказывает следующий канал, не переводит наклон мощности в метры
// и не ставит точку человека. Волокно отсюда не видно.
// Слова оператора: «информация», «помощник».
// ============================================================================
import { bandBucket, type AttackBand } from "./attackAtlas";
import type { AttackTrack, AttackTrackState } from "./attackTracks";

/** Снимок мощности. Id трекера жив внутри одного скана. */
export interface AttackInfoRow {
  id: number;
  freqMhz: number;
  powerDbm: number;
  widthMhz: number;
  duty: number;
  firstSweep: number;
  state: AttackTrackState;
  /**
   * true — хит этого обхода, мощность свежая.
   * false — окно накрывало частоту, хита не было.
   * Поле можно не ставить: тогда строка считается свежим хитом.
   */
  measured?: boolean;
}

export interface AttackInfoSnap {
  ts: number;
  rows: AttackInfoRow[];
}

export interface AttackInfoRole {
  trackId: number;
  roleRu: string;
}

export interface AttackInfo {
  /** Пусто, если сказать нечего. Иначе начинается с «Информация:». */
  line: string;
  roles: AttackInfoRole[];
  /**
   * След вместо самого громкого. null — помощник решает по-старому
   * (семья уже виденных вспышек / два этажа / сильнейший).
   */
  redirectId: number | null;
  /** Широкая полка вместо более громкого узкого голоса. Два этажа в одной корзине помощник уже закрывает сам. */
  preferWideId: number | null;
}

const HIGH_VIDEO: readonly AttackBand[] = ["c51", "c58"];
const LOW_VIDEO: readonly AttackBand[] = ["l12", "c33"];
const CONTROL_BANDS: readonly AttackBand[] = ["vhf", "uhf", "p900", "s24"];

/** Выше частота — раньше садится за препятствием (нож ITU-R P.526). */
const SHADOW_DROP_DB = 8;
const CONTROL_HOLD_DB = 3;
/** Вместе сели — горизонт или тень, не шаг усилителя. */
const FADE_TOGETHER_DB = 6;
/** Один дискретный шаг мощности пульта. Не наклон и не метры. */
const STEP_MIN_DB = 2;
const STEP_MAX_DB = 12;
const SHELF_STILL_DB = 1.5;
/** Нуль антенны борта дрожит быстрее, чем наземный луч поворачивают. */
const FLUTTER_PP_DB = 4;
const FLUTTER_REVERSALS = 3;
const ROOM_STD_DB = 1.2;
const ROOM_MIN_SAMPLES = 4;
const ROOM_BIRTH_SWEEPS = 4;
/** Столько совместных попаданий в одно окно, чтобы сказать «одна радиосвязь». */
const GEMINI_SHARED_HITS = 4;

function videoLike(t: { widthMhz: number; duty: number }): boolean {
  return t.duty >= 0.7 && t.widthMhz >= 6;
}

function narrowLike(t: { widthMhz: number; duty: number }): boolean {
  return t.duty < 0.45 && t.widthMhz <= 2;
}

function liveState(state: AttackTrackState): boolean {
  return state === "new" || state === "confirmed" || state === "held";
}

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return Number.POSITIVE_INFINITY;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return Math.sqrt(v / xs.length);
}

function peakToPeak(xs: readonly number[]): number {
  let lo = xs[0] ?? 0;
  let hi = lo;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

function reversals(xs: readonly number[]): number {
  let n = 0;
  let prev = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    if (Math.abs(d) < 0.8) continue;
    const s = Math.sign(d);
    if (prev !== 0 && s !== prev) n += 1;
    prev = s;
  }
  return n;
}

interface Seen {
  id: number;
  freqMhz: number;
  widthMhz: number;
  duty: number;
  firstSweep: number;
  state: AttackTrackState;
  /** Свежие хиты, по времени. Промах и чужое окно сюда не входят. */
  powers: number[];
  /** Каждый взгляд, когда частота была в окне: true = хит. */
  present: boolean[];
  hitTs: number[];
  obsTs: number[];
}

function buildSeen(tracks: readonly AttackTrack[], snaps: readonly AttackInfoSnap[]): Map<number, Seen> {
  const map = new Map<number, Seen>();
  const ensure = (id: number): Seen => {
    let row = map.get(id);
    if (!row) {
      row = {
        id,
        freqMhz: 0,
        widthMhz: 0,
        duty: 0,
        firstSweep: 1,
        state: "new",
        powers: [],
        present: [],
        hitTs: [],
        obsTs: [],
      };
      map.set(id, row);
    }
    return row;
  };
  for (const snap of snaps) {
    for (const row of snap.rows) {
      const measured = row.measured !== false && row.state !== "cooled";
      const seen = ensure(row.id);
      seen.obsTs.push(snap.ts);
      seen.present.push(measured);
      if (!measured) continue;
      seen.freqMhz = row.freqMhz;
      seen.widthMhz = row.widthMhz;
      seen.duty = row.duty;
      seen.firstSweep = row.firstSweep;
      seen.state = row.state;
      seen.powers.push(row.powerDbm);
      seen.hitTs.push(snap.ts);
    }
  }
  for (const t of tracks) {
    const seen = ensure(t.id);
    seen.freqMhz = t.freqMhz;
    seen.widthMhz = t.widthMhz;
    seen.duty = t.duty;
    seen.firstSweep = t.firstSweep;
    seen.state = t.state;
  }
  return map;
}

function timeOverlap(a: readonly number[], b: readonly number[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a[0]! <= b[b.length - 1]! && b[0]! <= a[a.length - 1]!;
}

function sharedHits(a: Seen, b: Seen): number {
  const set = new Set(a.hitTs);
  let n = 0;
  for (const ts of b.hitTs) if (set.has(ts)) n += 1;
  return n;
}

function dropDb(powers: readonly number[]): number | null {
  if (powers.length < 4) return null;
  const early = mean(powers.slice(0, 3));
  const late = mean(powers.slice(-3));
  return early - late;
}

function stepDb(powers: readonly number[]): number | null {
  if (powers.length < 6) return null;
  const prev = mean(powers.slice(-6, -3));
  const late = mean(powers.slice(-3));
  return late - prev;
}

/** Последние взгляды в окно — пустые, раньше хит был. Чужое окно сюда не попадает. */
function diedInView(seen: Seen): boolean {
  if (seen.present.length < 4) return false;
  const tail = seen.present.slice(-2);
  const head = seen.present.slice(0, -2);
  return tail.every((p) => !p) && head.some((p) => p);
}

function trendSigns(powers: readonly number[]): number[] {
  const signs: number[] = [];
  for (let i = 1; i < powers.length; i++) {
    const d = powers[i]! - powers[i - 1]!;
    if (Math.abs(d) < 0.8) continue;
    signs.push(Math.sign(d));
  }
  return signs;
}

/** Одинаковый ход двух рядов свежих хитов. Мало точек или ровные полки — свидетельства нет. */
function trendsMatch(a: readonly number[], b: readonly number[]): boolean {
  const sa = trendSigns(a);
  const sb = trendSigns(b);
  if (sa.length < 2 || sb.length < 2) return false;
  const n = Math.min(sa.length, sb.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (sa[i] === sb[i]) same += 1;
  return same >= 2 && same >= n * 0.6;
}

function loudest(tracks: readonly AttackTrack[]): AttackTrack | null {
  if (tracks.length === 0) return null;
  return tracks.reduce((a, b) => (b.powerDbm > a.powerDbm ? b : a));
}

function emptyInfo(): AttackInfo {
  return { line: "", roles: [], redirectId: null, preferWideId: null };
}

/**
 * Роли кадра и вето физики. Частоты в ответе — только те, что уже в треках.
 * Таблички Remote ID / DroneID в этом процессе нет — такая проверка не запускается.
 */
export function readAttackInfo(input: {
  tracks: readonly AttackTrack[];
  snaps?: readonly AttackInfoSnap[];
}): AttackInfo {
  const snaps = input.snaps ?? [];
  const tracks = input.tracks;
  const live = tracks.filter((t) => liveState(t.state));
  if (live.length === 0) return emptyInfo();

  const seen = buildSeen(tracks, snaps);
  const roomIds = new Set<number>();
  for (const t of live) {
    const powers = seen.get(t.id)?.powers ?? [];
    if (powers.length < ROOM_MIN_SAMPLES || stdev(powers) >= ROOM_STD_DB) continue;
    const bornLater = live.some((o) => o.id !== t.id && o.firstSweep >= t.firstSweep + ROOM_BIRTH_SWEEPS);
    if (!bornLater) continue;
    if (videoLike(t)) {
      const withControl = live.some(
        (o) => o.id !== t.id && narrowLike(o) && Math.abs(o.firstSweep - t.firstSweep) <= 2,
      );
      if (withControl) continue;
    }
    roomIds.add(t.id);
  }

  const wides = live.filter((t) => videoLike(t) && !roomIds.has(t.id));
  const narrows = live.filter((t) => narrowLike(t) && !roomIds.has(t.id));

  const highWides = wides.filter((t) => HIGH_VIDEO.includes(bandBucket(t.freqMhz)));
  const lowWides = wides.filter((t) => LOW_VIDEO.includes(bandBucket(t.freqMhz)));
  let repeater = false;
  let repeaterLoud: AttackTrack | null = null;
  let repeaterOther: AttackTrack | null = null;
  if (highWides.length >= 1 && lowWides.length >= 1) {
    const high = loudest(highWides)!;
    const low = loudest(lowWides)!;
    const hs = seen.get(high.id);
    const ls = seen.get(low.id);
    if (hs && ls && timeOverlap(hs.hitTs, ls.hitTs) && trendsMatch(hs.powers, ls.powers)) {
      repeater = true;
      repeaterLoud = high.powerDbm >= low.powerDbm ? high : low;
      repeaterOther = repeaterLoud.id === high.id ? low : high;
    }
  }

  let gemini = false;
  if (wides.length < 2 && narrows.length >= 2) {
    for (let i = 0; i < narrows.length && !gemini; i++) {
      for (let j = i + 1; j < narrows.length && !gemini; j++) {
        const a = narrows[i]!;
        const b = narrows[j]!;
        const ba = bandBucket(a.freqMhz);
        const bb = bandBucket(b.freqMhz);
        if (!CONTROL_BANDS.includes(ba) || !CONTROL_BANDS.includes(bb)) continue;
        const spread = Math.abs(a.freqMhz - b.freqMhz);
        if (ba === bb && spread < 10) continue;
        const sa = seen.get(a.id);
        const sb = seen.get(b.id);
        if (!sa || !sb || sharedHits(sa, sb) < GEMINI_SHARED_HITS) continue;
        gemini = true;
      }
    }
  }

  let shadow = false;
  let shadowControl: AttackTrack | null = null;
  let fade = false;
  let fadeKeep: AttackTrack | null = null;
  const controls = narrows.filter((t) => CONTROL_BANDS.includes(bandBucket(t.freqMhz)));
  for (const c of controls) {
    const cs = seen.get(c.id);
    if (!cs) continue;
    for (const s of seen.values()) {
      if (s.id === c.id || !videoLike(s) || !HIGH_VIDEO.includes(bandBucket(s.freqMhz))) continue;
      if (snaps.length > 0 && !timeOverlap(s.obsTs, cs.obsTs)) continue;
      const videoDrop = dropDb(s.powers);
      const videoGone = diedInView(s) || (videoDrop != null && videoDrop >= SHADOW_DROP_DB);
      const controlDrop = dropDb(cs.powers);
      const controlHolds = controlDrop != null && controlDrop < CONTROL_HOLD_DB;
      const bothDown =
        videoDrop != null &&
        controlDrop != null &&
        videoDrop >= FADE_TOGETHER_DB &&
        controlDrop >= FADE_TOGETHER_DB;
      if (bothDown) {
        fade = true;
        const videoLive = live.find((t) => t.id === s.id) ?? null;
        fadeKeep = videoLive && videoLive.powerDbm >= c.powerDbm ? videoLive : c;
      } else if (videoGone && controlHolds && liveState(c.state)) {
        shadow = true;
        shadowControl = c;
      }
    }
  }

  let step = false;
  let stepWide: AttackTrack | null = null;
  if (!fade) {
    for (const n of narrows) {
      const ns = seen.get(n.id);
      if (!ns) continue;
      const delta = stepDb(ns.powers);
      if (delta == null || Math.abs(delta) < STEP_MIN_DB || Math.abs(delta) > STEP_MAX_DB) continue;
      const shelf = wides.find((w) => {
        const ws = seen.get(w.id);
        if (!ws) return false;
        const d = stepDb(ws.powers);
        return d != null && Math.abs(d) <= SHELF_STILL_DB;
      });
      if (!shelf) continue;
      step = true;
      stepWide = shelf;
      break;
    }
  }

  let flutterId: number | null = null;
  let flutterScore = 0;
  for (const t of live) {
    if (roomIds.has(t.id)) continue;
    const powers = (seen.get(t.id)?.powers ?? []).slice(-8);
    if (powers.length < 4) continue;
    const rev = reversals(powers);
    if (peakToPeak(powers) < FLUTTER_PP_DB || rev < FLUTTER_REVERSALS) continue;
    const score = rev + (videoLike(t) ? 2 : 0);
    if (score > flutterScore) {
      flutterScore = score;
      flutterId = t.id;
    }
  }

  let redirectId: number | null = null;
  if (fade && fadeKeep) {
    const top = loudest(live);
    const pair = new Set<number>([fadeKeep.id]);
    if (top && !pair.has(top.id) && top.id !== fadeKeep.id) redirectId = fadeKeep.id;
    else if (top && roomIds.has(top.id)) redirectId = fadeKeep.id;
  }
  if (redirectId == null && step && stepWide) {
    const top = loudest(live);
    if (top && top.id !== stepWide.id) redirectId = stepWide.id;
  }
  if (redirectId == null && shadow && shadowControl) {
    const top = loudest(live);
    const videoIds = new Set(
      [...seen.values()].filter((s) => videoLike(s) && HIGH_VIDEO.includes(bandBucket(s.freqMhz))).map((s) => s.id),
    );
    if (top && top.id !== shadowControl.id && !videoIds.has(top.id)) redirectId = shadowControl.id;
  }
  if (redirectId == null && flutterId != null) {
    const top = loudest(live);
    if (top && top.id !== flutterId) redirectId = flutterId;
  }
  if (redirectId == null) {
    const top = loudest(live);
    if (top && roomIds.has(top.id)) {
      const rest = live.filter((t) => !roomIds.has(t.id));
      const wideRest = rest.filter((t) => videoLike(t));
      const pick = loudest(wideRest.length ? wideRest : rest);
      if (pick) redirectId = pick.id;
    }
  }

  let preferWideId: number | null = null;
  if (redirectId == null) {
    const top = loudest(live);
    const wide = repeater && repeaterLoud ? repeaterLoud : loudest(wides);
    if (top && wide && top.id !== wide.id && !videoLike(top)) preferWideId = wide.id;
  }

  const roleOf = new Map<number, string>();
  for (const t of live) {
    if (roomIds.has(t.id)) {
      roleOf.set(t.id, "фон");
      continue;
    }
    if (repeater && (t.id === repeaterLoud?.id || t.id === repeaterOther?.id)) {
      roleOf.set(t.id, "ретранслятор");
      continue;
    }
    if (videoLike(t)) roleOf.set(t.id, "борт");
    else if (narrowLike(t)) roleOf.set(t.id, "пульт");
  }

  const bits: string[] = [];
  if (fade) bits.push("обе сели вместе — горизонт или тень");
  if (step) bits.push("шаг мощности узкого голоса, широкая полка на месте");
  if (shadow) bits.push("тень: верхняя полка села, узкий голос той же картины жив");
  if (flutterId != null) bits.push("быстрое дрожание мощности — нуль антенны борта");
  if (repeater && repeaterLoud && repeaterOther) {
    bits.push(
      `ретранслятор: громкая полка ${repeaterLoud.freqMhz.toFixed(2)} МГц сейчас, вторая полка ${repeaterOther.freqMhz.toFixed(2)} МГц сейчас`,
    );
  }
  if (gemini) bits.push("две узкие частоты — одна радиосвязь");
  const listed = [...roleOf.entries()]
    .map(([id, role]) => {
      const t = live.find((x) => x.id === id);
      return t ? `${role} ${t.freqMhz.toFixed(2)} МГц` : "";
    })
    .filter((s) => s.length > 0);
  if (listed.length) bits.push(listed.join("; "));

  return {
    line: bits.length ? `Информация: ${bits.join(". ")}.` : "",
    roles: [...roleOf.entries()].map(([trackId, roleRu]) => ({ trackId, roleRu })),
    redirectId,
    preferWideId,
  };
}
