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
 * На широкой полосе след уже одного пикселя всё равно рисуется полоской minPx:
 * зона наведения равна этой полоске, а не только частотной ширине.
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
    const pad = pxPerMhz > 0 ? Math.max(0, (minPx / pxPerMhz - width) / 2) : 0;
    if (mhz < lo - pad || mhz > hi + pad) continue;
    if (!best || track.widthMhz < best.widthMhz) best = track;
  }
  return best;
}
