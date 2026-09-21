// ============================================================================
// LEGION — треки хост-Атаки. Порт: esm-wideband-cfar PeakTracker
// (nearest-neighbour, max_gap) + ворота SDRwatch (min_hits / min_windows)
// + occupancy hits/streak/duty. Не pickArmedAutoTarget.
// ============================================================================
import type { AttackHit } from "./attackDetect";
import { FWD_BIN_MHZ } from "./orchestrator";

export type AttackTrackState = "new" | "confirmed" | "held" | "cooled";

export interface AttackTrack {
  id: number;
  freqMhz: number;
  fLowMhz: number;
  fHighMhz: number;
  widthMhz: number;
  powerDbm: number;
  noiseDbm: number;
  snrDb: number;
  hits: number;
  streak: number;
  maxStreak: number;
  firstSweep: number;
  lastSweep: number;
  gap: number;
  duty: number;
  state: AttackTrackState;
  lastSeenTs: number;
}

export const ATTACK_MIN_HITS = 2;
export const ATTACK_MIN_WINDOWS = 2;
export const ATTACK_MAX_GAP = 2;
export const ATTACK_ASSOC_MHZ = FWD_BIN_MHZ;

export class AttackTracker {
  private tracks: AttackTrack[] = [];
  private nextId = 1;
  private sweep = 0;

  reset(): void {
    this.tracks = [];
    this.nextId = 1;
    this.sweep = 0;
  }

  snapshot(): AttackTrack[] {
    return this.tracks.map((t) => ({ ...t }));
  }

  confirmed(): AttackTrack[] {
    return this.snapshot().filter((t) => t.state === "confirmed" || t.state === "held");
  }

  /** Номер обхода после update. Свежий хит: lastSweep === currentSweep(). */
  currentSweep(): number {
    return this.sweep;
  }

  markHeld(mhz: number | null): void {
    for (const t of this.tracks) {
      if (t.state === "cooled") continue;
      if (mhz != null && Math.abs(t.freqMhz - mhz) <= ATTACK_ASSOC_MHZ) t.state = "held";
      else if (t.state === "held") t.state = this.qualifies(t) ? "confirmed" : "new";
    }
  }

  update(hits: readonly AttackHit[], ts: number): AttackTrack[] {
    this.sweep += 1;
    const used = new Set<number>();
    for (const h of hits) {
      const track = this.bestTrack(h.freqMhz, used);
      if (track) {
        used.add(track.id);
        this.append(track, h, ts);
      } else {
        const created = this.create(h, ts);
        used.add(created.id);
      }
    }
    for (const t of this.tracks) {
      if (used.has(t.id)) {
        t.gap = 0;
      } else {
        t.gap += 1;
        t.streak = 0;
      }
      const span = this.sweep - t.firstSweep + 1;
      t.duty = span > 0 ? t.hits / span : 1;
      if (t.gap > ATTACK_MAX_GAP) t.state = "cooled";
      else if (this.qualifies(t)) {
        if (t.state !== "held") t.state = "confirmed";
      } else if (t.state !== "held") t.state = "new";
    }
    this.tracks = this.tracks.filter((t) => t.state !== "cooled" || t.gap <= ATTACK_MAX_GAP + 8);
    return this.snapshot();
  }

  private qualifies(t: AttackTrack): boolean {
    const windows = t.lastSweep - t.firstSweep + 1;
    return t.hits >= ATTACK_MIN_HITS && windows >= ATTACK_MIN_WINDOWS && t.maxStreak >= ATTACK_MIN_HITS;
  }

  private bestTrack(freqMhz: number, used: Set<number>): AttackTrack | null {
    let best: AttackTrack | null = null;
    let bestD = Infinity;
    for (const t of this.tracks) {
      if (t.state === "cooled" || used.has(t.id)) continue;
      const d = Math.abs(t.freqMhz - freqMhz);
      if (d <= ATTACK_ASSOC_MHZ && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  private create(h: AttackHit, ts: number): AttackTrack {
    const t: AttackTrack = {
      id: this.nextId++,
      freqMhz: h.freqMhz,
      fLowMhz: h.fLowMhz,
      fHighMhz: h.fHighMhz,
      widthMhz: h.widthMhz,
      powerDbm: h.powerDbm,
      noiseDbm: h.noiseDbm,
      snrDb: h.snrDb,
      hits: 1,
      streak: 1,
      maxStreak: 1,
      firstSweep: this.sweep,
      lastSweep: this.sweep,
      gap: 0,
      duty: 1,
      state: "new",
      lastSeenTs: ts,
    };
    this.tracks.push(t);
    return t;
  }

  private append(t: AttackTrack, h: AttackHit, ts: number): void {
    t.freqMhz = h.freqMhz;
    t.fLowMhz = Math.min(t.fLowMhz, h.fLowMhz);
    t.fHighMhz = Math.max(t.fHighMhz, h.fHighMhz);
    t.widthMhz = Math.max(h.widthMhz, t.fHighMhz - t.fLowMhz);
    t.powerDbm = h.powerDbm;
    t.noiseDbm = h.noiseDbm;
    t.snrDb = h.snrDb;
    t.hits += 1;
    t.streak += 1;
    t.maxStreak = Math.max(t.maxStreak, t.streak);
    t.lastSweep = this.sweep;
    t.lastSeenTs = ts;
  }
}

export function strongestConfirmed(tracks: readonly AttackTrack[]): AttackTrack | null {
  const live = tracks.filter((t) => t.state === "confirmed" || t.state === "held");
  if (live.length === 0) return null;
  return live.reduce((a, b) => (b.powerDbm > a.powerDbm ? b : a));
}
