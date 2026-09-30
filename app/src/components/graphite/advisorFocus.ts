import { useSyncExternalStore } from "react";

export interface MarkerHit {
  id: number;
  fLowMhz: number;
  fHighMhz: number;
  widthMhz: number;
  state: string;
}

let focusId: number | null = null;
const listeners = new Set<() => void>();

export function advisorFocusId(): number | null {
  return focusId;
}

/** Наведение на маркер. Повтор того же следа карточку не пересобирает. */
export function focusAdvisorTrack(id: number): void {
  if (focusId === id) return;
  focusId = id;
  listeners.forEach((listener) => listener());
}

export function clearAdvisorFocus(): void {
  if (focusId == null) return;
  focusId = null;
  listeners.forEach((listener) => listener());
}

export function useAdvisorFocusId(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => focusId,
    () => null,
  );
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
