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

export interface AdviceMerge {
  queue: readonly AdviceQueueItem[];
  /** Список и номера следов те же. Частота того же id могла уйти — это не новый сигнал. */
  same: boolean;
  /** Старый номер следа → номер, который трекер оставил той же частоте. */
  rebind: ReadonlyArray<readonly [number, number]>;
}

/**
 * Очередь держится за номер следа, не за частоту первого кадра.
 * Трекер на каждом хите пишет новую частоту и может сдвинуть её на ATTACK_ASSOC_MHZ
 * (attackTracks.append + bestTrack). Два таких шага уже дальше 0.2 МГц от первой
 * цифры: сравнение с ней заводило тот же след заново и обрывало 8 секунд.
 * Текущий след (pinnedId) не выкидывается, пока пауза не кончилась, даже если он остыл.
 * Остывший чужой след из очереди уходит.
 */
export function mergeAdviceQueue(
  queue: readonly AdviceQueueItem[],
  live: readonly { id: number; freqMhz: number; state: string }[],
  pinnedId: number | null,
): AdviceMerge {
  const alive = live.filter((row) => row.state !== "cooled");
  const used = new Set<number>();
  const next: AdviceQueueItem[] = [];
  const rebind: Array<readonly [number, number]> = [];
  let changed = false;
  for (const item of queue) {
    const byId = alive.find((row) => row.id === item.trackId);
    const row = byId && !used.has(byId.id)
      ? byId
      : alive.find((candidate) => !used.has(candidate.id) && sameAdviceEmitter(candidate.freqMhz, item.freqMhz));
    if (row) {
      used.add(row.id);
      if (row.id !== item.trackId) {
        next.push({ freqMhz: row.freqMhz, trackId: row.id });
        rebind.push([item.trackId, row.id]);
        changed = true;
      } else {
        next.push(item);
      }
      continue;
    }
    if (item.trackId === pinnedId && !next.some((kept) => kept.trackId === pinnedId)) {
      next.push(item);
      continue;
    }
    changed = true;
  }
  for (const row of alive) {
    if (used.has(row.id)) continue;
    next.push({ freqMhz: row.freqMhz, trackId: row.id });
    changed = true;
  }
  if (!changed) return { queue, same: true, rebind };
  return { queue: next, same: false, rebind };
}

export function queueIndexForFreq(queue: readonly AdviceQueueItem[], freqMhz: number): number {
  return queue.findIndex((item) => sameAdviceEmitter(item.freqMhz, freqMhz));
}

export function queueIndexForId(queue: readonly AdviceQueueItem[], trackId: number): number {
  return queue.findIndex((item) => item.trackId === trackId);
}

/**
 * Текущий номер остаётся, пока этот след в очереди.
 * Остывание само по себе номер не меняет: паузу кончает таймер, не пропадание хита.
 */
export function resolveAdviceId(prevId: number | null, queue: readonly AdviceQueueItem[]): number | null {
  if (queue.length === 0) return null;
  if (prevId != null && queue.some((item) => item.trackId === prevId)) return prevId;
  return queue[0]?.trackId ?? null;
}

/**
 * Следующий живой след. Один живой сигнал остаётся.
 * Если текущий уже остыл и других нет, очередь пустая, а не вечный показ трупа.
 */
export function advanceAdviceId(
  queue: readonly AdviceQueueItem[],
  currentId: number | null,
  live: readonly { id: number; state: string }[],
): number | null {
  const alive = new Set(live.filter((row) => row.state !== "cooled").map((row) => row.id));
  if (queue.length === 0) return null;
  const at = currentId == null ? -1 : queue.findIndex((item) => item.trackId === currentId);
  for (let step = 1; step <= queue.length; step += 1) {
    const item = queue[(at + step) % queue.length];
    if (item && alive.has(item.trackId)) return item.trackId;
  }
  return null;
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
