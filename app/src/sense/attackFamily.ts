// ============================================================================
// LEGION — склейка hop-семьи Атаки. Не предсказание канала в TX.
// Ворота ширины/duty как у SDRwatch occupancy + ExpressLRS сетка ~1 МГц
// (ISM2G4 2400.4…2479.4 / 79 = 1.000). Ассоциация треков 0.2 МГц семью не видит.
// ============================================================================
import { bandBucket, type AttackBand } from "./attackAtlas";
import type { AttackTrack } from "./attackTracks";

export interface AttackHopFamily {
  id: string;
  band: AttackBand;
  members: number[];
  fLowMhz: number;
  fHighMhz: number;
  gridMhz: number;
  widthMhz: number;
  hits: number;
}

function hopLike(t: Pick<AttackTrack, "widthMhz" | "duty" | "streak">): boolean {
  return t.duty < 0.45 && t.streak <= 2 && t.widthMhz <= 2;
}

function modeDelta(freqs: number[]): number {
  if (freqs.length < 2) return 0;
  const xs = freqs.slice().sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    if (d >= 0.35 && d <= 2.6) deltas.push(d);
  }
  if (deltas.length === 0) return 0;
  const bins = new Map<number, number>();
  for (const d of deltas) {
    const key = Math.round(d * 4) / 4;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [k, n] of bins) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

export function stitchHopFamilies(
  tracks: readonly AttackTrack[],
  memoryMhz: readonly number[],
): AttackHopFamily[] {
  const live = tracks.filter((t) => t.state !== "cooled" && hopLike(t));
  const byBand = new Map<AttackBand, AttackTrack[]>();
  for (const t of live) {
    const b = bandBucket(t.freqMhz);
    const arr = byBand.get(b) ?? [];
    arr.push(t);
    byBand.set(b, arr);
  }
  const out: AttackHopFamily[] = [];
  let n = 0;
  for (const [band, members] of byBand) {
    const mem = memoryMhz.filter((f) => bandBucket(f) === band);
    const freqs = [...members.map((t) => t.freqMhz), ...mem];
    const grid = modeDelta(freqs);
    if (members.length < 1) continue;
    if (members.length === 1 && mem.length < 2 && grid <= 0) continue;
    const lows = members.map((t) => t.fLowMhz);
    const highs = members.map((t) => t.fHighMhz);
    if (mem.length) {
      lows.push(Math.min(...mem));
      highs.push(Math.max(...mem));
    }
    const fLow = Math.min(...lows);
    const fHigh = Math.max(...highs);
    if (fHigh - fLow < 0.3 && members.length < 2) continue;
    n += 1;
    out.push({
      id: `hop-${band}-${n}`,
      band,
      members: members.map((t) => t.id),
      fLowMhz: fLow,
      fHighMhz: fHigh,
      gridMhz: grid,
      widthMhz: members.reduce((s, t) => s + t.widthMhz, 0) / members.length,
      hits: members.length + mem.length,
    });
  }
  // Свежий удар на той же сетке ещё duty 1: двух промахов не было, hopLike молчит.
  // Это уже увиденный канал, не следующий. Без него кнопка обводит одну вспышку,
  // хотя семья 900…909 уже есть.
  for (const fam of out) {
    const centers = tracks.filter((t) => fam.members.includes(t.id)).map((t) => t.freqMhz);
    const reach = Math.max(fam.gridMhz, 1) * 2;
    const extra = tracks.filter((t) => {
      if (t.state === "cooled" || fam.members.includes(t.id) || t.widthMhz > 2) return false;
      if (bandBucket(t.freqMhz) !== fam.band) return false;
      return centers.some((c) => Math.abs(t.freqMhz - c) <= reach);
    });
    if (extra.length === 0) continue;
    fam.members = [...fam.members, ...extra.map((t) => t.id)];
    fam.fLowMhz = Math.min(fam.fLowMhz, ...extra.map((t) => t.fLowMhz));
    fam.fHighMhz = Math.max(fam.fHighMhz, ...extra.map((t) => t.fHighMhz));
  }
  return out;
}

export function familySpanWithPad(fam: AttackHopFamily): { f1Mhz: number; f2Mhz: number } {
  const pad = fam.gridMhz > 0 ? fam.gridMhz * 0.5 : 0.5;
  return { f1Mhz: fam.fLowMhz - pad, f2Mhz: fam.fHighMhz + pad };
}
