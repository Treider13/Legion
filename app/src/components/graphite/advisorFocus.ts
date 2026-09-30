import { useSyncExternalStore } from "react";
import { ATTACK_ASSOC_MHZ } from "../../sense/attackTracks";

export interface MarkerHit {
  id: number;
  fLowMhz: number;
  fHighMhz: number;
  widthMhz: number;
  state: string;
}

/** Сколько совет держит один обнаруженный сигнал, прежде чем очередь шагнёт дальше. */
export const ADVICE_HOLD_MS = 8000;

export interface AdviceQueueItem {
  freqMhz: number;
  trackId: number;
}

export interface AdvisorPick {
  seq: number;
  freqMhz: number | null;
  trackId: number | null;
}

let focusFreq: number | null = null;
let focusTrackId: number | null = null;
let focusSeq = 0;
let pickSnapshot: AdvisorPick = { seq: 0, freqMhz: null, trackId: null };
const listeners = new Set<() => void>();

function publishPick(): void {
  pickSnapshot = { seq: focusSeq, freqMhz: focusFreq, trackId: focusTrackId };
  listeners.forEach((listener) => listener());
}

export function advisorPick(): AdvisorPick {
  return pickSnapshot;
}

/**
 * Наведение на маркер. Тот же излучатель (в пределах окна ассоциации)
 * карточку не пересобирает и таймер 8 с не сбрасывает.
 */
export function focusAdvisorTrack(id: number, freqMhz: number): void {
  if (!Number.isFinite(freqMhz)) return;
  if (focusFreq != null && Math.abs(focusFreq - freqMhz) <= ATTACK_ASSOC_MHZ) return;
  focusFreq = freqMhz;
  focusTrackId = id;
  focusSeq += 1;
  publishPick();
}

export function clearAdvisorFocus(): void {
  if (focusFreq == null && focusTrackId == null) return;
  focusFreq = null;
  focusTrackId = null;
  publishPick();
}

export function useAdvisorPick(): AdvisorPick {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => pickSnapshot,
    () => pickSnapshot,
  );
}

/** Один излучатель, даже если трекер выдал новый id на той же частоте. */
export function sameAdviceEmitter(aMhz: number, bMhz: number): boolean {
  return Math.abs(aMhz - bMhz) <= ATTACK_ASSOC_MHZ;
}

/**
 * Очередь обнаруженных сигналов в порядке появления.
 * Уже стоящий след не дублируется и не переезжает вперёд, если стал громче.
 * Остывший след из очереди уходит.
 */
export function mergeAdviceQueue(
  queue: readonly AdviceQueueItem[],
  live: readonly { id: number; freqMhz: number; state: string }[],
): readonly AdviceQueueItem[] {
  const alive = live.filter((row) => row.state !== "cooled");
  const kept = queue.filter((item) => alive.some((row) => sameAdviceEmitter(row.freqMhz, item.freqMhz)));
  const next = kept.slice();
  let changed = kept.length !== queue.length;
  for (const row of alive) {
    if (next.some((item) => sameAdviceEmitter(item.freqMhz, row.freqMhz))) continue;
    next.push({ freqMhz: row.freqMhz, trackId: row.id });
    changed = true;
  }
  return changed ? next : queue;
}

export function queueIndexForFreq(queue: readonly AdviceQueueItem[], freqMhz: number): number {
  return queue.findIndex((item) => sameAdviceEmitter(item.freqMhz, freqMhz));
}

/** Следующий в очереди. Один сигнал остаётся на месте. */
export function advanceAdviceMhz(
  queue: readonly AdviceQueueItem[],
  currentMhz: number | null,
): number | null {
  if (queue.length === 0) return null;
  const at = currentMhz == null ? -1 : queueIndexForFreq(queue, currentMhz);
  return queue[(at + 1) % queue.length]?.freqMhz ?? null;
}

/**
 * Текущий сигнал остаётся, пока он в очереди.
 * Если он исчез, берётся следующий, кто ещё жив, а не самый громкий.
 */
export function resolveAdviceMhz(
  prevMhz: number | null,
  before: readonly AdviceQueueItem[],
  after: readonly AdviceQueueItem[],
): number | null {
  if (after.length === 0) return null;
  if (prevMhz != null && queueIndexForFreq(after, prevMhz) >= 0) return prevMhz;
  if (prevMhz == null) return after[0]?.freqMhz ?? null;
  const oldAt = queueIndexForFreq(before, prevMhz);
  const start = oldAt < 0 ? 0 : oldAt + 1;
  for (let i = start; i < before.length; i += 1) {
    const kept = after.find((item) => sameAdviceEmitter(item.freqMhz, before[i].freqMhz));
    if (kept) return kept.freqMhz;
  }
  return after[0]?.freqMhz ?? null;
}

/**
 * Самый узкий живой след под курсором.
 * Полоска рисуется от нижней частоты вправо и не уже minPx
 * (fillRect от x(fLow), ширина max(пиксели следа, minPx)).
 * Зона наведения — этот прямоугольник, не полоса симметрично вокруг центра.
 * Широкая полка не перекрывает узкий маркер внутри неё.
 */
export function trackUnderMhz<T extends MarkerHit>(
  tracks: readonly T[],
  mhz: number,
  pxPerMhz = 0,
  minPx = 2,
): T | null {
  if (!Number.isFinite(mhz)) return null;
  let best: T | null = null;
  for (const track of tracks) {
    if (track.state === "cooled") continue;
    const lo = Math.min(track.fLowMhz, track.fHighMhz);
    const hi = Math.max(track.fLowMhz, track.fHighMhz);
    const width = Math.max(hi - lo, 0);
    const drawn = pxPerMhz > 0 ? Math.max(width, minPx / pxPerMhz) : width;
    if (mhz < lo || mhz > lo + drawn) continue;
    if (!best || track.widthMhz < best.widthMhz) best = track;
  }
  return best;
}
