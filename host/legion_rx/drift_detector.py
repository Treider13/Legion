"""DriftDetector — детект сбоя паттерна (фаза 4 ТЗ).

Метрика: LP score (match живых скачков с подтверждённым паттерном) в
скользящем окне. score < 0.7 НА ПРОТЯЖЕНИИ 3 циклов подряд → DRIFT_DETECTED
(→ пауза помехи, переобучение — фаза 1).
"""
from __future__ import annotations

DRIFT_THRESHOLD = 0.7  # ТЗ: LP score < 0.7
DRIFT_CYCLES = 3       # ТЗ: 3 цикла подряд


class DriftDetector:
    def __init__(self, threshold: float = DRIFT_THRESHOLD,
                 cycles: int = DRIFT_CYCLES):
        self.thr = float(threshold)
        self.need = int(cycles)
        self._strikes = 0
        self._window: list[float] = []

    def update(self, lp_score: float) -> dict:
        """Тик с LP score текущего цикла → {drift, score, strikes}."""
        s = float(lp_score)
        self._window.append(s)
        self._window = self._window[-16:]
        if s < self.thr:
            self._strikes += 1
        else:
            self._strikes = 0
        return {"drift": self._strikes >= self.need,
                "score": s,
                "mean_score": sum(self._window) / len(self._window),
                "strikes": self._strikes}

    def reset(self) -> None:
        self._strikes = 0
        self._window = []
