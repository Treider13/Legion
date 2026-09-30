import { useState } from "react";

import type { Slide } from "./modes";

/**
 * Ручные шаги. Автопрокрутки нет: w3c/aria-practices (carousel-pattern)
 * требует кнопку стоп и запрещает продолжать вращение после фокуса.
 * Здесь вращение не включается — остаются «Назад» и «Дальше».
 */
export function useCue(slides: readonly Slide[], resetKey: string): {
  key: string;
  index: number;
  count: number;
  showKey: (key: string) => void;
  next: () => void;
  prev: () => void;
} {
  const [key, setKey] = useState(slides[0]?.key ?? "");
  const [seenReset, setSeenReset] = useState(resetKey);

  if (seenReset !== resetKey) {
    setSeenReset(resetKey);
    setKey(slides[0]?.key ?? "");
  } else if (slides.length > 0 && !slides.some((slide) => slide.key === key)) {
    setKey(slides[0].key);
  }

  const found = slides.findIndex((slide) => slide.key === key);
  const index = found < 0 ? 0 : found;
  const current = slides[index];

  const showKey = (nextKey: string) => {
    if (slides.some((slide) => slide.key === nextKey)) setKey(nextKey);
  };

  const step = (dir: -1 | 1) => {
    if (slides.length < 2) return;
    const at = slides.findIndex((slide) => slide.key === (current?.key ?? key));
    const from = at < 0 ? 0 : at;
    const nextSlide = slides[(from + dir + slides.length) % slides.length];
    if (nextSlide) setKey(nextSlide.key);
  };

  return {
    key: current?.key ?? "",
    index,
    count: slides.length,
    showKey,
    next: () => step(1),
    prev: () => step(-1),
  };
}
