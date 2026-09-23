import { useEffect, useRef, useState } from "react";

import type { Slide } from "./modes";

export const CUE_MS = 4000;

/** Удержание карточки по часам. Смена режима начинает отсчёт заново и не перескакивает вперёд. */
export function useCue(slides: readonly Slide[], paused: boolean, resetKey: string): { key: string; progress: number } {
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const dueRef = useRef(performance.now() + CUE_MS);
  const keyRef = useRef(slides[0]?.key ?? "");
  const [key, setKey] = useState(slides[0]?.key ?? "");
  const [progress, setProgress] = useState(0);
  const [seenReset, setSeenReset] = useState(resetKey);

  if (seenReset !== resetKey) {
    const first = slides[0]?.key ?? "";
    keyRef.current = first;
    dueRef.current = performance.now() + CUE_MS;
    setSeenReset(resetKey);
    setKey(first);
    setProgress(0);
  }

  useEffect(() => {
    if (paused) return;
    dueRef.current = performance.now() + CUE_MS;
    setProgress(0);
    const id = window.setInterval(() => {
      const now = performance.now();
      const list = slidesRef.current;
      if (list.length === 0) return;
      const held = 1 - (dueRef.current - now) / CUE_MS;
      setProgress(Math.min(1, Math.max(0, held)));
      if (list.length < 2) {
        dueRef.current = now + CUE_MS;
        return;
      }
      const idx = list.findIndex((slide) => slide.key === keyRef.current);
      if (idx < 0) {
        keyRef.current = list[0].key;
        setKey(list[0].key);
        dueRef.current = now + CUE_MS;
        setProgress(0);
        return;
      }
      if (now >= dueRef.current) {
        const next = list[(idx + 1) % list.length];
        keyRef.current = next.key;
        setKey(next.key);
        dueRef.current = now + CUE_MS;
        setProgress(0);
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [paused]);

  return { key, progress };
}
