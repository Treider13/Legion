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

/** Самый узкий живой след под курсором. Широкая полка не перекрывает маркер внутри неё. */
export function trackUnderMhz<T extends MarkerHit>(tracks: readonly T[], mhz: number): T | null {
  if (!Number.isFinite(mhz)) return null;
  let best: T | null = null;
  for (const track of tracks) {
    if (track.state === "cooled") continue;
    const lo = Math.min(track.fLowMhz, track.fHighMhz);
    const hi = Math.max(track.fLowMhz, track.fHighMhz);
    if (mhz < lo || mhz > hi) continue;
    if (!best || track.widthMhz < best.widthMhz) best = track;
  }
  return best;
}
