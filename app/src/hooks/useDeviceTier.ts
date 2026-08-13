// ============================================================================
// LEGION — device-tier детекция (тренд SOTD 2026: слабым устройствам — легче).
// low: без постпроцессинга, меньше точек; + prefers-reduced-motion.
// ============================================================================
import { useMemo } from "react";

export type DeviceTier = "low" | "high";

export function useDeviceTier(): DeviceTier {
  return useMemo(() => {
    // Тестовый/отладочный хук: ?tier=high|low
    const forced = new URLSearchParams(window.location.search).get("tier");
    if (forced === "high" || forced === "low") return forced;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return "low";
    const cores = navigator.hardwareConcurrency ?? 4;
    const mem = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    // Пороги откалиброваны под десктопный инструмент: 4 ядра — норма (high)
    if (mobile || cores <= 2 || mem <= 2) return "low";
    return "high";
  }, []);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
