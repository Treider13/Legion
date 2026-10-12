"""DriftDetector — детект сбоя паттерна (фаза 4 ТЗ).

Метрика: доля align ±1 живых скачков с паттерном. score < 0.7
на протяжении need hops (need = max(3, 3×cycle_length)) → DRIFT.
FSM зовёт update() только при смене канала, не на каждый кадр.
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
        """Один hop с LP score → {drift, score, strikes}."""
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

    def set_cycles(self, cycle_length: int) -> None:
        """need = max(3, 3×cycle_length) hops, не кадры FSM."""
        self.need = max(3, 3 * max(1, int(cycle_length)))

    def reset(self) -> None:
        self._strikes = 0
        self._window = []
