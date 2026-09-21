// ============================================================================
// LEGION — память сессии Атаки на ноутбуке. Hop-частоты, сцены, остатки.
// IQ-кольцо живёт в воркере (16 М отсчётов). Здесь мозг помнит картину эфира.
// Сброс только при уходе с Атаки. Старт скана треки обнуляет — память нет.
// ============================================================================
import { bandBucket } from "./attackAtlas";
import type { AttackHopFamily } from "./attackFamily";
import type { AttackInfoSnap } from "./attackInfo";
import type { AttackLook } from "./attackLook";
import { ATTACK_ASSOC_MHZ, type AttackTrack } from "./attackTracks";

export interface AttackMemHop {
  mhz: number;
  ts: number;
}

export interface AttackResidual {
  ts: number;
  leftover: number;
  clip: boolean;
  paintLow: number;
  paintHigh: number;
  note: string;
}

export interface AttackMemStats {
  hopRemembered: number;
  scenes: number;
  residuals: number;
  workerSamples: number;
  workerCap: number;
  workerMs: number;
}

const HOP_KEEP = 512;
const SCENE_KEEP = 96;
const RES_KEEP = 24;
const POWER_KEEP = 48;
const SCENE_MIN_MS = 400;

export class AttackSessionMemory {
  hops: AttackMemHop[] = [];
  scenes: Array<{ ts: number; n: number; bands: string }> = [];
  residuals: AttackResidual[] = [];
  looks = new Map<number, AttackLook>();
  /** Мощность по id трекера. Только Атака. Старт скана обнуляет id — ряд тоже. */
  powers: AttackInfoSnap[] = [];
  workerSamples = 0;
  workerCap = 0;
  workerMs = 0;
  private lastHopById = new Map<number, number>();

  reset(): void {
    this.hops = [];
    this.scenes = [];
    this.residuals = [];
    this.looks.clear();
    this.powers = [];
    this.lastHopById.clear();
    this.workerSamples = 0;
    this.workerCap = 0;
    this.workerMs = 0;
  }

  noteWorker(samples: number, cap: number, ms: number): void {
    this.workerSamples = samples;
    this.workerCap = cap;
    this.workerMs = ms;
  }

  noteHops(tracks: readonly AttackTrack[], ts: number): void {
    const live = new Set<number>();
    for (const t of tracks) {
      if (t.state === "cooled") continue;
      live.add(t.id);
      if (t.duty >= 0.45 || t.widthMhz > 2) continue;
      const prev = this.lastHopById.get(t.id);
      if (prev != null && Math.abs(prev - t.freqMhz) < ATTACK_ASSOC_MHZ) continue;
      this.lastHopById.set(t.id, t.freqMhz);
      this.hops.push({ mhz: t.freqMhz, ts });
    }
    for (const id of [...this.lastHopById.keys()]) {
      if (!live.has(id)) this.lastHopById.delete(id);
    }
    if (this.hops.length > HOP_KEEP) this.hops = this.hops.slice(-HOP_KEEP);
  }

  noteScene(ts: number, tracks: readonly AttackTrack[]): void {
    this.powers.push({
      ts,
      rows: tracks.map((t) => ({
        id: t.id,
        freqMhz: t.freqMhz,
        powerDbm: t.powerDbm,
        widthMhz: t.widthMhz,
        duty: t.duty,
        firstSweep: t.firstSweep,
        state: t.state,
      })),
    });
    if (this.powers.length > POWER_KEEP) this.powers = this.powers.slice(-POWER_KEEP);
    if (this.scenes.length && ts - this.scenes[this.scenes.length - 1]!.ts < SCENE_MIN_MS) return;
    const live = tracks.filter((t) => t.state !== "cooled");
    const bands = [...new Set(live.map((t) => bandBucket(t.freqMhz)))].join(",");
    this.scenes.push({ ts, n: live.length, bands });
    if (this.scenes.length > SCENE_KEEP) this.scenes = this.scenes.slice(-SCENE_KEEP);
  }

  noteLook(id: number, look: AttackLook): void {
    this.looks.set(id, look);
  }

  /** Старт скана обнуляет id трекера — старый разбор и ряд мощности к новым id не липнут. Hop не трогаем. */
  forgetLooks(): void {
    this.looks.clear();
    this.powers = [];
  }

  powerSnaps(): readonly AttackInfoSnap[] {
    return this.powers;
  }

  noteResidual(row: AttackResidual): void {
    this.residuals.push(row);
    if (this.residuals.length > RES_KEEP) this.residuals = this.residuals.slice(-RES_KEEP);
  }

  hopMhz(): number[] {
    return this.hops.map((h) => h.mhz);
  }

  lastResidual(): AttackResidual | null {
    return this.residuals.length ? this.residuals[this.residuals.length - 1] : null;
  }

  stats(): AttackMemStats {
    return {
      hopRemembered: this.hops.length,
      scenes: this.scenes.length,
      residuals: this.residuals.length,
      workerSamples: this.workerSamples,
      workerCap: this.workerCap,
      workerMs: this.workerMs,
    };
  }
}

export function memoryLineRu(s: AttackMemStats, families: readonly AttackHopFamily[]): string {
  const iq =
    s.workerCap > 0
      ? `плата помнит ${s.workerMs.toFixed(0)} мс IQ (${s.workerSamples} из ${s.workerCap} отсчётов)`
      : "память IQ на плате ещё пуста — копится с каждого взгляда Атаки";
  const hop = s.hopRemembered
    ? `мозг помнит ${s.hopRemembered} вспышек hop`
    : "hop-вспышек в памяти пока нет";
  const fam = families.length ? `семей hop: ${families.length}` : "семья hop ещё не сложилась";
  return `${iq}. ${hop}. ${fam}. сцен сессии ${s.scenes}.`;
}
